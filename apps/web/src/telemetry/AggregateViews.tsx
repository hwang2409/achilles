import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { errorShare } from "./errorShare";
import { errorKey, modelKey, toolKey } from "./aggregates";
import { formatBytes, formatCount, formatDuration, formatFullTime, formatHour, formatLatency, formatPercent, formatTime, formatTokens, shortId } from "./format";
import { TrendChart } from "./Overview";
import type { AggregateLoaded, useTelemetryReads } from "./reads";
import { OPERATIONS, type ErrorRow, type Operation, type ModelSeriesPoint } from "./telemetry-types";
import "./aggregates.css";

type Reads = ReturnType<typeof useTelemetryReads>;
type Bucket = "hour" | "day";
type Open = (event: MouseEvent<HTMLAnchorElement>, href: string) => void;

export function AggregateView({ data, reads, bucket, label, open, empty }: { data: AggregateLoaded; reads: Reads; bucket: Bucket; label: string; open: Open; empty: ReactNode }) {
  const { page, tab } = data;
  const more = page.next_cursor !== null;
  if (!page.items.length && tab !== "errors") return empty;
  return <section className="tm-aggregate">
    {tab === "models" ? <Models data={data} bucket={bucket} label={label} />
      : tab === "tools" ? <ToolTable data={data} />
      : <Errors data={data} operation={reads.operation} choose={reads.chooseOperation} open={open} label={label} />}
    {page.items.length > 0 && <footer className="tm-ag-footer">
      <span className="tm-dim">{formatCount(page.items.length)} shown{tab !== "errors" && ` of ${formatCount(data.total)}`}{tab === "errors" && " · messages not recorded"}{data.ask.aggregate?.prefix && ` · through ${formatHour(data.window.end_ns)}`}</span>
      {(more || reads.aggregateLatest) && <div className="tm-ag-pages">
        {reads.aggregateLatest && <button className="tm-button" type="button" onClick={reads.aggregateLatest}>back to latest</button>}
        <button className="tm-button" type="button" aria-disabled={!reads.aggregateNext} onClick={reads.aggregateNext}>{tab === "errors" ? "older" : "load more"} ›</button>
      </div>}
    </footer>}
  </section>;
}

function Heading({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <header className="tm-ag-heading"><h1>{title}</h1><p className="tm-dim">{children}</p></header>;
}

// One table in both layouts: the row becomes stacked, labelled cells on narrow screens.
function Table({ kind, columns, children }: { kind: AggregateLoaded["tab"]; columns: string[]; children: ReactNode }) {
  return <div role="table" aria-label={kind} className={`tm-ag-table tm-ag-${kind}`} tabIndex={0}>
    <div role="row" className="tm-ag-columns">
      {columns.map((name) => <span key={name} role="columnheader" aria-sort={name.endsWith("↓") ? "descending" : undefined}>{name}</span>)}
    </div>
    {children}
  </div>;
}

function Cell({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return <span role="cell" className={className}>
    {label && <span className="tm-ag-cell-label tm-dim" aria-hidden="true">{label} </span>}{children}
  </span>;
}

function Name({ name, kind, reveal, compact }: { name: string; kind: string; compact?: boolean; reveal: (name: string, anchor: HTMLButtonElement) => void }) {
  return <button type="button" className={compact ? "tm-ag-name tm-ag-peek" : "tm-ag-name"} title={name} aria-label={`full ${kind} name: ${name}`} onClick={(event) => reveal(name, event.currentTarget)}>{compact ? "↗" : name}</button>;
}

function useFullName(kind: string) {
  const [name, setName] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (name !== null) dialog.current?.showModal(); }, [name]);
  return {
    reveal(value: string, anchor: HTMLButtonElement) { trigger.current = anchor; setName(value); },
    panel: name !== null && <dialog ref={dialog} className="tm-ag-name-pane" aria-label={`full ${kind} name`} onClose={() => { setName(null); trigger.current?.focus(); }}>
      <header><h2>full {kind} name</h2><button type="button" className="tm-button" onClick={() => dialog.current?.close()}>close</button></header>
      <p>{name}</p>
    </dialog>,
  };
}

