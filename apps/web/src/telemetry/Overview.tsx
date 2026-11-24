import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes, formatCount, formatDay, formatHour, formatPercent, formatTokens } from "./format";
import { errorShare } from "./errorShare";
import type { ModelSeriesPoint, SeriesPoint, TelemetryOverview } from "./telemetry-types";

type Chart = "calls" | "tokens";

const RECEIVER = {
  ready: { text: "receiver ready", tone: "ok", mark: "■" },
  starting: { text: "receiver starting", tone: "warn", mark: "□" },
  stopped: { text: "receiver stopped", tone: "muted", mark: "■" },
  error: { text: "receiver error", tone: "danger", mark: "▲" },
} as const;
const ENDPOINT = { builtin: "built-in · 127.0.0.1:4323", external: "external collector" } as const;

export function Overview({ overview, bucket, chart, setChart, empty }: { overview: TelemetryOverview; bucket: "hour" | "day"; chart: Chart; setChart: (chart: Chart) => void; empty: ReactNode }) {
  const { status, totals, series } = overview;
  const receiver = RECEIVER[status.receiver];
  const rate = formatPercent(errorShare({ spans: totals }), 1);
  return (
    <div className="min-w-0">
      <h1 className="sr-only">telemetry overview</h1>
      <ul className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-b pb-4 text-sm" aria-label="receiver and storage">
        <li>
          <span aria-hidden="true" data-tone={receiver.tone} className="data-[tone=danger]:text-destructive">{receiver.mark} </span><b>{receiver.text}</b>
          {status.endpoint && <span className="text-muted-foreground"> {ENDPOINT[status.endpoint]}</span>}
        </li>
        {(status.oldest_raw_ns !== null || status.oldest_rollup_ns !== null) && <li className="text-muted-foreground">
          {status.oldest_raw_ns !== null && <>raw since <b>{formatDay(status.oldest_raw_ns)}</b></>}
          {status.oldest_raw_ns !== null && status.oldest_rollup_ns !== null && " · "}
          {status.oldest_rollup_ns !== null && <>hourly since <b>{formatDay(status.oldest_rollup_ns)}</b></>}
        </li>}
        <li className="text-muted-foreground">
          storage <span className="mx-2 inline-block h-1.5 w-16 bg-muted align-middle [&>span]:block [&>span]:h-full [&>span]:bg-primary" aria-hidden="true"><span style={{ width: `${Math.min(100, (status.used_bytes / Math.max(1, status.max_bytes)) * 100)}%` }} /></span>
          <b>{formatBytes(status.used_bytes)}</b> of {formatBytes(status.max_bytes)}
        </li>
      </ul>
      {totals.spans === 0 ? empty : <>
        <div className="mb-5 grid gap-2 sm:grid-cols-3 xl:flex xl:flex-wrap">
          <Metric label="sessions" value={formatCount(totals.sessions)} metric="sessions" />
          <Metric label="model calls" mark="■" markClass="text-accent-foreground" value={formatCount(totals.model_calls)} metric="calls" />
          <Metric label="tool calls" mark="■" markClass="text-foreground" value={formatCount(totals.tool_calls)} metric="tools" />
          <Metric label="errors" mark="▲" markClass="text-destructive" tone="danger" value={formatCount(totals.errors)} detail={rate} detailSuffix=" errored spans / all spans" metric="errors" />
          <Metric label="tokens" value={formatTokens(totals.total_tokens)} detail={`in ${formatTokens(totals.input_tokens)} · out ${formatTokens(totals.output_tokens)}`} metric="tokens" />
          <div className="flex items-center gap-1 xl:ms-auto" role="group" aria-label="chart shows">
            {(["calls", "tokens"] as Chart[]).map((value) => <Button variant="outline" key={value} type="button" className="aria-pressed:bg-accent" aria-pressed={chart === value} onClick={() => setChart(value)}>{value}</Button>)}
          </div>
        </div>
        <TrendChart series={series} chart={chart} bucket={bucket} />
        <ComingNext />
      </>}
    </div>
  );
}

function Metric({ label, value, detail, detailSuffix, mark, markClass, tone, metric }: { label: string; value: string; detail?: string | null; detailSuffix?: string; mark?: string; markClass?: string; tone?: "danger"; metric: string }) {
  return (
    <Card data-telemetry-metric={metric} className="min-w-0 gap-1 p-3">
      <span className="text-sm text-muted-foreground">{mark && <span aria-hidden="true" className={markClass}>{mark} </span>}{label}</span>
      <span className="flex flex-wrap items-baseline gap-2">
        <span data-tone={tone} className="text-2xl font-semibold tabular-nums data-[tone=danger]:text-destructive">{value}</span>
        {detail && <span data-metric-detail className="text-xs text-muted-foreground">{detail}{detailSuffix && <span data-metric-detail-label>{detailSuffix}</span>}</span>}
      </span>
    </Card>
  );
}

/** The T1 sections zeta does not serve yet, each with the zeta read that brings it. */
function ComingNext() {
  return (
    <section className="mt-6 border-t py-3 text-sm text-muted-foreground [&_h2]:font-semibold [&_h2]:text-foreground" aria-label="coming next">
      <h2>coming next</h2>
      <ul>
        <li>running now <span>— with zeta state slice 6c (<code>state_sessions</code>, <code>state_agents</code>)</span></li>
      </ul>
    </section>
  );
}

