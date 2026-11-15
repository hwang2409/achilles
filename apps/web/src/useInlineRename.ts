import { useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Click-to-edit text: enter commits, esc cancels, blur-away commits.
 * Shared by the chat header title and the sidebar row rename action.
 */
export function useInlineRename() {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const start = (initial: string) => { cancelled.current = false; setDraft(initial); };

  const bind = (onCommit: (value: string) => void) => ({
    value: draft ?? "",
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") { event.preventDefault(); const value = draft ?? ""; setDraft(null); onCommit(value); }
      else if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; event.currentTarget.blur(); }
    },
    onBlur: () => {
      const value = draft;
      setDraft(null);
      if (cancelled.current) { cancelled.current = false; return; }
      if (value !== null) onCommit(value);
    },
  });

  return { editing: draft !== null, start, bind };
}
