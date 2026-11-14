import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { isEditableTarget } from "../keyboard";
import { enterAction, type ComposerModel } from "./composer-machine";
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
  const focusedRef = useRef(true);
  const editable = useRef(new Compartment()).current;
  const { model, edit, submit, stop } = useComposerDelivery(props);
  const modelRef = useRef<ComposerModel>(model);
  const submitRef = useRef(submit);
  modelRef.current = model;
  submitRef.current = submit;
  const [mode, setMode] = useState<Mode>("insert");
  const [focused, setFocused] = useState(true);
  const [pending, setPending] = useState("");
  const [selectionLength, setSelectionLength] = useState(0);

  const replaceText = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: next.length } });
  }, []);
  useLayoutEffect(() => { replaceText(model.draft); }, [model.draft, replaceText]);
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
        doc: defaultValue,
        extensions: [
          vim(), drawSelection(), EditorView.lineWrapping, editable.of(EditorView.editable.of(state !== "read-only")),
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
      const ctrlRedo = event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "r";
      const allowed = ctrlRedo || event.key === "Tab" || event.key === "Escape" || /^[0-9ghjklwbeiaIoOAxdcypuvVG$]$/.test(event.key);
      if (!allowed) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); return; }
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
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (event.key === "i" || event.key === "Enter") {
        event.preventDefault(); view.focus();
        if (event.key === "i" && vimMode(view) === "normal") Vim.handleKey(cm!, "i", "user");
        syncVimState(view);
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault(); document.querySelector(".transcript")?.scrollBy({ top: event.key === "j" ? 96 : -96, behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", onPageKeyDown);
    return () => {
      document.removeEventListener("keydown", onPageKeyDown);
      host.current?.removeEventListener("keydown", onKeyDown, true);
      cm?.off("vim-command-done", commandDone);
      view.destroy(); viewRef.current = null;
    };
  }, [defaultValue, edit, editable, id, label, placeholder]);

  const running = state === "running" || state === "steerable";
  const steer = state === "steerable";
  const canSubmit = model.draft.trim() !== "" && !model.sending && state !== "running" && state !== "read-only";
  const message = model.error?.text ?? (model.stopping ? "stopping" : model.sending ? (steer ? "steering" : "sending") : "");
  const hint = mode === "insert" ? "esc normal · enter send · shift+enter new line" : mode === "visual" ? "d delete · y yank · c change · esc normal" : focused ? "i insert · v visual · enter send · esc leave" : "i focus · j/k scroll chat · ? shortcuts";
  const onFormSubmit = (event: FormEvent) => { event.preventDefault(); viewRef.current?.focus(); submit(); };
  const stopButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { if (document.activeElement === button) viewRef.current?.focus(); };
  }, []);

  return <form className={["vim-composer", className].filter(Boolean).join(" ")} data-part="composer" data-state={state} data-mode={mode} data-focused={focused || undefined} data-error={model.error?.kind} data-pending={model.sending ? "submit" : model.stopping ? "stop" : undefined} aria-label={label} aria-busy={model.sending || model.stopping || undefined} onSubmit={onFormSubmit}>
    <div data-part="composer-field" data-empty={!model.draft || undefined} data-value={model.draft} ref={host} />
    {state === "read-only" ? <p data-part="composer-reason">{reason}</p> : <div data-part="composer-bar">
      <span className="vim-mode-chip" data-mode={mode} id={`${id}-mode`} aria-live="polite">{mode.toUpperCase()}</span>
      <p data-part="composer-status" data-tone={model.error ? "danger" : message ? "busy" : undefined} title={model.error?.text}>
        <span data-part="composer-hint" id={`${id}-hint`} hidden={Boolean(message)}>{hint}</span>
        <span data-part="composer-message" id={`${id}-message`} role="status">{message}</span>
      </p>
      <span className="vim-pending" aria-hidden="true">{mode === "visual" && selectionLength ? `${selectionLength} chars` : pending}</span>
      {running && onStop ? <button ref={stopButtonRef} type="button" data-part="composer-stop" data-action="stop" aria-label="stop the running turn" aria-disabled={model.stopping || undefined} onClick={stop}>{model.stopping ? "stopping" : "stop"}</button> : null}
      <button type="submit" data-part="composer-submit" data-action={steer ? "steer" : "send"} aria-label={steer ? "steer the running turn" : "send message"} aria-disabled={!canSubmit || undefined}>{steer ? "steer" : "send"}</button>
    </div>}
  </form>;
}