function Spark({ points }: { points: ModelSeriesPoint[] | undefined }) {
  if (!points) return <span className="tm-dim" title="not in the top 20 models by calls">—</span>;
  const max = Math.max(1, ...points.map((point) => point.model_calls));
  return <span className="tm-ag-spark" aria-hidden="true">{points.map((point) => <i key={point.start_ns} style={{ height: `${100 * point.model_calls / max}%` }} />)}</span>;
}

const latencyTitle = "estimated from zeta’s hourly latency histograms";
function Models({ data, bucket, label }: { data: Extract<AggregateLoaded, { tab: "models" }>; bucket: Bucket; label: string }) {
  const { page: { items }, trends, total, totals } = data;
  const [selected, setSelected] = useState<string | null>(null);
  const [chart, setChart] = useState<"calls" | "tokens">("calls");
  const full = useFullName("model");
  const model = items.find((row) => modelKey(row) === selected) ?? items[0];
  const key = modelKey(model);
  const points = trends.get(key);
  return <>
    <Heading title="models">{formatCount(total)} models · {formatCount(totals.model_calls)} calls · tokens only</Heading>
    <Table kind="models" columns={["model / provider", `calls per ${bucket}`, "calls ↓", "errors / rate", "p50", "p95", "TTFT p50", "TTFT p95", "input", "output", "total", "cache read", "cache write", "last"]}>
      {items.map((row) => {
        const id = modelKey(row);
        return <div role="row" key={id} data-selected={id === key}>
          <Cell className="tm-ag-identity">
            <button type="button" className="tm-ag-name" title={row.model} aria-label={`show trend for ${row.model}${row.provider ? ` (${row.provider})` : ""}`} aria-pressed={id === key} onClick={() => setSelected(id)}>{row.model}</button>
            <span className="tm-ag-byline"><span className="tm-ag-ellipsis tm-dim" title={row.provider ?? undefined}>{row.provider ?? "—"}</span><Name name={row.model} kind="model" compact reveal={full.reveal} /></span>
          </Cell>
          <Cell className="tm-ag-mini"><Spark points={trends.get(id)} /></Cell>
          <Cell label="calls">{formatCount(row.calls)}</Cell>
          <Cell label="errors"><span className={row.errors ? "tm-danger" : "tm-dim"}>{formatCount(row.errors)}</span><span className="tm-dim"> · {formatPercent(errorShare({ model: row }), 1) ?? "—"}</span></Cell>
          <Cell label="p50"><span title={latencyTitle}>{formatLatency(row.p50_ns)}</span></Cell>
          <Cell label="p95"><span title={latencyTitle}>{formatLatency(row.p95_ns)}</span></Cell>
          <Cell label="TTFT p50"><span title={`time to first token · ${latencyTitle}`}>{formatLatency(row.ttft_p50_ns)}</span></Cell>
          <Cell label="TTFT p95"><span title={`time to first token · ${latencyTitle}`}>{formatLatency(row.ttft_p95_ns)}</span></Cell>
          <Cell label="in">{formatTokens(row.input_tokens)}</Cell>
          <Cell label="out">{formatTokens(row.output_tokens)}</Cell>
          <Cell label="tokens">{formatTokens(row.total_tokens)}</Cell>
          <Cell label="cache read">{formatTokens(row.cache_read_tokens)}</Cell>
          <Cell label="cache write">{formatTokens(row.cache_write_tokens)}</Cell>
          <Cell label="last" className="tm-ag-last tm-dim"><time title={formatFullTime(row.last_ns)}>{formatHour(row.last_ns)}</time></Cell>
        </div>;
      })}
    </Table>
    <section className="tm-ag-trend" aria-label="selected model trend">
      <header>
        <h2 className="tm-ag-ellipsis" title={model.model}>{model.model}</h2><span className="tm-dim">{model.provider && <>{model.provider} · </>}{label} · by {bucket}</span>
        <div className="tm-toggle" aria-label="model chart shows" role="group">
          {(["calls", "tokens"] as const).map((metric) => <button type="button" key={metric} aria-pressed={metric === chart} onClick={() => setChart(metric)}>{metric}</button>)}
        </div>
      </header>
      {points ? <TrendChart series={points} bucket={bucket} chart={chart} /> : <p className="tm-dim">no series for this model · zeta returns the top 20 by calls</p>}
    </section>
    {full.panel}
  </>;
}

