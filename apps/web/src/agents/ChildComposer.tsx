import { useEffect, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { WRITE_SURFACE } from "../writeSurfaces";
import { supportsFeature } from "../zeta/connection";
import type { ChildSendOwner } from "./childSend";
import { readAttachedRoot, rowKey, type AgentRun } from "./reads";

export function ChildComposer({ client, row, owner, reportedAt, refreshing, refresh }: {
  client: ZetaClient | null; row: AgentRun; owner: ChildSendOwner; reportedAt: number; refreshing: boolean; refresh(): void;
}) {
  const { sessionId, runId, agentType } = row;
  const sendable = client && supportsFeature(client, "child_runs") && agentType && row.acceptsFollowUps &&
    row.finishedAt === undefined && (row.status === "running" || row.status === "idle" || row.status === "waiting");
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
  if (!inspect || attachment?.client !== inspect || attachment.root !== sessionId) return null;
  const label = `send to ${agentType}`;
  const blocked = (outcome?.refreshAfter ?? -Infinity) >= reportedAt;
  return <div className="agents-composer" aria-label={`message ${agentType}`} role="group">
    <textarea aria-label={`message ${agentType}`} placeholder={`message ${agentType}`} value={text} rows={2} readOnly={pending}
      onChange={(event) => owner.edit(id, event.target.value)} />
    <div className="agents-composer-actions">
      <span role="status">{pending ? "sending…" : outcome?.message ?? "zeta queues the message for the child’s next safe point."}</span>
      {blocked && <button type="button" disabled={refreshing} onClick={refresh}>refresh run</button>}
      <button type="button" data-write-surface={WRITE_SURFACE.agentsSend} disabled={!text.trim() || pending || blocked}
        onClick={() => void owner.send({ sessionId, runId }, reportedAt)}>{label}</button>
    </div>
  </div>;
}
