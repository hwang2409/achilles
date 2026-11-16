import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { restoreFocus } from "../keyboard";
import { composerStatus, enterAction, submitAction } from "./composer-machine";
import { QueuedMessages } from "./QueuedMessages";
import {
  useComposerDelivery,
  type ComposerAdapterProps,
} from "./useComposerDelivery";

/** A textarea adapter for the shared Achilles composer delivery module. */
export function PlainComposer(props: ComposerAdapterProps) {
  const {
    state,
    reason,
    label = "message",
    placeholder,
    className,
    onStop,
  } = props;
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const focusLost = useRef(false);
  const stopFocused = useRef(false);
  const { model, edit, submit, stop, retry, restore, cancel } = useComposerDelivery(props);
  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";
  const action = submitAction(model);
  const queues = model.sending || model.queue.length > 0;
  const { text: message, tone } = composerStatus(model);
  const hint =
    state === "running"
      ? "a turn is running · stop it or wait to send"
      : queues
        ? "enter to queue · esc in an empty box cancels the last"
        : steer
          ? "enter to steer · shift+enter new line"
          : "enter to send · shift+enter for a new line";
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !model.draft && model.queue.length && !event.nativeEvent.isComposing) {
      event.preventDefault();
      cancel();
      return;
    }
    if (
      enterAction({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        mode: "insert",
      }) !== "submit"
    )
      return;
    event.preventDefault();
    submit();
  };
  const focusInput = () => input.current?.focus({ preventScroll: true });
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    focusInput();
    submit();
  };
  const stopButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement !== button && !stopFocused.current) return;
      focusLost.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    stopFocused.current = false;
    restoreFocus(input.current, group.current);
  });

  if (state === "read-only")
    return (
      <div
        ref={group}
        tabIndex={-1}
        className={className}
        data-part="composer"
        data-state="read-only"
        role="group"
        aria-label={label}
      >
        {model.draft ? (
          <div data-part="composer-field" data-value={model.draft}>
            <textarea
              ref={input}
              rows={1}
              value={model.draft}
              readOnly
              aria-label={`${label} (draft, read-only)`}
            />
          </div>
        ) : null}
        <p data-part="composer-reason">{reason}</p>
      </div>
    );

  return (
    <form
      className={className}
      data-part="composer"
      data-state={state}
      data-error={model.error?.kind}
      data-pending={
        model.sending ? "submit" : model.stopping ? "stop" : undefined
      }
      data-queued={model.queue.length || undefined}
      aria-label={label}
      aria-busy={model.sending || model.stopping || undefined}
      onSubmit={onFormSubmit}
    >
      <QueuedMessages model={model} onRetry={(id) => { retry(id); focusInput(); }} onRestore={(id) => { restore(id); focusInput(); }} onCancel={(id) => { cancel(id); focusInput(); }} />
      <div data-part="composer-field" data-value={model.draft}>
        <textarea
          ref={input}
          rows={1}
          value={model.draft}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={`${id}-hint ${id}-message`}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div data-part="composer-bar">
        <p
          data-part="composer-status"
          data-tone={tone}
          title={model.error?.text}
        >
          <span
            data-part="composer-hint"
            id={`${id}-hint`}
            hidden={Boolean(message)}
          >
            {hint}
          </span>
          <span data-part="composer-message" id={`${id}-message`} role={model.error ? "alert" : "status"}>
            {message}
          </span>
        </p>
        {running && onStop ? (
          <button
            ref={stopButtonRef}
            type="button"
            data-part="composer-stop"
            data-action="stop"
            aria-label="stop the running turn"
            aria-disabled={model.stopping || undefined}
            onFocus={() => { stopFocused.current = true; }}
            onBlur={(event) => { if (event.relatedTarget) stopFocused.current = false; }}
            onClick={stop}
          >
            {model.stopping ? "stopping" : "stop"}
          </button>
        ) : null}
        <button
          type="submit"
          data-part="composer-submit"
          data-action={queues ? "queue" : steer ? "steer" : "send"}
          aria-label={queues ? "queue message" : steer ? "steer the running turn" : "send message"}
          aria-disabled={!action || undefined}
        >
          {queues ? "queue" : steer ? "steer" : "send"}
        </button>
      </div>
    </form>
  );
}
