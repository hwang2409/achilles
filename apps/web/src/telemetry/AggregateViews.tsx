import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { errorShare } from "./errorShare";
import { errorKey, modelKey, toolKey } from "./aggregates";
import { formatBytes, formatCount, formatDuration, formatFullTime, formatHour, formatLatency, formatPercent, formatTime, formatTokens, shortId } from "./format";
import { TrendChart } from "./Overview";
import type { AggregateLoaded, useTelemetryReads } from "./reads";
import { OPERATIONS, type ErrorRow, type Operation, type ModelSeriesPoint } from "./telemetry-types";

type Reads = ReturnType<typeof useTelemetryReads>;
type Bucket = "hour" | "day";
type Open = (event: MouseEvent<HTMLAnchorElement>, href: string) => void;

export function AggregateView({ data, reads, bucket, label, open, empty }: { data: AggregateLoaded; reads: Reads; bucket: Bucket; label: string; open: Open; empty: ReactNode }) {
  const { page, tab } = data;
  const more = page.next_cursor !== null;
  if (!page.items.length && tab !== "errors") return empty;
  return <section className="min-w-0 tabular-nums">
    {tab === "models" ? <Models data={data} bucket={bucket} label={label} />
      : tab === "tools" ? <ToolTable data={data} />
      : <Errors data={data} operation={reads.operation} choose={reads.chooseOperation} open={open} label={label} />}
    {page.items.length > 0 && <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{formatCount(page.items.length)} shown{tab !== "errors" && ` of ${formatCount(data.total)}`}{tab === "errors" && " · messages not recorded"}{data.ask.aggregate?.prefix && ` · through ${formatHour(data.window.end_ns)}`}</span>
      {(more || reads.aggregateLatest) && <div className="flex flex-wrap gap-2">
        {reads.aggregateLatest && <Button variant="outline"  type="button" onClick={reads.aggregateLatest}>back to latest</Button>}
        <Button variant="outline"  type="button" aria-disabled={!reads.aggregateNext} onClick={reads.aggregateNext}>{tab === "errors" ? "older" : "load more"} ›</Button>
      </div>}
    </footer>}
  </section>;
}

