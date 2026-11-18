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
};
