import { createContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { buildLabel, buildTone, type BuildRow } from "../create/buildActivity";
import { Highlight, type PaletteEntry } from "../CommandPalette";
import { createListOwner, initialListState, type ListOwner, type ListState } from "../pageList";
import { useInlineRename } from "../useInlineRename";
import { useFocusAfterCommit } from "../keyboard";
import { surfaceHref } from "./routes";
import { WRITE_SURFACE } from "../writeSurfaces";

export type PageLink = {
  id: string;
  route: string;
  title: string;
  created_at: string;
  updated_at: string;
  create_mode: boolean;
  chat_count: number;
  created_by_route: string | null;
};

export type Chat = {
  session_id: string;
  purpose: "chat" | "page_build";
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

export const PageChatCatalog = createContext<{
  chats: readonly Chat[];
  loading: boolean;
  error: boolean;
  next: string | null;
  reload: () => void;
  more: () => void;
  clearSearch: () => void;
  builds: readonly BuildRow[];
  onScreen: (id: string, shown: boolean) => void;
} | null>(null);

// The views tell the build owner which build rows are on screen; the owner decides what to read. Returns a callback ref.
// On screen: inside the nearest scroll box, below its sticky heads (the box's scroll-padding-top), and not inert (a
// page behind the open 390 drawer). Only those rows are read first. A row needs a real slice on screen: a quarter of it,
// or a quarter of the box for a row taller than four boxes, so a 0.5 px edge under the heads does not count.
export function useOnScreen(id: string | undefined, report: ((id: string, shown: boolean) => void) | undefined) {
  const [node, setNode] = useState<Element | null>(null);
  useEffect(() => {
    if (!node || id === undefined || !report) return;
    let root = node.parentElement;
    while (root && !/auto|scroll/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    const heads = parseFloat(getComputedStyle(root ?? document.documentElement).scrollPaddingTop) || 0;
    // shortcut: box and row heights are read once per mount; re-measure on resize if rows start to change height.
    const box = (root?.clientHeight ?? innerHeight) - heads;
    const slice = Math.min(0.25, Math.max(0, box) / 4 / (node.getBoundingClientRect().height || 1));
    let intersecting = false;
    let shown = false;
    const update = () => {
      const next = intersecting && !node.closest("[inert]");
      if (next !== shown) report(id, shown = next);
    };
    const observer = new IntersectionObserver((entries) => { const entry = entries.at(-1)!; intersecting = entry.isIntersecting && entry.intersectionRatio >= slice; update(); }, { root, rootMargin: `-${heads}px 0px 0px 0px`, threshold: [0, slice] });
    const inert = new MutationObserver(update);
    observer.observe(node);
    inert.observe(document.body, { attributes: true, attributeFilter: ["inert"], subtree: true });
    return () => { observer.disconnect(); inert.disconnect(); if (shown) report(id, false); };
  }, [node, id, report]);
  return setNode;
}

export const chatHref = (chat: Pick<Chat, "page_route" | "session_id">) => {
  const url = new URL(surfaceHref(chat.page_route), location.href);
  url.searchParams.set("chat", chat.session_id);
  return `${url.pathname}${url.search}`;
};
// a sent chat with no title (an older row) is "untitled"; "new chat" means nothing was sent yet
export const titleOf = (chat: Pick<Chat, "title" | "first_title" | "message_sent">) => chat.title?.trim() || chat.first_title?.trim() || (chat.message_sent ? "untitled chat" : "new chat");
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

// use the locale’s time and date casing.
export function timeLabel(value: string) {
  const date = new Date(value);
  const group = groupLabel(value);
  const label = group === "today" ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : group === "yesterday" || group === "this week" ? date.toLocaleDateString([], { weekday: "short" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return label;
}

// the one GET /api/chats loader: the sidebar list and the palette each own a list over it
const chatPage = (include: () => string | null) => async (search: string, before: string | null, signal: AbortSignal | undefined, limit = 50) => {
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

// `include` makes unsent chats eligible, but does not move them ahead of the other rows.
export async function findChat(sessionId: string, signal?: AbortSignal) {
  const read = chatPage(() => sessionId);
  let before: string | null = null;
  do {
    const { items, next } = await read("", before, signal, 200);
    const chat = items.find((row) => row.session_id === sessionId);
    if (chat) return chat;
    before = items.length ? next : null;
  } while (before);
  return null;
}

const emptyChats: readonly Chat[] = [];
const initialPageListState = initialListState<PageLink, null>(null);
const initialChatListState = initialListState<Chat, number>(0);
const listStatus = <T, M>(state: ListState<T, M>) => state.error ? "error" : state.loading || state.items === null ? "loading" : "ready";

// heldChatId: the open chat another tab controls; only that tab renames it
export function useAgentNavAdapter({ sessionId, waiting, canWrite, heldChatId = null, onSelectChat, onRenameChat, refreshKey, pageRefreshKey }: { sessionId: string | null; waiting: number; canWrite: boolean; heldChatId?: string | null; onSelectChat?: (chat: Chat) => void; onRenameChat?: (chat: Chat, title: string) => void; refreshKey: number; pageRefreshKey: number }) {
  const requestFocus = useFocusAfterCommit();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [recentChats, setRecentChats] = useState(emptyChats);
  const [chatList, setChatList] = useState(initialChatListState);
  const [pageList, setPageList] = useState(initialPageListState);
  const [activeResult, setActiveResult] = useState(0);
  const chatListElement = useRef<HTMLElement>(null);
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
    chatListOwner.current = createListOwner(initialChatListState, async (key, before, signal, limit) => {
      const page = await chatPage(() => openChat.current)(key, before, signal, limit);
      if (!key && !before && !signal.aborted) setRecentChats(page.items);
      return page;
    }, (item) => item.session_id, setChatList, 50, 200);
  }
  const chats = chatList.items ?? [];
  const loading = chatList.items === null && !chatList.error;
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setActiveResult(0); }, [search]);
  useEffect(() => { void pageListOwner.current!.reload(null); }, [pageRefreshKey]);
  // Q4: a build started in another tab appears when this tab comes back, with one chat-list read and no polling.
  const [backKey, setBackKey] = useState(0);
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") setBackKey((value) => value + 1); };
    addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, []);
  useEffect(() => { void chatListOwner.current!.reload(search); }, [refreshKey, backKey, search]);
  useEffect(() => () => {
    pageListOwner.current?.dispose();
    chatListOwner.current?.dispose();
  }, []);
  const pageRows = pageList.items ?? [];
  // A page build that needs you is counted by the build owner (the shell adds it), so the current build's wait is not counted here.
  const currentIsBuild = [...recentChats, ...chats].some((chat) => chat.session_id === sessionId && chat.purpose === "page_build");
  const waitingTotal = Math.max(currentIsBuild ? 0 : waiting, chatList.meta);
  const groups = useMemo(() => {
    const values = new Map<string, Chat[]>();
    for (const chat of chats ?? []) { const group = groupLabel(chat.updated_at); values.set(group, [...(values.get(group) ?? []), chat]); }
    return [...values];
  }, [chats]);
  const select = (chat: Chat, close: () => void) => {
    close();
    if (onSelectChat) onSelectChat(chat);
    else location.assign(chatHref(chat));
  };
  // shortcut: pages filter only the loaded pages (the first 20 and any the sidebar paged in); add server search to /api/pages when lists grow.
  const pageEntries = pageRows.map((item): PaletteEntry => ({ id: `page:${item.id}`, label: item.title, detail: item.route, run: () => location.assign(surfaceHref(item.route)) }));
  const searchChats = (close: () => void) => (search: string, before: string | null, signal: AbortSignal, limit = 20) => chatPage(() => null)(search, before, signal, limit)
    .then((result) => ({ ...result, items: result.items.map((chat): PaletteEntry => ({ id: chat.session_id, label: titleOf(chat), detail: `${chat.page_title} · ${timeLabel(chat.updated_at)}`, run: () => select(chat, close) })) }));
  // a row rename (F2 or the pencil) hands focus back to its row: once the editor closes, and again after the
  // list refresh moves the row; it lets go as soon as focus lands anywhere else.
  const renamedRow = useRef<string | null>(null);
  const returnRowFocus = () => {
    const id = renamedRow.current;
    const row = id && document.activeElement === document.body ? document.querySelector<HTMLElement>(`a[data-chat-id="${CSS.escape(id)}"]`) : null;
    row?.focus();
    return row;
  };
  const startRowRename = (id: string) => { renamedRow.current = id; };
  // the current row can land above a scrolled list (a new chat's first send moves it to the top): show it when it appears
  // or moves to the top, then leave the user's scrolling alone; scroll-padding-top keeps it below the sticky heads
  const shownCurrent = useRef({ id: "", first: false });
  useEffect(() => {
    const row = sessionId ? chatListElement.current?.querySelector<HTMLElement>(`a[data-chat-id="${CSS.escape(sessionId)}"]`) : null;
    if (!sessionId || !row) return;
    const first = chats[0]?.session_id === sessionId;
    const shown = shownCurrent.current;
    shownCurrent.current = { id: sessionId, first };
    const list = chatListElement.current;
    if (!list || (shown.id === sessionId && (!first || shown.first))) return;
    // Only the chat list moves; its selected row must not scroll the places out of view.
    const item = row.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    const top = bounds.top + parseFloat(getComputedStyle(list).scrollPaddingTop);
    if (item.top < top) list.scrollTop += item.top - top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [sessionId, chats]);
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
  const searchKey = (close: () => void) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!search || !chats?.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveResult((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + chats.length) % chats.length); }
    if (event.key === "Enter") { event.preventDefault(); select(chats[activeResult] ?? chats[0], close); }
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

  return {
    loading, query, pageEntries, searchChats,
    pageCatalog: pageList, recentChats,
    reloadPages: () => void pageListOwner.current!.reload(null),
    morePages: loadOlder,
    clearSearch: () => { setQuery(""); setSearch(""); setActiveResult(0); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); },
    searchControl: (close: () => void) => loading ? <div className="search-skeleton" aria-label="loading search" /> : <label className="chat-search"><span>⌕</span><input aria-label="search chats and pages" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKey(close)} placeholder="Search" role="combobox" aria-expanded={Boolean(search)} aria-controls="chat-search-results" aria-activedescendant={search && chats.length ? `chat-result-${activeResult}` : undefined} /></label>,
    counts: {
      chats: { waiting: waitingTotal },
    },
    recent: (close: () => void, builds: readonly BuildRow[], onScreen: (id: string, shown: boolean) => void) => {
      const projectedBuild = (chat: Chat) => chat.purpose === "page_build" ? builds.find((row) => row.chat.session_id === chat.session_id) : undefined;
      return <section ref={chatListElement} className="chat-list" id="chat-search-results" tabIndex={0} aria-label="chat list" data-list-state={listStatus(chatList)} data-loaded-count={chats.length} onKeyDown={chatListKey}>
        <div className="list-head"><span>recent chats</span></div>
        {chatList.error ? <div className="page-list-error"><span>could not load chats</span><button onClick={() => void chatListOwner.current!.reload(search)}>retry</button></div> : chatList.items === null ? <SidebarSkeleton /> : search ? <div className="chat-group"><h2>{chats.length} results</h2>{chats.map((chat, index) => <ChatRow key={chat.session_id} chat={chat} build={projectedBuild(chat)} onScreen={onScreen} current={chat.session_id === sessionId} active={index === activeResult} index={index} query={search} onSelect={onSelectChat ? (chat) => select(chat, close) : undefined} onRename={canWrite && chat.session_id !== heldChatId ? onRenameChat : undefined} onRenameStart={startRowRename} onRenameEnd={returnRowFocus} />)}</div> : groups.map(([label, rows]) => <div className="chat-group" key={label}><h2>{label}</h2>{rows.map((chat) => <ChatRow key={chat.session_id} chat={chat} build={projectedBuild(chat)} onScreen={onScreen} current={chat.session_id === sessionId} active={false} query="" onSelect={onSelectChat ? (chat) => select(chat, close) : undefined} onRename={canWrite && chat.session_id !== heldChatId ? onRenameChat : undefined} onRenameStart={startRowRename} onRenameEnd={returnRowFocus} />)}</div>)}
        {chatList.next && <button className="load-older" onClick={(event) => void loadOlderChats(event.currentTarget)}>load 50 older</button>}
      </section>;
    },
    catalog: {
        chats: search ? [] : chats, loading: Boolean(search) || loading || chatList.loading,
        error: !search && Boolean(chatList.error), next: search ? null : chatList.next,
        reload: () => void chatListOwner.current!.reload(search), more: () => void chatListOwner.current!.more(),
        clearSearch: () => { setQuery(""); setSearch(""); },
      },
  };
}