function Heading({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <header className="mb-4 flex flex-wrap items-baseline gap-3 [&_h1]:text-xl [&_h1]:font-semibold"><h1>{title}</h1><p className="text-muted-foreground">{children}</p></header>;
}

// Keep all reported columns available in a horizontally scrollable table.
function AggregateTable({ kind, columns, children }: { kind: AggregateLoaded["tab"]; columns: string[]; children: ReactNode }) {
  return <Table aria-label={kind} className="min-w-max border-y" tabIndex={0}>
    <TableHeader><TableRow>{columns.map((name) => <TableHead key={name} scope="col" aria-sort={name.endsWith("↓") ? "descending" : undefined}>{name}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{children}</TableBody>
  </Table>;
}

function Cell({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return <TableCell className={className}>
    {label && <span className="hidden" aria-hidden="true">{label} </span>}{children}
  </TableCell>;
}

function Name({ name, kind, reveal, compact }: { name: string; kind: string; compact?: boolean; reveal: (name: string, anchor: HTMLButtonElement) => void }) {
  return <Button variant="outline" type="button" className={compact ? "px-2" : "h-auto min-h-8 max-w-72 justify-start whitespace-normal text-start wrap-anywhere"} title={name} aria-label={`full ${kind} name: ${name}`} onClick={(event) => reveal(name, event.currentTarget)}>{compact ? "↗" : name}</Button>;
}

function useFullName(kind: string) {
  const [name, setName] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return {
    reveal(value: string, anchor: HTMLButtonElement) { trigger.current = anchor; setName(value); },
    panel: <Dialog open={name !== null} onOpenChange={(open) => { if (!open) setName(null); }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogTitle>full {kind} name</DialogTitle>
        <DialogDescription className="wrap-anywhere">{name}</DialogDescription>
      </DialogContent>
    </Dialog>,
  };
}

function Spark({ points }: { points: ModelSeriesPoint[] | undefined }) {
  if (!points) return <span className="text-muted-foreground" title="not in the top 20 models by calls">—</span>;
  const max = Math.max(1, ...points.map((point) => point.model_calls));
  return <span className="flex h-6 items-end gap-px [&>i]:w-1 [&>i]:bg-primary" aria-hidden="true">{points.map((point) => <i key={point.start_ns} style={{ height: `${100 * point.model_calls / max}%` }} />)}</span>;
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
    <AggregateTable kind="models" columns={["model / provider", `calls per ${bucket}`, "calls ↓", "errors / rate", "p50", "p95", "TTFT p50", "TTFT p95", "input", "output", "total", "cache read", "cache write", "last"]}>
      {items.map((row) => {
        const id = modelKey(row);
        return <TableRow key={id} data-selected={id === key} data-state={id === key ? "selected" : undefined}>
          <Cell className="min-w-40">
            <Button variant="outline" type="button" className="h-auto min-h-8 max-w-72 justify-start whitespace-normal text-start wrap-anywhere hover:underline" title={row.model} aria-label={`show trend for ${row.model}${row.provider ? ` (${row.provider})` : ""}`} aria-pressed={id === key} onClick={() => setSelected(id)}>{row.model}</Button>
            <span className="flex items-center gap-2 text-xs"><span className="max-w-56 truncate text-muted-foreground" title={row.provider ?? undefined}>{row.provider ?? "—"}</span><Name name={row.model} kind="model" compact reveal={full.reveal} /></span>
          </Cell>
          <Cell ><Spark points={trends.get(id)} /></Cell>
          <Cell label="calls">{formatCount(row.calls)}</Cell>
          <Cell label="errors"><span className={row.errors ? "text-destructive" : "text-muted-foreground"}>{formatCount(row.errors)}</span><span className="text-muted-foreground"> · {formatPercent(errorShare({ model: row }), 1) ?? "—"}</span></Cell>
          <Cell label="p50"><span title={latencyTitle}>{formatLatency(row.p50_ns)}</span></Cell>
          <Cell label="p95"><span title={latencyTitle}>{formatLatency(row.p95_ns)}</span></Cell>
          <Cell label="TTFT p50"><span title={`time to first token · ${latencyTitle}`}>{formatLatency(row.ttft_p50_ns)}</span></Cell>
          <Cell label="TTFT p95"><span title={`time to first token · ${latencyTitle}`}>{formatLatency(row.ttft_p95_ns)}</span></Cell>
          <Cell label="in">{formatTokens(row.input_tokens)}</Cell>
          <Cell label="out">{formatTokens(row.output_tokens)}</Cell>
          <Cell label="tokens">{formatTokens(row.total_tokens)}</Cell>
          <Cell label="cache read">{formatTokens(row.cache_read_tokens)}</Cell>
          <Cell label="cache write">{formatTokens(row.cache_write_tokens)}</Cell>
          <Cell label="last" className="text-muted-foreground"><time title={formatFullTime(row.last_ns)}>{formatHour(row.last_ns)}</time></Cell>
        </TableRow>;
      })}
    </AggregateTable>
    <section className="mt-6 [&_header]:mb-3 [&_header]:flex [&_header]:flex-wrap [&_header]:items-start [&_header]:justify-between [&_h2]:font-semibold" aria-label="selected model trend">
      <header>
        <h2 className="max-w-56 truncate" title={model.model}>{model.model}</h2><span className="text-muted-foreground">{model.provider && <>{model.provider} · </>}{label} · by {bucket}</span>
        <div className="flex items-center gap-1 xl:ms-auto" aria-label="model chart shows" role="group">
          {(["calls", "tokens"] as const).map((metric) => <Button variant="outline" type="button" key={metric} aria-pressed={metric === chart} onClick={() => setChart(metric)}>{metric}</Button>)}
        </div>
      </header>
      {points ? <TrendChart series={points} bucket={bucket} chart={chart} /> : <p className="text-muted-foreground">no series for this model · zeta returns the top 20 by calls</p>}
    </section>
    {full.panel}
  </>;
}

function Meter({ part, scale }: { part: number; scale: number }) {
  return <span data-aggregate-meter className="me-2 inline-block h-1 w-14 bg-muted align-middle [&>i]:block [&>i]:h-full [&>i]:bg-destructive" aria-hidden="true"><i style={{ width: `${100 * part / Math.max(scale, Number.EPSILON)}%` }} /></span>;
}

function ToolTable({ data }: { data: Extract<AggregateLoaded, { tab: "tools" }> }) {
  const { page: { items }, totals } = data;
  const full = useFullName("tool");
  const rates = items.map((row) => ({ row, share: errorShare({ tool: row }) }));
  const highest = Math.max(0, ...rates.map(({ share }) => share ?? 0));
  const failures = items.reduce((sum, row) => sum + row.errors, 0);
  return <>
    <Heading title="tools">{formatCount(totals.tool_calls)} calls · <span className="text-destructive">{formatCount(failures)}</span> failed{data.page.next_cursor !== null && " in rows shown"} · sizes only</Heading>
    <AggregateTable kind="tools" columns={["tool", "type", "calls ↓", "failed", "failure rate", "p50", "p95", "args in", "results out", "last"]}>
      {rates.map(({ row, share }) => <TableRow key={toolKey(row)}>
        <Cell className="min-w-36"><Name name={row.tool_name} kind="tool" reveal={full.reveal} /></Cell>
        <Cell className="max-w-56 truncate text-muted-foreground"><span title={row.tool_type ?? undefined}>{row.tool_type ?? "—"}</span></Cell>
        <Cell label="calls" className="font-medium">{formatCount(row.calls)}</Cell>
        <Cell label="failed" className={row.errors ? "text-destructive" : "text-muted-foreground"}>{formatCount(row.errors)}</Cell>
        <Cell className="text-muted-foreground"><Meter part={share ?? 0} scale={highest} /><span data-failure-rate>{formatPercent(share, 1) ?? "—"}</span></Cell>
        <Cell label="p50"><span title={latencyTitle}>{formatLatency(row.p50_ns)}</span></Cell>
        <Cell label="p95"><span title={latencyTitle}>{formatLatency(row.p95_ns)}</span></Cell>
        <Cell label="args" className="tabular-nums">{formatBytes(row.argument_bytes)}</Cell>
        <Cell label="out" className="tabular-nums">{formatBytes(row.result_bytes)}</Cell>
        <Cell label="last" className="text-muted-foreground"><time title={formatFullTime(row.last_ns)}>{formatHour(row.last_ns)}</time></Cell>
      </TableRow>)}
    </AggregateTable>
    <p className="mt-4 border bg-card p-3 text-sm text-muted-foreground">□ telemetry keeps tool call sizes, never arguments or results. open a session to see when each call ran.</p>
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
    <Heading title={<><span className="text-destructive">{formatCount(items.length)}</span> {next_cursor !== null ? "errors shown" : "errors"}</>}>{label}{answered && ` · ${answered}`} · error type only, never the message</Heading>
    {classes.length > 0 && <>
      <p className="mb-2 text-sm text-muted-foreground" id="tm-error-classes-label">error classes · full range</p>
      <ul className="flex flex-wrap gap-2 [&>li]:border [&>li]:px-2 [&>li]:py-1 [&>li]:text-sm" aria-labelledby="tm-error-classes-label">
        {(expanded ? classes : classes.slice(0, 4)).map(({ error_type, count }) => {
          const name = error_type ?? "unknown class";
          return <li key={name}>
            <span className="max-w-56 truncate" title={name}>{name}</span><span className="text-muted-foreground"><Meter part={count} scale={scale} />{formatCount(count)}</span>
          </li>;
        })}
        {hidden > 0 && <li className="text-muted-foreground"><Button variant="outline"  type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "fewer types" : `${hidden} more buckets ▾`}</Button></li>}
      </ul>
    </>}
    <p className="mb-1 text-xs text-muted-foreground xl:hidden" aria-hidden="true">more operations →</p>
    <div className="my-3 flex flex-wrap gap-1" role="group" aria-label="filter by operation"><span className="text-muted-foreground">operation</span>
      {([null, ...OPERATIONS] as const).map((op) => <Button variant="outline" key={op ?? "all"} type="button"  className="aria-pressed:bg-accent" aria-pressed={op === operation} onClick={op !== operation ? () => choose(op) : undefined}>{op ?? "all"}</Button>)}
    </div>
    {items.length === 0 ? <p className="border-t py-4 text-muted-foreground" role="status">no {answered ? `${answered} ` : ""}errors in the {label}</p> :
      <AggregateTable kind="errors" columns={["time ↓", "error type", "operation", "duration", "session"]}>
        {items.map((row) => <ErrorLine key={errorKey(row)} row={row} open={open} />)}
      </AggregateTable>}
  </>;
}

function ErrorLine({ row, open }: { row: ErrorRow; open: Open }) {
  const target = row.model ?? row.tool_name ?? (row.operation === "mcp" ? [row.mcp_server, row.mcp_tool ?? row.mcp_method].filter(Boolean).join(" · ") : row.agent_name);
  // The detail projection accepts the root id even when the failing span belongs to a child agent.
  const root = row.session_id?.split(":", 1)[0];
  const href = root && /^[0-9a-f]{32}$/.test(root) ? `/telemetry/sessions/${root}` : null;
  return <TableRow>
    <Cell className="text-muted-foreground"><time title={formatFullTime(row.time_ns)}>{formatTime(row.time_ns)}</time></Cell>
    <Cell className="max-w-56 truncate text-destructive"><span title={row.error_type ?? undefined}>▲ {row.error_type ?? "unknown class"}</span></Cell>
    <Cell className="max-w-56 truncate">{row.operation}{target && <> <span className={row.tool_name ? "text-foreground" : "text-muted-foreground"} title={target}>{target}</span></>}</Cell>
    <Cell className="tabular-nums">{formatDuration(row.duration_ns)}</Cell>
    <Cell >{href ? <a className="text-accent-foreground" href={href} onClick={(event) => open(event, href)} aria-label={`open session ${root}`}>{shortId(root!)} <span aria-hidden="true">↗</span></a> : <span className="text-muted-foreground">—</span>}</Cell>
  </TableRow>;
}

export function AggregateSkeleton({ tab }: { tab: AggregateLoaded["tab"] }) {
  return <div className="grid gap-3" aria-hidden="true">
    <Skeleton className="h-6 w-36" />{Array.from({ length: tab === "models" ? 3 : 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    {tab === "models" && <Skeleton className="mt-4 h-32 w-full" />}
  </div>;
}
