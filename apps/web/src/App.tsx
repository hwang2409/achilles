import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { AppShell } from "./AppShell";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, type Connection, type ConnectionState } from "./zeta";
import { useActiveChat, type Page } from "./useActiveChat";
import "./style.css";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = {};
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;
const renderers: Renderers = { message: ({ id }) => <Message id={id} markdown={RichMarkdown} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };

function ComposerSlot({ focus, children }: { focus: boolean; children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (focus) slot.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="message"]')?.focus({ preventScroll: true }); }, [focus]);
  return <div id="message-composer" ref={slot} style={{ display: "contents" }}>{children}</div>;
}

function connectionFailure(state: ConnectionState): string | null {
  if (state.phase !== "connected" && "lost" in state && state.lost) return "the connection to zeta was lost.";
  switch (state.phase) {
    case "not_running": return "zeta serve is not running.";
    case "auth_failed": return state.reason === "origin" ? `this origin is not allowed by zeta. restart zeta serve with --ws-origin ${location.origin}.` : "zeta rejected this browser connection.";
    case "unresponsive": return "zeta is not responding.";
    case "incompatible": return "this zeta version is not compatible with achilles.";
    default: return null;
  }
}

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [client, setClient] = useState(connection.client);
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const active = useActiveChat(client, connectionState.phase === "connected");
  const ready = active.state.phase === "ready" ? active.state : null;
  const store = ready?.lease.store ?? null;
  const snapshot = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store ? () => {
    const state = store.getState();
    const completedTurns = state.turn === "idle" ? state.turns.length : Math.max(0, state.turns.length - 1);
    const completedTools = state.outline.reduce((count, item) => { if (item.kind !== "tool") return count; const value = store.getItem(item.id); return count + (value?.type === "tool" && !value.active ? 1 : 0); }, 0);
    const approvals = state.outline.reduce((count, item) => count + (store.getItem(item.id)?.type === "approval" && !(store.getItem(item.id) as { ended?: unknown }).ended ? 1 : 0), 0);
    const toolStates = state.outline.map((item) => {
      const value = store.getItem(item.id) as { active?: boolean; is_error?: boolean; version?: number } | undefined;
      return `${item.id}:${value?.active ?? "missing"}:${value?.is_error ?? false}:${value?.version ?? 0}`;
    }).join(",");
    return `${state.turn}:${completedTurns}:${completedTools}:${approvals}:${state.endOutcome ?? ""}:${state.outline.length}:${toolStates}`;
  } : () => "idle:0:0:0::0:");
  const [turn, completedTurns, completedTools, approvalCount, outcome, outlineLength] = snapshot.split(":") as ["idle" | "running", string, string, string, string, string];
  const refreshKey = `${completedTurns}:${completedTools}`;
  const waiting = Number(approvalCount);
  const previousTurn = useRef(turn);
  const [followRequest, setFollowRequest] = useState(0);
  const [pageRefreshNonce, setPageRefreshNonce] = useState(0);
  const completedCreatePages = useRef(new Set<string>());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [fulcrumJumpToLatest, setFulcrumJumpToLatest] = useState(false);
  const transcriptRef = useRef<HTMLElement>(null);
  const send: typeof active.send = (...args) => {
    setFollowRequest((value) => value + 1);
    return active.send(...args);
  };

  useEffect(() => {
    const unsubscribe = connection.subscribe(() => setClient(connection.client));
    return () => { unsubscribe(); connection.stop(); };
  }, [connection]);
  useEffect(() => store?.subscribe(() => {
    for (const item of store.getState().outline) {
      if (item.kind !== "tool") continue;
      const value = store.getItem(item.id) as { active?: boolean; is_error?: boolean; tool_call?: { name?: string } } | undefined;
      if (value && ["create_page", "achilles__create_page", "update_layout", "achilles__update_layout"].includes(value.tool_call?.name ?? "") && !value.active && !value.is_error && !completedCreatePages.current.has(item.id)) {
        completedCreatePages.current.add(item.id);
        setPageRefreshNonce((current) => current + 1);
      }
    }
  }), [store]);
  useEffect(() => {
    if (ready?.sessionId) setFollowRequest((value) => value + 1);
  }, [ready?.sessionId]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    const scroll = transcript?.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
    if (!scroll) return;
    let contentHeight = scroll.scrollHeight;
    const update = () => {
      const grew = scroll.scrollHeight > contentHeight;
      setFulcrumJumpToLatest(Boolean(transcript?.querySelector('[data-part="jump-to-latest-lane"] [data-part="jump-to-latest"]')));
      if (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4) setShowJumpToLatest(false);
      else if (grew) setShowJumpToLatest(true);
      contentHeight = scroll.scrollHeight;
    };
    scroll.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    const mutations = new MutationObserver(update);
    mutations.observe(scroll, { subtree: true, childList: true, characterData: true });
    return () => { scroll.removeEventListener("scroll", update); observer.disconnect(); mutations.disconnect(); };
  }, [ready?.sessionId, outlineLength]);
  useEffect(() => {
    const previous = previousTurn.current; previousTurn.current = turn;
    if (previous === "running" && turn === "idle") void active.settleApprovalMode();
  }, [active.settleApprovalMode, turn]);
  const lastState = waiting ? "approval" : outcome === "failed" ? "failed" : turn === "running" ? "running" : "idle";
  useEffect(() => { active.recordLastState(lastState); }, [active.recordLastState, lastState]);

  const connected = connectionState.phase === "connected";
  const approval = connected && client && store ? createApprovalDecider(client, store) : null;
  const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} disabledReason={!approval ? "zeta is offline" : undefined} onApprove={approval ? (request) => approval("approve", request) : undefined} onDeny={approval ? (request) => approval("deny", request) : undefined} /> };
  const failure = connectionFailure(connectionState);
  const lost = connectionState.phase !== "connected" && "lost" in connectionState && connectionState.lost;
  const content = <>
    {ready && <ChatHeader page={ready.page} sessionId={ready.sessionId} title={ready.title} state={lost ? "offline" : lastState} toggling={active.toggling || !connected} toggle={active.toggle} toggleError={active.toggleError} />}
    {lost && ready && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p><button className="primary" onClick={active.retrySaving}>retry creating chat</button></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" onClick={active.newChat}>new chat</button></div>
      : active.state.phase === "error" && active.state.error === "page not found" ? <NotFoundState onNewChat={active.newChat} />
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !ready || !store ? <div className="full-state"><p role="status">loading chat…</p></div>
      : <RunProvider store={store}>
        {ready.page.layout.blocks.length > 0 && <div className="layout-blocks">{ready.page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={ready.page.id} credential={ready.credential} refreshKey={refreshKey} />)}</div>}
        <section ref={transcriptRef} className="transcript">{Number(outlineLength) === 0 && <EmptyChat page={ready.page} send={send} continueWaiting={active.continueWaitingChat} />}<Timeline renderers={appRenderers} virtual followRequest={followRequest} />{showJumpToLatest && !fulcrumJumpToLatest && <button type="button" data-part="jump-to-latest" onClick={() => { setFollowRequest((value) => value + 1); const scroll = transcriptRef.current?.querySelector<HTMLElement>('[data-part="timeline-scroll"]'); scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }); }}>jump to latest</button>}</section>
        <ComposerSlot key={ready.sessionId} focus={active.focusSessionId === ready.sessionId}>{!connected || !client ? <Composer state="read-only" reason="send is off until zeta is back" onSubmit={send} placeholder="message zeta" /> : <Composer state={turn === "running" ? "steerable" : "idle"} onSubmit={send} onStop={() => client.request("abort", { session_id: ready.sessionId })} placeholder="message zeta" />}</ComposerSlot>
      </RunProvider>}
  </>;
  return <AppShell page={ready?.page ?? null} sessionId={ready?.sessionId ?? null} waiting={waiting} serverForcesAsk={ready?.serverApprovalMode === "ask"} onNewChat={active.newChat} onToggleCreateMode={active.toggle} onSelectChat={active.selectChat} refreshKey={active.listRefresh} pageRefreshKey={pageRefreshNonce}>{content}</AppShell>;
}

