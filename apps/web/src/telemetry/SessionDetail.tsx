import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { EnumListbox } from "../page/EnumListbox";
import { agentRows, traceBar, waterfallRows } from "./detail-layout";
import type { DetailData } from "./detail-read";
import { formatCount, formatDuration, formatTime, formatTokens, shortId } from "./format";
import { isApproval, isRetry, SpanInspector, spanLabel, spanModel, spanTone } from "./SpanInspector";
import type { TelemetrySpan, TelemetryTrace } from "./telemetry-types";
import "./session-detail.css";

export type SessionBack = (event: MouseEvent<HTMLAnchorElement>) => void;
export const SESSION_LIST = "/telemetry/sessions";

export function SessionBackLink({ back }: { back: SessionBack }) {
  return <a className="td-back" href={SESSION_LIST} onClick={back}>‹ sessions</a>;
}

export function DetailNotice({ back, title, children }: { back: SessionBack; title: string; children: string }) {
  return <section className="td-state"><SessionBackLink back={back} /><div className="tm-empty"><h1>{title}</h1><p>{children}</p></div></section>;
}

export function DetailLoading({ back }: { back: SessionBack }) {
  return <section className="td-state" aria-busy="true"><SessionBackLink back={back} /><p className="tm-loading" role="status">□ loading session…</p>
    <div aria-hidden="true" className="td-grid td-skeleton tm-skeleton">{[4, 8, 5].map((count, pane) => <div key={pane}>{Array.from({ length: count }, (_, row) => <i key={row} />)}</div>)}</div>
  </section>;
}

