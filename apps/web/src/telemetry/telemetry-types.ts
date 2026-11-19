// Exact v1 shapes of zeta's `telemetry_read_v1` serve methods. Times and durations are integer unix nanoseconds.

export type TelemetryStatus = {
  enabled: boolean;
  receiver: "ready" | "starting" | "stopped" | "error";
  endpoint: "builtin" | "external" | null;
  last_export: "ok" | "error" | null;
  last_export_ns: number | null;
  raw_days: number;
  rollup_days: number;
  max_bytes: number;
  used_bytes: number;
  oldest_raw_ns: number | null;
  oldest_rollup_ns: number | null;
};

export type TelemetrySession = {
  session_id: string;
  first_ns: number;
  last_ns: number;
  last_trace_id: string;
  profile: string | null;
  model: string | null;
  span_count: number;
  turn_count: number;
  model_count: number;
  tool_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type SeriesPoint = {
  start_ns: number;
  end_ns: number;
  sessions: number;
  traces: number;
  spans: number;
  errors: number;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ns: number;
};

export type Page<T> = { items: T[]; next_cursor: string | null; as_of_ns: number };

export type TelemetryOverview = {
  status: TelemetryStatus;
  totals: SeriesPoint;
  series: SeriesPoint[];
  active_models: number;
  active_tools: number;
  /** More series points; null for the 24-hour and 7-day views, which fit in one page. */
  next_cursor: string | null;
};

export type SpanStatus = "unset" | "ok" | "error";

export type TelemetryAgent = {
  session_id: string;
  parent_session_id: string | null;
  agent_name: string | null;
  depth: number;
  background: boolean | null;
  first_ns: number;
  last_ns: number;
  status: SpanStatus;
};

export type TelemetryTrace = {
  trace_id: string;
  first_ns: number;
  last_ns: number;
  root_span_id: string | null;
  root_session_id: string | null;
  status: SpanStatus;
  span_count: number;
  error_count: number;
};

export type SpanEvent = {
  name: string;
  time_ns: number;
  retry_attempt: number | null;
  retry_reason: string | null;
  retry_delay: number | null;
  retry_after: boolean | null;
  decision: string | null;
  scope: string | null;
  duration_ns: number | null;
};

export type TelemetrySpan = {
  span_id: string;
  parent_span_id: string | null;
  operation: "invoke_agent" | "turn" | "chat" | "execute_tool" | "context_compact" | "serve" | "mcp";
  start_ns: number;
  end_ns: number;
  duration_ns: number;
  status: SpanStatus;
  error_type: string | null;
  error_code: "invalid_request" | "rate_limit" | "overloaded" | "timeout" | "auth" | "context_length" | "server_error" | "network" | "stream_error" | "model_not_found" | "max_tokens" | "refusal" | "turn_limit" | "cancelled" | "tool_error" | "unknown" | null;
  session_id: string | null;
  agent_name: string | null;
  agent_depth: number | null;
  background: boolean | null;
  run_id: string | null;
  parent_run_id: string | null;
  turn_number: number | null;
  notification: boolean | null;
  outcome: "finished" | "failed" | "cancelled" | "interrupted" | "turn_limit" | "redispatched" | null;
  provider: string | null;
  request_model: string | null;
  response_model: string | null;
  stream: boolean | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  finish_reason: string | null;
  ttft_ns: number | null;
  retry_count: number | null;
  tool_name: string | null;
  tool_type: string | null;
  tool_call_id: string | null;
  tool_argument_bytes: number | null;
  tool_result_bytes: number | null;
  tool_count: number | null;
  emergency: boolean | null;
  tokens_before: number | null;
  tokens_after: number | null;
  rpc_method: string | null;
  mcp_method: string | null;
  mcp_server: string | null;
  mcp_tool: string | null;
  mcp_prompt: string | null;
  mcp_protocol: string | null;
  request_id: string | null;
  events: SpanEvent[];
};
