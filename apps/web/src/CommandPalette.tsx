import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { modKey, wrapTab } from "./keyboard";
import { createListOwner, initialListState, type ListOwner, type ListPage } from "./pageList";
import { surfaceHref, surfaceRoutes } from "./surface/routes";
import "./command-palette.css";

export type PaletteEntry = { id: string; label: string; detail?: string; shortcut?: string; run: () => void };
type SearchChats = (query: string, before: string | null, signal: AbortSignal, limit?: number) => Promise<ListPage<PaletteEntry, unknown>>;

export function Highlight({ value, query }: { value: string; query: string }) {
  if (!query) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

// a modal <dialog> that is open while mounted; Escape is closed by the shell's layer stack, and Tab stays inside
function Modal({ className, label, onClose, children }: { className: string; label: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog
    ref={dialog}
    className={className}
    aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}
  >{children}</dialog>;
}

const initialChats = initialListState<PaletteEntry, unknown>(null);

export function CommandPalette({ commands, pages, searchChats, onClose }: { commands: PaletteEntry[]; pages: PaletteEntry[]; searchChats: SearchChats; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [chats, setChats] = useState(initialChats);
  const [active, setActive] = useState(0);
  const owner = useRef<ListOwner<string, PaletteEntry, unknown> | null>(null);
  const list = useRef<HTMLDivElement>(null);
  if (!owner.current) owner.current = createListOwner(initialChats, searchChats, (entry) => entry.id, setChats, 20, 200);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 150); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { void owner.current!.reload(search); }, [search]);
  useEffect(() => () => owner.current?.dispose(), []);
  useEffect(() => { setActive(0); }, [query]);

  const needle = query.trim();
  const match = (entry: PaletteEntry) => entry.label.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  const places = surfaceRoutes.map((route): PaletteEntry => ({ id: `place:${route.id}`, label: route.label, detail: route.path, run: () => location.assign(surfaceHref(route.path)) }));
  const groups: Array<[string, PaletteEntry[]]> = ([["commands", commands.filter(match)], ["places", places.filter(match)], ["pages", pages.filter(match)], ["chats", chats.items ?? []]] as Array<[string, PaletteEntry[]]>).filter(([, entries]) => entries.length);
  const entries = groups.flatMap(([, rows]) => rows);
  const current = Math.min(active, Math.max(0, entries.length - 1));
  useEffect(() => { list.current?.querySelector(`#palette-option-${current}`)?.scrollIntoView({ block: "nearest" }); }, [current]);
  const run = (entry: PaletteEntry | undefined) => { if (!entry) return; onClose(); entry.run(); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length) setActive((current + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); run(entries[current]); }
  };
  let index = 0;
  return <Modal className="command-palette" label="command palette" onClose={onClose}>
    <div className="palette-input">
      <span aria-hidden="true">&gt;</span>
      <input autoFocus aria-label="search commands, pages, and chats" placeholder="Search commands, pages, and chats" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={entries.length ? `palette-option-${current}` : undefined} autoComplete="off" spellCheck={false} />
      <kbd>esc</kbd>
    </div>
    <div ref={list} className="palette-results" id="palette-results" role="listbox" aria-label="results">
      {groups.map(([label, rows]) => <div key={label} role="group" aria-labelledby={`palette-group-${label}`}>
        <h2 id={`palette-group-${label}`}>{label}</h2>
        {rows.map((entry) => {
          const position = index++;
          return <div key={entry.id} id={`palette-option-${position}`} role="option" aria-selected={position === current} className="palette-option" onMouseMove={() => setActive(position)} onMouseDown={(event) => event.preventDefault()} onClick={() => run(entry)}>
            <span><Highlight value={entry.label} query={needle} /></span>{entry.detail && <small>{entry.detail}</small>}{entry.shortcut && <kbd className="palette-shortcut">{entry.shortcut}</kbd>}
          </div>;
        })}
      </div>)}
      {!entries.length && <p className="palette-empty">{chats.error ? "could not load chats" : chats.loading || search !== needle ? "searching…" : "no matches"}</p>}
    </div>
    <footer><span>↑↓ move · enter open · esc close</span>{chats.error && <span>chats could not load</span>}</footer>
  </Modal>;
}

const shortcuts: Array<[string, Array<[string, string]>]> = [
  ["anywhere", [[modKey("K"), "command palette"], [modKey("⇧O"), "new chat"], [modKey("B"), "collapse sidebar"], [modKey(","), "settings"], [modKey("."), "toggle create mode"]]],
  ["outside text fields", [["/", "search chats and pages"], ["?", "keyboard shortcuts"], ["F2", "rename the open chat"]]],
  ["lists", [["↑ ↓", "move"], ["enter", "open"], ["esc", "close or clear"]]],
  ["vim mode", [["esc", "INSERT to NORMAL, then leave the composer"], ["i, enter", "focus the composer"], ["j / k", "scroll the chat"]]],
];

export function ShortcutsSheet({ onClose }: { onClose(): void }) {
  return <Modal className="shortcuts-sheet" label="keyboard shortcuts" onClose={onClose}>
    <div className="sheet-title"><h2>keyboard shortcuts</h2><button type="button" autoFocus onClick={onClose}>esc</button></div>
    <div className="sheet-groups">
      {shortcuts.map(([group, keys]) => <section key={group}><h3>{group}</h3><dl>{keys.map(([key, action]) => <div key={key + action}><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl></section>)}
    </div>
  </Modal>;
}
