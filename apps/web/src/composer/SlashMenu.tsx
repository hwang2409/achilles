import { useEffect, useState, type KeyboardEvent } from "react";
import type { SlashCommandInfo } from "@fulcrum/zeta";
import { slashMatches } from "./commands";
import "./slash-menu.css";

/**
 * The "/" menu over the composer: arrows choose, tab or a click puts the command in the draft, enter runs it, escape
 * closes. Nothing runs without enter, so a command that changes the session (/compact, /model x) waits for the user.
 */
export function useSlashMenu(id: string, draft: string, commands: readonly SlashCommandInfo[] | null | undefined, edit: (draft: string) => void, submit: () => void) {
  const [active, setActive] = useState(0);
  // the draft the user put there or moved the caret in: a draft set from outside (a refusal's restore, a reload, a
  // chat switch) opens no menu, so the refusal reason under it stays visible; escape closes, typing reopens
  const [openFor, setOpenFor] = useState<string | null>(null);
  const rows = openFor === draft ? slashMatches(draft, commands ?? null) : null;
  const current = rows ? Math.min(active, rows.length - 1) : 0;
  const [seen, setSeen] = useState(draft);
  if (seen !== draft) { setSeen(draft); setActive(0); if (openFor !== draft) setOpenFor(null); }
  const put = (next: string) => { setOpenFor(next); edit(next); };
  const optionId = (index: number) => `${id}-slash-${index}`;
  const shown = rows ? optionId(current) : null;
  useEffect(() => { if (shown) document.getElementById(shown)?.scrollIntoView?.({ block: "nearest" }); }, [shown]);

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!rows || event.nativeEvent.isComposing) return false;
    const move = (step: number) => setActive((current + step + rows.length) % rows.length);
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Escape") setOpenFor(null);
    else if (event.key === "Tab" && !event.shiftKey) put(`/${rows[current]!.name} `);
    else if (event.key === "Enter" && !event.shiftKey) { edit(`/${rows[current]!.name}`); submit(); }
    else return false;
    event.preventDefault();
    return true;
  };

  const field = rows ? { "aria-controls": `${id}-slash`, "aria-expanded": true, "aria-autocomplete": "list" as const, "aria-activedescendant": optionId(current) } : {};
  const menu = rows && <div className="composer-slash-menu" id={`${id}-slash`} role="listbox" aria-label="commands">
    {rows.map((row, index) => <div key={row.name} id={optionId(index)} role="option" aria-selected={index === current} className="composer-slash-option"
      onMouseMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => put(`/${row.name} `)}>
      <span>/{row.name}</span>
      <small>{row.description}</small>
    </div>)}
  </div>;
  return {
    onKeyDown, field, menu,
    /** the user typed `value` into the field */
    typed: setOpenFor,
    /** a key release (`key`) or a pointer release (no key): a caret move means the user acts on this draft, so its
     * menu may open. enter and escape are not caret moves: an enter keyup after a fast refusal must not reopen it */
    caretMoved: (key?: string) => { if (key === undefined || /^(Arrow|Home$|End$|Page)/.test(key)) setOpenFor(draft); },
  };
}
