import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { EnumListbox } from "../page/EnumListbox";
import { agentRows, traceBar, waterfallRows } from "./detail-layout";
import type { DetailData } from "./detail-read";
import { formatCount, formatDuration, formatTime, formatTokens, shortId } from "./format";
import { isApproval, isRetry, SpanInspector, spanLabel, spanModel, spanTone } from "./SpanInspector";
import type { TelemetrySpan, TelemetryTrace } from "./telemetry-types";

export type SessionBack = (event: MouseEvent<HTMLAnchorElement>) => void;
export const SESSION_LIST = "/telemetry/sessions";

export function SessionBackLink({ back }: { back: SessionBack }) {
  return <a className="inline-flex min-h-10 items-center text-sm text-accent-foreground hover:underline" href={SESSION_LIST} onClick={back}>‹ sessions</a>;
}

export function DetailNotice({ back, title, children }: { back: SessionBack; title: string; children: string }) {
  return <section className="p-4"><SessionBackLink back={back} /><div className="grid max-w-[62ch] gap-3 py-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-semibold [&_p]:text-muted-foreground"><h1>{title}</h1><p>{children}</p></div></section>;
}

export function DetailLoading({ back }: { back: SessionBack }) {
  return <section className="p-4" aria-busy="true"><SessionBackLink back={back} /><p className="mb-4 border-b pb-3 text-muted-foreground" role="status">□ loading session…</p>
    <div aria-hidden="true" className="grid grid-cols-3 gap-4 [&>div]:space-y-2">{[4, 8, 5].map((count, pane) => <div key={pane}>{Array.from({ length: count }, (_, row) => <Skeleton key={row} className="h-6 w-full" />)}</div>)}</div>
  </section>;
}

export function SessionDetail({ data, sessionId, back, chooseTrace }: { data: DetailData; sessionId: string; back: SessionBack; chooseTrace: (id: string) => void }) {
  const { session, trace, traceIds, agents } = data;
  if (!session && !trace && traceIds.length === 0) return <DetailNotice back={back} title="session not found">no retained telemetry matches this id. raw traces may have expired.</DetailNotice>;
  const root = agents.find((agent) => agent.session_id === sessionId);
  const errors = session?.error_count ?? trace?.error_count;
  const elapsed = session ? session.last_ns - session.first_ns : trace ? trace.last_ns - trace.first_ns : null;
  return <div className="min-w-0">
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b p-4 md:px-8">
      <SessionBackLink back={back} />
      <div className="flex flex-wrap items-baseline gap-2 [&_h1]:text-xl [&_h1]:font-semibold"><h1>{session?.profile ?? root?.agent_name ?? "session"}</h1><span className="text-accent-foreground" title={sessionId}>{shortId(sessionId)}</span></div>
      <p className="flex flex-wrap gap-2 text-sm text-muted-foreground">
        {elapsed !== null && <span><b>{formatDuration(elapsed)}</b> recorded</span>}
        {session && <span><b>{formatCount(session.turn_count)}</b> turns</span>}
        {trace && <span><b>{formatCount(agents.length)}</b> agents <span className="hidden xl:inline">in trace</span></span>}
        {session && <><span><b>{formatCount(session.model_count)}</b> model calls</span><span><b>{formatCount(session.tool_count)}</b> tool calls</span></>}
        {errors !== undefined && <span><strong className={errors ? "text-destructive" : undefined}>{formatCount(errors)}</strong> errors</span>}
        {session && <span><b>{formatTokens(session.total_tokens)}</b> tokens</span>}
        {!session && trace && <span><b>{formatCount(trace.span_count)}</b> spans</span>}
      </p>
      {!session && <p className="basis-full text-sm text-muted-foreground">session summary unavailable · showing selected trace totals</p>}
    </header>
    {trace ? <TraceView key={trace.trace_id} {...{ data, sessionId, trace, chooseTrace }} /> : <div className="grid max-w-[62ch] gap-3 py-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-semibold [&_p]:text-muted-foreground"><h2>no retained traces</h2><p>there are no trace spans to inspect for this session.</p></div>}
  </div>;
}

// A single Tab stop per list; arrows select and focus the adjacent row.
function moveRow(event: KeyboardEvent, index: number, count: number, choose: (index: number) => void) {
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: count - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  choose(Math.min(count - 1, Math.max(0, next)));
}

