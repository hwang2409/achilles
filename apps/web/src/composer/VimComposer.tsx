import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { Composer, useRunStore, type ComposerProps, type ComposerState } from "@fulcrum/react";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import "./vim-composer.css";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";
const noDelivery = () => false;
const noSubscription = () => () => {};
const attempt = (action: () => unknown) => new Promise<unknown>((resolve) => resolve(action()));
const unsentDraft = (current: string, sent: string) => current.startsWith(sent) ? current.slice(sent.length) : current;
const isCoarsePointer = () => matchMedia("(pointer: coarse)").matches;

export function vimEnabled() {
  try { return JSON.parse(localStorage.getItem("achilles-settings") ?? "null")?.vim === true; }
  catch { return false; }
}

type Send = { sent: string; delivered: boolean; deliveryId?: string };
type Mode = "insert" | "normal" | "visual";

function vimMode(view: EditorView): Mode {
  const state = getCM(view)?.state.vim;
  return state?.visualMode ? "visual" : state?.insertMode ? "insert" : "normal";
}

function isTextField(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

/** A CodeMirror-backed composer with the same delivery contract as Fulcrum's Composer. */
export function VimComposer(props: ComposerProps) {
  if (props.state === "read-only" || isCoarsePointer()) return <Composer {...props} />;
  return <InteractiveVimComposer {...props} />;
}

function InteractiveVimComposer({ state, onSubmit, onStop, label = "message", placeholder, defaultValue = "", className }: ComposerProps & { state: Exclude<ComposerState, "read-only"> }) {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const text = useRef(defaultValue);
  const currentState = useRef(state);
  const submitAction = useRef(onSubmit);
  const stopAction = useRef(onStop);
  const inFlight = useRef({ submit: false, stop: false });
  const inFlightSend = useRef<Send | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<{ kind: "submit" | "stop"; text: string }>();
  const [deliveryId, setDeliveryId] = useState<string>();
  const [mode, setMode] = useState<Mode>("insert");
  const [draft, setDraft] = useState(defaultValue);
  const [focused, setFocused] = useState(true);
  const focusedRef = useRef(true);
  const [pending, setPending] = useState("");
  const [selectionLength, setSelectionLength] = useState(0);
  const store = useRunStore();
  currentState.current = state;
  submitAction.current = onSubmit;
  stopAction.current = onStop;

  const hasMessageDelivered = useCallback((delivery: string) => store.hasMessageDelivery?.(delivery) ?? false, [store]);
  const readDelivery = deliveryId === undefined ? noDelivery : () => hasMessageDelivered(deliveryId);
  const echoed = useSyncExternalStore(deliveryId === undefined ? noSubscription : store.subscribe, readDelivery, readDelivery);

  const replaceText = useCallback((next: string) => {
    text.current = next;
    setDraft(next);
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: next.length } });
  }, []);
  const delivered = useCallback((send: Send) => {
    if (send.delivered) return;
    send.delivered = true;
    replaceText(unsentDraft(text.current, send.sent));
    setError((current) => current?.kind === "submit" ? undefined : current);
    if (inFlightSend.current === send) inFlightSend.current = null;
    setDeliveryId(undefined);
  }, [replaceText]);
  useLayoutEffect(() => {
    if (echoed && inFlightSend.current) delivered(inFlightSend.current);
  }, [echoed, delivered]);

  const submit = useCallback(() => {
    const value = text.current;
    const composerState = currentState.current;
    if (inFlight.current.submit || !value.trim() || composerState === "running") return;
    const steer = composerState === "steerable";
    inFlight.current.submit = true;
    inFlightSend.current = null;
    setDeliveryId(undefined);
    const send: Send = { sent: value, delivered: false };
    inFlightSend.current = send;
    setSending(true);
    setError(undefined);
    const trackDelivery = (nextDeliveryId: string) => {
      if (inFlightSend.current !== send || send.delivered || send.deliveryId !== undefined) return;
      send.deliveryId = nextDeliveryId;
      setDeliveryId(nextDeliveryId);
    };
    attempt(() => submitAction.current(send.sent, { steer }, trackDelivery))
      .then(
        () => delivered(send),
        (failure: unknown) => {
          if (!send.delivered && send.deliveryId && hasMessageDelivered(send.deliveryId)) delivered(send);
          if (!send.delivered) setError({ kind: "submit", text: `could not ${steer ? "steer" : "send"}: ${errorText(failure)}` });
        },
      )
      .finally(() => {
        inFlight.current.submit = false;
        if (inFlightSend.current === send && (!send.deliveryId || send.delivered)) {
          inFlightSend.current = null;
          setDeliveryId(undefined);
        }
        setSending(false);
      });
  }, [delivered, hasMessageDelivered]);

  const stopRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) viewRef.current?.focus(); };
  }, []);
  const stop = useCallback(() => {
    if (inFlight.current.stop || !stopAction.current) return;
    inFlight.current.stop = true;
    setStopping(true);
    setError(undefined);
    attempt(stopAction.current)
      .catch((failure: unknown) => setError({ kind: "stop", text: `could not stop: ${errorText(failure)}` }))
      .finally(() => { inFlight.current.stop = false; setStopping(false); });
  }, []);

  useLayoutEffect(() => {
    if (!host.current) return;
    let yankPending = false;
    const syncVimState = (view: EditorView) => {
      const cm = getCM(view);
      const nextMode = vimMode(view);
      const selection = view.state.selection.main;
      setMode(nextMode);
      setSelectionLength(nextMode === "visual" ? Math.abs(selection.to - selection.from) : 0);
      setPending(nextMode === "visual" ? "" : cm?.state.vim?.status ?? "");
    };
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: defaultValue,
        extensions: [
          vim(),
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label, "aria-describedby": `${id}-hint ${id}-message`, "data-placeholder": placeholder ?? "" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              text.current = update.state.doc.toString();
              setDraft(text.current);
              if (!inFlight.current.submit && inFlightSend.current) {
                inFlightSend.current = null;
                setDeliveryId(undefined);
                setError((current) => current?.kind === "submit" ? undefined : current);
              }
            }
            syncVimState(update.view);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const cm = getCM(view);
    const commandDone = () => {
      syncVimState(view);
      if (!yankPending) return;
      yankPending = false;
      const register = Vim.getRegisterController().getRegister().toString();
      if (register) void navigator.clipboard?.writeText(register).catch(() => {});
    };
    cm?.on("vim-command-done", commandDone);
    const onFocus = () => { focusedRef.current = true; setFocused(true); syncVimState(view); };
    const onBlur = () => { focusedRef.current = false; setFocused(false); };
    const onKeyDown = (event: KeyboardEvent) => {
      const modeBefore = vimMode(view);
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        if (event.shiftKey && modeBefore === "insert") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.shiftKey) submit();
        return;
      }
      if (event.key === "Escape" && modeBefore === "normal") {
        event.preventDefault();
        event.stopImmediatePropagation();
        view.contentDOM.blur();
        return;
      }
      if (modeBefore === "insert") {
        if (event.key === "Escape") queueMicrotask(() => syncVimState(view));
        return;
      }
      const ctrlRedo = event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r";
      const allowed = ctrlRedo || event.key === "Tab" || event.key === "Escape" || /^[0-9hjklwbeiaIoOAxdcypuvVG$]$/.test(event.key);
      if (!allowed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const status = cm?.state.vim?.status ?? "";
      if (event.key === "y" || status.includes("y")) yankPending = true;
      queueMicrotask(() => syncVimState(view));
    };
    view.contentDOM.addEventListener("focus", onFocus);
    view.contentDOM.addEventListener("blur", onBlur);
    view.dom.addEventListener("keydown", onKeyDown, true);
    if (cm) Vim.handleKey(cm, "i", "user");
    view.focus();
    syncVimState(view);

    const onPageKeyDown = (event: KeyboardEvent) => {
      if (focusedRef.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (event.key === "i" || event.key === "Enter") {
        event.preventDefault();
        view.focus();
        if (event.key === "i" && vimMode(view) === "normal") Vim.handleKey(cm!, "i", "user");
        syncVimState(view);
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        document.querySelector(".transcript")?.scrollBy({ top: event.key === "j" ? 96 : -96, behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", onPageKeyDown);
    return () => {
      document.removeEventListener("keydown", onPageKeyDown);
      view.dom.removeEventListener("keydown", onKeyDown, true);
      cm?.off("vim-command-done", commandDone);
      view.destroy();
      viewRef.current = null;
    };
  }, [defaultValue, id, label, placeholder, submit]);

  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";
  useLayoutEffect(() => {
    if (!running) setError((current) => current?.kind === "stop" ? undefined : current);
  }, [running]);
  const canSubmit = draft.trim() !== "" && !sending && state !== "running";
  const message = error?.text ?? (stopping ? "stopping" : sending ? (steer ? "steering" : "sending") : "");
  const hint = mode === "insert"
    ? "esc normal · enter send · shift+enter new line"
    : mode === "visual"
      ? "d delete · y yank · c change · esc normal"
      : focused ? "i insert · v visual · enter send · esc leave" : "i focus · j/k scroll chat · ? shortcuts";
  const modeLabel = mode.toUpperCase();

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    viewRef.current?.focus();
    submit();
  };
  return (
    <form
      className={["vim-composer", className].filter(Boolean).join(" ")}
      data-part="composer"
      data-state={state}
      data-mode={mode}
      data-focused={focused || undefined}
      data-error={error?.kind}
      data-pending={sending ? "submit" : stopping ? "stop" : undefined}
      aria-label={label}
      aria-busy={sending || stopping || undefined}
      onSubmit={onFormSubmit}
    >
      <div data-part="composer-field" data-empty={!draft || undefined} ref={host} />
      <div data-part="composer-bar">
        <span className="vim-mode-chip" data-mode={mode}>{modeLabel}</span>
        <p data-part="composer-status" data-tone={error ? "danger" : message ? "busy" : undefined} title={error?.text}>
          <span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint}</span>
          <span data-part="composer-message" id={`${id}-message`} role="status">{message}</span>
        </p>
        <span className="vim-pending" aria-hidden="true">{mode === "visual" && selectionLength ? `${selectionLength} chars` : pending}</span>
        {running && onStop ? (
          <button ref={stopRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={stopping || undefined} onClick={stop}>
            {stopping ? "stopping" : "stop"}
          </button>
        ) : null}
        <button type="submit" data-part="composer-submit" data-action={steer ? "steer" : "send"} aria-label={steer ? "steer the running turn" : "send message"} aria-disabled={!canSubmit || undefined}>
          {steer ? "steer" : "send"}
        </button>
      </div>
    </form>
  );
}
