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
  // the draft escape closed the menu for; typing reopens it
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const rows = closedFor === draft ? null : slashMatches(draft, commands ?? null);
  const current = rows ? Math.min(active, rows.length - 1) : 0;
  const [seen, setSeen] = useState(draft);
  if (seen !== draft) { setSeen(draft); setActive(0); }
  const optionId = (index: number) => `${id}-slash-${index}`;
  const shown = rows ? optionId(current) : null;
  useEffect(() => { if (shown) document.getElementById(shown)?.scrollIntoView?.({ block: "nearest" }); }, [shown]);

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!rows || event.nativeEvent.isComposing) return false;
    const move = (step: number) => setActive((current + step + rows.length) % rows.length);
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Escape") setClosedFor(draft);
    else if (event.key === "Tab" && !event.shiftKey) edit(`/${rows[current]!.name} `);
    else if (event.key === "Enter" && !event.shiftKey) { edit(`/${rows[current]!.name}`); submit(); }
    else return false;
    event.preventDefault();
    return true;
  };

  const field = rows ? { "aria-controls": `${id}-slash`, "aria-expanded": true, "aria-autocomplete": "list" as const, "aria-activedescendant": optionId(current) } : {};
  const menu = rows && <div className="composer-slash-menu" id={`${id}-slash`} role="listbox" aria-label="commands">
    {rows.map((row, index) => <div key={row.name} id={optionId(index)} role="option" aria-selected={index === current} className="composer-slash-option"
      onMouseMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => edit(`/${row.name} `)}>
      <span>/{row.name}</span>
      <small>{row.description}</small>
    </div>)}
  </div>;
  return { onKeyDown, field, menu };
}
