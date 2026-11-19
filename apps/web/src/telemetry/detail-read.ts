import { telemetryClient } from "./telemetry-client";
import type { TelemetryAgent, TelemetrySession, TelemetrySpan, TelemetryStatus, TelemetryTrace } from "./telemetry-types";

type Client = ReturnType<typeof telemetryClient>;
export type DetailTarget = { sessionId: string; traceId: string | null };
export type DetailData = {
  status: TelemetryStatus;
  session: TelemetrySession | undefined;
  traceIds: string[];
  trace: TelemetryTrace | undefined;
  agents: TelemetryAgent[];
  spans: TelemetrySpan[];
};

async function* pages<T extends { next_cursor: string | null }>(load: (cursor: string | null) => Promise<T>) {
  let cursor: string | null = null;
  do {
    const page: T = await load(cursor);
    yield page;
    cursor = page.next_cursor;
  } while (cursor !== null);
}

async function collect<T>(load: (cursor: string | null) => Promise<{ items: T[]; next_cursor: string | null }>) {
  const items: T[] = [];
  for await (const page of pages(load)) items.push(...page.items);
  return items;
}

export async function readDetail(reads: Client, { sessionId, traceId }: DetailTarget): Promise<DetailData> {
  const status = await reads.status();
  const empty = { status, session: undefined, traceIds: [], trace: undefined, agents: [], spans: [] };
  if (!status.enabled) return empty;
  const [session, traceIds] = await Promise.all([reads.session(sessionId), collect((cursor) => reads.traceIds(sessionId, cursor))]);
  // No range filter on a permalink. Prefer the session's last trace unless the user picked one.
  const latest = session?.last_trace_id;
  const selected = traceId ?? (latest && traceIds.includes(latest) ? latest : traceIds.at(-1));
  if (!selected) return { ...empty, traceIds, session };
  if (!traceIds.includes(selected)) {
    // A pinned trace can expire between polls.
    throw { data: { code: "trace_not_found" } };
  }
  const [agents, waterfall] = await Promise.all([
    collect((cursor) => reads.agents(sessionId, selected, cursor)),
    (async () => {
      let trace: TelemetryTrace | undefined;
      const spans: TelemetrySpan[] = [];
      for await (const page of pages((cursor) => reads.trace(selected, cursor))) {
        trace = page.trace;
        spans.push(...page.spans);
      }
      return { trace, spans };
    })(),
  ]);
  return { status, session, traceIds, agents, ...waterfall };
}