function Meter({ part, scale }: { part: number; scale: number }) {
  return <span className="tm-ag-meter" aria-hidden="true"><i style={{ width: `${100 * part / Math.max(scale, Number.EPSILON)}%` }} /></span>;
}

function ToolTable({ data }: { data: Extract<AggregateLoaded, { tab: "tools" }> }) {
  const { page: { items }, totals } = data;
  const full = useFullName("tool");
  const rates = items.map((row) => ({ row, share: errorShare({ tool: row }) }));
  const highest = Math.max(0, ...rates.map(({ share }) => share ?? 0));
  const failures = items.reduce((sum, row) => sum + row.errors, 0);
  return <>
    <Heading title="tools">{formatCount(totals.tool_calls)} calls · <span className="tm-danger">{formatCount(failures)}</span> failed{data.page.next_cursor !== null && " in rows shown"} · sizes only</Heading>
    <Table kind="tools" columns={["tool", "type", "calls ↓", "failed", "failure rate", "p50", "p95", "args in", "results out", "last"]}>
      {rates.map(({ row, share }) => <div role="row" key={toolKey(row)}>
        <Cell className="tm-ag-identity tm-tool"><Name name={row.tool_name} kind="tool" reveal={full.reveal} /></Cell>
        <Cell className="tm-ag-ellipsis tm-dim"><span title={row.tool_type ?? undefined}>{row.tool_type ?? "—"}</span></Cell>
        <Cell label="calls" className="tm-ag-tool-calls">{formatCount(row.calls)}</Cell>
        <Cell label="failed" className={row.errors ? "tm-danger" : "tm-dim"}>{formatCount(row.errors)}</Cell>
        <Cell className="tm-ag-failure-rate tm-dim"><Meter part={share ?? 0} scale={highest} />{formatPercent(share, 1) ?? "—"}</Cell>
        <Cell label="p50"><span title={latencyTitle}>{formatLatency(row.p50_ns)}</span></Cell>
        <Cell label="p95"><span title={latencyTitle}>{formatLatency(row.p95_ns)}</span></Cell>
        <Cell label="args" className="tm-ag-size">{formatBytes(row.argument_bytes)}</Cell>
        <Cell label="out" className="tm-ag-size">{formatBytes(row.result_bytes)}</Cell>
        <Cell label="last" className="tm-ag-last tm-dim"><time title={formatFullTime(row.last_ns)}>{formatHour(row.last_ns)}</time></Cell>
      </div>)}
    </Table>
    <p className="tm-ag-tool-note tm-dim">□ telemetry keeps tool call sizes, never arguments or results. open a session to see when each call ran.</p>
    {full.panel}
  </>;
}