export function SessionDetail({ data, sessionId, back, chooseTrace }: { data: DetailData; sessionId: string; back: SessionBack; chooseTrace: (id: string) => void }) {
  const { session, trace, traceIds, agents } = data;
  if (!session && !trace && traceIds.length === 0) return <DetailNotice back={back} title="session not found">no retained telemetry matches this id. raw traces may have expired.</DetailNotice>;
  const root = agents.find((agent) => agent.session_id === sessionId);
  const errors = session?.error_count ?? trace?.error_count;
  const elapsed = session ? session.last_ns - session.first_ns : trace ? trace.last_ns - trace.first_ns : null;
  return <div className="td-detail">
    <header className="td-session-head">
      <SessionBackLink back={back} />
      <div className="td-session-title"><h1>{session?.profile ?? root?.agent_name ?? "session"}</h1><span className="tm-accent" title={sessionId}>{shortId(sessionId)}</span></div>
      <p className="td-metrics tm-dim">
        {elapsed !== null && <span><b>{formatDuration(elapsed)}</b> recorded</span>}
        {session && <span><b>{formatCount(session.turn_count)}</b> turns</span>}
        {trace && <span><b>{formatCount(agents.length)}</b> agents <span className="td-desktop">in trace</span></span>}
        {session && <><span><b>{formatCount(session.model_count)}</b> model calls</span><span><b>{formatCount(session.tool_count)}</b> tool calls</span></>}
        {errors !== undefined && <span><strong className={errors ? "tm-danger" : undefined}>{formatCount(errors)}</strong> errors</span>}
        {session && <span><b>{formatTokens(session.total_tokens)}</b> tokens</span>}
        {!session && trace && <span><b>{formatCount(trace.span_count)}</b> spans</span>}
      </p>
      {!session && <p className="td-fallback tm-dim">session summary unavailable · showing selected trace totals</p>}
    </header>
    {trace ? <TraceView key={trace.trace_id} {...{ data, sessionId, trace, chooseTrace }} /> : <div className="tm-empty"><h2>no retained traces</h2><p>there are no trace spans to inspect for this session.</p></div>}
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

  return <div className="td-grid">
    <aside className="td-agents" aria-label="agents">
      <header className="td-pane-head td-desktop"><h2>agents · {formatCount(agents.length)}</h2></header>
      <button type="button" className="td-tree-toggle tm-button" aria-controls={treeId} aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>
        <span>{ancestry.length > 0 && <span className="tm-dim td-path">{ancestry.join(" / ")} /</span>}<b>{agentName}</b> {agent && <span className="tm-accent">{agentId(agent.session_id)}</span>}</span><span className="tm-accent">tree {treeOpen ? "▴" : "▾"}</span>
      </button>
      <div id={treeId} className={treeOpen ? "td-tree td-tree-open" : "td-tree"} ref={treeRef} role="group" aria-label="agent tree">
        {tree.length === 0 && <p className="td-pane-empty tm-dim">no recorded agents</p>}
        {tree.map(({ item, depth }, index) => {
          const stats = byAgent.get(item.session_id);
          const selected = item === agent;
          return <button key={item.session_id} type="button" className="td-agent-row" aria-pressed={selected} tabIndex={selected ? 0 : -1} data-agent-row
            style={{ paddingInlineStart: `${16 + Math.min(depth, 5) * 12}px` }} onClick={() => chooseAgent(item.session_id)}
            onKeyDown={(event) => moveRow(event, index, tree.length, (next) => { chooseAgent(tree[next].item.session_id); treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-agent-row]")[next]?.focus(); })}>
            <span className="td-split"><span className="td-clip" title={item.agent_name ?? item.session_id}><span className={item.status === "error" ? "tm-danger" : "tm-ok"} aria-label={item.status === "error" ? "has errors" : "no recorded errors"}>{item.status === "error" ? "▲" : "✓"}</span> {item.agent_name ?? (item.session_id === sessionId ? "root agent" : `agent ${agentId(item.session_id)}`)}</span><span className="tm-num">{formatDuration(item.last_ns - item.first_ns)}</span></span>
            <span className="td-clip tm-dim td-agent-meta" title={stats?.model ?? undefined}>{[stats?.model, `${formatCount(stats?.turns ?? 0)} ${stats?.turns === 1 ? "turn" : "turns"}`, item.background ? "background" : null].filter(Boolean).join(" · ")}</span>
          </button>;
        })}
      </div>
    </aside>
    <section className="td-waterfall" aria-label="trace waterfall">
      <header className="td-waterfall-head">
        <div className="td-current-agent td-desktop"><b className="td-clip" title={agentName}>{agentName}</b>{agent && <span className="tm-accent" title={agent.session_id}>{agentId(agent.session_id)}</span>}{ancestry.length > 0 && <span className="tm-dim td-clip" title={ancestry.join(" / ")}>{ancestry.join(" / ")}</span>}</div>
        {traceIds.length > 1 && <div className="td-trace-choose"><EnumListbox label="trace" value={traceOptions[traceIds.indexOf(trace.trace_id)] ?? shortId(trace.trace_id)} options={traceOptions} onChange={(label) => chooseTrace(traceIds[traceOptions.indexOf(label)])} /></div>}
        <div className="td-turn-controls">
          {turns.length > 0 && <div className="td-stepper">
            <button type="button" className="tm-button" aria-label="older turn" disabled={turnIndex < 0 || turnIndex + 1 >= turns.length} onClick={() => chooseTurn(turns[turnIndex + 1].item.span_id)}>‹</button>
            <button type="button" className="tm-button td-all" aria-label={turn ? `${turnLabel}, show all spans` : "all spans, show latest turn"} onClick={() => chooseTurn(turn ? "all" : turns[0].item.span_id)}>{turnLabel}{turn && <span className="tm-dim"> · {turns.length - turnIndex}/{formatCount(turns.length)}</span>}</button>
            <button type="button" className="tm-button" aria-label="newer turn" disabled={turnIndex <= 0} onClick={() => chooseTurn(turns[turnIndex - 1].item.span_id)}>›</button>
          </div>}
          <button type="button" className="tm-button td-error-filter" aria-pressed={onlyErrors} onClick={() => setOnlyErrors(!onlyErrors)}><span aria-hidden="true">{onlyErrors ? "☑" : "□"}</span> errors<span className="td-desktop"> only</span></button>
        </div>
      </header>
      <div className="td-axis" aria-hidden="true"><span>span</span><span className="td-axis-ticks"><span>0</span><span>{formatDuration((trace.last_ns - trace.first_ns) / 2)}</span><span>{formatDuration(trace.last_ns - trace.first_ns)}</span></span><span>duration</span></div>
      <div ref={timelineRef} role="group" aria-label="recorded spans">
        {rows.length === 0 && <p className="td-pane-empty tm-dim">{onlyErrors ? "no errors in this selection" : "no recorded spans for this selection"}</p>}
        {rows.map(({ item, depth, left, width }, index) => {
          const selected = item === active;
          const approvals = item.events.filter(isApproval);
          return <div key={item.span_id} className={`td-span${selected ? " td-span-selected" : ""}`}>
            <button type="button" className={`td-span-row td-${spanTone(item)}`} aria-pressed={selected} tabIndex={selected || (!active && index === 0) ? 0 : -1} data-span-row
              onClick={() => setSpan(item.span_id)} onKeyDown={(event) => moveRow(event, index, rows.length, (next) => { setSpan(rows[next].item.span_id); timelineRef.current?.querySelectorAll<HTMLButtonElement>("[data-span-row]")[next]?.focus(); })}>
              <span className="td-span-label td-clip" title={spanLabel(item)} style={{ paddingInlineStart: `${Math.min(depth, 6) * 10}px` }}><span className="td-mark" aria-hidden="true">{item.status === "error" ? "▲" : item.operation === "turn" ? "□" : "■"}</span> {item.operation === "execute_tool" && item.tool_name ? <>execute_tool <span className="td-tool-name">{item.tool_name}</span></> : spanLabel(item)}</span>
              <span className="td-track" aria-hidden="true"><span className="td-bar" style={{ left: `${left}%`, width: `${width}%` }} />
                {approvals.map((event, i) => {
                  if (event.duration_ns === null || event.duration_ns <= 0) return null;
                  const mark = traceBar(trace.first_ns, trace.last_ns, Math.max(item.start_ns, event.time_ns - event.duration_ns), Math.min(item.end_ns, event.time_ns));
                  return <span key={i} className="td-bar td-approval" style={{ left: `${mark.left}%`, width: `${mark.width}%` }} />;
                })}
                {item.events.filter(isRetry).map((event, i) => <span key={i} className="td-retry" style={{ left: `${traceBar(trace.first_ns, trace.last_ns, event.time_ns, event.time_ns).left}%` }}>◆</span>)}
              </span>
              <span className="tm-num td-span-duration">{formatDuration(item.duration_ns)}</span>
              {item.status === "error" && <span className="td-span-note">{item.error_type ?? item.error_code ?? "span failed"}</span>}
              {approvals.map((event, i) => event.duration_ns !== null && <span key={i} className="td-span-note tm-warn">waited {formatDuration(event.duration_ns)} for approval</span>)}
            </button>
            {selected && <SpanInspector inline span={item} first={trace.first_ns} traceId={trace.trace_id} />}
          </div>;
        })}
      </div>
      <footer className="td-legend"><span className="td-chat">■ model call</span><span className="td-execute_tool">■ tool</span><span className="tm-warn">▧ approval wait</span><span className="td-context_compact">■ compaction</span><span className="td-error">▲ error</span><span className="tm-warn">◆ retry</span><span className="td-span-total tm-dim">{formatCount(rows.length)} completed spans</span></footer>
      {turns.length > 0 && <section className="td-turns"><div className="td-split"><h2>turns of this agent</h2><span className="tm-dim">newest first · {formatCount(turns.length)}</span></div>
        <div className="td-turn-row tm-dim" aria-hidden="true"><span>turn</span><span>started</span><span>duration</span><span>calls</span><span>tools</span><span>errors</span></div>
        {turns.map(({ item }) => {
          const total = totals.get(item.span_id)!;
          return <button key={item.span_id} type="button" className="td-turn-row" aria-pressed={item === turn} aria-label={`${spanLabel(item)}, ${formatCount(total.calls)} model calls, ${formatCount(total.tools)} tool calls, ${formatCount(total.errors)} errors`} onClick={() => chooseTurn(item.span_id)}>
            <span>{item.turn_number ?? "—"}</span><span className="tm-dim">{formatTime(item.start_ns)}</span><span className="td-turn-duration"><i aria-hidden="true" style={{ width: `${item.duration_ns / longest * 100}%` }} />{formatDuration(item.duration_ns)}</span><span>{formatCount(total.calls)}</span><span>{formatCount(total.tools)}</span><span className={total.errors ? "tm-danger" : "tm-dim"}>{formatCount(total.errors)}</span>
          </button>;
        })}
      </section>}
    </section>
    <aside className="td-inspector" aria-label="span inspector">{active ? <SpanInspector key={active.span_id} span={active} first={trace.first_ns} traceId={trace.trace_id} close={closeInspector} /> : <p className="td-pane-empty tm-dim">select a span to inspect it</p>}</aside>
  </div>;
}

const agentId = (id: string) => id.includes(":") ? `${shortId(id)}${id.slice(id.indexOf(":"))}` : shortId(id);
