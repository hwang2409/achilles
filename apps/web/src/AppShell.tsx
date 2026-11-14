import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { SettingsControl, SettingsDialog } from "./SettingsDialog";

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
  serverForcesAsk?: boolean;
  children: ReactNode;
  onNewChat: () => Promise<void>;
  onToggleCreateMode: () => Promise<void>;
  onSelectChat: (chat: Chat) => void;
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
const titleOf = (chat: Chat) => chat.title?.trim() || "untitled chat";
const focusable = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]:not([tabindex='-1'])";
const nativelyFocusable = "button, a[href], input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false'])";
const firstFocusable = (parent: HTMLElement | null) => parent?.querySelector<HTMLElement>(focusable) ?? null;
const restorableFocus = (...candidates: Array<Element | null>) => candidates.find((element): element is HTMLElement => {
  if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement || !element.isConnected || element.matches("[disabled], :disabled") || element.closest("[inert], [aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (element.tabIndex >= 0 || element.matches(nativelyFocusable)) && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}) ?? null;

function useFocusAfterCommit() {
  const pending = useRef<(() => HTMLElement | null) | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    pending.current = null;
    target?.()?.focus();
  });
  return (target: () => HTMLElement | null) => { pending.current = target; };
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

function Highlight({ value, query }: { value: string; query: string }) {
  if (!query) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + query.length)}</mark>{value.slice(index + query.length)}</>;
}

