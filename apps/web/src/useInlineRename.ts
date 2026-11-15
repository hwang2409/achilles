import { useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Click-to-edit text: enter commits, esc cancels, blur-away commits.
 * Shared by the chat header title and the sidebar row rename action.
 * The commit target is bound when editing starts, so a later prop change cannot redirect the draft.
 */
export function useInlineRename() {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = useRef<(value: string) => void>(() => {});

  const start = (initial: string, onCommit: (value: string) => void) => { cancelled.current = false; commit.current = onCommit; setDraft(initial); };
  const cancel = () => { cancelled.current = true; setDraft(null); };

  const bind = () => ({
    value: draft ?? "",
    autoFocus: true,
    // the shell's capture-phase escape layer skips this marker, so esc reaches the input
    "data-inline-rename": "",
    // select all so typing replaces the title, but scroll back to the start: select() alone leaves
    // a long value scrolled to the caret at the end, hiding the start of the title
    onFocus: (event: FocusEvent<HTMLInputElement>) => { const input = event.currentTarget; input.select(); input.scrollLeft = 0; },
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // the input owns its keys: list roving focus, F2, and vim page keys must not see them
      if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); const value = draft ?? ""; cancelled.current = true; setDraft(null); commit.current(value); }
      else if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; event.currentTarget.blur(); }
    },
    onBlur: () => {
      const value = draft;
      setDraft(null);
      if (cancelled.current) { cancelled.current = false; return; }
      if (value !== null) commit.current(value);
    },
  });

  return { editing: draft !== null, start, cancel, bind };
}
