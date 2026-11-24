import { Button } from "@/components/ui/button";
import { useState, type ReactNode } from "react";
import { formatBytes, formatCount, formatDuration, formatPercent } from "./format";
import type { SpanEvent, TelemetrySpan } from "./telemetry-types";

export const isRetry = (event: SpanEvent) => event.name === "gen_ai.client.retry";
export const isApproval = (event: SpanEvent) => event.name === "zeta.approval.resolved";
export const spanModel = (span: TelemetrySpan) => span.response_model ?? span.request_model;
export const spanTone = (span: TelemetrySpan) => span.status === "error" ? "error" : span.operation;
export function spanLabel(span: TelemetrySpan) {
  if (span.operation === "turn" && span.turn_number !== null) return `turn ${span.turn_number}`;
  const detail = span.operation === "chat" ? spanModel(span) : span.operation === "execute_tool" ? span.tool_name : span.operation === "invoke_agent" ? span.agent_name : null;
  return detail ? `${span.operation} ${detail}` : span.operation;
}

const count = (value: number | null) => value === null ? null : formatCount(value);
const duration = (value: number | null) => value === null ? null : formatDuration(value);
const bytes = (value: number | null) => value === null ? null : formatBytes(value);
const bool = (value: boolean | null) => value === null ? null : value ? "yes" : "no";

