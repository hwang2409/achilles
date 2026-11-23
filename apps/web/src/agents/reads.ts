import { listChildRuns, type ChildRunRow, type ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { rpcCode } from "../zeta/historyRead";

export const AGENT_REFRESH_MS = 30_000;
const capabilities = { catalog: ["agent_run_catalog_v1", "agent_run_catalog"], state: ["state_read_v1", "state_agents"], attached: ["child_runs", "child_run_list"] } as const;
type Source = keyof typeof capabilities;
export const sourceNote = {
  catalog: null,
  state: "full agent details need a newer zeta. showing stored agent state.",
  attached: "runs from other sessions need a newer zeta. showing the attached session.",
};
export const unavailable = "child details need a newer zeta.";
export const catalogStatuses = ["running", "idle", "finishing", "completed", "failed", "canceled"] as const;
const stateStatuses = ["running", "idle", "waiting", "finished", "failed", "cancelled", "unknown"] as const;
export type AgentStatus = typeof catalogStatuses[number] | "waiting" | "unknown";
const statusesForState = { running: "running", idle: "idle", waiting: "waiting", finished: "completed", failed: "failed", cancelled: "canceled", unknown: "unknown" } as const;
export const agentStatuses = [...catalogStatuses, "waiting", "unknown"] as const;
export const rowKey = (root: string, run: string) => JSON.stringify([root, run]);

export type AgentRun = {
  runId: string;
  sessionId: string;
  parentRunId: string | null;
  agentType?: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  description?: string;
  currentStep?: string;
  turnsUsed?: number;
  toolCount?: number;
  elapsedSeconds?: number;
  background?: boolean;
};
export type AgentFilters = { root?: string; status?: AgentStatus };
type Cursor = string | number;
type Page = { rows: AgentRun[]; next?: Cursor; omitted: number };
type Report = { source: Source; rows: readonly AgentRun[]; attached: string | null; filters: AgentFilters; reportedAt: number; omitted: number; complete: boolean };
type Snapshot = { report?: Report; refreshing: boolean; warning?: string; unsupported?: boolean; paging?: boolean };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const invalid = "zeta returned an invalid response";
const bad = () => new Error(invalid);

function runIdentity(v: unknown) {
  if (!object(v) || !text(v.run_id) || !text(v.session_id) || (v.parent_run_id !== null && !text(v.parent_run_id))) return;
  return { runId: v.run_id, sessionId: v.session_id, parentRunId: v.parent_run_id };
}

function rich(v: unknown): AgentRun | undefined {
  const id = runIdentity(v);
  if (!id || !object(v) || !text(v.status) || typeof v.agent_type !== "string" || typeof v.description !== "string" ||
      typeof v.current_step !== "string" || typeof v.accepts_follow_ups !== "boolean" || !count(v.turns_used) ||
      !count(v.tool_count) || !finite(v.elapsed_seconds) || !date(v.started_at) || (v.finished_at !== null && !date(v.finished_at))) return;
  return { ...id, agentType: v.agent_type || undefined, status: catalogStatuses.find((s) => s === v.status) ?? "unknown",
    description: v.description, currentStep: v.current_step, turnsUsed: v.turns_used, toolCount: v.tool_count,
    elapsedSeconds: v.elapsed_seconds, startedAt: Date.parse(v.started_at), finishedAt: v.finished_at === null ? undefined : Date.parse(v.finished_at) };
}

function stored(v: unknown): AgentRun | undefined {
  const id = runIdentity(v);
  if (!id || !object(v)) return;
  const status = stateStatuses.find((s) => s === v.status);
  if (!status || (v.profile !== null && !text(v.profile)) || (v.background !== null && typeof v.background !== "boolean") ||
      (v.started_ns !== null && !finite(v.started_ns)) || (v.ended_ns !== null && !finite(v.ended_ns))) return;
  return { ...id, status: statusesForState[status], agentType: v.profile ?? undefined, background: v.background ?? undefined,
    startedAt: v.started_ns === null ? undefined : Math.floor(v.started_ns / 1e6), finishedAt: v.ended_ns === null ? undefined : Math.floor(v.ended_ns / 1e6) };
}

function attachedRow(v: ChildRunRow): AgentRun | undefined {
  return rich({ run_id: v.runId, session_id: v.sessionId, parent_run_id: v.parentRunId, agent_type: v.agentType,
    description: v.description, current_step: v.currentStep, status: v.status.value, accepts_follow_ups: v.acceptsFollowUps,
    turns_used: v.turnsUsed, tool_count: v.toolCount, elapsed_seconds: v.elapsedSeconds, started_at: v.startedAt, finished_at: v.finishedAt });
}

function page(v: unknown, source: "catalog" | "state", root?: string): Page {
  if (!object(v)) throw bad();
  const body = source === "catalog" && text(v.revision) ? v.data : source === "state" && finite(v.as_of_ns) ? v : undefined;
  if (!object(body) || !Array.isArray(body.items)) throw bad();
  const next = body.next_cursor;
  if (!text(next) && next !== (source === "catalog" ? undefined : null)) throw bad();
  const rows = body.items.flatMap((value) => {
    const row = (source === "catalog" ? rich : stored)(value);
    return row && (!root || row.sessionId === root) ? [row] : [];
  });
  return { rows, next: text(next) ? next : undefined, omitted: body.items.length - rows.length };
}

function warning(error: unknown) {
  switch (rpcCode(error)) {
    case -32000: return "zeta could not read the stored agent runs";
    case -32003: return "the attached session changed · retry";
    case -32005: return "zeta could not read agent runs right now";
    case -32007: return "zeta could not fit the agent runs in a reply";
    case -32009: case -32602: return "zeta rejected the agent run request or continuation · retry";
    default: return error instanceof Error && error.message === invalid ? invalid : "could not read agent runs from zeta";
  }
}

export async function readAttachedRoot(client: ZetaClient, signal: AbortSignal) {
  const value: unknown = await client.request("status", {}, { signal, timeoutMs: 12000 });
  signal.throwIfAborted();
  if (!object(value)) throw bad();
  if (value.session === null) return null;
  if (!object(value.session) || !text(value.session.session_id)) throw bad();
  return value.session.session_id;
}

/** Owns the selected read source, report and continuation generation. Refresh retains the last valid report. */
export function createAgentRunsReader(client: ZetaClient, advertised = (method: string) => supportsRequest(client, method), now = Date.now) {
  let snapshot: Snapshot = { refreshing: true };
  let pending: AbortController | undefined;
  let continuation: Cursor | undefined;
  let seen = new Set<Cursor>();
  const denied = new Set<Source>();
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((fn) => fn()); };
  const sources = (Object.keys(capabilities) as Source[]).filter((source) => {
    const [feature, method] = capabilities[source];
    return supportsFeature(client, feature) && advertised(method);
  });
  const load = async (source: Source, { root, status }: AgentFilters, attached: string | null, cursor: Cursor | undefined, signal: AbortSignal): Promise<Page> => {
    signal.throwIfAborted();
    if (source === "attached") {
      if (!attached || root && root !== attached) return { rows: [], omitted: 0 };
      const result = await listChildRuns(client, attached, { limit: 100, offset: typeof cursor === "number" ? cursor : 0, signal, timeoutMs: 12000 });
      if (result.kind !== "page") throw bad();
      const rows = result.runs.flatMap((value) => {
        const row = attachedRow(value);
        return row?.sessionId === attached ? [row] : [];
      });
      return { rows: status ? rows.filter((row) => row.status === status) : rows, next: result.nextOffset, omitted: result.invalidRows + result.runs.length - rows.length };
    }
    const state = source === "catalog" ? catalogStatuses.find((s) => s === status) : stateStatuses.find((s) => statusesForState[s] === status);
    if (status && !state) return { rows: [], omitted: 0 };
    const params = source === "catalog" ? { limit: 100, ...(cursor === undefined ? {} : { cursor }), ...(root ? { root_session_id: root } : {}), ...(state ? { state } : {}) }
      : { limit: 100, cursor: cursor ?? null, ...(root ? { session_id: root } : {}), ...(state ? { status: state } : {}) };
    return page(await client.request(capabilities[source][1], params, { signal, timeoutMs: 12000 }), source, root);
  };
  const first = async (filters: AgentFilters, signal: AbortSignal) => {
    let attached: string | null = null;
    for (const source of sources) {
      if (denied.has(source)) continue;
      try {
        if (source === "attached") {
          attached = await readAttachedRoot(client, signal);
          if (!attached) return { unsupported: true };
        }
        return { source, attached, page: await load(source, filters, attached, undefined, signal) };
      } catch (error) {
        signal.throwIfAborted();
        if (rpcCode(error) !== -32601) throw error;
        denied.add(source);
      }
    }
    return { unsupported: true };
  };
  const request = async (filters: AgentFilters, more = false) => {
    const base = snapshot.report;
    const cursor = more ? continuation : undefined;
    if (more && (!base || cursor === undefined || pending)) return;
    pending?.abort();
    const controller = pending = new AbortController();
    const { signal } = controller;
    const commit = (result: Page, source: Source, attached: string | null, append: boolean) => {
      signal.throwIfAborted();
      if (!append) seen = new Set();
      if (result.next !== undefined) seen.add(result.next);
      continuation = result.next;
      const rows = new Map((append ? base!.rows : []).map((row) => [rowKey(row.sessionId, row.runId), row]));
      result.rows.forEach((row) => rows.set(rowKey(row.sessionId, row.runId), row));
      publish({ refreshing: false, report: { source, attached, filters, rows: [...rows.values()], omitted: result.omitted + (append ? base!.omitted : 0),
        reportedAt: append ? base!.reportedAt : now(), complete: result.next === undefined } });
    };
    publish({ ...snapshot, refreshing: !more, paging: more, warning: undefined });
    try {
      if (more && base) {
        try {
          const result = await load(base.source, filters, base.attached, cursor, signal);
          if (result.next !== undefined && seen.has(result.next)) throw Object.assign(bad(), { code: -32009 });
          return commit(result, base.source, base.attached, true);
        } catch (error) {
          signal.throwIfAborted();
          const code = rpcCode(error);
          if (code === -32601) denied.add(base.source);
          else if (code !== -32602 && code !== -32009 && code !== -32003) throw error;
          // The cursor is tied to this report. Restart once, never append a new generation.
          publish({ ...snapshot, refreshing: true, paging: false });
        }
      }
      const result = await first(filters, signal);
      signal.throwIfAborted();
      if (result.source) commit(result.page, result.source, result.attached, false);
      else publish({ refreshing: false, unsupported: true });
    } catch (error) {
      if (!signal.aborted) publish({ report: base, refreshing: false, warning: warning(error) });
    } finally {
      if (pending === controller) pending = undefined;
    }
  };
  return {
    snapshot: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: (filters: AgentFilters = {}) => request(filters),
    more: () => request(snapshot.report?.filters ?? {}, true),
    stop() { pending?.abort(); pending = undefined; },
  };
}