function ChatRow({ chat, build, onScreen, current, active, index, query, onSelect, onRename, onRenameStart, onRenameEnd }: { chat: Chat; build?: BuildRow; onScreen?: (id: string, shown: boolean) => void; current: boolean; active: boolean; index?: number; query: string; onSelect?: (chat: Chat) => void; onRename?: (chat: Chat, title: string) => void; onRenameStart: (id: string) => void; onRenameEnd: () => void }) {
  const rename = useInlineRename();
  const seen = useOnScreen(chat.purpose === "page_build" ? chat.session_id : undefined, onScreen);
  const rowId = index === undefined ? undefined : `chat-result-${index}`;
  // defer past the focus change: a blur commit flushes in a microtask while focus is on body, before the clicked control gets it
  useEffect(() => { if (rename.editing) return; const timer = setTimeout(onRenameEnd); return () => clearTimeout(timer); }, [rename.editing]);
  // A page build's state comes only from the build owner; with no row there is no claim.
  const state = chat.purpose === "page_build" ? buildTone(build) : chat.last_state;
  const label = chat.purpose === "page_build" ? build && buildLabel(build) : state === "approval" ? "needs you" : state === "idle" ? null : state;
  const rowClass = `chat-row state-${state ?? "idle"} ${current ? "current" : ""} ${active ? "active-result" : ""}`;
  const meta = label && <span className="chat-row-meta">{label}</span>;
  if (rename.editing) {
    // the hidden title under the editor keeps the row's height, so the list below does not move
    return <div ref={seen} id={rowId} data-chat-id={chat.session_id} className={`${rowClass} editing`}>
      <strong aria-hidden="true">{titleOf(chat)}</strong>
      <input className="chat-row-edit" aria-label={`rename ${titleOf(chat)}`} {...rename.bind()} />
      {meta}
    </div>;
  }
  // F2 or the pencil both start a rename the same way, so focus returns to the row either way (onRenameStart marks it)
  const startRename = (event: { preventDefault(): void; stopPropagation(): void }) => {
    if (!onRename) return;
    event.preventDefault();
    event.stopPropagation();
    onRenameStart(chat.session_id);
    rename.start(chat.title?.trim() || chat.first_title?.trim() || "", (value) => onRename(chat, value));
  };
  return <a ref={seen} tabIndex={-1} id={rowId} data-chat-id={chat.session_id} className={rowClass} href={chatHref(chat)} onClick={onSelect && ((event) => { event.preventDefault(); onSelect(chat); })} onKeyDown={(event) => { if (event.key === "F2") startRename(event); }} aria-keyshortcuts={onRename ? "F2" : undefined} aria-current={current ? "page" : undefined}>
    <strong title={titleOf(chat)}><Highlight value={titleOf(chat)} query={query} /></strong>
    {meta}
    {onRename && <button type="button" tabIndex={-1} aria-hidden="true" className="chat-row-rename" data-write-surface={WRITE_SURFACE.sidebarRename} title="rename (F2)" onClick={startRename}>✎</button>}
  </a>;
}

function SidebarSkeleton({ count = 4 }: { count?: number }) {
  return <div className="sidebar-skeleton" aria-label="loading chats">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>;
}