/** Blocks at the real size of the metrics and chart, so nothing jumps when the first read lands. */
export function OverviewSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden="true">
      <div className="flex flex-wrap gap-4 [&>div]:grid [&>div]:gap-2">{[0, 1, 2].map((index) => <div key={index}><Skeleton className="h-3 w-24" /><Skeleton className="h-8 w-20" /></div>)}</div>
      <div className="flex h-64 items-end gap-2 border-b [&>*]:flex-1">{[8, 6, 4, 14, 28, 42, 50, 58, 70, 62, 48, 38].map((height, index) => <Skeleton key={index} style={{ height: `${height}%` }} />)}</div>
    </div>
  );
}

type ChartPoint = SeriesPoint | ModelSeriesPoint;

const bucketLabel = (point: ChartPoint, bucket: "hour" | "day") =>
  bucket === "hour" ? `${formatHour(point.start_ns)} – ${formatHour(point.end_ns)}` : formatDay(point.start_ns);

/**
 * Bars per bucket: model calls or total tokens. Only model-grouped buckets can show a call error share. The bucket that holds now is dashed: it is
 * still filling. One tab stop; arrow keys and the pointer pick a bucket, and its exact numbers show in a live tooltip.
 */
export function TrendChart({ series, chart, bucket }: { series: ChartPoint[]; chart: Chart; bucket: "hour" | "day" }) {
  const [active, setActive] = useState<number | null>(null);
  const value = (point: ChartPoint) => (chart === "calls" ? point.model_calls : point.total_tokens);
  const max = Math.max(1, ...series.map(value));
  const step = Math.max(1, Math.ceil(series.length / 8));
  const middle = Math.floor(series.length / 2); // narrow screens keep only the first, the middle, and "now"
  const shown = active !== null && active < series.length ? series[active] : null;
  const nowNs = Date.now() * 1e6;
  const keys = (event: KeyboardEvent) => {
    const last = series.length - 1;
    const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(last);
    else if (move) setActive(Math.min(last, Math.max(0, (active ?? (move > 0 ? -1 : last + 1)) + move)));
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  };
  const modelSeries = series[0] && "errored_model_calls" in series[0];
  const what = chart === "calls" ? `model calls per ${bucket}${modelSeries ? " · errored calls on top" : ""}` : `tokens per ${bucket}`;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
        <span>{what}</span>
        <span>now {formatHour(nowNs)} · dashed = this {bucket} so far</span>
      </figcaption>
      <div className="relative pb-8">
        <div
          className="relative flex h-52 items-end gap-1 border-b focus-visible:outline-ring sm:h-64"
          tabIndex={0}
          role="group"
          aria-label={`${what}. use the left and right arrow keys to read each ${bucket}.`}
          onKeyDown={keys}
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
        >
          {series.map((point, index) => {
            const share = chart === "calls" && "errored_model_calls" in point ? errorShare({ modelBucket: point }) : null;
            const open = point.start_ns <= nowNs && nowNs < point.end_ns;
            return (
              <div key={point.start_ns} data-active={index === active} data-open={open} className="relative flex h-full flex-1 items-end data-[active=true]:bg-accent data-[open=true]:[&>div]:border-2 data-[open=true]:[&>div]:border-dashed data-[open=true]:[&>div]:border-primary data-[open=true]:[&>div]:bg-transparent" onMouseEnter={() => setActive(index)}>
                <div className="relative w-full bg-primary" style={{ height: `${(value(point) / max) * 100}%` }}>
                  {share !== null && share > 0 && <div data-chart-errors className="absolute inset-x-0 top-0 bg-destructive" style={{ height: `${share * 100}%` }} />}
                </div>
                {(index % step === 0 || index === middle) && <span data-key={index === 0 || index === middle} className="absolute start-0 top-full hidden pt-1 whitespace-nowrap text-xs text-muted-foreground data-[key=true]:block sm:block" aria-hidden="true">{bucket === "hour" ? formatHour(point.start_ns) : formatDay(point.start_ns)}</span>}
              </div>
            );
          })}
          <span className="absolute end-0 top-full pt-1 text-xs text-muted-foreground" aria-hidden="true">now</span>
        </div>
        {/* the live region stays mounted: screen readers skip a region that appears in the same change as its text */}
        <div aria-live="polite">
          {shown && <Card className="pointer-events-none absolute top-0 z-10 w-max gap-1 max-w-[calc(100%-1rem)] border bg-popover p-3 text-xs tabular-nums text-popover-foreground shadow-sm data-[side=left]:-translate-x-full [&_dl]:grid [&_dl]:grid-cols-[1fr_auto] [&_dl]:gap-x-3 [&_dd]:text-end" style={{ left: `${((active! + 0.5) / series.length) * 100}%` }} data-side={active! > series.length / 2 ? "left" : "right"}>
            <b>{bucketLabel(shown, bucket)}</b>
            <dl>
              <dt>model calls</dt><dd>{formatCount(shown.model_calls)}</dd>
              {"errored_model_calls" in shown
                ? <><dt>errored model calls</dt><dd className="text-destructive">{formatCount(shown.errored_model_calls)}</dd></>
                : <><dt>errored spans</dt><dd className="text-destructive">{formatCount(shown.errors)}</dd></>}
              <dt>tool calls</dt><dd>{formatCount(shown.tool_calls)}</dd>
              <dt>tokens</dt><dd>{formatTokens(shown.total_tokens)}</dd>
            </dl>
          </Card>}
        </div>
      </div>
    </figure>
  );
}
