import type { ZetaClient } from "@fulcrum/zeta";
import type { ErrorRow, ModelRow, Operation, Page, SeriesPage, TelemetryOverview, TelemetrySession, ToolRow } from "./telemetry-types";

export const TELEMETRY_FEATURE = "telemetry_read_v1";
/** Shown on the needs-a-newer-zeta page only: the projects views read through it. */
export const STATE_FEATURE = "state_read_v1";

type Rpc = Pick<ZetaClient, "request" | "features">;

export const telemetryNegotiated = (client: Rpc) => client.features.includes(TELEMETRY_FEATURE);

/** A time window in unix nanoseconds. Paged reads keep one window, because zeta ties cursors to their filters. */
export type Window = { start_ns: number; end_ns: number };

type PageQuery = Window & { cursor?: string | null; limit: number };

export type SessionQuery = Window & { cursor?: string | null; limit?: number; errorsOnly?: boolean; profile?: string | null; model?: string | null };

/** Drops absent and empty values so the request carries only what the user chose; zeta applies its own defaults. */
function params(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

/** Read-only telemetry calls over the page's one negotiated zeta connection. */
export function telemetryClient(client: Rpc) {
  return {
    overview: (window: Window, bucket: "hour" | "day") => client.request("telemetry_overview", { ...window, bucket }) as Promise<TelemetryOverview>,
    models: (query: PageQuery) => client.request("telemetry_models", params(query)) as Promise<Page<ModelRow>>,
    tools: (query: PageQuery) => client.request("telemetry_tools", params(query)) as Promise<Page<ToolRow>>,
    errors: (query: PageQuery & { operation: Operation | null }) => client.request("telemetry_errors", params(query)) as Promise<Page<ErrorRow>>,
    modelSeries: (query: Window & { bucket: "hour" | "day"; cursor: string | null }) =>
      client.request("telemetry_series", params({ ...query, metric: "model_calls", group_by: "model" })) as Promise<SeriesPage>,
    sessions: ({ cursor, limit = 50, errorsOnly, profile, model, ...window }: SessionQuery) =>
      client.request("telemetry_sessions", params({
        ...window,
        limit: Math.min(200, Math.max(1, Math.floor(limit))),
        cursor,
        status: errorsOnly ? "error" : undefined,
        profile,
        model,
      })) as Promise<Page<TelemetrySession>>,
  };
}

/** `code` is zeta's `data.code` (`receiver_unavailable`, `state_unavailable`, ...) when it sent one. */
export type TelemetryProblem = { kind: "off" | "failed"; message: string; code?: string };

/**
 * Sorts a rejected read into what the page shows: telemetry off, or a failure the user can retry. An old zeta is known
 * from the hello (`telemetryNegotiated`), so a `-32601` after the feature was granted is a failure too.
 */
export function telemetryProblem(error: unknown): TelemetryProblem {
  const rpc = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null;
  const message = typeof rpc?.message === "string" ? rpc.message : "telemetry could not be read";
  if (rpc?.data?.code === "telemetry_off") return { kind: "off", message };
  return typeof rpc?.data?.code === "string" ? { kind: "failed", message, code: rpc.data.code } : { kind: "failed", message };
}
