import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import type { SessionLease, ZetaClient } from "@fulcrum/zeta";
import { AppShell, type Chat } from "./AppShell";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, supportsFeature, type Connection, type ConnectionState } from "./zeta";
import { applyApprovalMode, loadSession, openHomeSession } from "./zeta/session";
import "./style.css";

const renderers: Renderers = { message: ({ id }) => <Message id={id} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
type Page = { id: string; route: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; layout: { blocks: Array<Record<string, unknown>> } };
type Attachment = { page: Page; sessionId: string; lease: SessionLease; credential: string; pendingApprovalMode: string | null; title: string };

function connectionFailure(state: ConnectionState): string | null {
  switch (state.phase) {
    case "not_running": return "zeta serve is not running.";
    case "auth_failed": return state.reason === "origin" ? `this origin is not allowed by zeta. restart zeta serve with --ws-origin ${location.origin}.` : "zeta rejected this browser connection.";
    case "unresponsive": return "zeta is not responding.";
    case "incompatible": return "this zeta version is not compatible with achilles.";
    case "dropped": return "the connection to zeta was lost. retrying…";
    default: return null;
  }
}

function attachmentError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.includes("MCP server is not a trusted global server: achilles")
    ? "achilles is not trusted by zeta. add it to $ZETA_HOME/mcp.json, then restart zeta serve."
    : message;
}

async function findChat(sessionId: string) {
  let before: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (before) params.set("before", before);
    const response = await fetch(`/api/chats?${params}`, { cache: "no-store" });
    if (!response.ok) return null;
    const result = await response.json() as { chats: Chat[]; next: string | null };
    const found = result.chats.find((chat) => chat.session_id === sessionId);
    if (found) return found;
    if (!result.chats.length) return null;
    before = result.next;
  } while (before);
  return null;
}

