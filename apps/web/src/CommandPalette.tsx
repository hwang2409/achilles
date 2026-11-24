import { useEffect, useRef, useState } from "react";
import { modKey } from "./keyboard";
import { createListOwner, initialListState, type ListOwner, type ListPage } from "./pageList";
import { surfaceHref, surfaceRoutes } from "./surface/routes";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type PaletteEntry = { id: string; label: string; detail?: string; shortcut?: string; run: () => void };
type SearchChats = (query: string, before: string | null, signal: AbortSignal, limit?: number) => Promise<ListPage<PaletteEntry, unknown>>;

export function Highlight({ value, query }: { value: string; query: string }) {
  if (!query) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

const initialChats = initialListState<PaletteEntry, string | null>(null);

export function CommandPalette({ commands, pages, searchChats, open, onClose, restoreFocus }: { commands: PaletteEntry[]; pages: PaletteEntry[]; searchChats: SearchChats; open: boolean; onClose(): void; restoreFocus(): void }) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const [search, setSearch] = useState("");
  const [chats, setChats] = useState(initialChats);
  const owner = useRef<ListOwner<string, PaletteEntry, string | null> | null>(null);
  if (!owner.current) owner.current = createListOwner(initialChats, async (key, before, signal, limit) => ({ ...await searchChats(key, before, signal, limit), meta: key }), (entry) => entry.id, setChats, 20, 200);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 150); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { void owner.current!.reload(search); }, [search]);
  useEffect(() => () => owner.current?.dispose(), []);

  const needle = query.trim();
  const match = (entry: PaletteEntry) => entry.label.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  const places = surfaceRoutes.map((route): PaletteEntry => ({ id: `place:${route.id}`, label: route.label, detail: route.path, run: () => location.assign(surfaceHref(route.path)) }));
  const groups: Array<[string, PaletteEntry[]]> = ([["commands", commands.filter(match)], ["places", places.filter(match)], ["pages", pages.filter(match)], ["chats", chats.meta === needle ? chats.items ?? [] : []]] as Array<[string, PaletteEntry[]]>).filter(([, entries]) => entries.length);
  const rows = groups.flatMap(([, entries]) => entries);
  const active = rows.some((entry) => entry.id === highlighted) ? highlighted : rows[0]?.id ?? "";
  return <CommandDialog contentProps={{ "data-shell-overlay": "palette" }} value={active} onValueChange={setHighlighted} open={open} onOpenChange={(open) => { if (!open) onClose(); }} title="command palette" showCloseButton={false}
    className="top-[min(24vh,12rem)] translate-y-0 rounded-none max-sm:max-w-none" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
    <CommandInput aria-label="search commands, pages, and chats" placeholder="Search commands, pages, and chats" value={query} onValueChange={(value) => { setHighlighted(""); setQuery(value); }} autoComplete="off" spellCheck={false} />
    <CommandList label="results">
      {groups.map(([label, rows]) => <CommandGroup key={label} heading={label}>
        {rows.map((entry) => <CommandItem key={entry.id} value={entry.id} onSelect={() => {
          entry.run();
          onClose();
        }}>
          <span><Highlight value={entry.label} query={needle} /></span>
          {entry.detail && <small className="text-muted-foreground">{entry.detail}</small>}
          {entry.shortcut && <kbd className="ml-auto text-xs text-muted-foreground">{entry.shortcut}</kbd>}
        </CommandItem>)}
      </CommandGroup>)}
      {!groups.length && <p className="p-6 text-center text-sm text-muted-foreground">{chats.error ? "could not load chats" : chats.loading || search !== needle ? "searching…" : "no matches"}</p>}
    </CommandList>
    <footer className="flex justify-between border-t p-3 text-xs text-muted-foreground"><span>↑↓ move · enter open · esc close</span>{chats.error && <span>chats could not load</span>}</footer>
  </CommandDialog>;
}

const shortcuts: Array<[string, Array<[string, string]>]> = [
  ["anywhere", [[modKey("K"), "command palette"], [modKey("⇧O"), "new chat"], [modKey("B"), "collapse sidebar"], [modKey(","), "settings"], [modKey("."), "toggle create mode"]]],
  ["outside text fields", [["/", "search chats and pages"], ["?", "keyboard shortcuts"], ["F2", "rename the open chat"]]],
  ["lists", [["↑ ↓", "move"], ["enter", "open"], ["esc", "close or clear"]]],
  ["vim mode", [["esc", "INSERT to NORMAL, then leave the composer"], ["i, enter", "focus the composer"], ["j / k", "scroll the chat"]]],
];

export function ShortcutsSheet({ open, onClose, restoreFocus }: { open: boolean; onClose(): void; restoreFocus(): void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  return <Dialog open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-shell-overlay="shortcuts" showCloseButton={false} aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); closeButton.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} className="max-h-[90dvh] overflow-auto rounded-none">
      <div className="flex items-center justify-between gap-3"><DialogTitle>keyboard shortcuts</DialogTitle><Button ref={closeButton} type="button" size="sm" variant="outline" onClick={onClose}>esc</Button></div>
      <div className="grid gap-4 sm:grid-cols-2">
        {shortcuts.map(([group, keys]) => <section key={group} className="border-t pt-2"><h3 className="mb-1 text-sm font-semibold">{group}</h3><dl className="grid gap-1 text-sm">{keys.map(([key, action]) => <div key={key + action} className="grid grid-cols-[5.5rem_1fr] gap-2"><dt><kbd>{key}</kbd></dt><dd>{action}</dd></div>)}</dl></section>)}
      </div>
    </DialogContent>
  </Dialog>;
}
