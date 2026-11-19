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

export type AggregateCall = {
  calls: number;
  errors: number;
  duration_ns: number;
  p50_ns: number;
  p95_ns: number;
  last_ns: number;
};

export type ModelRow = AggregateCall & Pick<SeriesPoint, "input_tokens" | "output_tokens" | "total_tokens"> & {
  provider: string | null;
  model: string;
  ttft_p50_ns?: number | null;
  ttft_p95_ns?: number | null;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type ToolRow = AggregateCall & {
  tool_name: string;
  tool_type: string | null;
  argument_bytes: number;
  result_bytes: number;
};

export const OPERATIONS = ["chat", "execute_tool", "invoke_agent", "mcp", "turn", "context_compact", "serve"] as const;
export type Operation = typeof OPERATIONS[number];
export type ErrorRow = {
  trace_id: string;
  span_id: string;
  session_id: string | null;
  time_ns: number;
  operation: Operation;
  error_type: string | null;
  duration_ns: number;
  model: string | null;
  tool_name: string | null;
  agent_name: string | null;
  mcp_server: string | null;
  mcp_method: string | null;
  mcp_tool: string | null;
};

export type ErrorPage = Page<ErrorRow> & { classes?: { error_type: string | null; count: number }[] };

export type SeriesRow = { key: string | null; point: SeriesPoint };
export type SeriesPage = { points: SeriesRow[]; next_cursor: string | null };
