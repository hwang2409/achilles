import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection, supportsFeature, type ConnectionState } from "./zeta";
import type { ZetaClient } from "@fulcrum/zeta";
import { loadSession, openHomeSession, rebindPage } from "./zeta/session";
import type { SessionLease } from "@fulcrum/zeta";
import "./style.css";

const renderers: Renderers = { message: ({ id }) => <Message id={id} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
type Page = { id: string; title: string; zeta_session_id: string | null; workspace: string; layout: { blocks: Array<Record<string, unknown>> } };
type Attachment = { page: Page; sessionId: string; lease: SessionLease };

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
  const binding = { cwd: page.workspace, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${credential}` } }] };
  const id = await openHomeSession(client, page.zeta_session_id, credential, page.workspace);
  let lease = await loadSession(client, id);
  const saved = await fetch(`/api/pages/${page.id}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: page.zeta_session_id, session_id: id }) });
  if (!saved.ok && saved.status !== 409) { lease.release(); throw new Error(`could not save session mapping (${saved.status})`); }
  if (saved.status === 409) { const actual = (await saved.json()).session_id as string; lease.release(); await rebindPage(client, actual, binding); lease = await loadSession(client, actual); return { page, sessionId: actual, lease }; }
  return { page, sessionId: id, lease };
}

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [page, setPage] = useState<Page | null>(null); const [store, setStore] = useState<ReturnType<typeof createRunStore> | null>(null);
  const [client, setClient] = useState<ZetaClient | null>(null); const [sessionId, setSessionId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const connectionState = useSyncExternalStore(connection.subscribe, () => connection.state);
  const turn = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store ? () => store.getState().turn : () => "idle" as const);
  useEffect(() => { let live = true; let attempt = 0; let attachment: Attachment | null = null; const key = location.pathname === "/" ? "home" : location.pathname.slice(1);
    const unsubscribe = connection.subscribe(() => { const next = connection.client; if (!next || connection.state.phase !== "connected") return; const current = ++attempt; setClient(next); setError(null);
      void (async () => { try {
        const attached = await attachPage(next, key); if (!live || current !== attempt) { attached.lease.release(); return; }
        attachment?.lease.release(); attachment = attached;
        setSessionId(attached.sessionId); setPage(attached.page); setStore(attached.lease.store);
      } catch (caught) { if (live && current === attempt) setError(attachmentError(caught)); } })(); });
    return () => { live = false; attachment?.lease.release(); unsubscribe(); connection.stop(); };
  }, [connection]);
  if (error) return <main className="shell"><p role="alert">{error}</p></main>;
  const failure = connectionFailure(connectionState);
  if (failure) return <main className="shell"><p role="alert">{failure}</p></main>;
  if (!store || !client || !sessionId || !page) return <main className="shell"><p role="status">connecting to zeta…</p></main>;
  const approval = createApprovalDecider(client, store); const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} onApprove={r => approval("approve", r)} onDeny={r => approval("deny", r)} /> };
  const send = async (text: string, intent: { steer: boolean }, track: (id: string) => void) => { const delivery_id = crypto.randomUUID(); track(delivery_id); await client.request(intent.steer ? "steer" : "send", { session_id: sessionId, text, delivery_id }); };
  return <RunProvider store={store}><main className="shell"><header><h1>{page.title}</h1><span data-session-id={sessionId}>zeta session</span></header><section className="transcript"><Timeline renderers={appRenderers} />{page.layout.blocks.map((block, index) => <LayoutBlock key={index} block={block} />)}</section><Composer state={turn === "running" ? "steerable" : "idle"} onSubmit={send} onStop={() => client.request("abort", { session_id: sessionId })} placeholder="message zeta" /></main></RunProvider>;
}

function LayoutBlock({ block }: { block: Record<string, unknown> }) {
  if (block.type === "text") return <p>{String(block.text)}</p>;
  if (block.type === "metric") return <p><strong>{String(block.label)}:</strong> {String(block.value)}</p>;
  if (block.type === "list") return <p>{String(block.title)}: {String(block.collection)}</p>;
  if (block.type === "detail") return <p>{String(block.title)}: {Array.isArray(block.fields) ? block.fields.join(", ") : ""}</p>;
  if (block.type === "form") return <p aria-disabled="true">{String(block.title)}: no tool assigned</p>;
  return null;
}
