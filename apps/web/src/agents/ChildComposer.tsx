import { useEffect, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { WRITE_SURFACE } from "../writeSurfaces";
import { supportsFeature } from "../zeta/connection";
import type { ChildSendOwner } from "./childSend";
import { readAttachedRoot, rowKey, type AgentRun } from "./reads";

export function ChildComposer({ client, row, owner, readOnly, reportedAt, refreshing, refresh }: {
  client: ZetaClient | null; row: AgentRun; owner: ChildSendOwner; readOnly?: string; reportedAt: number; refreshing: boolean; refresh(): void;
}) {
  const { sessionId, runId, agentType } = row;
  // zeta's accepts_send is the send rule; rows from an older zeta fall back to status (a suspended one gets no box)
  const sendable = client && supportsFeature(client, "child_runs") && agentType && row.finishedAt === undefined &&
    (row.acceptsSend ?? (row.acceptsFollowUps && (row.status === "running" || row.status === "idle" || row.status === "waiting")));
  const inspect = sendable ? client : null;
  const [attachment, setAttachment] = useState<{ client: ZetaClient; root: string | null }>();
  useEffect(() => {
    if (!inspect) return;
    const abort = new AbortController();
    void readAttachedRoot(inspect, abort.signal).then(
      (root) => setAttachment({ client: inspect, root }),
      () => { if (!abort.signal.aborted) setAttachment(undefined); },
    );
    return () => abort.abort();
  }, [inspect, reportedAt]);
  const id = rowKey(sessionId, runId);
  const { text, pending, outcome } = useSyncExternalStore(owner.subscribe, () => owner.snapshot(id));
  const blocked = (outcome?.refreshAfter ?? -Infinity) >= reportedAt;
  // one reread per refusal: the row's state changed under the send
  useEffect(() => { if (blocked) refresh(); }, [outcome?.refreshAfter]);
  // a refusal's reread can make the row unsendable: keep the reason, drop the box
  if (!inspect) return outcome ? <p className="agents-composer" role="status">{outcome.message}</p> : null;
  if (attachment?.client !== inspect || attachment.root !== sessionId) return null;
  const label = `send to ${agentType}`;
  return <div className="agents-composer" aria-label={`message ${agentType}`} role="group">
    <textarea aria-label={`message ${agentType}`} placeholder={`message ${agentType}`} value={text} rows={2} readOnly={pending}
      onChange={(event) => owner.edit(id, event.target.value)} />
    <div className="agents-composer-actions">
      <span role="status">{pending ? "sending…" : readOnly ?? outcome?.message ?? (row.status === "suspended" ? "sending wakes it now." : "zeta queues the message for the child’s next safe point.")}</span>
      {blocked && <button type="button" disabled={refreshing} onClick={refresh}>refresh run</button>}
      <button type="button" data-write-surface={WRITE_SURFACE.agentsSend} disabled={!text.trim() || pending || blocked || !!readOnly}
        onClick={() => void owner.send({ sessionId, runId }, reportedAt)}>{label}</button>
    </div>
  </div>;
}