export function AppShell({ page, sessionId, waiting, serverForcesAsk = false, children, onNewChat, onToggleCreateMode, onSelectChat, refreshKey, pageRefreshKey }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [pages, setPages] = useState<PageLink[] | null>(null);
  const [pagesError, setPagesError] = useState(false);
  const [pagesRetry, setPagesRetry] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [pageNext, setPageNext] = useState<string | null>(null);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [activeResult, setActiveResult] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 760px)").matches);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const chatList = useRef<HTMLElement>(null);
  const settingsOpener = useRef<Element>(null);
  const requestFocus = useFocusAfterCommit();
  const loading = chats === null;
  const closeDrawer = () => { requestFocus(() => restorableFocus(menuButton.current)); setDrawer(false); };
  const openSettings = (opener: Element | null) => {
    setSettingsOpen((open) => {
      if (!open) settingsOpener.current = opener;
      return true;
    });
  };
  const closeSettings = () => {
    if (!settingsOpen) return;
    requestFocus(() => {
      const target = restorableFocus(
        settingsOpener.current,
        drawer ? firstFocusable(sidebar.current) : null,
        document.querySelector(".main-pane textarea[aria-label='message']"),
        document.querySelector(".settings-button"),
      );
      settingsOpener.current = null;
      return target;
    });
    setSettingsOpen(false);
  };

  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setActiveResult(0); }, [search]);
  useEffect(() => { const media = matchMedia("(max-width: 760px)"); const changed = () => setNarrow(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    const load = () => {
      setPagesLoading(true);
      void fetch("/api/pages?limit=20", { cache: "no-store", signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`could not load pages (${response.status})`);
        const result = await response.json() as { pages: PageLink[]; next: string | null };
        if (live) { setPages(result.pages); setPageNext(result.next); setPagesError(false); }
      }).catch((error) => { if (live && !(error instanceof DOMException && error.name === "AbortError")) setPagesError(true); })
        .finally(() => { if (live) setPagesLoading(false); });
    };
    const settle = setTimeout(load, 0);
    return () => { live = false; clearTimeout(settle); controller.abort(); };
  }, [pageRefreshKey, pagesRetry]);
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
    const layers: Array<() => void> = [];
    if (query) layers.push(() => { setQuery(""); setSearch(""); setActiveResult(0); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); });
    if (drawer) layers.push(closeDrawer);
    if (settingsOpen) layers.push(closeSettings);
    const top = layers.at(-1);
    if (!top) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      top();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [drawer, query, settingsOpen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); setCollapsed((value) => !value); }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") { event.preventDefault(); openSettings(document.activeElement instanceof Element ? document.activeElement : null); }
      if (!loading && (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); void onNewChat(); }
      if (!loading && (event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); void onToggleCreateMode(); }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); document.querySelector<HTMLInputElement>(".chat-search input")?.focus(); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [loading, onNewChat, onToggleCreateMode, settingsOpen]);

  const pageRows = pages ?? [];
  const waitingTotal = Math.max(waiting, approvalCount);
  const groups = useMemo(() => {
    const values = new Map<string, Chat[]>();
    for (const chat of chats ?? []) { const group = groupLabel(chat.updated_at); values.set(group, [...(values.get(group) ?? []), chat]); }
    return [...values];
  }, [chats]);
  const select = (chat: Chat) => { setDrawer(false); onSelectChat(chat); };
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
  const loadOlder = async () => {
    if (!pageNext || pagesLoading) return;
    setPagesLoading(true);
    try {
      const response = await fetch(`/api/pages?limit=20&before=${encodeURIComponent(pageNext)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`could not load pages (${response.status})`);
      const result = await response.json() as { pages: PageLink[]; next: string | null };
      const firstPage = result.pages[0];
      if (firstPage) requestFocus(() => document.querySelector<HTMLAnchorElement>(`[data-page-id="${CSS.escape(firstPage.id)}"]`));
      setPages((current) => [...(current ?? []), ...result.pages]);
      setPageNext(result.next);
    } catch {
      setPagesError(true);
    } finally {
      setPagesLoading(false);
    }
  };
  const loadOlderChats = async () => {
    if (!next) return;
    const params = new URLSearchParams({ limit: "50", before: next });
    if (search) params.set("q", search);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json() as { chats: Chat[]; next: string | null; approval_count: number };
    const firstChat = result.chats[0];
    if (firstChat) requestFocus(() => document.querySelector<HTMLAnchorElement>(`[data-chat-id="${CSS.escape(firstChat.session_id)}"]`));
    setChats((current) => [...(current ?? []), ...result.chats]);
    setApprovalCount(result.approval_count);
    setNext(result.chats.length ? result.next : null);
  };

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${drawer ? "drawer-open" : ""} ${loading ? "shell-loading" : ""}`}>
    <a className="skip-link" href="#message-composer" onClick={(event) => { event.preventDefault(); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]')?.focus(); }}>skip to message</a>
    <button className="drawer-scrim" aria-label="close menu" hidden={!drawer} tabIndex={-1} onClick={closeDrawer} />
    <aside ref={sidebar} className="sidebar" aria-label="sidebar" aria-hidden={narrow && !drawer ? "true" : undefined} inert={narrow && !drawer ? true : undefined}>
      <div className="brand-row"><span className="brand-mark" /><strong>achilles</strong><span>v3.2</span><button aria-label={collapsed ? "expand sidebar" : "collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>◧</button></div>
      <button className="new-chat" disabled={loading} onClick={() => { setDrawer(false); void onNewChat(); }}><span>+</span><b>new chat</b><kbd>⌘⇧O</kbd></button>
      {loading ? <div className="search-skeleton" aria-label="loading search" /> : <label className="chat-search"><span>⌕</span><input aria-label="search chats and pages" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKey} placeholder="search chats and pages" role="combobox" aria-expanded={Boolean(search)} aria-controls="chat-search-results" aria-activedescendant={search && chats.length ? `chat-result-${activeResult}` : undefined} /><kbd>/</kbd></label>}
      {waitingTotal > 0 && <div className="waiting-count" aria-label={`${waitingTotal} waiting approvals`}>{waitingTotal}</div>}
      <section className={`page-list ${pagesOpen && pageRows.length >= 3 ? "has-pages" : ""}`}>
        <button className="list-head" onClick={() => setPagesOpen((value) => !value)}><span>{pagesOpen ? "▾" : "▸"} pages</span><b>{pagesError ? "!" : pages === null ? "" : pageNext ? "20+" : pageRows.length}</b></button>
        <div className="page-list-scroll">
          {pagesError ? <div className="page-list-error"><span>could not load pages</span><button onClick={() => { setPagesError(false); setPagesRetry((value) => value + 1); }}>retry</button></div> : pages === null ? <SidebarSkeleton count={2} /> : pagesOpen && <>{pageRows.map((item) => <a key={item.id} data-page-id={item.id} href={pageHref(item.route)} title={item.title} aria-label={item.title}><span>/</span><b>{item.title}</b></a>)}{pageNext && <button className="load-older" onClick={() => void loadOlder()}>show more pages</button>}</>}
        </div>
      </section>
      <section ref={chatList} className="chat-list" id="chat-search-results" tabIndex={0} aria-label="chat list" onKeyDown={chatListKey}>
        <div className="list-head"><span>chats</span><b>{chats?.length ?? ""}</b></div>
        {chats === null ? <SidebarSkeleton /> : search ? <div className="chat-group"><h2>{chats.length} results</h2>{chats.map((chat, index) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={index === activeResult} index={index} query={search} onSelect={select} />)}</div> : groups.map(([label, rows]) => <div className="chat-group" key={label}><h2>{label}</h2>{rows.map((chat) => <ChatRow key={chat.session_id} chat={chat} current={chat.session_id === sessionId} active={false} query="" onSelect={select} />)}</div>)}
        {next && <button className="load-older" onClick={loadOlderChats}>load 50 older</button>}
      </section>
      <footer><SettingsControl onOpen={openSettings} className="settings-button" /><kbd>⌘K</kbd></footer>
    </aside>
    <main className="main-pane" aria-hidden={narrow && drawer ? "true" : undefined} inert={narrow && drawer ? true : undefined}>
      <button ref={menuButton} className="menu-button" aria-label="open menu" onClick={() => { requestFocus(() => firstFocusable(sidebar.current)); setDrawer(true); }}>☰</button>
      {children}
    </main>
    <SettingsDialog open={settingsOpen} onClose={closeSettings} serverForcesAsk={serverForcesAsk} />
  </div>;
}

function ChatRow({ chat, current, active, index, query, onSelect }: { chat: Chat; current: boolean; active: boolean; index?: number; query: string; onSelect: (chat: Chat) => void }) {
  return <a tabIndex={-1} id={index === undefined ? undefined : `chat-result-${index}`} data-chat-id={chat.session_id} className={`chat-row state-${chat.last_state ?? "idle"} ${current ? "current" : ""} ${active ? "active-result" : ""}`} href={chatHref(chat)} onClick={(event) => { event.preventDefault(); onSelect(chat); }} aria-current={current ? "page" : undefined}>
    <strong title={titleOf(chat)}><Highlight value={titleOf(chat)} query={query} /></strong>
    <span title={chat.page_title}>{chat.last_state === "approval" && <>needs approval · </>}{chat.last_state === "failed" && <>failed · </>}{chat.page_title} <i>{timeLabel(chat.updated_at)}</i></span>
  </a>;
}

function SidebarSkeleton({ count = 4 }: { count?: number }) {
  return <div className="sidebar-skeleton" aria-label="loading chats">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>;
}
