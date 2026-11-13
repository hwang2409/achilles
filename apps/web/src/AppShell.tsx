import { useEffect, useMemo, useState, type ReactNode } from "react";

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

const pageHref = (route: string) => route === "/" ? "/" : route;
const chatHref = (chat: Chat) => `${pageHref(chat.page_route)}?chat=${encodeURIComponent(chat.session_id)}`;
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

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    void fetch(`/api/chats?${params}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`could not load chats (${response.status})`);
      const result = await response.json() as { chats: Chat[]; next: string | null };
      if (live) { setChats(result.chats); setNext(result.next); }
    }).catch(() => { if (live) { setChats([]); setNext(null); } });
    return () => { live = false; };
  }, [refreshKey, search]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); setCollapsed((value) => !value); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); onNewChat(); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [onNewChat]);

  const pages = useMemo(() => {
    const values = new Map<string, PageLink>();
    if (page) values.set(page.id, page);
    for (const chat of chats ?? []) values.set(chat.page_id, { id: chat.page_id, route: chat.page_route, title: chat.page_title });
    return [...values.values()];
  }, [chats, page]);
  const waitingTotal = Math.max(waiting, (chats ?? []).filter((chat) => chat.last_state === "approval").length);
  const groups = useMemo(() => {
    const values = new Map<string, Chat[]>();
    for (const chat of chats ?? []) { const group = groupLabel(chat.updated_at); values.set(group, [...(values.get(group) ?? []), chat]); }
    return [...values];
  }, [chats]);
  const select = (chat: Chat) => { setDrawer(false); onSelectChat(chat); };
  const loadOlder = async () => {
    if (!next) return;
    const params = new URLSearchParams({ limit: "50", before: next });
    if (search) params.set("q", search);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json() as { chats: Chat[]; next: string | null };
    setChats((current) => [...(current ?? []), ...result.chats]);
    setNext(result.chats.length ? result.next : null);
  };

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""}`}>
    <button className="drawer-scrim" aria-label="close menu" onClick={() => setDrawer(false)} />
    <aside className="sidebar" aria-label="sidebar">
      <div className="brand-row"><span className="brand-mark" /><strong>achilles</strong><span>v3.2</span><button aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>◧</button></div>
      <button className="new-chat" onClick={() => { setDrawer(false); onNewChat(); }}><span>+</span><b>new chat</b><kbd>⌘⇧O</kbd></button>
      <label className="chat-search"><span>⌕</span><input aria-label="search chats and pages" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search chats and pages" /><kbd>/</kbd></label>
      {waitingTotal > 0 && <div className="waiting-count" aria-label={`${waitingTotal} waiting approvals`}>{waitingTotal}</div>}
      <section className="page-list">
        <button className="list-head" onClick={() => setPagesOpen((value) => !value)}><span>{pagesOpen ? "▾" : "▸"} pages</span><b>{pages.length}</b></button>
        {pagesOpen && pages.map((item) => <a key={item.id} href={pageHref(item.route)}><span>/</span>{item.title}</a>)}
      </section>
      <section className="chat-list">
        <div className="list-head"><span>chats</span><b>{chats?.length ?? ""}</b></div>
        {chats === null ? <SidebarSkeleton /> : search ? <div className="chat-group"><h2>{chats.length} results</h2>{chats.map((chat) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} query={search} onSelect={select} />)}</div> : groups.map(([label, rows]) => <div className="chat-group" key={label}><h2>{label}</h2>{rows.map((chat) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} query="" onSelect={select} />)}</div>)}
        {next && <button className="load-older" onClick={loadOlder}>load 50 older</button>}
      </section>
      <footer><button type="button">⚙ <span>settings</span></button><kbd>⌘K</kbd></footer>
    </aside>
    <main className="main-pane">
      <button className="menu-button" aria-label="open menu" onClick={() => setDrawer(true)}>☰</button>
      {children}
    </main>
  </div>;
}

function ChatRow({ chat, current, query, onSelect }: { chat: Chat; current: boolean; query: string; onSelect: (chat: Chat) => void }) {
  return <a className={`chat-row state-${chat.last_state ?? "idle"} ${current ? "current" : ""}`} href={chatHref(chat)} onClick={(event) => { event.preventDefault(); onSelect(chat); }} aria-current={current ? "page" : undefined}>
    <strong><Highlight value={titleOf(chat)} query={query} /></strong>
    <span>{chat.last_state === "approval" && <>needs approval · </>}{chat.last_state === "failed" && <>failed · </>}{chat.page_title} <i>{timeLabel(chat.updated_at)}</i></span>
  </a>;
}

function SidebarSkeleton() {
  return <div className="sidebar-skeleton" aria-label="loading chats"><i /><i /><i /><i /></div>;
}
