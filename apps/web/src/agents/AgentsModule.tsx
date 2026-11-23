import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { RunProvider, Timeline } from "@fulcrum/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { readSessionTitles } from "../sessions/reads";
import { ModuleState, ShellDockSlot } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { childHistorySupported, createChildRunsController, newerHistory } from "./childRuns";
import { groupAgentRuns, type RunBranch } from "./groupAgentRuns";
import { AGENT_REFRESH_MS, agentStatuses, catalogStatuses, createAgentRunsReader, rowKey, sourceNote, unavailable, type AgentFilters, type AgentRun } from "./reads";
import "./agents.css";

const short = (id: string) => id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-5)}` : id;
const runHref = (run?: AgentRun) => surfaceHref(run ? `/agents/${encodeURIComponent(run.sessionId)}/${encodeURIComponent(run.runId)}` : "/agents");
const sessionHref = (id: string) => surfaceHref(`/sessions/${encodeURIComponent(id)}`);
const stamp = (time: number) => new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).toLowerCase();
const duration = (seconds: number) => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;

function selection() {
  const [, , root, run, ...extra] = location.pathname.split("/");
  if (!root && !run && !extra.length) return {};
  if (!root || !run || extra.length) return { invalid: true };
  try { return { id: rowKey(decodeURIComponent(root), decodeURIComponent(run)) }; }
  catch { return { invalid: true }; }
}

function StateTag({ row }: { row: AgentRun }) {
  return <span className="agents-state" data-status={row.status}>{row.status}</span>;
}

export function AgentsModule({ client, connecting, retry }: { client: ZetaClient | null; connecting: boolean; retry: () => void }) {
  const reader = useMemo(() => client ? createAgentRunsReader(client) : undefined, [client]);
  const [snapshot, setSnapshot] = useState<ReturnType<NonNullable<typeof reader>["snapshot"]>>({ refreshing: true });
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [filters, setFilters] = useState<AgentFilters>({});
  const [refreshRequest, requestRefresh] = useState(0);
  const [roots, setRoots] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [{ id, invalid }, setSelection] = useState(selection);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLAnchorElement>(null);
  const restore = useRef<string | undefined>(undefined);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!reader) return;
    return reader.subscribe(() => {
      const next = reader.snapshot();
      setSnapshot((old) => next.refreshing && !next.report ? { ...next, report: old.report } : next);
      if (next.report) setRoots((old) => [...new Set([...old, ...next.report!.rows.map((row) => row.sessionId)])]);
    });
  }, [reader]);
  useEffect(() => {
    if (!reader) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const run = () => {
      clearTimeout(timer);
      void reader.refresh(filters).finally(() => {
        clearTimeout(timer);
        if (active) timer = setTimeout(() => { if (!document.hidden) run(); }, AGENT_REFRESH_MS);
      });
    };
    const onFocus = () => { if (!document.hidden && !reader.snapshot().refreshing && !reader.snapshot().paging) run(); };
    run();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { active = false; clearTimeout(timer); reader.stop(); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [reader, filters, refreshRequest]);
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    void readSessionTitles(client, abort.signal).then((names) => { if (!abort.signal.aborted) setTitles(names); }, () => {});
    return () => abort.abort();
  }, [client]);
  useEffect(() => {
    const pop = () => { moveFocus.current = true; setSelection(selection()); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    const url = event.currentTarget.getAttribute("href")!;
    if (url === location.pathname + location.search) return;
    if (!event.currentTarget.dataset.back) history.pushState({ agentsList: !id || history.state?.agentsList === true }, "", url);
    else if (history.state?.agentsList === true) { history.back(); return; }
    else history.replaceState(null, "", url);
    moveFocus.current = true;
    setSelection(selection());
  };
  useLayoutEffect(() => {
    if (moveFocus.current) {
      moveFocus.current = false;
      if (id || invalid) back.current?.focus();
      else ((restore.current && rowRefs.current.get(restore.current)) || search.current)?.focus();
    }
    if (id) restore.current = id;
  }, [id, invalid]);

  const { report, warning, refreshing, paging, unsupported } = snapshot;
  const rows = report?.rows ?? [];
  const byId = new Map(rows.map((row) => [rowKey(row.sessionId, row.runId), row]));
  const chosen = id ? byId.get(id) : undefined;
  const parent = chosen?.parentRunId ? byId.get(rowKey(chosen.sessionId, chosen.parentRunId)) : undefined;
  const matches = query.trim().toLowerCase();
  const shown = matches ? rows.filter((row) => [row.agentType, row.description, row.currentStep, row.runId, titles.get(row.sessionId)].some((value) => value?.toLowerCase().includes(matches))) : rows;
  const lanes = groupAgentRuns(shown);
  const rootTitle = (root: string) => titles.get(root) ?? `session ${short(root)}`;
  const refresh = () => requestRefresh((value) => value + 1);
  const renderRun = ({ run, depth, missingParent }: RunBranch) => {
    const key = rowKey(run.sessionId, run.runId);
    return <li key={key} className="agents-branch" style={{ marginInlineStart: `${Math.min(depth, 5) * 1.15}em` }}>
      <a ref={(element) => { if (element) rowRefs.current.set(key, element); else rowRefs.current.delete(key); }} className="agents-row" href={runHref(run)} onClick={follow} aria-current={id === key ? "page" : undefined} data-status={run.status} data-nested={depth > 0}>
        <div className="agents-row-copy">
          <span className="agents-row-title"><b>{run.agentType ?? short(run.runId)}</b>{run.description ? ` ${run.description}` : ""}</span>
          <small><StateTag row={run} />{run.currentStep && run.currentStep !== run.status ? ` · ${run.currentStep}` : ""}{missingParent && run.parentRunId ? ` · parent ${short(run.parentRunId)}` : ""}</small>
        </div>
        {run.elapsedSeconds !== undefined && <span className="agents-elapsed">{duration(run.elapsedSeconds)}</span>}
      </a>
    </li>;
  };
  return <section className="module-frame agents-frame">
    <header className="agents-head"><h1>agents</h1>{report && <span>{client ? "reported" : "offline · reported"} <time dateTime={new Date(report.reportedAt).toISOString()}>{stamp(report.reportedAt)}</time></span>}</header>
    <ShellDockSlot />
    {!report ? <div className="module-body">
      {!client ? connecting ? <ModuleState kind="loading" title="connecting to zeta" /> : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retry }} />
        : unsupported ? <ModuleState kind="unsupported" title={unavailable} />
        : warning && !refreshing ? <ModuleState kind="failed" title="could not load agent runs" detail={warning} action={{ label: "retry now", run: refresh }} />
        : <ModuleState kind="loading" title="loading agent runs" />}
    </div> : <>
      {(!client || refreshing || warning) && <p className="agents-notice" role="status">{!client ? <>zeta is offline · showing data from {stamp(report.reportedAt)} <button type="button" onClick={retry}>retry now</button></> : refreshing ? "refreshing…" : `showing data from ${stamp(report.reportedAt)} · refresh failed · ${warning}`}</p>}
      <div className="agents-split" data-detail={!!id || !!invalid}>
        <section className="agents-catalog" aria-label="agent run catalog">
          <div className="agents-filters">
            <input ref={search} type="search" aria-label="filter loaded runs" placeholder="filter loaded runs" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div>
              <label>state <select value={filters.status ?? ""} disabled={!client} onChange={(event) => setFilters({ ...filters, status: (event.target.value || undefined) as AgentFilters["status"] })}>
                <option value="">all</option>{(report.source === "catalog" ? catalogStatuses : agentStatuses.filter((state) => report.source === "attached" ? state !== "waiting" : state !== "finishing")).map((state) => <option key={state} value={state}>{state}</option>)}
              </select></label>
              {roots.length > 1 && report.source !== "attached" && <label>session <select value={filters.root ?? ""} disabled={!client} onChange={(event) => setFilters({ ...filters, root: event.target.value || undefined })}>
                <option value="">all</option>{[...roots].sort((a, b) => rootTitle(a).localeCompare(rootTitle(b))).map((root) => <option key={root} value={root}>{rootTitle(root)}</option>)}
              </select></label>}
              <button type="button" disabled={!client || refreshing} onClick={refresh}>refresh now</button>
            </div>
          </div>
          <div className="agents-lane-note">
            {sourceNote[report.source] && <p role="status">{sourceNote[report.source]}</p>}
            <p>lanes group runs by their top-level session. zeta does not store lanes.</p>
            <p>{shown.length} {report.complete ? "runs in view" : "loaded results"}{report.omitted ? ` · ${report.omitted} malformed ${report.omitted === 1 ? "row" : "rows"} omitted` : ""}</p>
          </div>
          {!lanes.length && <ModuleState kind="empty" title={matches || report.filters.status || report.filters.root || !report.complete || report.omitted ? "no agent runs in this view" : "no agent runs yet"} />}
          {lanes.map((lane) => <section className="agents-lane" key={lane.sessionId}>
            <h2><span>{rootTitle(lane.sessionId)}</span><small>{lane.count} {lane.count === 1 ? "run" : "runs"}</small></h2>
            {!!lane.direct.length && <ul>{lane.direct.map(renderRun)}</ul>}
            {!!lane.detached.length && <><h3>parent not in this view</h3><ul>{lane.detached.map(renderRun)}</ul></>}
          </section>)}
          {!report.complete && <button type="button" className="agents-more" disabled={!client || refreshing || paging} onClick={() => void reader?.more()}>{paging ? "loading more…" : "load more runs"}</button>}
        </section>
        <section className="agents-detail" aria-label="agent run detail">
          {(id || invalid) && <a className="agents-back" ref={back} href={runHref()} data-back="true" onClick={follow}>‹ all runs</a>}
          {chosen ? <RunDetail key={id} row={chosen} parent={parent} rootTitle={rootTitle(chosen.sessionId)} client={client} />
            : <ModuleState kind="empty" title={id || invalid ? "run not in this view" : "select a run"}
              detail={invalid ? "this link is not an agent run address." : id ? "clear the filters or load more runs to find it." : "see what the run was doing when zeta last reported it."} />}
        </section>
      </div>
    </>}
  </section>;
}

function RunDetail({ row, parent, rootTitle, client }: { row: AgentRun; parent?: AgentRun; rootTitle: string; client: ZetaClient | null }) {
  const supported = client && childHistorySupported(client);
  const fields: [string, ReactNode][] = [
    ["session", <a href={sessionHref(row.sessionId)} title={row.sessionId}>{rootTitle}</a>],
    ["parent", row.parentRunId ? <span title={row.parentRunId}>{parent?.agentType ? `${parent.agentType} · ` : ""}{short(row.parentRunId)}</span> : undefined],
    ["started", row.startedAt !== undefined && <time dateTime={new Date(row.startedAt).toISOString()}>{stamp(row.startedAt)}</time>],
    ["finished", row.finishedAt !== undefined && <time dateTime={new Date(row.finishedAt).toISOString()}>{stamp(row.finishedAt)}</time>],
    ["elapsed at last refresh", row.elapsedSeconds === undefined ? undefined : duration(row.elapsedSeconds)],
    ["turns", row.turnsUsed], ["tool calls", row.toolCount], ["current step", row.currentStep],
    ["execution", row.background === undefined ? undefined : row.background ? "background" : "foreground"],
  ];
  return <>
    <header className="agents-run-head">
      <h2>{row.agentType && row.description && <span>{row.agentType}</span>} {row.description || row.agentType || "agent run"}</h2>
      <p><StateTag row={row} /> <span title={row.runId}>· run {short(row.runId)}</span></p>
      <dl>{fields.filter(([, value]) => value !== undefined && value !== false && value !== "").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </header>
    <section aria-label="child activity" className="agents-activity">
      <h3>activity <small>stored transcript</small></h3>
      {client && supported ? <RunHistory client={client} row={row} /> : <p>{client ? newerHistory : "connect to zeta to read this transcript."}</p>}
    </section>
  </>;
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
