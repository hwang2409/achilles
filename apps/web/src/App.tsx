import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type ComposerProps, type Renderers } from "@fulcrum/react";
import { AppShell } from "./AppShell";
import { draftStore } from "./draftStore";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, type Connection, type ConnectionState } from "./zeta";
import { useActiveChat, type Page } from "./useActiveChat";
import "./style.css";

const renderers: Renderers = { message: ({ id }) => <Message id={id} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
const LazyVimComposer = lazy(() => import("./composer/VimComposer").then(({ VimComposer }) => ({ default: VimComposer })));

function vimEnabled() {
  if (matchMedia("(pointer: coarse)").matches) return false;
  try { return JSON.parse(localStorage.getItem("achilles-settings") ?? "null")?.vim === true; }
  catch { return false; }
}

function ComposerSlot({ sessionId, focus, vim, props }: { sessionId: string; focus: boolean; vim: boolean; props: ComposerProps }) {
  const slot = useRef<HTMLDivElement>(null);
  const previousVim = useRef(vim);
  const storedDraft = draftStore.get(sessionId);
  const draft = vim && !previousVim.current ? slot.current?.querySelector<HTMLTextAreaElement>("textarea")?.value ?? storedDraft : storedDraft;
  useLayoutEffect(() => {
    if (vim && !previousVim.current) draftStore.set(sessionId, draft);
    previousVim.current = vim;
  }, [draft, sessionId, vim]);
  useLayoutEffect(() => { if (focus) slot.current?.querySelector<HTMLElement>('textarea[aria-label="message"], [role="textbox"]')?.focus({ preventScroll: true }); }, [focus]);
  const composer = vim
    ? <Suspense fallback={<VimLoading />}><LazyVimComposer {...props} defaultValue={draft} onDraftChange={(text) => draftStore.set(sessionId, text)} /></Suspense>
    : <Composer {...props} defaultValue={draft} />;
  return <div ref={slot} style={{ display: "contents" }}>{composer}</div>;
}

function VimLoading() {
  return <div className="vim-loading" data-part="composer" data-state="read-only" role="group" aria-label="message" aria-disabled="true"><div data-part="composer-field"><textarea rows={1} aria-label="message" placeholder="loading vim…" disabled /></div></div>;
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
    return `${state.turn}:${completedTurns}:${completedTools}:${approvals}:${state.endOutcome ?? ""}:${state.outline.length}`;
  } : () => "idle:0:0:0::0");
  const [turn, completedTurns, completedTools, approvalCount, outcome, outlineLength] = snapshot.split(":") as ["idle" | "running", string, string, string, string, string];
  const refreshKey = `${completedTurns}:${completedTools}`;
  const waiting = Number(approvalCount);
  const previousTurn = useRef(turn);

  useEffect(() => {
    const unsubscribe = connection.subscribe(() => setClient(connection.client));
    return () => { unsubscribe(); connection.stop(); };
  }, [connection]);
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
    {active.creationError ? <div className="full-state"><p role="alert">{active.creationError}</p><button className="primary" onClick={active.retrySaving}>retry saving this chat</button></div>
      : active.state.phase === "missing" ? <div className="full-state"><p role="alert">this chat no longer exists</p><button className="primary" onClick={active.newChat}>new chat</button></div>
      : active.state.phase === "error" ? <div className="full-state"><p role="alert">{active.state.error}</p></div>
      : failure && !lost ? <ConnectionBanner state={connectionState} connection={connection} />
      : !ready || !store ? <div className="full-state"><p role="status">loading chat…</p></div>
      : <RunProvider store={store}>
        <section className="transcript">{Number(outlineLength) === 0 && <EmptyChat page={ready.page} send={active.send} continueWaiting={active.continueWaitingChat} />}<Timeline renderers={appRenderers} />{ready.page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={ready.page.id} credential={ready.credential} refreshKey={refreshKey} />)}</section>
        <ComposerSlot key={ready.sessionId} sessionId={ready.sessionId} focus={active.focusSessionId === ready.sessionId} vim={vimEnabled()} props={!connected || !client ? { state: "read-only", reason: "send is off until zeta is back", onSubmit: active.send, placeholder: "message zeta" } : { state: turn === "running" ? "steerable" : "idle", onSubmit: active.send, onStop: () => client.request("abort", { session_id: ready.sessionId }), placeholder: "message zeta" }} />
      </RunProvider>}
  </>;
  return <AppShell page={ready?.page ?? null} sessionId={ready?.sessionId ?? null} waiting={waiting} onNewChat={active.newChat} onSelectChat={active.selectChat} refreshKey={active.listRefresh}>{content}</AppShell>;
}

function EmptyChat({ page, send, continueWaiting }: { page: Page; send: (text: string, intent: { steer: boolean }, track: (id: string) => void) => Promise<void>; continueWaiting: () => Promise<void> }) {
  const starters = ["make a page that tracks my reading list", "what changed in my repos since yesterday", "continue: grade last night's eval runs"];
  return <div className="empty-chat"><h1>new chat on {page.title}</h1><p>a fresh zeta session with the normal tools. turn on create mode to let it make pages and page tools.</p><div className="chat-starters">{starters.map((starter, index) => <button key={starter} onClick={() => void (index === 2 ? continueWaiting() : send(starter, { steer: false }, () => {}))}><b>{index + 1}</b><span>{starter}</span>{index === 0 ? <i>create mode</i> : index === 2 ? <i>waiting chat</i> : null}</button>)}</div></div>;
}

function ChatHeader({ page, sessionId, title, state, toggling, toggle, toggleError }: { page: Page; sessionId: string | null; title: string; state: string; toggling: boolean; toggle: () => void; toggleError: string | null }) {
  const [overflow, setOverflow] = useState(false);
  const controls = <><span className={`approval-mode mode-${page.approval_mode ?? "ask"}`} aria-label={page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}>{page.approval_mode === "allow" ? "auto-approve" : "ask before tools"}</span><button type="button" aria-pressed={page.create_mode ? "true" : "false"} disabled={toggling} onClick={toggle}>{page.create_mode ? "create mode on" : "create mode off"}</button></>;
  return <header className="chat-header" onKeyDown={(event) => { if (event.key === "Escape") setOverflow(false); }}><div className="chat-heading"><strong data-session-id={sessionId ?? undefined}>{title}</strong><span>{page.title}</span></div><div className="chat-actions">{controls}<span className={`run-state state-${state}`}>{state === "approval" ? "waiting on you" : state}</span><button className="header-overflow" aria-label="chat options" aria-expanded={overflow} onClick={() => setOverflow((value) => !value)}>•••</button>{overflow && <div className="header-menu">{controls}</div>}</div>{toggleError && <p role="alert">{toggleError}</p>}</header>;
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
