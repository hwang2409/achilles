import { useState, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes, formatCount, formatDay, formatHour, formatPercent, formatTokens } from "./format";
import type { SeriesPoint, TelemetryOverview } from "./telemetry-types";

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
  const rate = formatPercent(totals.errors, totals.model_calls);
  return (
    <div className="tm-overview">
      <h1 className="tm-visually-hidden">telemetry overview</h1>
      <ul className="tm-strip" aria-label="receiver and storage">
        <li>
          <span aria-hidden="true" className={`tm-mark tm-${receiver.tone}`}>{receiver.mark} </span><b>{receiver.text}</b>
          {status.endpoint && <span className="tm-dim"> {ENDPOINT[status.endpoint]}</span>}
        </li>
        {(status.oldest_raw_ns !== null || status.oldest_rollup_ns !== null) && <li className="tm-dim">
          {status.oldest_raw_ns !== null && <>raw since <b>{formatDay(status.oldest_raw_ns)}</b></>}
          {status.oldest_raw_ns !== null && status.oldest_rollup_ns !== null && " · "}
          {status.oldest_rollup_ns !== null && <>hourly since <b>{formatDay(status.oldest_rollup_ns)}</b></>}
        </li>}
        <li className="tm-dim">
          storage <span className="tm-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (status.used_bytes / Math.max(1, status.max_bytes)) * 100)}%` }} /></span>
          <b>{formatBytes(status.used_bytes)}</b> of {formatBytes(status.max_bytes)}
        </li>
      </ul>
      {totals.spans === 0 ? empty : <>
        <div className="tm-metrics">
          <Metric label="sessions" value={formatCount(totals.sessions)} className="tm-m-sessions" />
          <Metric label="model calls" mark="■" markClass="tm-accent" value={formatCount(totals.model_calls)} className="tm-m-calls" />
          <Metric label="tool calls" mark="■" markClass="tm-tool" value={formatCount(totals.tool_calls)} className="tm-m-tools" />
          <Metric label="errors" mark="▲" markClass="tm-danger" tone="danger" value={formatCount(totals.errors)} detail={rate} detailSuffix=" of model calls" className="tm-m-errors" />
          <Metric label="tokens" value={formatTokens(totals.total_tokens)} detail={`in ${formatTokens(totals.input_tokens)} · out ${formatTokens(totals.output_tokens)}`} className="tm-m-tokens" />
          <div className="tm-toggle" role="group" aria-label="chart shows">
            {(["calls", "tokens"] as Chart[]).map((value) => <button key={value} type="button" aria-pressed={chart === value} onClick={() => setChart(value)}>{value}</button>)}
          </div>
        </div>
        <TrendChart series={series} chart={chart} bucket={bucket} />
      </>}
    </div>
  );
}

/** `detailSuffix` is dropped on narrow screens, as the T1m board shows the rate alone. */
function Metric({ label, value, detail, detailSuffix, mark, markClass, tone, className }: { label: string; value: string; detail?: string | null; detailSuffix?: string; mark?: string; markClass?: string; tone?: "danger"; className?: string }) {
  return (
    <div className={`tm-metric${className ? ` ${className}` : ""}`}>
      <span className="tm-metric-label">{mark && <span aria-hidden="true" className={`tm-metric-mark ${markClass}`}>{mark} </span>}{label}</span>
      <span className="tm-metric-value-line">
        <span className={`tm-metric-value${tone ? ` tm-${tone}` : ""}`}>{value}</span>
        {detail && <span className="tm-metric-detail">{detail}{detailSuffix && <span className="tm-metric-suffix">{detailSuffix}</span>}</span>}
      </span>
    </div>
  );
}

/** Blocks at the real size of the metrics and chart, so nothing jumps when the first read lands. */
export function OverviewSkeleton() {
  return (
    <div className="tm-skeleton" aria-hidden="true">
      <div className="tm-skeleton-metrics">{[0, 1, 2].map((index) => <div key={index}><i /><b /></div>)}</div>
      <div className="tm-skeleton-chart">{[8, 6, 4, 14, 28, 42, 50, 58, 70, 62, 48, 38].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
    </div>
  );
}

const bucketLabel = (point: SeriesPoint, bucket: "hour" | "day") =>
  bucket === "hour" ? `${formatHour(point.start_ns)} – ${formatHour(point.end_ns)}` : formatDay(point.start_ns);

/**
 * Bars per bucket: model calls with errors as a red cap, or total tokens. The bucket that holds now is dashed: it is
 * still filling. One tab stop; arrow keys and the pointer pick a bucket, and its exact numbers show in a live tooltip.
 */
function TrendChart({ series, chart, bucket }: { series: SeriesPoint[]; chart: Chart; bucket: "hour" | "day" }) {
  const [active, setActive] = useState<number | null>(null);
  const value = (point: SeriesPoint) => (chart === "calls" ? point.model_calls : point.total_tokens);
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
  const what = chart === "calls" ? `model calls per ${bucket} · errors on top` : `tokens per ${bucket}`;
  return (
    <figure className="tm-chart">
      <figcaption className="tm-chart-head">
        <span>{what}</span>
        <span className="tm-chart-now">now {formatHour(nowNs)} · dashed = this {bucket} so far</span>
      </figcaption>
      <div className="tm-chart-body">
        <div
          className="tm-plot"
          tabIndex={0}
          role="group"
          aria-label={`${what}. use the left and right arrow keys to read each ${bucket}.`}
          onKeyDown={keys}
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
        >
          {series.map((point, index) => {
            const errors = chart === "calls" ? Math.min(point.errors, point.model_calls) : 0;
            const open = point.start_ns <= nowNs && nowNs < point.end_ns;
            return (
              <div key={point.start_ns} className={`tm-col${index === active ? " tm-col-active" : ""}${open ? " tm-col-open" : ""}`} onMouseEnter={() => setActive(index)}>
                <div className="tm-bar-fill" style={{ height: `${(value(point) / max) * 100}%` }}>
                  {errors > 0 && <div className="tm-bar-error" style={{ height: `${Math.max(4, (errors / Math.max(1, point.model_calls)) * 100)}%` }} />}
                </div>
                {(index % step === 0 || index === middle) && <span className={`tm-tick${index === 0 || index === middle ? " tm-tick-key" : ""}`} aria-hidden="true">{bucket === "hour" ? formatHour(point.start_ns) : formatDay(point.start_ns)}</span>}
              </div>
            );
          })}
          <span className="tm-tick tm-tick-now" aria-hidden="true">now</span>
        </div>
        <div className="tm-tooltip" aria-live="polite" hidden={!shown} style={shown ? { left: `${((active! + 0.5) / series.length) * 100}%` } : undefined} data-side={active !== null && active > series.length / 2 ? "left" : "right"}>
          {shown && <>
            <b>{bucketLabel(shown, bucket)}</b>
            <dl>
              <dt>model calls</dt><dd>{formatCount(shown.model_calls)}</dd>
              <dt>errors</dt><dd className="tm-danger">{formatCount(shown.errors)}</dd>
              <dt>tool calls</dt><dd>{formatCount(shown.tool_calls)}</dd>
              <dt>tokens</dt><dd>{formatTokens(shown.total_tokens)}</dd>
            </dl>
          </>}
        </div>
      </div>
    </figure>
  );
}
