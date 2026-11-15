import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useRunStore, type ComposerProps } from "@fulcrum/react";
import { DroppedSteerDeliveryError } from "../useActiveChat";
import {
  createComposerModel,
  transition,
  waitingCount,
  type ComposerEffect,
  type ComposerEvent,
  type ComposerModel,
  type SendOutcome,
} from "./composer-machine";

const attempt = (action: () => unknown) =>
  new Promise<unknown>((resolve) => resolve(action()));
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)) || "unknown error";

/** Queued messages a composer left behind when it unmounted, and the send they must wait for. */
export type ParkedQueue = { texts: string[]; after: Promise<SendOutcome> };

export type ComposerAdapterProps = ComposerProps & {
  onDraftChange: (text: string) => void;
  onDeliveryConfirm: (sent: string) => void;
  /** keeps this chat's queue when the composer unmounts; the next composer of the chat takes it */
  parkQueue?: (parked: ParkedQueue) => void;
  takeQueue?: () => ParkedQueue | undefined;
  onActivity?: (activity: { sending: boolean; queued: number }) => void;
};

type DeliveryOptions = ComposerAdapterProps & {
  isTurnRunning?: () => boolean;
};

export type ComposerDelivery = {
  getModel(): ComposerModel;
  subscribe(listener: () => void): () => void;
  update(options: DeliveryOptions): void;
  sync(state: ComposerProps["state"], defaultValue?: string): void;
  edit(draft: string): void;
  dismissError(): void;
  submit(): Promise<void>;
  retry(id: number): Promise<void>;
  cancel(id?: number): void;
  /** Mount: take the chat's parked queue. The returned detach parks it again; a detached owner never starts a send. */
  attach(): () => void;
  stop(): Promise<void>;
};

export function createComposerDelivery(options: DeliveryOptions): ComposerDelivery {
  let current = options;
  let model = createComposerModel(options.defaultValue ?? "", options.state);
  const listeners = new Set<() => void>();

  const apply = (event: ComposerEvent) => {
    // a queued message never sat in the box, so its confirm leaves the stored draft alone
    const confirmedText = event.type === "confirm" && model.send?.attempt === event.attempt && model.send.queuedId === undefined
      ? model.send.sent
      : undefined;
    const draft = model.draft;
    const result = transition(model, event);
    if (result.model !== model) {
      model = result.model;
      for (const listener of listeners) listener();
    }
    if (event.type === "edit" || (event.type === "submit" && model.draft !== draft)) current.onDraftChange(model.draft);
    if (confirmedText !== undefined) current.onDeliveryConfirm(confirmedText);
    return result.effect;
  };

  let detached = false;
  let sending: Promise<SendOutcome> | undefined;
  const turnRunning = () => current.isTurnRunning?.() ?? current.state === "steerable";

  const deliver = async ({ attempt: sendAttempt, text, steer }: Extract<ComposerEffect, { type: "submit" }>) => {
    const queued = model.send?.queuedId !== undefined;
    let done!: (outcome: SendOutcome) => void;
    sending = new Promise((resolve) => { done = resolve; });
    let outcome: SendOutcome = {};
    try {
      await attempt(() => current.onSubmit(text, { steer }, () => {}));
      apply({ type: "confirm", attempt: sendAttempt });
    } catch (failure) {
      outcome = { failed: errorText(failure), text: queued ? text : undefined };
      apply({
        type: "reject",
        attempt: sendAttempt,
        message: outcome.failed!,
        dropped: failure instanceof DroppedSteerDeliveryError,
      });
    } finally {
      apply({ type: "settle", attempt: sendAttempt });
      sending = undefined;
      done(outcome);
    }
  };

  // one message at a time, in order, each through the current props; a detached owner stops here
  const drain = async () => {
    while (!detached) {
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
    dismissError() {
      apply({ type: "dismiss-error" });
    },
    async submit() {
      apply({ type: "state", state: current.state });
      const effect = apply({ type: "submit", turnRunning: turnRunning() });
      if (effect?.type === "submit") await deliver(effect);
      await drain();
    },
    async retry(id) {
      apply({ type: "retry", id });
      await drain();
    },
    cancel(id) {
      apply(id === undefined ? { type: "cancel-last" } : { type: "cancel", id });
      void drain();
    },
    attach() {
      detached = false;
      const parked = current.takeQueue?.();
      if (parked) {
        apply({ type: "adopt", texts: parked.texts });
        void parked.after.then((outcome) => { apply({ type: "adopted", outcome }); return drain(); });
      }
      return () => {
        detached = true;
        const inFlight = model.send?.queuedId;
        const waiting = model.waiting;
        const texts = model.queue.filter((item) => item.id !== inFlight).map((item) => item.text);
        apply({ type: "detach" });
        if (texts.length || inFlight !== undefined || waiting)
          current.parkQueue?.({ texts, after: sending ?? parked?.after ?? Promise.resolve({}) });
      };
    },
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
  if (!delivery.current) delivery.current = createComposerDelivery(deliveryOptions);
  delivery.current.update(deliveryOptions);
  const owner = delivery.current;
  const model = useSyncExternalStore(owner.subscribe, owner.getModel, owner.getModel);

  // a layout effect, so the old composer parks its queue before the next one (same commit) takes it
  useLayoutEffect(() => owner.attach(), [owner]);
  useLayoutEffect(() => {
    owner.sync(options.state, options.defaultValue);
  }, [owner, options.defaultValue, options.state]);
  const sendingNow = model.sending && model.send?.queuedId === undefined;
  const queued = waitingCount(model);
  useEffect(() => options.onActivity?.({ sending: sendingNow, queued }), [options.onActivity, sendingNow, queued]);
  useEffect(() => () => options.onActivity?.({ sending: false, queued: 0 }), [options.onActivity]);

  const edit = useCallback((draft: string) => owner.edit(draft), [owner]);
  const dismissError = useCallback(() => owner.dismissError(), [owner]);
  const submit = useCallback(() => void owner.submit(), [owner]);
  const stop = useCallback(() => void owner.stop(), [owner]);
  const retry = useCallback((id: number) => void owner.retry(id), [owner]);
  const cancel = useCallback((id?: number) => owner.cancel(id), [owner]);
  return { model, edit, dismissError, submit, stop, retry, cancel, getModel: owner.getModel };
}
