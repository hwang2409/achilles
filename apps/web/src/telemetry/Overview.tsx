import { useState, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes, formatCount, formatDay, formatHour, formatPercent, formatTokens } from "./format";
import type { SeriesPoint, TelemetryOverview } from "./telemetry-types";

type Chart = "calls" | "tokens";

const RECEIVER_TEXT = { ready: "Receiver healthy", starting: "Receiver starting", stopped: "Receiver stopped", error: "Receiver error" } as const;
const RECEIVER_MARK = { ready: "●", starting: "○", stopped: "■", error: "▲" } as const;
const ENDPOINT_TEXT = { builtin: "built-in receiver", external: "external collector" } as const;

export function Overview({ overview, rangeLabel, bucket, chart, setChart, empty }: { overview: TelemetryOverview; rangeLabel: string; bucket: "hour" | "day"; chart: Chart; setChart: (chart: Chart) => void; empty: ReactNode }) {
  const { status, totals, series } = overview;
  const oldest = status.oldest_rollup_ns ?? status.oldest_raw_ns;
  return (
    <div className="tm-overview">
      <ul className="tm-strip" aria-label="Receiver and storage">
        <li className={`tm-${status.receiver === "ready" ? "ok" : status.receiver === "error" ? "danger" : "warn"}`}>
          <span aria-hidden="true" className="tm-mark">{RECEIVER_MARK[status.receiver]}</span> <b>{RECEIVER_TEXT[status.receiver]}</b>
          {status.endpoint && <span className="tm-dim"> {ENDPOINT_TEXT[status.endpoint]}</span>}
        </li>
        <li><b className="tm-num">{formatCount(totals.sessions)}</b> {totals.sessions === 1 ? "session" : "sessions"}</li>
        <li><b className="tm-num">{formatCount(overview.active_models)}</b> models · <b className="tm-num">{formatCount(overview.active_tools)}</b> tools</li>
        {oldest !== null && <li>retained since <b className="tm-num">{formatDay(oldest)}</b></li>}
        <li><b className="tm-num">{formatBytes(status.used_bytes)}</b> of {formatBytes(status.max_bytes)}</li>
      </ul>
      {totals.spans === 0 ? empty : <>
        <div className="tm-metrics">
          <Metric label="Model calls" swatch="calls" value={formatCount(totals.model_calls)} />
          <Metric label="Errors" swatch="errors" tone="danger" value={formatCount(totals.errors)} detail={formatPercent(totals.errors, totals.spans) ?? undefined} detailLabel="of spans" />
          <Metric label="Tool calls" value={formatCount(totals.tool_calls)} />
          <Metric label="Tokens" value={formatTokens(totals.total_tokens)} detail={`in ${formatTokens(totals.input_tokens)} · out ${formatTokens(totals.output_tokens)}`} />
          <div className="tm-toggle" role="group" aria-label="Chart shows">
            {(["calls", "tokens"] as Chart[]).map((value) => <button key={value} type="button" aria-pressed={chart === value} onClick={() => setChart(value)}>{value === "calls" ? "Calls" : "Tokens"}</button>)}
          </div>
        </div>
        <TrendChart series={series} chart={chart} bucket={bucket} rangeLabel={rangeLabel} />
      </>}
    </div>
  );
}

function Metric({ label, value, detail, detailLabel, swatch, tone }: { label: string; value: string; detail?: string; detailLabel?: string; swatch?: "calls" | "errors"; tone?: "danger" }) {
  return (
    <div className="tm-metric">
      <span className="tm-metric-label">{swatch && <i aria-hidden="true" className={`tm-swatch tm-swatch-${swatch}`} />}{label}</span>
      <span className={`tm-metric-value${tone ? ` tm-${tone}` : ""}`}>{value}</span>
      {detail && <span className="tm-metric-detail">{detail}{detailLabel && <span className="tm-visually-hidden"> {detailLabel}</span>}</span>}
    </div>
  );
}

const bucketLabel = (point: SeriesPoint, bucket: "hour" | "day") =>
  bucket === "hour" ? `${formatHour(point.start_ns)} – ${formatHour(point.end_ns)}` : formatDay(point.start_ns);

/**
 * Bars per bucket: model calls with errors as a red cap, or total tokens. One tab stop; arrow keys and the pointer pick
 * a bucket, and its exact numbers show in a live tooltip.
 */
function TrendChart({ series, chart, bucket, rangeLabel }: { series: SeriesPoint[]; chart: Chart; bucket: "hour" | "day"; rangeLabel: string }) {
  const [active, setActive] = useState<number | null>(null);
  const value = (point: SeriesPoint) => (chart === "calls" ? point.model_calls : point.total_tokens);
  const max = Math.max(1, ...series.map(value));
  const step = Math.max(1, Math.ceil(series.length / 8));
  const shown = active !== null && active < series.length ? series[active] : null;
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
  return (
    <figure className="tm-chart">
      <div
        className="tm-plot"
        tabIndex={0}
        role="group"
        aria-label={`${chart === "calls" ? "Model calls and errors" : "Tokens"} per ${bucket}, ${rangeLabel}. Use left and right arrow keys to read each ${bucket}.`}
        onKeyDown={keys}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {series.map((point, index) => {
          const height = (value(point) / max) * 100;
          const errors = chart === "calls" ? Math.min(point.errors, point.model_calls) : 0;
          return (
            <div key={point.start_ns} className={`tm-col${index === active ? " tm-col-active" : ""}`} onMouseEnter={() => setActive(index)}>
              <div className="tm-bar-fill" style={{ height: `${height}%` }}>
                {errors > 0 && <div className="tm-bar-error" style={{ height: `${Math.max(4, (errors / Math.max(1, point.model_calls)) * 100)}%` }} />}
              </div>
              {index % step === 0 && <span className={`tm-tick${(index / step) % 2 ? " tm-tick-minor" : ""}`} aria-hidden="true">{bucket === "hour" ? formatHour(point.start_ns) : formatDay(point.start_ns)}</span>}
            </div>
          );
        })}
        <span className="tm-now" aria-hidden="true">now</span>
      </div>
      <div className="tm-tooltip" aria-live="polite" hidden={!shown} style={shown ? { left: `${((active! + 0.5) / series.length) * 100}%` } : undefined} data-side={active !== null && active > series.length / 2 ? "left" : "right"}>
        {shown && <>
          <b>{bucketLabel(shown, bucket)}</b>
          <dl>
            {chart === "calls"
              ? <><dt>Model calls</dt><dd>{formatCount(shown.model_calls)}</dd><dt>Errors</dt><dd className="tm-danger">{formatCount(shown.errors)}</dd><dt>Tool calls</dt><dd>{formatCount(shown.tool_calls)}</dd></>
              : <><dt>Tokens</dt><dd>{formatCount(shown.total_tokens)}</dd><dt>Input</dt><dd>{formatCount(shown.input_tokens)}</dd><dt>Output</dt><dd>{formatCount(shown.output_tokens)}</dd></>}
          </dl>
        </>}
      </div>
      <figcaption className="tm-visually-hidden">Peak {formatCount(max)} {chart === "calls" ? "model calls" : "tokens"} in one {bucket}.</figcaption>
    </figure>
  );
}
