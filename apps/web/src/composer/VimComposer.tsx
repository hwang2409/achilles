import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { history } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { isEditableTarget } from "../keyboard";
import { composerStatus, enterAction, submitAction, type ComposerModel } from "./composer-machine";
import { QueuedMessages } from "./QueuedMessages";
import { ComposerHint } from "./hint";
import { useComposerDelivery, type ComposerAdapterProps } from "./useComposerDelivery";
import "./vim-composer.css";

type Mode = "insert" | "normal" | "visual";

function vimMode(view: EditorView): Mode {
  const state = getCM(view)?.state.vim;
  return state?.visualMode ? "visual" : state?.insertMode ? "insert" : "normal";
}

/** A CodeMirror-backed composer with the same delivery contract as Fulcrum's Composer. */
export function VimComposer(props: ComposerAdapterProps) {
  return <InteractiveVimComposer {...props} />;
}

function InteractiveVimComposer(props: ComposerAdapterProps) {
  const { state, reason, label = "message", placeholder, defaultValue = "", className, onStop } = props;
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialDefaultValue = useRef(defaultValue).current;
  const focusedRef = useRef(true);
  const editable = useRef(new Compartment()).current;
  const { model, edit, submit: submitDraft, stop, retry, restore: restoreDraft, cancel, getModel } = useComposerDelivery(props);
  // enter and edit move text out of and into the box; the editor owns its document, so follow the model here
  const followModel = () => {
    const view = viewRef.current;
    const draft = getModel().draft;
    if (view && view.state.doc.toString() !== draft) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft } });
  };
  const submit = () => { submitDraft(); followModel(); };
  const restore = (id: number) => { restoreDraft(id); followModel(); viewRef.current?.focus(); };
  const modelRef = useRef<ComposerModel>(model);
  const submitRef = useRef(submit);
  modelRef.current = model;
  submitRef.current = submit;
  const [mode, setMode] = useState<Mode>("insert");
  const [focused, setFocused] = useState(true);
  const [pending, setPending] = useState("");
  // a short note shown when a key achilles intercepts has no action (e.g. the ex line ":")
  const [note, setNote] = useState("");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [selectionLength, setSelectionLength] = useState(0);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (focusedRef.current || !view || view.state.doc.toString() === defaultValue) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: defaultValue } });
  }, [defaultValue]);
  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(state !== "read-only")) });
  }, [editable, state]);

  useLayoutEffect(() => {
    if (!host.current) return;
    let yankPending = false;
    const syncVimState = (view: EditorView) => {
      const nextMode = vimMode(view);
      const selection = view.state.selection.main;
      setMode(nextMode);
      setSelectionLength(nextMode === "visual" ? Math.abs(selection.to - selection.from) : 0);
      setPending(nextMode === "visual" ? "" : getCM(view)?.state.vim?.status ?? "");
    };
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDefaultValue,
        extensions: [
          vim(), history(), drawSelection(), EditorView.lineWrapping, editable.of(EditorView.editable.of(state !== "read-only")),
          EditorView.contentAttributes.of({ "aria-label": label, "aria-describedby": `${id}-mode ${id}-hint ${id}-message`, "data-placeholder": placeholder ?? "" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) edit(update.state.doc.toString());
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
      if (modelRef.current.state === "read-only") return;
      const modeBefore = vimMode(view);
      const action = enterAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing, keyCode: event.keyCode, mode: modeBefore });
      if (action !== "ignore") {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        if (action === "submit") submitRef.current();
        else {
          const selection = view.state.selection.main;
          view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "\n" }, selection: { anchor: selection.from + 1 } });
        }
        return;
      }
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && modeBefore === "normal") { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); view.contentDOM.blur(); return; }
      if (modeBefore === "insert") { if (event.key === "Escape") queueMicrotask(() => syncVimState(view)); return; }
      // codemirror-vim owns normal- and visual-mode keys; achilles intercepts only the ex line and cmd shortcuts, so a
      // new vim motion or operator needs no change here. (the command palette's mod+k is consumed upstream in AppShell.)
      if (event.key === ":") {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        setNote("ex commands are off in achilles");
        clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote(""), 3000);
        return;
      }
      if (event.metaKey) return; // cmd shortcuts (palette, settings, sidebar) belong to the app and browser
      if (event.key === "y" || (cm?.state.vim?.status ?? "").includes("y")) yankPending = true;
      queueMicrotask(() => syncVimState(view));
    };
    view.contentDOM.addEventListener("focus", onFocus);
    view.contentDOM.addEventListener("blur", onBlur);
    host.current.addEventListener("keydown", onKeyDown, true);
    if (cm) Vim.handleKey(cm, "i", "user");
    if (state !== "read-only") view.focus();
    syncVimState(view);

    const onPageKeyDown = (event: KeyboardEvent) => {
      if (modelRef.current.state === "read-only" || focusedRef.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event)) return;
      if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
      if (event.key === "i" || event.key === "Enter") {
        event.preventDefault(); view.focus();
        if (event.key === "i" && vimMode(view) === "normal") Vim.handleKey(cm!, "i", "user");
        syncVimState(view);
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault(); document.querySelector('[data-part="timeline-scroll"]')?.scrollBy({ top: event.key === "j" ? 96 : -96, behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", onPageKeyDown);
    return () => {
      clearTimeout(noteTimer.current);
      document.removeEventListener("keydown", onPageKeyDown);
      host.current?.removeEventListener("keydown", onKeyDown, true);
      cm?.off("vim-command-done", commandDone);
      view.destroy(); viewRef.current = null;
    };
  }, [edit, editable, id, initialDefaultValue, label, placeholder]);

  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";
  const action = submitAction(model);
  const queues = model.sending || model.queue.length > 0;
  const { text: message, tone } = composerStatus(model);
  const hint = note || undefined;
  const onFormSubmit = (event: FormEvent) => { event.preventDefault(); viewRef.current?.focus(); submit(); };
  const stopButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) viewRef.current?.focus(); };
  }, []);

  return <form className={["vim-composer", className].filter(Boolean).join(" ")} data-part="composer" data-state={state} data-mode={mode} data-focused={focused || undefined} data-error={model.error?.kind} data-pending={model.sending ? "submit" : model.stopping ? "stop" : undefined} data-queued={model.queue.length || undefined} aria-label={label} aria-busy={model.sending || model.stopping || undefined} onSubmit={onFormSubmit}>
    <QueuedMessages model={model} onRetry={(id) => { retry(id); viewRef.current?.focus(); }} onRestore={restore} onCancel={(id) => { cancel(id); viewRef.current?.focus(); }} />
    <div data-part="composer-field" data-empty={!model.draft || undefined} data-value={model.draft} ref={host} />
    {state === "read-only" ? <p data-part="composer-reason">{reason}</p> : <div data-part="composer-bar">
      <div className="vim-guidance">
        <span className="vim-mode-chip" data-mode={mode} id={`${id}-mode`} aria-live="polite">{mode.toUpperCase()}</span>
        <p data-part="composer-status" data-tone={tone} title={model.error?.text}>
          <ComposerHint id={`${id}-hint`} state={state} mode={mode} queues={queues} focused={focused} hidden={Boolean(message)} />
          <span data-part="composer-message" id={`${id}-message`} role={model.error ? "alert" : "status"}>{message}</span>
        </p>
      </div>
      <span className="vim-pending" aria-hidden="true">{mode === "visual" && selectionLength ? `${selectionLength} chars` : pending}</span>
      {running && onStop ? <button ref={stopButtonRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={model.stopping || undefined} onClick={stop}>{model.stopping ? "stopping" : "stop"}</button> : null}
      <button type="submit" data-part="composer-submit" data-action={queues ? "queue" : steer ? "steer" : "send"} aria-label={queues ? "queue message" : steer ? "steer the running turn" : "send message"} aria-disabled={!action || undefined}>{queues ? "queue" : steer ? "steer" : "send"}</button>
    </div>}
  </form>;
}