function NotFoundState({ onNewChat }: { onNewChat: () => Promise<void> }) {
  return <div className="full-state not-found-state"><p role="alert">page not found</p><div><a className="primary" href="/">go home</a><button className="primary" onClick={() => void onNewChat()}>new chat</button></div></div>;
}

function EmptyChat({ page, send, continueWaiting }: { page: Page; send: (text: string, intent: { steer: boolean }, track: (id: string) => void) => Promise<void>; continueWaiting: () => Promise<void> }) {
  const starters = ["make a page that tracks my reading list", "what changed in my repos since yesterday", "continue: grade last night's eval runs"];
  return <div className="empty-chat"><h1 title={`new chat on ${page.title}`}>new chat on {page.title}</h1><p>a fresh zeta session with the normal tools. turn on create mode to let it make pages and page tools.</p><div className="chat-starters">{starters.map((starter, index) => <button key={starter} onClick={() => void (index === 2 ? continueWaiting() : send(starter, { steer: false }, () => {}))}><b>{index + 1}</b><span>{starter}</span>{index === 0 ? <i>create mode</i> : index === 2 ? <i>waiting chat</i> : null}</button>)}</div></div>;
}

function ChatHeader({ page, sessionId, title, state, toggling, toggle, toggleError }: { page: Page; sessionId: string | null; title: string; state: string; toggling: boolean; toggle: () => void; toggleError: string | null }) {
  const [overflow, setOverflow] = useState(false);
  const controls = <><span className={`approval-mode mode-${page.approval_mode ?? "ask"}`} aria-label={page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}>{page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}</span><button type="button" aria-pressed={page.create_mode ? "true" : "false"} disabled={toggling} onClick={toggle}>{page.create_mode ? "create mode on" : "create mode off"}</button></>;
  return <header className="chat-header" onKeyDown={(event) => { if (event.key === "Escape") setOverflow(false); }}><div className="chat-heading"><strong title={title} aria-label={title} data-session-id={sessionId ?? undefined}>{title}</strong><span title={page.title} aria-label={page.title}>{page.title}</span></div><div className="chat-actions">{controls}<span className={`run-state state-${state}`}>{state === "approval" ? "waiting on you" : state}</span><button className="header-overflow" aria-label="chat options" aria-expanded={overflow} onClick={() => setOverflow((value) => !value)}>•••</button>{overflow && <div className="header-menu">{controls}</div>}</div>{toggleError && <p role="alert">{toggleError}</p>}</header>;
}