function TraceView({ data, trace, sessionId, chooseTrace }: { data: DetailData; trace: TelemetryTrace; sessionId: string; chooseTrace: (id: string) => void }) {
  const { agents, spans, traceIds } = data;
  const [agentChoice, setAgent] = useState<string>();
  const [turnChoice, setTurn] = useState<string>();
  const [spanChoice, setSpan] = useState<string | null>();
  const [treeOpen, setTreeOpen] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const treeId = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(() => agentRows(agents), [agents]);
  const agent = agents.find((row) => row.session_id === (agentChoice ?? sessionId)) ?? tree[0]?.item;
  const display = useMemo(() => {
    const byAgent = new Map<string, { model: string | null; turns: number }>();
    for (const span of spans) {
      if (span.session_id === null) continue;
      const summary = byAgent.get(span.session_id) ?? { model: null, turns: 0 };
      if (span.operation === "chat") summary.model = spanModel(span) ?? summary.model;
      if (span.operation === "turn") summary.turns++;
      byAgent.set(span.session_id, summary);
    }
    // The v1 span_ids selector is exactly trace id + conversation id; the complete trace already includes that id on each span.
    const rows = waterfallRows(agent ? spans.filter((span) => span.session_id === agent.session_id) : spans, trace);
    const turns = rows.filter(({ item }) => item.operation === "turn").sort((a, b) => b.item.start_ns - a.item.start_ns);
    const totals = new Map<string, { calls: number; tools: number; errors: number }>();
    for (const { item, turn } of rows) {
      if (!turn) continue;
      const total = totals.get(turn.span_id) ?? { calls: 0, tools: 0, errors: 0 };
      if (item.operation === "chat") total.calls++;
      if (item.operation === "execute_tool") total.tools++;
      if (item.status === "error") total.errors++;
      totals.set(turn.span_id, total);
    }
    const longest = turns.reduce((max, { item }) => Math.max(max, item.duration_ns), 1);
    return { rows, turns, totals, byAgent, longest };
  }, [agent?.session_id, spans, trace]);
  const { turns, totals, byAgent, longest } = display;
  const turnIndex = turnChoice === "all" ? -1 : Math.max(0, turns.findIndex(({ item }) => item.span_id === turnChoice));
  const turn = turns[turnIndex]?.item;
  const rows = display.rows.filter(({ item, turn: owner }) => (!turn || owner === turn) && (!onlyErrors || item.status === "error"));
  const active = spanChoice === null ? undefined : rows.find(({ item }) => item.span_id === spanChoice)?.item ?? rows.find(({ item }) => item.operation === "chat")?.item ?? rows[0]?.item;
  const turnLabel = turn ? spanLabel(turn) : "all spans";
  const traceOptions = traceIds.map((id, index) => `${index + 1} · ${shortId(id)}`);
  const chooseAgent = (id: string) => { setAgent(id); setTurn(undefined); setSpan(undefined); };
  const chooseTurn = (id: string) => { setTurn(id); setSpan(undefined); };
  const closeInspector = () => { setSpan(null); timelineRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); };
  const parents = new Map(agents.map((row) => [row.session_id, row]));
  const ancestry: string[] = [];
  const seen = new Set([agent?.session_id]);
  for (let parent = agent?.parent_session_id ?? null; parent && !seen.has(parent); parent = parents.get(parent)?.parent_session_id ?? null) {
    seen.add(parent);
    ancestry.unshift(parents.get(parent)?.agent_name ?? shortId(parent));
  }
  const agentName = agent?.agent_name ?? (agent ? agent.session_id === sessionId ? "root agent" : "agent" : "trace");

  return <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)_minmax(13rem,1.25fr)]">
    <aside className="min-w-0 border-b xl:border-e xl:border-b-0" aria-label="agents">
      <header className="hidden border-b p-3 font-semibold xl:block"><h2>agents · {formatCount(agents.length)}</h2></header>
      <Button variant="outline" type="button" className="w-full justify-between text-start xl:hidden" aria-controls={treeId} aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>
        <span>{ancestry.length > 0 && <span className="text-muted-foreground">{ancestry.join(" / ")} /</span>}<b>{agentName}</b> {agent && <span className="text-accent-foreground">{agentId(agent.session_id)}</span>}</span><span className="text-accent-foreground">tree {treeOpen ? "▴" : "▾"}</span>
      </Button>
      <div id={treeId} data-expanded={treeOpen} className="hidden data-[expanded=true]:block xl:block" ref={treeRef} role="group" aria-label="agent tree">
        {tree.length === 0 && <p className="p-3 text-sm text-muted-foreground">no recorded agents</p>}
        {tree.map(({ item, depth }, index) => {
          const stats = byAgent.get(item.session_id);
          const selected = item === agent;
          return <Button variant="outline" key={item.session_id} type="button" className="grid h-auto min-h-12 w-full content-center justify-normal rounded-none border-0 border-b py-2 text-start aria-pressed:bg-accent" aria-pressed={selected} tabIndex={selected ? 0 : -1} data-agent-row
            style={{ paddingInlineStart: `${16 + Math.min(depth, 5) * 12}px` }} onClick={() => chooseAgent(item.session_id)}
            onKeyDown={(event) => moveRow(event, index, tree.length, (next) => { chooseAgent(tree[next].item.session_id); treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-agent-row]")[next]?.focus(); })}>
            <span className="flex items-baseline justify-between gap-2"><span className="min-w-0 truncate" title={item.agent_name ?? item.session_id}><span className={item.status === "error" ? "text-destructive" : "tm-ok"} aria-label={item.status === "error" ? "has errors" : "no recorded errors"}>{item.status === "error" ? "▲" : "✓"}</span> {item.agent_name ?? (item.session_id === sessionId ? "root agent" : `agent ${agentId(item.session_id)}`)}</span><span className="tabular-nums">{formatDuration(item.last_ns - item.first_ns)}</span></span>
            <span className="truncate ps-4 text-xs text-muted-foreground" title={stats?.model ?? undefined}>{[stats?.model, `${formatCount(stats?.turns ?? 0)} ${stats?.turns === 1 ? "turn" : "turns"}`, item.background ? "background" : null].filter(Boolean).join(" · ")}</span>
          </Button>;
        })}
      </div>
    </aside>
    <section className="min-w-0 xl:border-e" aria-label="trace waterfall">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="hidden min-w-0 items-center gap-2 xl:flex"><b className="min-w-0 truncate" title={agentName}>{agentName}</b>{agent && <span className="text-accent-foreground" title={agent.session_id}>{agentId(agent.session_id)}</span>}{ancestry.length > 0 && <span className="truncate text-muted-foreground" title={ancestry.join(" / ")}>{ancestry.join(" / ")}</span>}</div>
        {traceIds.length > 1 && <div className="min-w-0"><EnumListbox label="trace" value={traceOptions[traceIds.indexOf(trace.trace_id)] ?? shortId(trace.trace_id)} options={traceOptions} onChange={(label) => chooseTrace(traceIds[traceOptions.indexOf(label)])} /></div>}
        <div className="flex flex-wrap gap-2">
          {turns.length > 0 && <div className="flex flex-wrap gap-1">
            <Button variant="outline" type="button"  aria-label="older turn" disabled={turnIndex < 0 || turnIndex + 1 >= turns.length} onClick={() => chooseTurn(turns[turnIndex + 1].item.span_id)}>‹</Button>
            <Button variant="outline" type="button"  aria-label={turn ? `${turnLabel}, show all spans` : "all spans, show latest turn"} onClick={() => chooseTurn(turn ? "all" : turns[0].item.span_id)}>{turnLabel}{turn && <span className="text-muted-foreground"> · {turns.length - turnIndex}/{formatCount(turns.length)}</span>}</Button>
            <Button variant="outline" type="button"  aria-label="newer turn" disabled={turnIndex <= 0} onClick={() => chooseTurn(turns[turnIndex - 1].item.span_id)}>›</Button>
          </div>}
          <Button variant="outline" type="button" className="aria-pressed:bg-accent" aria-pressed={onlyErrors} onClick={() => setOnlyErrors(!onlyErrors)}><span aria-hidden="true">{onlyErrors ? "☑" : "□"}</span> errors<span className="hidden xl:inline"> only</span></Button>
        </div>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_5rem] gap-2 border-b px-3 py-2 text-xs text-muted-foreground" aria-hidden="true"><span>span</span><span className="flex justify-between"><span>0</span><span>{formatDuration((trace.last_ns - trace.first_ns) / 2)}</span><span>{formatDuration(trace.last_ns - trace.first_ns)}</span></span><span>duration</span></div>
      <div ref={timelineRef} role="group" aria-label="recorded spans">
        {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">{onlyErrors ? "no errors in this selection" : "no recorded spans for this selection"}</p>}
        {rows.map(({ item, depth, left, width }, index) => {
          const selected = item === active;
          const approvals = item.events.filter(isApproval);
          return <div key={item.span_id} className="border-b">
            <Button variant="outline" type="button" data-tone={spanTone(item)} className="grid h-auto min-h-10 w-full grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_5rem] gap-2 rounded-none border-0 px-3 py-2 text-start aria-pressed:bg-accent data-[tone=error]:text-destructive" aria-pressed={selected} tabIndex={selected || (!active && index === 0) ? 0 : -1} data-span-row
              onClick={() => setSpan(item.span_id)} onKeyDown={(event) => moveRow(event, index, rows.length, (next) => { setSpan(rows[next].item.span_id); timelineRef.current?.querySelectorAll<HTMLButtonElement>("[data-span-row]")[next]?.focus(); })}>
              <span className="min-w-0 truncate" title={spanLabel(item)} style={{ paddingInlineStart: `${Math.min(depth, 6) * 10}px` }}><span className="text-current" aria-hidden="true">{item.status === "error" ? "▲" : item.operation === "turn" ? "□" : "■"}</span> {item.operation === "execute_tool" && item.tool_name ? <>execute_tool <span className="text-muted-foreground">{item.tool_name}</span></> : spanLabel(item)}</span>
              <span className="relative block h-3 w-full" aria-hidden="true"><span className="absolute inset-y-0 min-w-px bg-current [[data-tone=chat]_&]:bg-primary [[data-tone=execute_tool]_&]:bg-muted-foreground" style={{ left: `${left}%`, width: `${width}%` }} />
                {approvals.map((event, i) => {
                  if (event.duration_ns === null || event.duration_ns <= 0) return null;
                  const mark = traceBar(trace.first_ns, trace.last_ns, Math.max(item.start_ns, event.time_ns - event.duration_ns), Math.min(item.end_ns, event.time_ns));
                  return <span key={i} className="absolute inset-y-0 min-w-px border border-dashed border-foreground bg-background" style={{ left: `${mark.left}%`, width: `${mark.width}%` }} />;
                })}
                {item.events.filter(isRetry).map((event, i) => <span key={i} className="absolute -top-2 -translate-x-1/2 text-foreground" style={{ left: `${traceBar(trace.first_ns, trace.last_ns, event.time_ns, event.time_ns).left}%` }}>◆</span>)}
              </span>
              <span className="text-end text-xs tabular-nums">{formatDuration(item.duration_ns)}</span>
              {item.status === "error" && <span className="col-span-full text-xs text-muted-foreground">{item.error_type ?? item.error_code ?? "span failed"}</span>}
              {approvals.map((event, i) => event.duration_ns !== null && <span key={i} className="col-span-full text-xs text-muted-foreground">waited {formatDuration(event.duration_ns)} for approval</span>)}
            </Button>
            {selected && <SpanInspector inline span={item} first={trace.first_ns} traceId={trace.trace_id} />}
          </div>;
        })}
      </div>
      <footer className="flex flex-wrap gap-x-3 gap-y-1 border-y px-3 py-2 text-xs text-muted-foreground"><span className="text-primary">■ model call</span><span className="text-muted-foreground">■ tool</span><span className="text-muted-foreground">▧ approval wait</span><span className="text-muted-foreground">■ compaction</span><span className="text-destructive">▲ error</span><span className="text-muted-foreground">◆ retry</span><span className="ms-auto text-muted-foreground">{formatCount(rows.length)} completed spans</span></footer>
      {turns.length > 0 && <section className="grid gap-2 p-3 [&_h2]:font-semibold"><div className="flex items-baseline justify-between gap-2"><h2>turns of this agent</h2><span className="text-muted-foreground">newest first · {formatCount(turns.length)}</span></div>
        <div className="grid grid-cols-5 gap-2 border-b px-2 py-1 text-xs text-muted-foreground" aria-hidden="true"><span>turn</span><span>started</span><span>duration</span><span>calls</span><span>tools</span><span>errors</span></div>
        {turns.map(({ item }) => {
          const total = totals.get(item.span_id)!;
          return <Button variant="outline" key={item.span_id} type="button" className="grid h-auto min-h-10 w-full grid-cols-5 gap-2 px-2 py-1 text-start text-xs aria-pressed:bg-accent" aria-pressed={item === turn} aria-label={`${spanLabel(item)}, ${formatCount(total.calls)} model calls, ${formatCount(total.tools)} tool calls, ${formatCount(total.errors)} errors`} onClick={() => chooseTurn(item.span_id)}>
            <span>{item.turn_number ?? "—"}</span><span className="text-muted-foreground">{formatTime(item.start_ns)}</span><span className="flex items-center gap-1 whitespace-nowrap [&>i]:h-1 [&>i]:bg-current"><i aria-hidden="true" style={{ width: `${item.duration_ns / longest * 100}%` }} />{formatDuration(item.duration_ns)}</span><span>{formatCount(total.calls)}</span><span>{formatCount(total.tools)}</span><span className={total.errors ? "text-destructive" : "text-muted-foreground"}>{formatCount(total.errors)}</span>
          </Button>;
        })}
      </section>}
    </section>
    <aside className="min-w-0 border-t p-3 xl:border-t-0" aria-label="span inspector">{active ? <SpanInspector key={active.span_id} span={active} first={trace.first_ns} traceId={trace.trace_id} close={closeInspector} /> : <p className="p-3 text-sm text-muted-foreground">select a span to inspect it</p>}</aside>
  </div>;
}

const agentId = (id: string) => id.includes(":") ? `${shortId(id)}${id.slice(id.indexOf(":"))}` : shortId(id);