type Field = [string, ReactNode];
function Fields({ rows }: { rows: Field[] }) {
  const present = rows.filter(([, value]) => value != null);
  return present.length > 0 && <dl className="mt-2 grid gap-1 text-xs [&>div]:grid [&>div]:grid-cols-[1fr_1.5fr] [&>div]:gap-2 [&_dt]:text-muted-foreground [&_dd]:wrap-anywhere">{present.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function SpanInspector({ span, first, traceId, inline = false, close }: { span: TelemetrySpan; first: number; traceId: string; inline?: boolean; close?: () => void }) {
  const [expanded, expand] = useState(false);
  const [copy, setCopy] = useState("");
  const start = formatDuration(Math.max(0, span.start_ns - first));
  const retries = span.events.filter(isRetry);
  const retryCount = span.retry_count ?? retries.length;
  const state = span.status === "error" ? "error" : retryCount ? `ok after ${retryCount} ${retryCount === 1 ? "retry" : "retries"}` : "ok";
  const cacheShare = span.cache_read_tokens !== null && span.input_tokens !== null ? formatPercent(span.cache_read_tokens, span.input_tokens) : null;
  const cache = cacheShare === null ? count(span.cache_read_tokens) : `${count(span.cache_read_tokens)} · ${cacheShare}`;
  const tokens: Field[] = [["input", count(span.input_tokens)], ["cache read", cache], ["cache write", count(span.cache_write_tokens)], ["output", count(span.output_tokens)]];
  const full = !inline || expanded;
  return <div className="grid gap-3 [&_section]:border-b [&_section]:pb-3 [&_h3]:font-semibold">
    {!inline && <header className="flex items-start justify-between gap-2 [&_h2]:font-semibold"><div><h2><span aria-hidden="true" data-tone={spanTone(span)} className="data-[tone=error]:text-destructive">{span.status === "error" ? "▲" : "■"}</span> {spanLabel(span)}</h2><p className="text-muted-foreground">{span.operation} span · <span className={span.status === "error" ? "text-destructive" : "tm-ok"}>{state}</span></p></div><Button variant="outline" type="button"  aria-label="close span inspector" onClick={close}>×</Button></header>}
    {inline && !expanded && <Fields rows={[["first token", duration(span.ttft_ns)], ...tokens, ["retry", retryCount ? <span className="text-muted-foreground">{retryCount}{retries[0]?.retry_reason ? ` · ${retries[0].retry_reason}` : ""}{retries[0] ? ` · +${formatDuration(Math.max(0, retries[0].time_ns - span.start_ns))}` : ""}</span> : null]]} />}
    {full && <>
      <div className="flex flex-wrap gap-3 border-y py-2 [&_strong]:block [&_strong]:text-foreground"><span className="text-muted-foreground">duration<strong>{formatDuration(span.duration_ns)}</strong></span><span className="text-muted-foreground">starts at<strong>+{start}</strong></span></div>
      {span.status === "error" && <section><h3 className="text-destructive">error</h3><Fields rows={[["type", span.error_type], ["code", span.error_code]]} /></section>}
      {span.operation === "chat" && <>
        <section><h3>model</h3><Fields rows={[["provider", span.provider], ["request model", span.request_model], ["response model", span.response_model], ["finish reason", span.finish_reason], ["streamed", bool(span.stream)], ["first token", duration(span.ttft_ns)], ["retries", count(span.retry_count)]]} /></section>
        {(span.total_tokens !== null || tokens.some(([, value]) => value !== null)) && <section><div className="flex items-baseline justify-between gap-2"><h3>tokens</h3>{span.total_tokens !== null && <span>{count(span.total_tokens)} <span className="text-muted-foreground">total</span></span>}</div>
          {span.input_tokens !== null && span.output_tokens !== null && span.input_tokens + span.output_tokens > 0 && <div className="mt-2 h-1 bg-primary [&>span]:block [&>span]:h-full [&>span]:bg-muted-foreground" aria-hidden="true"><i style={{ width: formatPercent(span.input_tokens, span.input_tokens + span.output_tokens)! }} /></div>}
          <Fields rows={tokens} />
        </section>}
      </>}
      {span.operation === "execute_tool" && <section><h3>tool</h3><Fields rows={[["name", span.tool_name], ["type", span.tool_type], ["call", span.tool_call_id], ["argument size", bytes(span.tool_argument_bytes)], ["result size", bytes(span.tool_result_bytes)]]} /></section>}
      {span.operation === "context_compact" && <section><h3>compaction</h3><Fields rows={[["emergency", bool(span.emergency)], ["tokens before", count(span.tokens_before)], ["tokens after", count(span.tokens_after)]]} /></section>}
      {(span.operation === "invoke_agent" || span.operation === "turn") && <section><h3>{span.operation === "turn" ? "turn" : "agent"}</h3><Fields rows={[["agent", span.agent_name], ["depth", span.agent_depth], ["background", bool(span.background)], ["turn number", span.turn_number], ["outcome", span.outcome], ["notification", bool(span.notification)], ["tool count", span.tool_count]]} /></section>}
      {(span.operation === "serve" || span.operation === "mcp") && <section><h3>{span.operation}</h3><Fields rows={[["rpc method", span.rpc_method], ["mcp method", span.mcp_method], ["server", span.mcp_server], ["tool", span.mcp_tool], ["prompt name", span.mcp_prompt], ["protocol", span.mcp_protocol]]} /></section>}
      {span.events.length > 0 && <section><h3>events · {formatCount(span.events.length)}</h3><ul className="mt-2 divide-y text-xs [&>li]:py-2">{span.events.map((event, index) => <li key={index}>
        <div className="flex items-baseline justify-between gap-2"><span>{isRetry(event) ? <><span className="text-muted-foreground" aria-hidden="true">◆</span> client retry</> : isApproval(event) ? "approval resolved" : event.name === "zeta.approval.requested" ? "approval requested" : event.name}</span><span className="text-muted-foreground">+{formatDuration(Math.max(0, event.time_ns - span.start_ns))}</span></div>
        <p className="text-muted-foreground">{[event.retry_attempt !== null ? `attempt ${event.retry_attempt}` : null, event.retry_reason, event.retry_delay !== null ? `waited ${formatCount(event.retry_delay)} ms` : null, event.retry_after ? "retry-after" : null, event.decision, event.scope, duration(event.duration_ns)].filter((value) => value != null).join(" · ")}</p>
      </li>)}</ul></section>}
      <section><h3>identifiers</h3><Fields rows={[["span", span.span_id], ["parent", span.parent_span_id], ["trace", traceId], ["session", span.session_id], ["run", span.run_id], ["parent run", span.parent_run_id], ["request", span.request_id]]} />
        <Button variant="outline"  type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(span.span_id); setCopy("span id copied"); }
          catch { setCopy("could not copy span id"); }
        }}>copy span id</Button>{copy && <p role="status">{copy}</p>}
        <p className="mt-2 text-xs text-muted-foreground">metadata only. no prompts, model output, reasoning, or tool arguments.</p>
      </section>
    </>}
    {inline && <Button variant="outline" type="button" className="mt-2" aria-expanded={expanded} onClick={() => expand(!expanded)}>{expanded ? "fewer span fields" : "all span fields"}</Button>}
  </div>;
}