async function attachPage(client: ZetaClient, key: string, selectedId: string | null): Promise<Attachment> {
  const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" });
  if (!loaded.ok) throw new Error("page not found");
  const page = await loaded.json() as Page;
  if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
  const credential = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" }).then((response) => response.json()).then((value) => value.credential as string);
  const selectedChat = selectedId ? await findChat(selectedId) : null;
  if (selectedId && selectedChat?.page_id !== page.id) throw new Error("chat not found on this page");
  let session = await openHomeSession(client, selectedId ?? page.zeta_session_id, credential, page.workspace, page.approval_mode ?? "allow");
  let lease = await loadSession(client, session.id);
  if (!selectedId) {
    const saved = await fetch(`/api/pages/${page.id}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: page.zeta_session_id, session_id: session.id }) });
    if (!saved.ok && saved.status !== 409) { lease.release(); throw new Error(`could not save session mapping (${saved.status})`); }
    if (saved.status === 409) {
      const actual = (await saved.json()).session_id as string;
      lease.release();
      session = await openHomeSession(client, actual, credential, page.workspace, page.approval_mode ?? "allow");
      lease = await loadSession(client, session.id);
    }
  }
  const desiredApprovalMode = page.approval_mode ?? "allow";
  page.approval_mode = session.approvalMode;
  const title = session.name?.trim() || selectedChat?.title?.trim() || (await findChat(session.id))?.title?.trim() || "untitled chat";
  if (session.name?.trim() && session.name.trim() !== selectedChat?.title?.trim()) void fetch(`/api/chats/${encodeURIComponent(session.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  return { page, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? desiredApprovalMode : null, title };
}

const selectedFromUrl = () => new URLSearchParams(location.search).get("chat");
const keyFromPath = () => location.pathname === "/" ? "home" : location.pathname.slice(1);

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [selectedId, setSelectedId] = useState(selectedFromUrl);
  const [page, setPage] = useState<Page | null>(null);
  const [store, setStore] = useState<ReturnType<typeof createRunStore> | null>(null);
  const [client, setClient] = useState<ZetaClient | null>(null);
  const [credential, setCredential] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState("untitled chat");
  const [error, setError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [pendingApprovalMode, setPendingApprovalMode] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const focusAfterAttach = useRef(false);
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
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
    let live = true;
    let attached: Attachment | null = null;
    if (!client || connectionState.phase !== "connected") return;
    setError(null);
    void attachPage(client, keyFromPath(), selectedId).then((next) => {
      if (!live) { next.lease.release(); return; }
      attached = next;
      previousTurn.current = next.lease.store.getState().turn;
      setSessionId(next.sessionId); setPage(next.page); setCredential(next.credential); setStore(next.lease.store); setPendingApprovalMode(next.pendingApprovalMode); setTitle(next.title);
      if (focusAfterAttach.current) { focusAfterAttach.current = false; requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="message"]')?.focus()); }
    }).catch((caught) => { if (live) setError(attachmentError(caught)); });
    return () => { live = false; attached?.lease.release(); };
  }, [client, connectionState.phase, selectedId]);
  useEffect(() => {
    const pop = () => setSelectedId(selectedFromUrl());
    addEventListener("popstate", pop); return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const previous = previousTurn.current; previousTurn.current = turn;
    if (previous !== "running" || turn !== "idle" || !client || !sessionId || !pendingApprovalMode) return;
    let live = true;
    void applyApprovalMode(client, sessionId, pendingApprovalMode).then((result) => {
      if (!live) return;
      setPage((current) => current ? { ...current, approval_mode: result.approvalMode } : current);
      setPendingApprovalMode(result.pending ? pendingApprovalMode : null);
    }).catch((caught) => { if (live) setError(attachmentError(caught)); });
    return () => { live = false; };
  }, [client, pendingApprovalMode, sessionId, turn]);
  const lastState = waiting ? "approval" : outcome === "failed" ? "failed" : turn === "running" ? "running" : "idle";
  useEffect(() => {
    if (!sessionId) return;
    void fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_state: lastState }) }).then(() => setListRefresh((value) => value + 1));
  }, [lastState, sessionId]);

  const selectChat = useCallback((chat: Chat) => {
    const route = chat.page_route === "/" ? "/" : chat.page_route;
    if (route !== location.pathname) { location.assign(`${route}?chat=${encodeURIComponent(chat.session_id)}`); return; }
    history.pushState({}, "", `${route}?chat=${encodeURIComponent(chat.session_id)}`);
    setTitle(chat.title?.trim() || "untitled chat"); setSelectedId(chat.session_id);
  }, []);
  const newChat = useCallback(() => {
    if (!client || !page) return;
    void (async () => {
      try {
        const created = await openHomeSession(client, null, credential, page.workspace, page.approval_mode ?? "allow");
        const registered = await fetch(`/api/pages/${page.id}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: created.id }) });
        if (!registered.ok) throw new Error(`could not save chat (${registered.status})`);
        history.pushState({}, "", `${page.route === "/" ? "/" : page.route}?chat=${encodeURIComponent(created.id)}`);
        focusAfterAttach.current = true; setTitle("untitled chat"); setSelectedId(created.id); setListRefresh((value) => value + 1);
      } catch (caught) { setError(attachmentError(caught)); }
    })();
  }, [client, credential, page]);

  const send = async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    if (!client || !sessionId) throw new Error("zeta is not connected");
    const delivery_id = crypto.randomUUID(); track(delivery_id);
    await client.request(intent.steer ? "steer" : "send", { session_id: sessionId, text, delivery_id });
    if (title === "untitled chat") {
      const nextTitle = text.trim().slice(0, 200);
      const response = await fetch(`/api/chats/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
      if (response.ok) { setTitle(nextTitle); setListRefresh((value) => value + 1); }
    }
  };
  const toggle = async () => {
    if (!page) return;
    setToggleError(null); setToggling(true);
    try {
      const response = await fetch(`/api/pages/${page.id}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !page.create_mode }) });
      if (!response.ok) throw new Error(`could not update create mode (${response.status})`);
      const result = await response.json() as { create_mode: boolean }; setPage({ ...page, create_mode: result.create_mode });
    } catch (caught) { setToggleError(caught instanceof Error ? caught.message : String(caught)); } finally { setToggling(false); }
  };

  const failure = connectionFailure(connectionState);
  const dropped = connectionState.phase === "dropped";
  const approval = client && store ? createApprovalDecider(client, store) : null;
  const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} disabledReason={!approval ? "zeta is offline" : undefined} onApprove={approval ? (request) => approval("approve", request) : undefined} onDeny={approval ? (request) => approval("deny", request) : undefined} /> };
  const content = <>
    {page && <ChatHeader page={page} sessionId={sessionId} title={title} state={lastState} toggling={toggling} toggle={toggle} toggleError={toggleError} />}
    {dropped && failure && <ConnectionBanner state={connectionState} connection={connection} compact />}
    {error ? <div className="full-state"><p role="alert">{error}</p></div> : failure && !dropped ? <ConnectionBanner state={connectionState} connection={connection} /> : !store || !page || !sessionId ? <div className="full-state"><p role="status">connecting to zeta…</p></div> : <RunProvider store={store}>
      <section className="transcript">{Number(outlineLength) === 0 && <div className="empty-chat"><h1>new chat on {page.title}</h1><p>a fresh zeta session with the normal tools. turn on create mode to let it make pages and page tools.</p></div>}<Timeline renderers={appRenderers} />{page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={page.id} credential={credential} refreshKey={refreshKey} />)}</section>
      {!client || dropped ? <Composer key={sessionId} state="read-only" reason="send is off until zeta is back" onSubmit={send} placeholder="message zeta" /> : <Composer key={sessionId} state={turn === "running" ? "steerable" : "idle"} onSubmit={send} onStop={() => client.request("abort", { session_id: sessionId })} placeholder="message zeta" />}
    </RunProvider>}
  </>;
  return <AppShell page={page} sessionId={sessionId} waiting={waiting} onNewChat={newChat} onSelectChat={selectChat} refreshKey={listRefresh}>{content}</AppShell>;
}

function ChatHeader({ page, sessionId, title, state, toggling, toggle, toggleError }: { page: Page; sessionId: string | null; title: string; state: string; toggling: boolean; toggle: () => void; toggleError: string | null }) {
  return <header className="chat-header"><div className="chat-heading"><span>{page.title} /</span><strong data-session-id={sessionId ?? undefined}>{title}</strong></div><div className="chat-actions">{page.approval_mode === "allow" && <span aria-label="auto-approve">auto-approve</span>}<button type="button" aria-pressed={page.create_mode ? "true" : "false"} disabled={toggling} onClick={toggle}>{page.create_mode ? "create mode on" : "create mode off"}</button><span className={`run-state state-${state}`}>{state === "approval" ? "waiting on you" : state}</span></div>{toggleError && <p role="alert">{toggleError}</p>}</header>;
}

function ConnectionBanner({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const text = connectionFailure(state) ?? "connecting to zeta…";
  if (compact) return <div className="connection-banner" role="alert"><span>{text} the transcript below is the last copy; your draft is kept.</span><button onClick={() => connection.retryNow()}>retry now</button></div>;
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
