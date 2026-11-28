import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { restoreFocus } from "../keyboard";
import { WRITE_SURFACE } from "../writeSurfaces";
import { composerStatus, enterAction, inFlight, submitAction } from "./composer-machine";
import { QueuedMessages } from "./QueuedMessages";
import { ImageChips, imageInputProps } from "./ImageChips";
import {
  useComposerDelivery,
  type ComposerAdapterProps,
} from "./useComposerDelivery";
import { ComposerHint } from "./hint";
import { useSlashMenu } from "./SlashMenu";
import { usePathCompletion } from "./pathCompletion";

// send while the composer is held: shown, and off
export const HeldSend = () => <button type="button" data-part="composer-submit" aria-label="send message" disabled>send</button>;

/** A textarea adapter for the shared Achilles composer delivery module. */
export function PlainComposer(props: ComposerAdapterProps) {
  const {
    state,
    label = "message",
    placeholder,
    className,
    onStop,
    questionWaiting,
  } = props;
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const focusLost = useRef(false);
  const stopFocused = useRef(false);
  const { model, edit, addImages, removeImage, submit, stop, retry, restore, cancel } = useComposerDelivery(props);
  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";
  const action = submitAction(model);
  // images cannot steer: with a turn running they wait for it, like a queued message
  const queues = model.sending || model.queue.length > 0 || (steer && model.images.length > 0);
  const { text: message, tone } = composerStatus(model);
  const slash = useSlashMenu(id, model.draft, props.slashCommands, edit, submit);
  const caret = useRef<number | null>(null);
  const paths = usePathCompletion(props.completePaths, (value, at) => { caret.current = at; edit(value); });
  useLayoutEffect(() => {
    if (caret.current === null || !input.current) return;
    input.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // the two lists cannot both be open: slash needs a draft of only `/name`, a path token needs `@` after a space
    if (slash.onKeyDown(event) || paths.onKeyDown(event)) return;
    if (event.key === "Escape" && !model.draft && model.queue.length && model.queue.at(-1) !== inFlight(model) && !event.nativeEvent.isComposing) {
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
    restoreFocus(input.current);
  });

  // one form in every state: a hold (read-only) and its end keep the same textarea, so focus and caret stay in it
  const readOnly = state === "read-only";
  return (
    <form
      className={className}
      data-part="composer"
      data-write-surface={WRITE_SURFACE.composerSend}
      data-state={state}
      data-held={props.held || undefined}
      data-error={model.error?.kind}
      data-pending={
        model.sending ? "submit" : model.stopping ? "stop" : undefined
      }
      data-queued={model.queue.length || undefined}
      aria-label={label}
      aria-busy={model.sending || model.stopping || undefined}
      onSubmit={onFormSubmit}
      {...(props.images && !readOnly ? imageInputProps(addImages) : {})}
    >
      {!readOnly && paths.list(() => input.current)}
      {!readOnly && <QueuedMessages model={model} onRetry={(id) => { retry(id); focusInput(); }} onRestore={(id) => { restore(id); focusInput(); }} onCancel={(id) => { cancel(id); focusInput(); }} />}
      {!readOnly && <ImageChips images={model.images} onRemove={(index) => { removeImage(index); focusInput(); }} />}
      <div data-part="composer-field" data-value={model.draft}>
        <textarea
          ref={input}
          rows={1}
          value={model.draft}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={readOnly ? undefined : `${id}-hint ${id}-message`}
          readOnly={readOnly}
          {...(readOnly ? {} : paths.fieldProps)}
          // after the path props: they set aria-controls even when closed, so the open slash menu must win
          {...(readOnly ? {} : slash.field)}
          onChange={readOnly ? undefined : (event) => { edit(event.target.value); paths.sync(event.target); }}
          onSelect={readOnly ? undefined : (event) => paths.sync(event.currentTarget)}
          onBlur={paths.close}
          onKeyDown={readOnly ? undefined : onKeyDown}
        />
      </div>
      {readOnly ? (props.controls || props.held) && <div data-part="composer-bar">{props.controls}{props.held && <><p data-part="composer-reason">{props.reason}</p><HeldSend /></>}</div> : <div data-part="composer-bar">
        {props.controls}
        <p
          data-part="composer-status"
          data-tone={tone}
          title={model.error?.text}
        >
          <ComposerHint id={`${id}-hint`} state={state} queues={queues} questionWaiting={questionWaiting} hidden={Boolean(message)} />
          <span data-part="composer-message" id={`${id}-message`} role={model.error ? "alert" : "status"}>
            {message}
          </span>
        </p>
        {running && onStop ? (
          <button
            ref={stopButtonRef}
            type="button"
            data-part="composer-stop"
            data-write-surface={WRITE_SURFACE.composerAbort}
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
          data-write-surface={steer ? WRITE_SURFACE.composerSteer : WRITE_SURFACE.composerSend}
          data-action={queues ? "queue" : steer ? "steer" : "send"}
          aria-label={queues ? "queue message" : steer ? "steer the running turn" : "send message"}
          aria-disabled={!action || undefined}
        >
          {queues ? "queue" : steer ? "steer" : "send"}
        </button>
      </div>}
    {!readOnly && (slash.menu || props.commandOutput)}
    </form>
  );
}