function Errors({ data, label, operation, choose, open }: { data: Extract<AggregateLoaded, { tab: "errors" }>; label: string; operation: Operation | null; choose: (op: Operation | null) => void; open: Open }) {
  const { items, next_cursor } = data.page;
  const answered = data.ask.aggregate?.operation ?? null;
  const [expanded, setExpanded] = useState(false);
  const classes = data.classes ?? [];
  const hidden = classes.length - 4;
  const scale = Math.max(0, ...classes.map(({ count }) => count));
  return <>
    <Heading title={<><span className="tm-danger">{formatCount(items.length)}</span> {next_cursor !== null ? "errors shown" : "errors"}</>}>{label}{answered && ` · ${answered}`} · error type only, never the message</Heading>
    {classes.length > 0 && <>
      <p className="tm-ag-classes-label tm-dim" id="tm-error-classes-label">error classes · full range</p>
      <ul className="tm-ag-classes" aria-labelledby="tm-error-classes-label">
        {(expanded ? classes : classes.slice(0, 4)).map(({ error_type, count }) => {
          const name = error_type ?? "unknown class";
          return <li key={name}>
            <span className="tm-ag-ellipsis" title={name}>{name}</span><span className="tm-dim"><Meter part={count} scale={scale} />{formatCount(count)}</span>
          </li>;
        })}
        {hidden > 0 && <li className="tm-ag-other"><button className="tm-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "fewer types" : `${hidden} more buckets ▾`}</button></li>}
      </ul>
    </>}
    <p className="tm-ag-scroll-hint tm-dim" aria-hidden="true">more operations →</p>
    <div className="tm-ag-filters" role="group" aria-label="filter by operation"><span className="tm-dim">operation</span>
      {([null, ...OPERATIONS] as const).map((op) => <button key={op ?? "all"} type="button" className="tm-button" aria-pressed={op === operation} onClick={op !== operation ? () => choose(op) : undefined}>{op ?? "all"}</button>)}
    </div>
    {items.length === 0 ? <p className="tm-ag-no-errors tm-dim" role="status">no {answered ? `${answered} ` : ""}errors in the {label}</p> :
      <Table kind="errors" columns={["time ↓", "error type", "operation", "duration", "session"]}>
        {items.map((row) => <ErrorLine key={errorKey(row)} row={row} open={open} />)}
      </Table>}
  </>;
}

function ErrorLine({ row, open }: { row: ErrorRow; open: Open }) {
  const target = row.model ?? row.tool_name ?? (row.operation === "mcp" ? [row.mcp_server, row.mcp_tool ?? row.mcp_method].filter(Boolean).join(" · ") : row.agent_name);
  // The detail projection accepts the root id even when the failing span belongs to a child agent.
  const root = row.session_id?.split(":", 1)[0];
  const href = root && /^[0-9a-f]{32}$/.test(root) ? `/telemetry/sessions/${root}` : null;
  return <div role="row">
    <Cell className="tm-ag-error-time tm-dim"><time title={formatFullTime(row.time_ns)}>{formatTime(row.time_ns)}</time></Cell>
    <Cell className="tm-ag-error-class tm-ag-ellipsis tm-danger"><span title={row.error_type ?? undefined}>▲ {row.error_type ?? "unknown class"}</span></Cell>
    <Cell className="tm-ag-error-op tm-ag-ellipsis">{row.operation}{target && <> <span className={row.tool_name ? "tm-tool" : "tm-dim"} title={target}>{target}</span></>}</Cell>
    <Cell className="tm-ag-error-duration">{formatDuration(row.duration_ns)}</Cell>
    <Cell className="tm-ag-error-session">{href ? <a className="tm-accent" href={href} onClick={(event) => open(event, href)} aria-label={`open session ${root}`}>{shortId(root!)} <span aria-hidden="true">↗</span></a> : <span className="tm-dim">—</span>}</Cell>
  </div>;
}

export function AggregateSkeleton({ tab }: { tab: AggregateLoaded["tab"] }) {
  return <div className={`tm-skeleton tm-ag-skeleton tm-ag-skeleton-${tab}`} aria-hidden="true">
    <b />{Array.from({ length: tab === "models" ? 3 : 6 }, (_, i) => <div key={i}><i /><i /><i /></div>)}
    {tab === "models" && <div className="tm-ag-skeleton-plot" />}
  </div>;
}
