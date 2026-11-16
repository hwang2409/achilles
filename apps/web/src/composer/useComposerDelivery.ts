import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useRunStore, type ComposerIntent, type ComposerProps } from "@fulcrum/react";
import {
  composerActivity,
  createComposerModel,
  transition,
  type ComposerEffect,
  type ComposerEvent,
  type ComposerModel,
  type QueuedMessage,
} from "./composer-machine";
import { chatQueues, MAYBE_SENT } from "./chatQueues";

const attempt = (action: () => unknown) =>
  new Promise<unknown>((resolve) => resolve(action()));
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)) || "unknown error";

export type ComposerAdapterProps = ComposerProps & {
  onDraftChange: (text: string) => void;
  /** Enter took this text out of the box; the stored draft drops it */
  onDraftSubmit: (sent: string) => void;
  /** the chat this composer shows; its submitted messages belong to the chat's owner in `chatQueues` */
  chatId: string;
  /** this chat was just created by the page's new-chat composer `fromNewChat`; that composer's owner moves here */
  fromNewChat?: string;
  onActivity?: (activity: ReturnType<typeof composerActivity>) => void;
};

/** `deliveryId`: send with this id (a retry of a row that may have been sent), not a new one */
export type SendIntent = ComposerIntent & { deliveryId?: string };

export type DeliveryOptions = ComposerProps & {
  onDraftChange: (text: string) => void;
  onDraftSubmit: (sent: string) => void;
  isTurnRunning?: () => boolean;
};

export type ComposerDelivery = {
  getModel(): ComposerModel;
  subscribe(listener: () => void): () => void;
  update(options: DeliveryOptions): void;
  sync(state: ComposerProps["state"], defaultValue?: string): void;
  edit(draft: string): void;
  submit(): Promise<void>;
  retry(id: number): Promise<void>;
  /** zeta's transcript shows the prompt sent with this delivery id (in flight now, or a row an earlier page load kept). */
  echo(deliveryId: string): void;
  /** Edit a failed message: its text goes back into the box. */
  restore(id: number): void;
  cancel(id?: number): void;
  /** A composer mounts. The owner starts sends only while at least one composer is attached; the returned function detaches it. */
  attach(): () => void;
  attached(): boolean;
  stop(): Promise<void>;
};

/** `rows`: the chat's unsent messages that an earlier page load kept (all failed) */
export function createComposerDelivery(options: DeliveryOptions, rows: Omit<QueuedMessage, "id">[] = []): ComposerDelivery {
  let current = options;
  let model = createComposerModel(options.defaultValue ?? "", options.state, rows);
  const listeners = new Set<() => void>();

  const apply = (event: ComposerEvent) => {
    const draft = model.draft;
    const result = transition(model, event);
    if (result.model !== model) {
      model = result.model;
      for (const listener of listeners) listener();
    }
    if (event.type === "submit" && model.draft !== draft) current.onDraftSubmit(draft);
    else if (model.draft !== draft || event.type === "edit") current.onDraftChange(model.draft);
    return result.effect;
  };

  let mounts = 0;
  const turnRunning = () => current.isTurnRunning?.() ?? current.state === "steerable";

  const deliver = async ({ attempt: sendAttempt, text, steer, deliveryId: reused }: Extract<ComposerEffect, { type: "submit" }>) => {
    const intent: SendIntent = reused ? { steer, deliveryId: reused } : { steer };
    try {
      await attempt(() => current.onSubmit(text, intent, (deliveryId) => apply({ type: "track", attempt: sendAttempt, deliveryId })));
      apply({ type: "confirm", attempt: sendAttempt });
    } catch (failure) {
      apply({ type: "reject", attempt: sendAttempt, message: errorText(failure) });
    } finally {
      apply({ type: "settle", attempt: sendAttempt });
    }
  };

  // one message at a time, in order, each through the current props; with no composer attached, nothing new goes out
  const drain = async () => {
    while (mounts > 0) {
      apply({ type: "state", state: current.state });
      const effect = apply({ type: "next", turnRunning: turnRunning() });
      if (effect?.type !== "submit") return;
      await deliver(effect);
    }
  };

  const delivery: ComposerDelivery = {
    getModel: () => model,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(next) {
      current = next;
    },
    sync(state, defaultValue) {
      apply({ type: "state", state });
      if (defaultValue !== undefined && defaultValue !== model.draft)
        apply({ type: "edit", draft: defaultValue });
      void drain();
    },
    edit(draft) {
      apply({ type: "edit", draft });
    },
    async submit() {
      apply({ type: "state", state: current.state });
      const effect = apply({ type: "submit", turnRunning: turnRunning() });
      if (effect?.type === "submit") await deliver(effect);
      await drain();
    },
    echo(deliveryId) {
      apply({ type: "echo", deliveryId });
    },
    async retry(id) {
      apply({ type: "retry", id });
      await drain();
    },
    restore(id) {
      apply({ type: "restore", id });
      void drain();
    },
    cancel(id) {
      apply(id === undefined ? { type: "cancel-last" } : { type: "cancel", id });
      void drain();
    },
    attach() {
      mounts += 1;
      void drain();
      let attachedNow = true;
      return () => {
        if (attachedNow) mounts -= 1;
        attachedNow = false;
      };
    },
    attached: () => mounts > 0,
    async stop() {
      const effect = apply({ type: "stop" });
      if (effect?.type !== "stop" || !current.onStop) return;
      try {
        await attempt(current.onStop);
      } catch (failure) {
        apply({ type: "stop-reject", message: errorText(failure) });
      } finally {
        apply({ type: "stop-settle" });
      }
    },
  };
  return delivery;
}

