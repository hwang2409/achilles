import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { readSessionTitles } from "../sessions/reads";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import type { ChildSendOwner } from "./childSend";
import { groupAgentRuns, type RunBranch } from "./groupAgentRuns";
import { AGENT_REFRESH_MS, agentStatuses, catalogStatuses, createAgentRunsReader, rowKey, sourceNote, unavailable, type AgentFilters, type AgentRun } from "./reads";
import type { ChildControls } from "./childControls";
import { AgentSpawn } from "./AgentControlViews";
import { AgentRunDetail, duration, short, stamp, StateTag } from "./AgentRunDetail";

const runHref = (run?: AgentRun) => surfaceHref(run ? `/agents/${encodeURIComponent(run.sessionId)}/${encodeURIComponent(run.runId)}` : "/agents");

function selection() {
  const [, , root, run, ...extra] = location.pathname.split("/");
  if (!root && !run && !extra.length) return {};
  if (!root || !run || extra.length) return { invalid: true };
  try { return { id: rowKey(decodeURIComponent(root), decodeURIComponent(run)) }; }
  catch { return { invalid: true }; }
}

export function AgentsModule({ client, connecting, retry, send, controls }: { client: ZetaClient | null; connecting: boolean; retry: () => void; send: ChildSendOwner; controls: ChildControls }) {
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
    return <li key={key}  style={{ marginInlineStart: `${Math.min(depth, 5) * 1.15}em` }}>
      <a ref={(element) => { if (element) rowRefs.current.set(key, element); else rowRefs.current.delete(key); }} className="flex min-h-11 items-center gap-2 border-b border-s-2 border-s-transparent px-4 py-1 hover:bg-accent aria-[current=page]:border-s-ring aria-[current=page]:bg-accent" href={runHref(run)} onClick={follow} aria-current={id === key ? "page" : undefined} data-status={run.status} data-nested={depth > 0}>
        <div className="min-w-0 flex-1 [&>small]:block [&>small]:truncate [&>small]:text-muted-foreground">
          <span className="block truncate [&_b]:font-semibold"><b>{run.agentType ?? short(run.runId)}</b>{run.description ? ` ${run.description}` : ""}</span>
          <small><StateTag row={run} />{run.currentStep && run.currentStep !== run.status ? ` · ${run.currentStep}` : ""}{missingParent && run.parentRunId ? ` · parent ${short(run.parentRunId)}` : ""}</small>
        </div>
        {run.elapsedSeconds !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration(run.elapsedSeconds)}</span>}
      </a>
    </li>;
  };
  return <ModuleFrame title="Agents" actions={report && <span className="text-sm tabular-nums text-muted-foreground">{client ? "reported" : "offline · reported"} <time dateTime={new Date(report.reportedAt).toISOString()}>{stamp(report.reportedAt)}</time></span>}>
    <AgentSpawn client={client} owner={controls} refresh={refresh} />
    {!report ? <>
      {!client ? connecting ? <ModuleState kind="loading" title="connecting to zeta" /> : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: retry }} />
        : unsupported ? <ModuleState kind="unsupported" title={unavailable} />
        : warning && !refreshing ? <ModuleState kind="failed" title="could not load agent runs" detail={warning} action={{ label: "retry now", run: refresh }} />
        : <ModuleState kind="loading" title="loading agent runs" />}
    </> : <>
      {(!client || refreshing || warning) && <p className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm text-muted-foreground" role="status">{!client ? <>zeta is offline · showing data from {stamp(report.reportedAt)} <Button variant="outline" type="button" onClick={retry}>retry now</Button></> : refreshing ? "refreshing…" : `showing data from ${stamp(report.reportedAt)} · refresh failed · ${warning}`}</p>}
      <div className="group grid min-h-0 w-full flex-1 min-[761px]:[@media(min-height:501px)]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-detail={!!id || !!invalid}>
        <section className="min-w-0 overflow-auto min-[761px]:border-e max-[760px]:group-data-[detail=true]:hidden [@media(max-height:500px)]:group-data-[detail=true]:hidden" aria-label="agent run catalog">
          <div className="grid gap-2 border-b p-4 [&>div]:flex [&>div]:flex-wrap [&>div]:items-end [&>div]:gap-2 [&_label]:grid [&_label]:gap-1 [&_label]:text-sm [&_label]:text-muted-foreground">
            <Input ref={search} type="search" aria-label="filter loaded runs" placeholder="filter loaded runs" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div>
              <label>state <select value={filters.status ?? ""} disabled={!client} onChange={(event) => setFilters({ ...filters, status: (event.target.value || undefined) as AgentFilters["status"] })}>
                <option value="">all</option>{(report.source === "catalog" ? catalogStatuses : agentStatuses.filter((state) => report.source === "attached" ? state !== "waiting" : state !== "finishing")).map((state) => <option key={state} value={state}>{state}</option>)}
              </select></label>
              {roots.length > 1 && report.source !== "attached" && <label>session <select value={filters.root ?? ""} disabled={!client} onChange={(event) => setFilters({ ...filters, root: event.target.value || undefined })}>
                <option value="">all</option>{[...roots].sort((a, b) => rootTitle(a).localeCompare(rootTitle(b))).map((root) => <option key={root} value={root}>{rootTitle(root)}</option>)}
              </select></label>}
              <Button variant="outline" type="button" disabled={!client || refreshing} onClick={refresh}>refresh now</Button>
            </div>
          </div>
          <div className="grid gap-1 px-4 py-2 text-sm text-muted-foreground">
            {sourceNote[report.source] && <p role="status">{sourceNote[report.source]}</p>}
            <p>lanes group runs by their top-level session. zeta does not store lanes.</p>
            <p>{shown.length} {report.complete ? "runs in view" : "loaded results"}{report.omitted ? ` · ${report.omitted} malformed ${report.omitted === 1 ? "row" : "rows"} omitted` : ""}</p>
          </div>
          {!lanes.length && <ModuleState kind="empty" title={matches || report.filters.status || report.filters.root || !report.complete || report.omitted ? "no agent runs in this view" : "no agent runs yet"} />}
          {lanes.map((lane) => <section className="border-t [&_h2]:flex [&_h2]:justify-between [&_h2]:gap-2 [&_h2]:px-4 [&_h2]:py-2 [&_h2]:font-semibold [&_h3]:px-4 [&_h3]:text-sm [&_h3]:text-muted-foreground [&_h2>small]:shrink-0 [&_h2>small]:text-muted-foreground" key={lane.sessionId}>
            <h2><span>{rootTitle(lane.sessionId)}</span><small>{lane.count} {lane.count === 1 ? "run" : "runs"}</small></h2>
            {!!lane.direct.length && <ul>{lane.direct.map(renderRun)}</ul>}
            {!!lane.detached.length && <><h3>parent not in this view</h3><ul>{lane.detached.map(renderRun)}</ul></>}
          </section>)}
          {!report.complete && <Button variant="outline" type="button" className="m-4" disabled={!client || refreshing || paging} onClick={() => void reader?.more()}>{paging ? "loading more…" : "load more runs"}</Button>}
        </section>
        <AgentRunDetail chosen={chosen} parent={parent} title={chosen && rootTitle(chosen.sessionId)}
          id={id} invalid={invalid} back={back} follow={follow} client={client} send={send} controls={controls}
          reportedAt={report.reportedAt} refreshing={refreshing} refresh={refresh} />
      </div>
    </>}
  </ModuleFrame>;
}