function ConnectionBanner({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const text = connectionFailure(state) ?? "connecting to zeta…";
  if (compact) { const seconds = "retryAt" in state ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : null; return <div className="connection-banner" role="alert"><span>{text}{seconds !== null && ` reconnecting in ${seconds}s…`} the transcript below is the last copy; your draft is kept.</span><button onClick={() => connection.retryNow()}>retry now</button></div>; }
  const command = `zeta serve --ws ${connection.port} --ws-origin ${location.origin}`;
  return <section className="full-state connection-state" role="alert"><p><span className="danger-mark" />{text}{"attempt" in state && ` · tried ${state.attempt} times`}</p><h1>{state.phase === "not_running" ? "start zeta, and this page connects by itself." : text}</h1>{state.phase === "not_running" && <div className="command"><span>shell</span><button onClick={() => navigator.clipboard.writeText(command)}>copy</button><code>$ {command}</code></div>}<button className="primary" onClick={() => connection.retryNow()}>retry now</button></section>;
}

function LayoutBlock({ block, pageId, credential, refreshKey }: { block: Record<string, unknown>; pageId: string; credential: string; refreshKey: string }) {
  if (block.type === "text") return <p>{String(block.text)}</p>;
  if (block.type === "metric") return <p><strong>{String(block.label)}:</strong> {String(block.value)}</p>;
  if (block.type === "list") return <RecordList title={String(block.title)} collection={String(block.collection)} pageId={pageId} credential={credential} refreshKey={refreshKey} />;
  if (block.type === "detail") return <p>{String(block.title)}: {Array.isArray(block.fields) ? block.fields.join(", ") : ""}</p>;
  if (block.type === "form") return <p aria-disabled="true">{String(block.title)}: no tool assigned</p>;
  return null;
}
function RecordList({ title, collection, pageId, credential, refreshKey }: { title: string; collection: string; pageId: string; credential: string; refreshKey: string }) {
  const [records, setRecords] = useState<Record<string, unknown>[]>([]); const [total, setTotal] = useState(0); const [error, setError] = useState<string | null>(null); const requestSequence = useRef(0);
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?limit=100`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch((caught) => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, refreshKey]);
  const columns = [...new Set(records.flatMap((record) => Object.keys(record).filter((key) => key !== "record_id")))]; if (records.some((record) => "record_id" in record)) columns.push("record_id");
  return <section className="record-list"><h2>{title}</h2>{error ? <p role="alert">{error}</p> : records.length === 0 ? <p>no records yet</p> : <><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{records.map((record, index) => <tr key={String(record.record_id ?? index)}>{columns.map((column) => <td key={column}>{formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>{total > 100 && <p>showing newest 100 of {total}</p>}</>}</section>;
}
function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
