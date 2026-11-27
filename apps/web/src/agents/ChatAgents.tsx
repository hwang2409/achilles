import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { wrapTab } from "../keyboard";
import { AgentSpawn } from "./AgentControlViews";
import { AgentRunDetail, StateTag } from "./AgentRunDetail";
import type { ChildControls } from "./childControls";
import type { ChildSendOwner } from "./childSend";
import { createAgentRunsReader, rowKey } from "./reads";
import "../settings-dialog.css";
import "./agents.css";

const idle = () => () => {};
const none = { refreshing: false } as ReturnType<ReturnType<typeof createAgentRunsReader>["snapshot"]>;

// this chat's child runs: spawn, the run list, and the chosen run's detail with cancel and send. every write targets sessionId.
export function ChatAgents({ client, sessionId, title, controls, send, readOnly, initialRun, opener, onClose }: {
  client: ZetaClient | null; sessionId: string; title: string; controls: ChildControls; send: ChildSendOwner; readOnly?: string;
  initialRun?: string; opener: HTMLElement | null; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reader = useMemo(() => client ? createAgentRunsReader(client) : undefined, [client]);
  const snapshot = useSyncExternalStore(reader?.subscribe ?? idle, reader?.snapshot ?? (() => none));
  const [chosenRun, choose] = useState(initialRun);
  const refresh = () => void reader?.refresh({ root: sessionId });
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); opener?.focus(); };
  }, []);
  useEffect(() => { refresh(); return () => reader?.stop(); }, [reader, sessionId]);
  const { report, refreshing, warning } = snapshot;
  const rows = report?.rows ?? [];
  const id = chosenRun ? rowKey(sessionId, chosenRun) : undefined;
  const chosen = rows.find((row) => row.runId === chosenRun);
  const parent = chosen?.parentRunId ? rows.find((row) => row.runId === chosen.parentRunId) : undefined;
  return <dialog ref={dialog} className="settings-dialog chat-agents" aria-labelledby="chat-agents-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}>
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="chat-agents-title">agents in this chat</h2></div>
        <div><button type="button" disabled={!reader || refreshing} onClick={refresh}>{refreshing ? "refreshing…" : "refresh"}</button><button type="button" onClick={onClose}>close</button></div></div>
      <div className="settings-content">
        <AgentSpawn client={client} owner={controls} refresh={refresh} sessionId={sessionId} readOnly={readOnly} />
        {warning && <p role="status">{warning}</p>}
        {report && (rows.length ? <ul className="chat-agents-runs">{rows.map((row) => <li key={row.runId}>
          <button type="button" className="agents-row" aria-current={row.runId === chosenRun ? "true" : undefined} onClick={() => choose(row.runId)}>
            <span className="agents-row-copy"><span className="agents-row-title"><b>{row.agentType ?? "agent"}</b>{row.description ? ` ${row.description}` : ""}</span><small><StateTag row={row} /></small></span>
          </button>
        </li>)}</ul> : <p>no agents in this chat yet.</p>)}
        {id && <AgentRunDetail chosen={chosen} parent={parent} title={title} id={id} client={client} send={send} controls={controls} readOnly={readOnly}
          reportedAt={report?.reportedAt ?? 0} refreshing={refreshing} refresh={refresh} />}
      </div>
    </div>
  </dialog>;
}
