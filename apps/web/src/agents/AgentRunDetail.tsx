import { useEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent, type ReactNode, type Ref } from "react";
import { RunProvider, Timeline } from "@fulcrum/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { AgentCancel } from "./AgentControlViews";
import { runDisplayId, type ChildControls } from "./childControls";
import { ChildComposer } from "./ChildComposer";
import { childHistorySupported, createChildRunsController, newerHistory } from "./childRuns";
import type { ChildSendOwner } from "./childSend";
import type { AgentRun } from "./reads";

export const short = (id: string) => id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id;
export const stamp = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
export const duration = (seconds: number) => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
const sessionHref = (id: string) => surfaceHref(`/sessions/${encodeURIComponent(id)}`);
export function StateTag({ row }: { row: AgentRun }) {
  return <span className="agents-state" data-status={row.status}>{row.status}</span>;
}

export function AgentRunDetail({ chosen, parent, title, id, invalid, back, follow, client, send, controls, readOnly, reportedAt, refreshing, refresh }: {
  chosen?: AgentRun; parent?: AgentRun; title?: string; id?: string; invalid?: boolean;
  back?: Ref<HTMLAnchorElement>; follow?: (event: MouseEvent<HTMLAnchorElement>) => void;
  client: ZetaClient | null; send?: ChildSendOwner; controls?: ChildControls; readOnly?: string; reportedAt: number; refreshing: boolean; refresh: () => void;
}) {
  return <section className="agents-detail" aria-label="agent run detail">
    <div className="agents-detail-scroll">
      {back && (id || invalid) && <a className="agents-back" ref={back} href={surfaceHref("/agents")} data-back="true" onClick={follow}>‹ all runs</a>}
      {chosen ? <RunDetail key={id} row={chosen} parent={parent} rootTitle={title!} />
        : <ModuleState kind="empty" title={id || invalid ? "run not in this view" : "select a run"}
          detail={invalid ? "this link is not an agent run address." : id ? "clear the filters or load more runs to find it." : "see what the run was doing when zeta last reported it."} />}
      {chosen && !controls && <p className="agents-cancel">control this run from its chat.</p>}
      {controls && <AgentCancel key={`cancel-${id}`} client={client} row={chosen} parent={parent} title={title} owner={controls} refresh={refresh} readOnly={readOnly}
        elapsed={chosen?.elapsedSeconds === undefined ? "elapsed unavailable" : `${duration(chosen.elapsedSeconds)} at last refresh`} />}
      {chosen && <RunActivity client={client} row={chosen} />}
    </div>
    {chosen && send && <ChildComposer key={id} client={client} row={chosen} owner={send} readOnly={readOnly} reportedAt={reportedAt} refreshing={refreshing} refresh={refresh} />}
  </section>;
}

function RunDetail({ row, parent, rootTitle }: { row: AgentRun; parent?: AgentRun; rootTitle: string }) {
  const fields: [string, ReactNode][] = [
    ["session", <a href={sessionHref(row.sessionId)} title={row.sessionId}>{rootTitle}</a>],
    ["parent", row.parentRunId ? <span title={row.parentRunId}>{parent?.agentType ? `${parent.agentType} · ` : ""}{short(row.parentRunId)}</span> : undefined],
    ["started", row.startedAt !== undefined && <time dateTime={new Date(row.startedAt).toISOString()}>{stamp(row.startedAt)}</time>],
    ["finished", row.finishedAt !== undefined && <time dateTime={new Date(row.finishedAt).toISOString()}>{stamp(row.finishedAt)}</time>],
    ["elapsed at last refresh", row.elapsedSeconds === undefined ? undefined : duration(row.elapsedSeconds)],
    ["turns", row.turnsUsed], ["tool calls", row.toolCount], ["current step", row.currentStep],
    ["execution", row.background === undefined ? undefined : row.background ? "background" : "foreground"],
  ];
  return <header className="agents-run-head">
      <h2>{row.agentType && row.description && <span>{row.agentType}</span>} {row.description || row.agentType || "agent run"}</h2>
      <p><StateTag row={row} /> <span title={row.runId}>· run {runDisplayId(row.agentType, row.runId)}</span></p>
      <dl>{fields.filter(([, value]) => value !== undefined && value !== false && value !== "").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </header>;
}

function RunActivity({ client, row }: { client: ZetaClient | null; row: AgentRun }) {
  return <section aria-label="child activity" className="agents-activity">
      <h3>activity <small>stored transcript</small></h3>
      {client && childHistorySupported(client) ? <RunHistory client={client} row={row} /> : <p>{client ? newerHistory : "connect to zeta to read this transcript."}</p>}
  </section>;
}

function RunHistory({ client, row }: { client: ZetaClient; row: AgentRun }) {
  const { sessionId, runId } = row;
  const owner = useMemo(() => createChildRunsController(client, { sessionId, runId }), [client, sessionId, runId]);
  const result = useSyncExternalStore(owner.subscribe, owner.snapshot);
  const revision = JSON.stringify([row.status, row.turnsUsed, row.toolCount, row.currentStep, row.finishedAt]);
  const seen = useRef(revision);
  useEffect(() => { void owner.refresh(); return () => owner.close(); }, [owner]);
  useEffect(() => { if (seen.current !== revision) { seen.current = revision; void owner.changed(); } }, [owner, revision]);
  return <>
    {result.loading && <ModuleState kind="loading" title="reading child history" />}
    {result.warning && <p role="status">{result.warning}</p>}
    {result.stale && <p role="status">run changed · refresh to read the latest stored history</p>}
    {!result.limited && <button type="button" disabled={result.loading} onClick={() => void owner.refresh()}>refresh transcript</button>}
    {result.result && (result.progress?.complete && result.progress.messages === 0 ? <p>no stored messages</p> : <div className="agents-timeline"><RunProvider store={result.result.lease.store}><Timeline /></RunProvider></div>)}
  </>;
}
