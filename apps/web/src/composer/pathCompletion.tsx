import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { PathCompletionEntry, PathCompletionResult } from "@fulcrum/zeta";
import "./path-completion.css";

/** Asks zeta for completions of the `@` path token that ends `textBeforeCursor`, in the chat's working directory. */
export type CompletePaths = (textBeforeCursor: string, signal: AbortSignal) => Promise<PathCompletionResult>;

export const PATH_DEBOUNCE_MS = 120;

// zeta's own token rule (core/commands/path_completion.py _PATH_TOKEN_RE): an `@` at a word start, then a quoted or
// bare path up to the cursor. Returns where the path text starts, which is where a completion replaces from.
export function pathTokenStart(before: string): number | null {
  const match = /(?<!\S)@(?:"([^"\n]*)|(\S*))$/.exec(before);
  return match ? match.index + 1 + (match[1] === undefined ? 0 : 1) : null;
}

type List = { before: string; entries: readonly PathCompletionEntry[]; truncated: boolean; active: number };

/** Path completion for a textarea: debounced requests, stale replies dropped, keyboard choice, and insertion.
 * `insert` gets the new value and caret; the caller writes them to the field. */
export function usePathCompletion(complete: CompletePaths | undefined, insert: (value: string, caret: number) => void) {
  const id = useId();
  const [list, setList] = useState<List | null>(null);
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; abort?: AbortController }>({});
  const last = useRef<string | null>(null);
  // the text before the cursor when the user closed the list or took a file: no list again until it changes
  const dismissed = useRef<string | null>(null);
  const stop = () => {
    clearTimeout(pending.current.timer);
    pending.current.abort?.abort();
    pending.current = {};
  };
  const close = () => { stop(); last.current = null; setList(null); };
  useEffect(() => close, [complete]);

  const update = (before: string | null) => {
    if (before === last.current) return;
    last.current = before;
    stop();
    if (before !== dismissed.current) dismissed.current = null;
    const from = before === null || dismissed.current !== null ? null : pathTokenStart(before);
    if (!complete || before === null || from === null) { setList(null); return; }
    // the shown list stays while the same token is edited, so it does not blink on every key
    setList((shown) => (shown && pathTokenStart(shown.before) === from ? shown : null));
    const abort = new AbortController();
    pending.current = {
      abort,
      timer: setTimeout(() => {
        complete(before, abort.signal).then(
          (result) => {
            if (abort.signal.aborted) return; // a newer edit asked again: this reply is stale
            setList(result.kind === "entries" && result.entries.length ? { before, entries: result.entries, truncated: result.truncated, active: 0 } : null);
          },
          () => { if (!abort.signal.aborted) setList(null); },
        );
      }, PATH_DEBOUNCE_MS),
    };
  };

  const caretText = (field: HTMLTextAreaElement) => (field.selectionStart === field.selectionEnd ? field.value.slice(0, field.selectionStart) : null);

  const choose = (field: HTMLTextAreaElement, index: number) => {
    const entry = list?.entries[index];
    if (!list || !entry) return;
    const cursor = field.selectionStart;
    const start = list.before.length + entry.startPosition;
    // the list may be one reply behind the field; it still applies while the caret ends the same token
    if (field.selectionEnd !== cursor || pathTokenStart(field.value.slice(0, cursor)) !== start) { close(); return; }
    const value = field.value.slice(0, start) + entry.text + field.value.slice(cursor);
    const caret = start + entry.text.length;
    insert(value, caret);
    // a directory lists its children next; a file is done
    if (entry.kind === "file") { dismissed.current = value.slice(0, caret); close(); } else update(value.slice(0, caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!list || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
    const count = list.entries.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setList({ ...list, active: (list.active + step + count) % count });
    } else if (event.key === "Escape") {
      dismissed.current = caretText(event.currentTarget);
      close();
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      choose(event.currentTarget, list.active);
    } else return false;
    event.preventDefault();
    event.stopPropagation(); // an open list owns these keys, not the page's escape or the send
    return true;
  };

  const listId = `${id}-paths`;
  const optionId = (index: number) => `${id}-path-${index}`;
  return {
    open: Boolean(list),
    /** spread on the textarea */
    fieldProps: complete ? {
      "aria-autocomplete": "list" as const,
      "aria-controls": list ? listId : undefined,
      "aria-activedescendant": list ? optionId(list.active) : undefined,
    } : {},
    /** call after every edit and caret move */
    sync: (field: HTMLTextAreaElement) => update(caretText(field)),
    onKeyDown,
    close,
    list: (field: () => HTMLTextAreaElement | null) => list && (
      <div className="composer-paths" data-part="composer-paths">
        <ul id={listId} role="listbox" aria-label="path completions">
          {list.entries.map((entry, index) => (
            <li
              key={entry.text}
              id={optionId(index)}
              role="option"
              aria-selected={index === list.active}
              data-kind={entry.kind}
              // keep focus and caret in the field
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { const element = field(); if (element) choose(element, index); }}
            >
              {entry.display}
            </li>
          ))}
        </ul>
        {list.truncated && <p data-part="composer-paths-more">more paths match. type more to narrow.</p>}
      </div>
    ),
  };
}