export function useComposerDelivery(options: ComposerAdapterProps) {
  const store = useRunStore();
  const deliveryOptions = {
    ...options,
    isTurnRunning: () => store.getState().turn === "running",
  };
  const delivery = useRef<ComposerDelivery | null>(null);
  delivery.current ??= chatQueues.open(options.chatId, deliveryOptions, options.fromNewChat);
  delivery.current.update(deliveryOptions);
  const owner = delivery.current;
  const model = useSyncExternalStore(owner.subscribe, owner.getModel, owner.getModel);

  // a layout effect, so the chat's owner counts this composer before `chatQueues.settle` runs in the same commit
  useLayoutEffect(() => owner.attach(), [owner]);
  useLayoutEffect(() => {
    owner.sync(options.state, options.defaultValue);
  }, [owner, options.defaultValue, options.state]);
  // zeta echoes an accepted prompt before it answers the send: the transcript shows it, so its row goes (a queued steer
  // stays: the transcript hides it until delivery settles)
  const echoWanted = model.send?.echoed === false && !model.send.steer ? model.send.deliveryId : undefined;
  useEffect(() => {
    if (!echoWanted) return;
    const check = () => {
      const { outline } = store.getState();
      for (let index = outline.length - 1; index >= 0; index -= 1) {
        const item = store.getItem(outline[index]!.id);
        if (item?.type !== "user") continue;
        // the newest prompt is the only candidate
        if (item.event.type === "user_message" && item.event.delivery_id === echoWanted && item.event.mode === "send") owner.echo(echoWanted);
        return;
      }
    };
    check();
    return store.subscribe(check);
  }, [owner, store, echoWanted]);
  // a row in flight when an earlier page load ended: zeta's transcript shows its delivery id once zeta took it
  const maybeSent = model.queue.some((item) => item.failed === MAYBE_SENT);
  useEffect(() => {
    if (!maybeSent) return;
    const check = () => {
      const taken = new Set<string>();
      for (const { id } of store.getState().outline) {
        const item = store.getItem(id);
        if (item?.type === "user" && item.event.type === "user_message" && item.event.delivery_id) taken.add(item.event.delivery_id);
      }
      for (const row of owner.getModel().queue) if (row.failed === MAYBE_SENT && row.deliveryId && taken.has(row.deliveryId)) owner.echo(row.deliveryId);
    };
    check();
    return store.subscribe(check);
  }, [owner, store, maybeSent]);
  const { sending, queued, failed } = composerActivity(model);
  useEffect(() => options.onActivity?.({ sending, queued, failed }), [options.onActivity, sending, queued, failed]);
  useEffect(() => () => options.onActivity?.({ sending: false, queued: 0, failed: false }), [options.onActivity]);

  const edit = useCallback((draft: string) => owner.edit(draft), [owner]);
  const submit = useCallback(() => void owner.submit(), [owner]);
  const stop = useCallback(() => void owner.stop(), [owner]);
  const retry = useCallback((id: number) => void owner.retry(id), [owner]);
  const restore = useCallback((id: number) => owner.restore(id), [owner]);
  const cancel = useCallback((id?: number) => owner.cancel(id), [owner]);
  return { model, edit, submit, stop, retry, restore, cancel, getModel: owner.getModel };
}
