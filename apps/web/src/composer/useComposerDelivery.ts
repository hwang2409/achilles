import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useRunStore, type ComposerProps } from "@fulcrum/react";
import { DroppedSteerDeliveryError, UncertainSteerDeliveryError } from "../useActiveChat";
import {
  createComposerModel,
  transition,
  type ComposerEvent,
  type ComposerModel,
} from "./composer-machine";

const attempt = (action: () => unknown) =>
  new Promise<unknown>((resolve) => resolve(action()));
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)) || "unknown error";

export type ComposerAdapterProps = ComposerProps & {
  onDraftChange: (text: string) => void;
  onDeliveryConfirm: (sent: string) => void;
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
  stop(): Promise<void>;
};

export function createComposerDelivery(options: DeliveryOptions): ComposerDelivery {
  let current = options;
  let model = createComposerModel(options.defaultValue ?? "", options.state);
  const listeners = new Set<() => void>();

  const apply = (event: ComposerEvent) => {
    const confirmedText = event.type === "confirm" && model.send?.attempt === event.attempt
      ? model.send.sent
      : undefined;
    const result = transition(model, event);
    if (result.model !== model) {
      model = result.model;
      for (const listener of listeners) listener();
    }
    if (event.type === "edit") current.onDraftChange(model.draft);
    if (confirmedText !== undefined) current.onDeliveryConfirm(confirmedText);
    return result.effect;
  };

  return {
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
    },
    edit(draft) {
      apply({ type: "edit", draft });
    },
    dismissError() {
      apply({ type: "dismiss-error" });
    },
    async submit() {
      apply({ type: "state", state: current.state });
      const effect = apply({
        type: "submit",
        turnRunning: current.isTurnRunning?.() ?? current.state === "steerable",
      });
      if (effect?.type !== "submit") return;
      const { attempt: sendAttempt, text, steer } = effect;
      try {
        await attempt(() => current.onSubmit(text, { steer }, () => {}));
        apply({ type: "confirm", attempt: sendAttempt });
      } catch (failure) {
        apply({
          type: "reject",
          attempt: sendAttempt,
          message: errorText(failure),
          uncertain: failure instanceof UncertainSteerDeliveryError,
          dropped: failure instanceof DroppedSteerDeliveryError,
        });
      } finally {
        apply({ type: "settle", attempt: sendAttempt });
      }
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

  useLayoutEffect(() => {
    owner.sync(options.state, options.defaultValue);
  }, [owner, options.defaultValue, options.state]);

  const edit = useCallback((draft: string) => owner.edit(draft), [owner]);
  const dismissError = useCallback(() => owner.dismissError(), [owner]);
  const submit = useCallback(() => void owner.submit(), [owner]);
  const stop = useCallback(() => void owner.stop(), [owner]);
  return { model, edit, dismissError, submit, stop };
}
