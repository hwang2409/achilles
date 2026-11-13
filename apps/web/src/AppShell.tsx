import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export type Chat = {
  session_id: string;
  page_id: string;
  page_route: string;
  page_title: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_state: "idle" | "running" | "approval" | "failed" | null;
};

type PageLink = { id: string; route: string; title: string };
type Props = {
  page: PageLink | null;
  sessionId: string | null;
  waiting: number;
  children: ReactNode;
  onNewChat: () => void;
  onSelectChat: (chat: Chat) => void;
  refreshKey: number;
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
const titleOf = (chat: Chat) => chat.title?.trim() || "untitled chat";

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

function Highlight({ value, query }: { value: string; query: string }) {
  if (!query) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

export function AppShell({ page, sessionId, waiting, children, onNewChat, onSelectChat, refreshKey }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [approvalCount, setApprovalCount] = useState(0);
  const [activeResult, setActiveResult] = useState(0);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 759px)").matches);
  const menuButton = useRef<HTMLButtonElement>(null);
  const loading = chats === null;

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setActiveResult(0); }, [search]);
  useEffect(() => { const media = matchMedia("(max-width: 759px)"); const changed = () => setNarrow(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    void fetch(`/api/chats?${params}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`could not load chats (${response.status})`);
      const result = await response.json() as { chats: Chat[]; next: string | null; approval_count: number };
      if (live) { setChats(result.chats); setNext(result.next); setApprovalCount(result.approval_count); }
    }).catch(() => { if (live) { setChats([]); setNext(null); } });
    return () => { live = false; };
  }, [refreshKey, search]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); setCollapsed((value) => !value); }
      if (!loading && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); onNewChat(); }
      if (event.key === "Escape" && drawer) { event.preventDefault(); setDrawer(false); requestAnimationFrame(() => menuButton.current?.focus()); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [drawer, loading, onNewChat]);

  const pages = useMemo(() => {
    const values = new Map<string, PageLink>();
    if (page) values.set(page.id, page);
    for (const chat of chats ?? []) values.set(chat.page_id, { id: chat.page_id, route: chat.page_route, title: chat.page_title });
    return [...values.values()];
  }, [chats, page]);
  const waitingTotal = Math.max(waiting, approvalCount);
  const groups = useMemo(() => {
    const values = new Map<string, Chat[]>();
    for (const chat of chats ?? []) { const group = groupLabel(chat.updated_at); values.set(group, [...(values.get(group) ?? []), chat]); }
    return [...values];
  }, [chats]);
  const closeDrawer = () => { setDrawer(false); requestAnimationFrame(() => menuButton.current?.focus()); };
  const select = (chat: Chat) => { setDrawer(false); onSelectChat(chat); };
  const searchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); setQuery(""); setSearch(""); setActiveResult(0); event.currentTarget.focus(); return; }
    if (!search || !chats?.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveResult((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + chats.length) % chats.length); }
    if (event.key === "Enter") { event.preventDefault(); select(chats[activeResult] ?? chats[0]); }
  };
  const loadOlder = async () => {
    if (!next) return;
    const params = new URLSearchParams({ limit: "50", before: next });
    if (search) params.set("q", search);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json() as { chats: Chat[]; next: string | null; approval_count: number };
    setChats((current) => [...(current ?? []), ...result.chats]);
    setApprovalCount(result.approval_count);
    setNext(result.chats.length ? result.next : null);
  };

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""} ${loading ? "shell-loading" : ""}`}>
    <button className="drawer-scrim" aria-label="close menu" hidden={!drawer} tabIndex={-1} onClick={closeDrawer} />
    <aside className="sidebar" aria-label="sidebar" aria-hidden={narrow && !drawer ? "true" : undefined} inert={narrow && !drawer ? true : undefined}>
      <div className="brand-row"><span className="brand-mark" /><strong>achilles</strong><span>v3.2</span><button aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>◧</button></div>
      <button className="new-chat" disabled={loading} onClick={() => { setDrawer(false); onNewChat(); }}><span>+</span><b>new chat</b><kbd>⌘⇧O</kbd></button>
      {loading ? <div className="search-skeleton" aria-label="loading search" /> : <label className="chat-search"><span>⌕</span><input aria-label="search chats and pages" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKey} placeholder="search chats and pages" role="combobox" aria-expanded={Boolean(search)} aria-controls="chat-search-results" aria-activedescendant={search && chats.length ? `chat-result-${activeResult}` : undefined} /><kbd>/</kbd></label>}
      {waitingTotal > 0 && <div className="waiting-count" aria-label={`${waitingTotal} waiting approvals`}>{waitingTotal}</div>}
      <section className="page-list">
        <button className="list-head" onClick={() => setPagesOpen((value) => !value)}><span>{pagesOpen ? "▾" : "▸"} pages</span><b>{pages.length}</b></button>
        {loading ? <SidebarSkeleton count={2} /> : pagesOpen && pages.map((item) => <a key={item.id} href={pageHref(item.route)}><span>/</span>{item.title}</a>)}
      </section>
      <section className="chat-list" id="chat-search-results">
        <div className="list-head"><span>chats</span><b>{chats?.length ?? ""}</b></div>
        {chats === null ? <SidebarSkeleton /> : search ? <div className="chat-group"><h2>{chats.length} results</h2>{chats.map((chat, index) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={index === activeResult} index={index} query={search} onSelect={select} />)}</div> : groups.map(([label, rows]) => <div className="chat-group" key={label}><h2>{label}</h2>{rows.map((chat) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={false} query="" onSelect={select} />)}</div>)}
        {next && <button className="load-older" onClick={loadOlder}>load 50 older</button>}
      </section>
      <footer><button type="button">⚙ <span>settings</span></button><kbd>⌘K</kbd></footer>
    </aside>
    <main className="main-pane">
      <button ref={menuButton} className="menu-button" aria-label="open menu" onClick={() => setDrawer(true)}>☰</button>
      {children}
    </main>
  </div>;
}

function ChatRow({ chat, current, active, index, query, onSelect }: { chat: Chat; current: boolean; active: boolean; index?: number; query: string; onSelect: (chat: Chat) => void }) {
  return <a id={index === undefined ? undefined : `chat-result-${index}`} className={`chat-row state-${chat.last_state ?? "idle"} ${current ? "current" : ""} ${active ? "active-result" : ""}`} href={chatHref(chat)} onClick={(event) => { event.preventDefault(); onSelect(chat); }} aria-current={current ? "page" : undefined}>
    <strong><Highlight value={titleOf(chat)} query={query} /></strong>
    <span>{chat.last_state === "approval" && <>needs approval · </>}{chat.last_state === "failed" && <>failed · </>}{chat.page_title} <i>{timeLabel(chat.updated_at)}</i></span>
  </a>;
}

function SidebarSkeleton({ count = 4 }: { count?: number }) {
  return <div className="sidebar-skeleton" aria-label="loading chats">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>;
}
