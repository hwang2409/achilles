import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, supportsFeature, type ConnectionState } from "./zeta";
import type { ZetaClient } from "@fulcrum/zeta";
import { applyApprovalMode, loadSession, openHomeSession } from "./zeta/session";
import type { SessionLease } from "@fulcrum/zeta";
import { SettingsControl } from "./SettingsDialog";
import { getSettings } from "./settings";

const renderers: Renderers = { message: ({ id }) => <Message id={id} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
type Page = { id: string; title: string; zeta_session_id: string | null; workspace: string; create_mode: boolean; approval_mode?: string | null; server_forces_ask?: boolean; layout: { blocks: Array<Record<string, unknown>> } };
type Attachment = { page: Page; sessionId: string; lease: SessionLease; credential: string; pendingApprovalMode: string | null };

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

async function attachPage(client: ZetaClient, key: string): Promise<Attachment> {
  const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" });
  if (!loaded.ok) throw new Error("page not found");
  const page = await loaded.json() as Page;
  if (!supportsFeature(client, "session_mcp_bindings")) throw new Error("this zeta does not support page tools");
  const credential = await fetch(`/api/pages/${page.id}/credential`, { cache: "no-store" }).then(r => r.json()).then(v => v.credential as string);
  page.server_forces_ask = page.approval_mode === "ask";
  const desiredApprovalMode = page.server_forces_ask || (page.zeta_session_id === null && !getSettings().autoApproveDefault) ? "ask" : "allow";
  let session = await openHomeSession(client, page.zeta_session_id, credential, page.workspace, desiredApprovalMode);
  let lease = await loadSession(client, session.id);
  const saved = await fetch(`/api/pages/${page.id}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: page.zeta_session_id, session_id: session.id }) });
  if (!saved.ok && saved.status !== 409) { lease.release(); throw new Error(`could not save session mapping (${saved.status})`); }
  if (saved.status === 409) { const actual = (await saved.json()).session_id as string; lease.release(); session = await openHomeSession(client, actual, credential, page.workspace, desiredApprovalMode); lease = await loadSession(client, session.id); }
  page.approval_mode = session.approvalMode;
  return { page, sessionId: session.id, lease, credential, pendingApprovalMode: session.pending ? desiredApprovalMode : null };
}

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [page, setPage] = useState<Page | null>(null); const [store, setStore] = useState<ReturnType<typeof createRunStore> | null>(null);
  const [client, setClient] = useState<ZetaClient | null>(null); const [credential, setCredential] = useState(""); const [sessionId, setSessionId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [toggleError, setToggleError] = useState<string | null>(null); const [toggling, setToggling] = useState(false); const [pendingApprovalMode, setPendingApprovalMode] = useState<string | null>(null);
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const snapshot = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store ? () => { const state = store.getState(); const completedTurns = state.turn === "idle" ? state.turns.length : Math.max(0, state.turns.length - 1); const completedTools = state.outline.reduce((count, item) => { if (item.kind !== "tool") return count; const value = store.getItem(item.id); return count + (value?.type === "tool" && !value.active ? 1 : 0); }, 0); return `${state.turn}:${completedTurns}:${completedTools}`; } : () => "idle:0:0");
  const [turn, completedTurns, completedTools] = snapshot.split(":") as ["idle" | "running", string, string];
  const refreshKey = `${completedTurns}:${completedTools}`;
  const previousTurn = useRef(turn);
  useEffect(() => { let live = true; let attempt = 0; let attachment: Attachment | null = null; const key = location.pathname === "/" ? "home" : location.pathname.slice(1);
    const unsubscribe = connection.subscribe(() => { const next = connection.client; if (!next || connection.state.phase !== "connected") return; const current = ++attempt; setClient(next); setError(null);
      void (async () => { try {
        const attached = await attachPage(next, key); if (!live || current !== attempt) { attached.lease.release(); return; }
        attachment?.lease.release(); attachment = attached;
        previousTurn.current = attached.lease.store.getState().turn;
        setSessionId(attached.sessionId); setPage(attached.page); setCredential(attached.credential); setStore(attached.lease.store); setPendingApprovalMode(attached.pendingApprovalMode);
      } catch (caught) { if (live && current === attempt) setError(attachmentError(caught)); } })(); });
    return () => { live = false; attachment?.lease.release(); unsubscribe(); connection.stop(); };
  }, [connection]);
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
  if (error) return <main className="shell"><p role="alert">{error}</p></main>;
  const failure = connectionFailure(connectionState);
  if (failure) return <main className="shell"><p role="alert">{failure}</p></main>;
  if (!store || !client || !sessionId || !page) return <main className="shell"><p role="status">connecting to zeta…</p></main>;
  const approval = createApprovalDecider(client, store); const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} onApprove={r => approval("approve", r)} onDeny={r => approval("deny", r)} /> };
  const send = async (text: string, intent: { steer: boolean }, track: (id: string) => void) => { const delivery_id = crypto.randomUUID(); track(delivery_id); await client.request(intent.steer ? "steer" : "send", { session_id: sessionId, text, delivery_id }); };
  const toggle = async () => { setToggleError(null); setToggling(true); try { const response = await fetch(`/api/pages/${page.id}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !page.create_mode }) }); if (!response.ok) throw new Error(`could not update create mode (${response.status})`); const result = await response.json() as { create_mode: boolean }; setPage({ ...page, create_mode: result.create_mode }); } catch (caught) { setToggleError(caught instanceof Error ? caught.message : String(caught)); } finally { setToggling(false); } };
  return <RunProvider store={store}><main className="shell"><SettingsControl serverForcesAsk={page.server_forces_ask} /><header><div><h1>{page.title}</h1><span data-session-id={sessionId}>zeta session</span>{page.approval_mode === "allow" && <span aria-label="auto-approve">auto-approve</span>}</div><button type="button" aria-pressed={page.create_mode ? "true" : "false"} disabled={toggling} onClick={toggle}>{page.create_mode ? "create mode on" : "create mode off"}</button>{toggleError && <p role="alert">{toggleError}</p>}</header><section className="transcript"><Timeline renderers={appRenderers} />{page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} pageId={page.id} credential={credential} refreshKey={refreshKey} />)}</section><Composer state={turn === "running" ? "steerable" : "idle"} onSubmit={send} onStop={() => client.request("abort", { session_id: sessionId })} placeholder="message zeta" /></main></RunProvider>;
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
  useEffect(() => { let live = true; const request = ++requestSequence.current; void fetch(`/api/pages/${pageId}/records/${encodeURIComponent(collection)}?limit=100`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" }).then(async response => { if (!response.ok) throw new Error(`could not load records (${response.status})`); const value = await response.json(); if (!Array.isArray(value)) throw new Error("invalid records response"); if (live && request === requestSequence.current) { setRecords(value); setTotal(Number(response.headers.get("x-achilles-total") ?? value.length)); setError(null); } }).catch(caught => { if (live && request === requestSequence.current) setError(caught instanceof Error ? caught.message : String(caught)); }); return () => { live = false; }; }, [collection, credential, pageId, refreshKey]);
  const columns = [...new Set(records.flatMap(record => Object.keys(record).filter(key => key !== "record_id")))]; if (records.some(record => "record_id" in record)) columns.push("record_id");
  return <section className="record-list"><h2>{title}</h2>{error ? <p role="alert">{error}</p> : records.length === 0 ? <p>no records yet</p> : <><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{records.map((record, index) => <tr key={String(record.record_id ?? index)}>{columns.map(column => <td key={column}>{formatRecordValue(record[column])}</td>)}</tr>)}</tbody></table>{total > 100 && <p>showing newest 100 of {total}</p>}</>}</section>;
}
function formatRecordValue(value: unknown): string { return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""); }
