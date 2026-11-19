import type { ZetaClient } from "@fulcrum/zeta";
import type { Page, TelemetryOverview, TelemetrySession } from "./telemetry-types";

type Rpc = Pick<ZetaClient, "request">;

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

/** `code` is zeta's `data.code` (`receiver_unavailable`, `state_unavailable`, ...) when it sent one. */
export type TelemetryProblem = { kind: "off" | "failed"; message: string; code?: string };

/**
 * Sorts a rejected read into what the page shows: telemetry off, or a failure the user can retry. An old zeta is known
 * from the granted hello features, so a `-32601` after the feature was granted is a failure too.
 */
export function telemetryProblem(error: unknown): TelemetryProblem {
  const rpc = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null;
  const message = typeof rpc?.message === "string" ? rpc.message : "telemetry could not be read";
  if (rpc?.data?.code === "telemetry_off") return { kind: "off", message };
  return typeof rpc?.data?.code === "string" ? { kind: "failed", message, code: rpc.data.code } : { kind: "failed", message };
}
