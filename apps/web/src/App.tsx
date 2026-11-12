import { useEffect, useMemo, useState } from "react";
import { Approval, Composer, Fallback, Message, RunProvider, Timeline, ToolCall, type Renderers } from "@fulcrum/react";
import { createApprovalDecider } from "./zeta/approvals";
import { createRunStore } from "@fulcrum/core";
import { createConnection } from "./zeta";
import type { ZetaClient } from "@fulcrum/zeta";
import { loadSession, openHomeSession } from "./zeta/session";
import "./style.css";

const renderers: Renderers = {
  message: ({ id }) => <Message id={id} />,
  tool: ({ id }) => <ToolCall id={id} />,
  error: ({ id }) => <Fallback id={id} />,
};

export function App() {
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const [store, setStore] = useState<ReturnType<typeof createRunStore> | null>(null);
  const [client, setClient] = useState<ZetaClient | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const unsubscribe = connection.subscribe(() => {
      const next = connection.client;
      if (!next || connection.state.phase !== "connected") return;
      setClient(next);
      void (async () => {
        try {
          const page = await fetch("/api/pages/home", { cache: "no-store" }).then((response) => response.json());
          const id = await openHomeSession(next, page.zeta_session_id);
          const lease = await loadSession(next, id);
          if (!live) return lease.release();
          const saved = await fetch("/api/pages/home/session", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: page.zeta_session_id, session_id: id }) });
          if (saved.status === 409) {
            const winner = (await saved.json()).session_id;
            if (typeof winner !== "string") throw new Error("session mapping changed without a winner");
            lease.release();
            const winningLease = await loadSession(next, winner);
            if (live) { setSessionId(winner); setStore(winningLease.store); } else winningLease.release();
          } else {
            if (!saved.ok) throw new Error(`could not save session mapping (${saved.status})`);
            setSessionId(id); setStore(lease.store);
          }
        } catch (caught) { if (live) setError(caught instanceof Error ? caught.message : String(caught)); }
      })();
    });
    return () => { live = false; unsubscribe(); connection.stop(); };
  }, [connection]);
  if (error) return <main className="shell"><p role="alert">{error}</p></main>;
  if (!store || !client || !sessionId) return <main className="shell"><p role="status">connecting to zeta…</p></main>;
  const approval = createApprovalDecider(client, store);
  const appRenderers: Renderers = { ...renderers, approval: ({ id }) => <Approval id={id} onApprove={(requestId) => approval("approve", requestId)} onDeny={(requestId) => approval("deny", requestId)} /> };
  const send = async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
    const delivery_id = crypto.randomUUID(); track(delivery_id);
    await client.request(intent.steer ? "steer" : "send", { session_id: sessionId, text, delivery_id });
  };
  return <RunProvider store={store}><main className="shell"><header><h1>home</h1><span data-session-id={sessionId}>zeta session</span></header><section className="transcript"><Timeline renderers={appRenderers} /></section><Composer state="idle" onSubmit={send} onStop={() => client.request("abort", { session_id: sessionId })} placeholder="message zeta" /></main></RunProvider>;
}
