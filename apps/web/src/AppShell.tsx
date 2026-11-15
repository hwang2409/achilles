import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CommandPalette, Highlight, ShortcutsSheet, type PaletteEntry } from "./CommandPalette";
import { SettingsControl, SettingsDialog } from "./SettingsDialog";
import { updateSettings, useSettings } from "./settings";
import { firstFocusable, isEditableTarget, isMac, modKey, restorableFocus, wrapTab } from "./keyboard";
import { createListOwner, initialListState, type ListOwner, type ListState } from "./pageList";
import { useInlineRename } from "./useInlineRename";

export type PageLink = { id: string; route: string; title: string };

export type Chat = {
  session_id: string;
  page_id: string;
  page_route: string;
  page_title: string;
  title: string | null;
  first_title?: string | null;
  message_sent?: boolean;
  created_at: string;
  updated_at: string;
  last_state: "idle" | "running" | "approval" | "failed" | null;
  titled_by_user?: boolean;
};

type Props = {
  page: PageLink | null;
  sessionId: string | null;
  waiting: number;
  serverForcesAsk?: boolean;
  hasComposer: boolean;
  children: ReactNode;
  onNewChat: () => Promise<void>;
  onToggleCreateMode: () => Promise<void>;
  onSelectChat: (chat: Chat) => void;
  onRenameChat: (chat: Chat, title: string) => void;
  refreshKey: number;
  pageRefreshKey: number;
};

const pageHref = (route: string) => {
  const url = new URL(route === "/" ? "/" : route, location.href);
  url.search = location.search;
  url.searchParams.delete("chat");
  return `${url.pathname}${url.search}`;
};
const chatHref = (chat: Chat) => {
  const url = new URL(pageHref(chat.page_route), location.href);
  url.searchParams.set("chat", chat.session_id);
  return `${url.pathname}${url.search}`;
};
// a sent chat with no title (an older row) is "untitled"; "new chat" means nothing was sent yet
export const titleOf = (chat: Pick<Chat, "title" | "first_title" | "message_sent">) => chat.title?.trim() || chat.first_title?.trim() || (chat.message_sent ? "untitled chat" : "new chat");
function useFocusAfterCommit() {
  const pending = useRef<(() => HTMLElement | null) | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    pending.current = null;
    target?.()?.focus();
  });
  const [, commit] = useState(0);
  return (target: () => HTMLElement | null) => {
    pending.current = target;
    commit((value) => value + 1);
  };
}

function groupLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = Math.floor((start - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (day <= 0) return "today";
  if (day === 1) return "yesterday";
  if (day < 7) return "this week";
  return date.toLocaleDateString(undefined, { month: "long", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" }).toLowerCase();
}

function timeLabel(value: string) {
  const date = new Date(value);
  const group = groupLabel(value);
  return group === "today" ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : group === "yesterday" || group === "this week" ? date.toLocaleDateString([], { weekday: "short" }) : date.toLocaleDateString([], { month: "short", day: "numeric" }).toLowerCase();
}

// the one GET /api/chats loader: the sidebar list and the palette each own a list over it
const chatPage = (include: () => string | null) => async (search: string, before: string | null, signal: AbortSignal, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) });
  // the server lists only chats with a sent message, plus the open chat named here
  const open = include();
  if (open) params.set("include", open);
  if (search) params.set("q", search);
  if (before) params.set("before", before);
  const response = await fetch(`/api/chats?${params}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`could not load chats (${response.status})`);
  const result = await response.json() as { chats: Chat[]; next: string | null; approval_count: number };
  return { items: result.chats, next: result.next, meta: result.approval_count };
};

const initialPageListState = initialListState<PageLink, null>(null);
const initialChatListState = initialListState<Chat, number>(0);
const listStatus = <T, M>(state: ListState<T, M>) => state.error ? "error" : state.loading || state.items === null ? "loading" : "ready";

export function AppShell({ page, sessionId, waiting, serverForcesAsk = false, hasComposer, children, onNewChat, onToggleCreateMode, onSelectChat, onRenameChat, refreshKey, pageRefreshKey }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [chatList, setChatList] = useState(initialChatListState);
  const [pageList, setPageList] = useState(initialPageListState);
  const [activeResult, setActiveResult] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const settings = useSettings();
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 760px)").matches);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const chatListElement = useRef<HTMLElement>(null);
  const settingsOpener = useRef<Element>(null);
  const paletteOpener = useRef<Element | null>(null);
  const shortcutsOpener = useRef<Element | null>(null);
  const requestFocus = useFocusAfterCommit();
  const pageListOwner = useRef<ListOwner<null, PageLink, null> | null>(null);
  const chatListOwner = useRef<ListOwner<string, Chat, number> | null>(null);
  const openChat = useRef(sessionId);
  openChat.current = sessionId;
  if (!pageListOwner.current) {
    pageListOwner.current = createListOwner(initialPageListState, async (_key, before, signal, limit = 20) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before) params.set("before", before);
      const response = await fetch(`/api/pages?${params}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(`could not load pages (${response.status})`);
      const result = await response.json() as { pages: PageLink[]; next: string | null };
      return { items: result.pages, next: result.next, meta: null };
    }, (item) => item.id, setPageList, 20, 200);
  }
  if (!chatListOwner.current) {
    chatListOwner.current = createListOwner(initialChatListState, chatPage(() => openChat.current), (item) => item.session_id, setChatList, 50, 200);
  }
  const chats = chatList.items ?? [];
  const loading = chatList.items === null && !chatList.error;
  const closeDrawer = () => { requestFocus(() => restorableFocus(menuButton.current)); setDrawer(false); };
  const openSettings = (opener: Element | null) => {
    setSettingsOpen((open) => {
      if (!open) settingsOpener.current = opener;
      return true;
    });
  };
  const focusBack = (opener: { current: Element | null }) => requestFocus(() => {
    const target = restorableFocus(
      opener.current,
      drawer ? firstFocusable(sidebar.current) : null,
      document.querySelector(".main-pane textarea[aria-label='message']"),
      document.querySelector(".settings-button"),
    );
    opener.current = null;
    return target;
  });
  const closeSettings = () => {
    if (!settingsOpen) return;
    focusBack(settingsOpener);
    setSettingsOpen(false);
  };
  const activeElement = () => document.activeElement instanceof Element ? document.activeElement : null;
  const openPalette = () => { if (!paletteOpen) paletteOpener.current = activeElement(); setPaletteOpen(true); };
  const closePalette = () => { focusBack(paletteOpener); setPaletteOpen(false); };
  const openShortcuts = (opener: Element | null) => { if (!shortcutsOpen) shortcutsOpener.current = opener; setShortcutsOpen(true); };
  const closeShortcuts = () => { focusBack(shortcutsOpener); setShortcutsOpen(false); };

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setActiveResult(0); }, [search]);
  useEffect(() => { const media = matchMedia("(max-width: 760px)"); const changed = () => setNarrow(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  useEffect(() => { if (!narrow) setDrawer(false); }, [narrow]);
  useEffect(() => { void pageListOwner.current!.reload(null); }, [pageRefreshKey]);
  useEffect(() => { void chatListOwner.current!.reload(search); }, [refreshKey, search]);
  useEffect(() => () => {
    pageListOwner.current?.dispose();
    chatListOwner.current?.dispose();
  }, []);
  useEffect(() => {
    const layers: Array<() => void> = [];
    if (query) layers.push(() => { setQuery(""); setSearch(""); setActiveResult(0); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); });
    if (drawer) layers.push(closeDrawer);
    if (settingsOpen) layers.push(closeSettings);
    if (shortcutsOpen) layers.push(closeShortcuts);
    if (paletteOpen) layers.push(closePalette);
    const top = layers.at(-1);
    if (!top) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-inline-rename]"))) return;
      event.preventDefault();
      event.stopPropagation();
      top();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [drawer, query, settingsOpen, shortcutsOpen, paletteOpen]);
  useEffect(() => {
    if (!narrow || !drawer) return;
    const key = (event: KeyboardEvent) => {
      if (sidebar.current?.contains(document.activeElement)) wrapTab(event, sidebar.current);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [drawer, narrow]);
  useEffect(() => {
    // capture on window runs before the composer (CodeMirror vim too) sees the key, so it only opens the palette
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      event.stopPropagation();
      if (paletteOpen) closePalette(); else openPalette();
    };
    addEventListener("keydown", key, true); return () => removeEventListener("keydown", key, true);
  }, [paletteOpen, drawer]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); if (!narrow) setCollapsed((value) => !value); }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") { event.preventDefault(); openSettings(document.activeElement instanceof Element ? document.activeElement : null); }
      if (!loading && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); void onNewChat(); }
      if (!loading && (event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); void onToggleCreateMode(); }
      if (isEditableTarget(event)) return;
      if (event.key === "/") { event.preventDefault(); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); }
      if (event.key === "?" && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openShortcuts(activeElement()); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [loading, narrow, onNewChat, onToggleCreateMode, settingsOpen, shortcutsOpen]);

  const pageRows = pageList.items ?? [];
  const waitingTotal = Math.max(waiting, chatList.meta);
  const groups = useMemo(() => {
    const values = new Map<string, Chat[]>();
    for (const chat of chats ?? []) { const group = groupLabel(chat.updated_at); values.set(group, [...(values.get(group) ?? []), chat]); }
    return [...values];
  }, [chats]);
  const select = (chat: Chat) => { setDrawer(false); onSelectChat(chat); };
  const commands: PaletteEntry[] = [
    ...loading ? [] : [{ id: "new-chat", label: "new chat", detail: modKey("⇧O"), run: () => { setDrawer(false); void onNewChat(); } }],
    ...loading || !page ? [] : [{ id: "create-mode", label: "toggle create mode", detail: modKey("."), run: () => void onToggleCreateMode() }],
    { id: "settings", label: "settings", detail: modKey(","), run: () => openSettings(paletteOpener.current) },
    { id: "vim", label: "toggle vim mode", detail: settings.vim ? "on" : "off", run: () => updateSettings({ vim: !settings.vim }) },
    { id: "shortcuts", label: "keyboard shortcuts", detail: "?", run: () => openShortcuts(paletteOpener.current) },
  ];
  // shortcut: pages filter only the loaded pages (the first 20 and any the sidebar paged in); add server search to /api/pages when lists grow.
  const pageEntries = pageRows.map((item): PaletteEntry => ({ id: `page:${item.id}`, label: item.title, detail: item.route, run: () => location.assign(pageHref(item.route)) }));
  const searchChats = (search: string, before: string | null, signal: AbortSignal, limit = 20) => chatPage(() => null)(search, before, signal, limit)
    .then((result) => ({ ...result, items: result.items.map((chat): PaletteEntry => ({ id: chat.session_id, label: titleOf(chat), detail: `${chat.page_title} · ${timeLabel(chat.updated_at)}`, run: () => select(chat) })) }));
  // a keyboard (F2) rename hands focus back to its row: once the editor closes, and again after the
  // list refresh moves the row; it lets go as soon as focus lands anywhere else.
  const renamedRow = useRef<string | null>(null);
  const returnRowFocus = () => {
    const id = renamedRow.current;
    const row = id && document.activeElement === document.body ? document.querySelector<HTMLElement>(`a[data-chat-id="${CSS.escape(id)}"]`) : null;
    row?.focus();
    return row;
  };
  const startKeyboardRename = (id: string) => { renamedRow.current = id; };
  useEffect(() => { if (returnRowFocus()) renamedRow.current = null; }, [chats]);
  useEffect(() => {
    const release = (event: FocusEvent) => {
      if (renamedRow.current && (event.target as Element).closest?.("[data-chat-id]")?.getAttribute("data-chat-id") !== renamedRow.current) renamedRow.current = null;
    };
    addEventListener("focusin", release);
    return () => removeEventListener("focusin", release);
  }, []);
  const chatListKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".chat-row")];
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    let next = current;
    switch (event.key) {
      case "Home": next = 0; break;
      case "End": next = rows.length - 1; break;
      case "ArrowDown": next = current < 0 ? 0 : current + 1; break;
      case "ArrowUp": next = current < 0 ? rows.length - 1 : current - 1; break;
    }
    if (next >= 0 && next < rows.length) rows[next].focus();
  };
  const searchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!search || !chats?.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveResult((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + chats.length) % chats.length); }
    if (event.key === "Enter") { event.preventDefault(); select(chats[activeResult] ?? chats[0]); }
  };
  const loadOlder = async (initiator: HTMLButtonElement) => {
    const firstPage = await pageListOwner.current!.more();
    if (firstPage) requestFocus(() => document.activeElement === initiator || (!initiator.isConnected && document.activeElement === document.body)
      ? document.querySelector<HTMLAnchorElement>(`[data-page-id="${CSS.escape(firstPage.id)}"]`)
      : null);
  };
  const loadOlderChats = async (initiator: HTMLButtonElement) => {
    const firstChat = await chatListOwner.current!.more();
    if (firstChat) requestFocus(() => {
      if (document.activeElement !== initiator && !(!initiator.isConnected && document.activeElement === document.body)) return null;
      const row = document.querySelector<HTMLAnchorElement>(`[data-chat-id="${CSS.escape(firstChat.session_id)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      return row;
    });
  };

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""} ${loading ? "shell-loading" : ""}`}>
    <a className="skip-link" href="#message-composer" inert={narrow && drawer ? true : undefined} onClick={(event) => { event.preventDefault(); const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]'); if (composer) composer.focus(); else document.querySelector<HTMLElement>(".main-pane")?.focus(); }}>{hasComposer ? "skip to message" : "skip to main content"}</a>
    <button className="drawer-scrim" aria-label="close menu" hidden={!drawer} tabIndex={-1} onClick={closeDrawer} />
    <aside ref={sidebar} className="sidebar" aria-label="sidebar" aria-hidden={narrow && !drawer ? "true" : undefined} inert={narrow && !drawer ? true : undefined}>
      <div className="brand-row"><span className="brand-mark" /><strong>achilles</strong><span>v3.2</span>{!narrow && <button aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>◧</button>}</div>
      <button className="new-chat" onClick={() => { setDrawer(false); void onNewChat(); }}><span>+</span><b>new chat</b><kbd>⌘⇧O</kbd></button>
      {loading ? <div className="search-skeleton" aria-label="loading search" /> : <label className="chat-search"><span>⌕</span><input aria-label="search chats and pages" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKey} placeholder="search chats and pages" role="combobox" aria-expanded={Boolean(search)} aria-controls="chat-search-results" aria-activedescendant={search && chats.length ? `chat-result-${activeResult}` : undefined} /><kbd>/</kbd></label>}
      {waitingTotal > 0 && <div className="waiting-count" aria-label={`${waitingTotal} waiting approvals`}>{waitingTotal}</div>}
      <section className={`page-list ${pagesOpen && pageRows.length >= 3 ? "has-pages" : ""}`} data-list-state={listStatus(pageList)} data-loaded-count={pageRows.length}>
        <button className="list-head" onClick={() => setPagesOpen((value) => !value)}><span>{pagesOpen ? "▾" : "▸"} pages</span><b>{pageList.error ? "!" : pageList.items === null ? "" : pageList.next ? "20+" : pageRows.length}</b></button>
        <div className="page-list-scroll">
          {pageList.error ? <div className="page-list-error"><span>could not load pages</span><button onClick={() => void pageListOwner.current!.reload(null)}>retry</button></div> : pageList.items === null ? <SidebarSkeleton count={2} /> : pagesOpen && <>{pageRows.map((item) => <a key={item.id} data-page-id={item.id} href={pageHref(item.route)} title={item.title} aria-label={item.title}><span>/</span><b>{item.title}</b></a>)}{pageList.next && <button className="load-older" onClick={(event) => void loadOlder(event.currentTarget)}>show more pages</button>}</>}
        </div>
      </section>
      <section ref={chatListElement} className="chat-list" id="chat-search-results" tabIndex={0} aria-label="chat list" data-list-state={listStatus(chatList)} data-loaded-count={chats.length} onKeyDown={chatListKey}>
        <div className="list-head"><span>chats</span><b>{chatList.items === null ? "" : chats.length}</b></div>
        {chatList.error ? <div className="page-list-error"><span>could not load chats</span><button onClick={() => void chatListOwner.current!.reload(search)}>retry</button></div> : chatList.items === null ? <SidebarSkeleton /> : search ? <div className="chat-group"><h2>{chats.length} results</h2>{chats.map((chat, index) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={index === activeResult} index={index} query={search} onSelect={select} onRename={onRenameChat} onKeyboardRename={startKeyboardRename} onRenameEnd={returnRowFocus} />)}</div> : groups.map(([label, rows]) => <div className="chat-group" key={label}><h2>{label}</h2>{rows.map((chat) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={false} query="" onSelect={select} onRename={onRenameChat} onKeyboardRename={startKeyboardRename} onRenameEnd={returnRowFocus} />)}</div>)}
        {chatList.next && <button className="load-older" onClick={(event) => void loadOlderChats(event.currentTarget)}>load 50 older</button>}
      </section>
      <footer><SettingsControl onOpen={openSettings} className="settings-button" /><button type="button" className="palette-button" aria-label="command palette" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openPalette}><kbd>{modKey("K")}</kbd></button></footer>
    </aside>
    <main className="main-pane" tabIndex={-1} aria-hidden={narrow && drawer ? "true" : undefined} inert={narrow && drawer ? true : undefined}>
      <button ref={menuButton} className="menu-button" aria-label="open menu" onClick={() => { requestFocus(() => firstFocusable(sidebar.current)); setDrawer(true); }}>☰</button>
      {children}
    </main>
    <SettingsDialog open={settingsOpen} onClose={closeSettings} serverForcesAsk={serverForcesAsk} />
    {shortcutsOpen && <ShortcutsSheet onClose={closeShortcuts} />}
    {paletteOpen && <CommandPalette commands={commands} pages={pageEntries} searchChats={searchChats} onClose={closePalette} />}
  </div>;
}

function ChatRow({ chat, current, active, index, query, onSelect, onRename, onKeyboardRename, onRenameEnd }: { chat: Chat; current: boolean; active: boolean; index?: number; query: string; onSelect: (chat: Chat) => void; onRename: (chat: Chat, title: string) => void; onKeyboardRename: (id: string) => void; onRenameEnd: () => void }) {
  const rename = useInlineRename();
  const rowId = index === undefined ? undefined : `chat-result-${index}`;
  useEffect(() => { if (!rename.editing) onRenameEnd(); }, [rename.editing]);
  const rowClass = `chat-row state-${chat.last_state ?? "idle"} ${current ? "current" : ""} ${active ? "active-result" : ""}`;
  if (rename.editing) {
    return <div id={rowId} data-chat-id={chat.session_id} className={rowClass}>
      <input className="chat-row-edit" aria-label={`rename ${titleOf(chat)}`} {...rename.bind()} />
    </div>;
  }
  const startRename = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    rename.start(chat.title?.trim() || chat.first_title?.trim() || "", (value) => onRename(chat, value));
  };
  // F2 is the keyboard path to rename a row; the pencil is a pointer shortcut only
  return <a tabIndex={-1} id={rowId} data-chat-id={chat.session_id} className={rowClass} href={chatHref(chat)} onClick={(event) => { event.preventDefault(); onSelect(chat); }} onKeyDown={(event) => { if (event.key === "F2") { onKeyboardRename(chat.session_id); startRename(event); } }} aria-keyshortcuts="F2" aria-current={current ? "page" : undefined}>
    <strong title={titleOf(chat)}><Highlight value={titleOf(chat)} query={query} /></strong>
    <span><span className="chat-row-meta" title={chat.page_title}>{chat.last_state === "approval" && <>needs approval · </>}{chat.last_state === "failed" && <>failed · </>}{chat.page_title}</span> <i>{timeLabel(chat.updated_at)}</i></span>
    <button type="button" tabIndex={-1} aria-hidden="true" className="chat-row-rename" title="rename (F2)" onClick={startRename}>✎</button>
  </a>;
}

function SidebarSkeleton({ count = 4 }: { count?: number }) {
  return <div className="sidebar-skeleton" aria-label="loading chats">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>;
}
