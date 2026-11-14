import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRunStore, type ComposerProps } from "@fulcrum/react";
import {
  createComposerModel,
  transition,
  type ComposerEvent,
} from "./composer-machine";

const noDelivery = () => false;
const noSubscription = () => () => {};
const attempt = (action: () => unknown) =>
  new Promise<unknown>((resolve) => resolve(action()));
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)) || "unknown error";

export type ComposerAdapterProps = ComposerProps & {
  onDraftChange: (text: string) => void;
};

export function useComposerDelivery({
  state,
  defaultValue,
  onSubmit,
  onStop,
  onDraftChange,
}: ComposerAdapterProps) {
  const [model, setModel] = useState(() =>
    createComposerModel(defaultValue ?? "", state),
  );
  const modelRef = useRef(model);
  const submitRef = useRef(onSubmit);
  const stopRef = useRef(onStop);
  const stateRef = useRef(state);
  const draftChangeRef = useRef(onDraftChange);
  const store = useRunStore();
  submitRef.current = onSubmit;
  stopRef.current = onStop;
  stateRef.current = state;
  draftChangeRef.current = onDraftChange;

  const apply = useCallback((event: ComposerEvent) => {
    const result = transition(modelRef.current, event);
    modelRef.current = result.model;
    setModel(result.model);
    if (event.type === "edit" || event.type === "confirm")
      draftChangeRef.current(result.model.draft);
    return result.effect;
  }, []);
  useLayoutEffect(() => {
    apply({ type: "state", state });
  }, [apply, state]);

  const deliveryId = model.send?.deliveryId;
  const hasMessageDelivered = useCallback(
    (id: string) => store.hasMessageDelivery?.(id) ?? false,
    [store],
  );
  const readDelivery =
    deliveryId === undefined
      ? noDelivery
      : () => hasMessageDelivered(deliveryId);
  const echoed = useSyncExternalStore(
    deliveryId === undefined ? noSubscription : store.subscribe,
    readDelivery,
    readDelivery,
  );
  useLayoutEffect(() => {
    if (echoed && modelRef.current.send)
      apply({ type: "confirm", attempt: modelRef.current.send.attempt });
  }, [apply, echoed]);

  const submit = useCallback(() => {
    apply({ type: "state", state: stateRef.current });
    const effect = apply({ type: "submit" });
    if (effect?.type !== "submit") return;
    const { attempt: sendAttempt, text, steer } = effect;
    const track = (nextDeliveryId: string) =>
      apply({
        type: "track",
        attempt: sendAttempt,
        deliveryId: nextDeliveryId,
      });
    attempt(() => submitRef.current(text, { steer }, track))
      .then(
        () => apply({ type: "confirm", attempt: sendAttempt }),
        (failure: unknown) => {
          const tracked = modelRef.current.send;
          const delivered =
            tracked?.attempt === sendAttempt &&
            Boolean(
              tracked.deliveryId && hasMessageDelivered(tracked.deliveryId),
            );
          apply({
            type: "reject",
            attempt: sendAttempt,
            message: errorText(failure),
            delivered,
          });
        },
      )
      .finally(() => apply({ type: "settle", attempt: sendAttempt }));
  }, [apply, hasMessageDelivered]);
  const stop = useCallback(() => {
    const effect = apply({ type: "stop" });
    if (effect?.type !== "stop" || !stopRef.current) return;
    attempt(stopRef.current)
      .catch((failure: unknown) =>
        apply({ type: "stop-reject", message: errorText(failure) }),
      )
      .finally(() => apply({ type: "stop-settle" }));
  }, [apply]);

  const edit = useCallback(
    (draft: string) => {
      apply({ type: "edit", draft });
    },
    [apply],
  );
  return { model, edit, submit, stop };
}
