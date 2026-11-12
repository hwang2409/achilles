import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import { createApprovalDecider } from "./zeta/approvals";
import { createConnection } from "./zeta";
import type { ZetaClient } from "@fulcrum/zeta";
import { loadSession, openHomeSession } from "./zeta/session";
import "./style.css";

const renderers: Renderers = { message: ({ id }) => <Message id={id} />, tool: ({ id }) => <ToolCall id={id} />, error: ({ id }) => <Fallback id={id} /> };
type Page = { id: string; title: string; zeta_session_id: string | null; workspace: string; layout: { blocks: Array<Record<string, unknown>> } };

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [page, setPage] = useState<Page | null>(null); const [store, setStore] = useState<ReturnType<typeof createRunStore> | null>(null);
  const [client, setClient] = useState<ZetaClient | null>(null); const [sessionId, setSessionId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const turn = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store ? () => store.getState().turn : () => "idle" as const);
  useEffect(() => { let live = true; const key = location.pathname === "/" ? "home" : location.pathname.slice(1);
    const unsubscribe = connection.subscribe(() => { const next = connection.client; if (!next || connection.state.phase !== "connected") return; setClient(next);
      void (async () => { try {
        const loaded = await fetch(`/api/pages/${key}`, { cache: "no-store" }); if (!loaded.ok) throw new Error("page not found"); const current = await loaded.json() as Page;
        const credential = await fetch(`/api/pages/${current.id}/credential`, { cache: "no-store" }).then(r => r.json()).then(v => v.credential as string);
        const id = await openHomeSession(next, current.zeta_session_id, credential, current.workspace); const lease = await loadSession(next, id); if (!live) { lease.release(); return; }
        const saved = await fetch(`/api/pages/${current.id}/session`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: current.zeta_session_id, session_id: id }) });
        if (!saved.ok && saved.status !== 409) throw new Error(`could not save session mapping (${saved.status})`);
        const actual = saved.status === 409 ? (await saved.json()).session_id : id; setPage(current); setSessionId(actual); setStore(lease.store);
      } catch (caught) { if (live) setError(caught instanceof Error ? caught.message : String(caught)); } })(); });
    return () => { live = false; unsubscribe(); connection.stop(); };
  }, [connection]);
  if (error) return <main className="shell"><p role="alert">{error}</p></main>;
  if (!store || !client || !sessionId || !page) return <main className="shell"><p role="status">connecting to zeta…</p></main>;
  const approval = createApprovalDecider(client, store); const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} onApprove={r => approval("approve", r)} onDeny={r => approval("deny", r)} /> };
  const send = async (text: string, intent: { steer: boolean }, track: (id: string) => void) => { const delivery_id = crypto.randomUUID(); track(delivery_id); await client.request(intent.steer ? "steer" : "send", { session_id: sessionId, text, delivery_id }); };
  return <RunProvider store={store}><main className="shell"><header><h1>{page.title}</h1><span data-session-id={sessionId}>zeta session</span></header><section className="transcript">{page.layout.blocks.length === 0 ? <Timeline renderers={appRenderers} /> : page.layout.blocks.map((block, index) => block.type === "chat" || block.type === "timeline" ? <Timeline key={index} renderers={appRenderers} /> : block.type === "text" ? <p key={index}>{String(block.text)}</p> : block.type === "metric" ? <p key={index}><strong>{String(block.label)}:</strong> {String(block.value)}</p> : block.type === "list" ? <p key={index}>{String(block.title)}: {String(block.collection)}</p> : null)}</section><Composer state={turn === "running" ? "steerable" : "idle"} onSubmit={send} onStop={() => client.request("abort", { session_id: sessionId })} placeholder="message zeta" /></main></RunProvider>;
}
