import type { ZetaClient } from "@fulcrum/zeta";
import type { Page, TelemetryOverview, TelemetrySession, TelemetryStatus } from "./telemetry-types";

export const TELEMETRY_FEATURE = "telemetry_read_v1";

type Rpc = Pick<ZetaClient, "request" | "features">;

export const telemetryNegotiated = (client: Rpc) => client.features.includes(TELEMETRY_FEATURE);

/** A time window in unix nanoseconds. Paged reads keep one window, because zeta ties cursors to their filters. */
export type Window = { start_ns: number; end_ns: number };

export type SessionQuery = Window & { cursor?: string | null; limit?: number; errorsOnly?: boolean; profile?: string | null; model?: string | null };

/** Drops absent and empty values so the request carries only what the user chose; zeta applies its own defaults. */
function params(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

/** Read-only telemetry calls over the page's one negotiated zeta connection. */
export function telemetryClient(client: Rpc) {
  return {
    status: () => client.request("telemetry_status", {}) as Promise<TelemetryStatus>,
    overview: (window: Window, bucket: "hour" | "day") => client.request("telemetry_overview", { ...window, bucket }) as Promise<TelemetryOverview>,
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

export type TelemetryProblem = { kind: "off" | "not_negotiated" | "failed"; message: string };

/** Sorts a rejected read into what the page shows: telemetry off, an old zeta, or a failure the user can retry. */
export function telemetryProblem(error: unknown): TelemetryProblem {
  const rpc = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null;
  const message = typeof rpc?.message === "string" ? rpc.message : "telemetry could not be read";
  if (rpc?.data?.code === "telemetry_off") return { kind: "off", message };
  if (rpc?.code === -32601) return { kind: "not_negotiated", message };
  return { kind: "failed", message };
}
