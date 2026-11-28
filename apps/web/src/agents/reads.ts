import { listChildRuns, type ChildRunRow, type SessionStore, type ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { rpcCode } from "../zeta/historyRead";
import { isTerminal, withLiveRow } from "./childControls";

export const AGENT_REFRESH_MS = 30_000;
const RECHECK_AFTER_MS = 3_000;
const capabilities = { catalog: ["agent_run_catalog_v1", "agent_run_catalog"], state: ["state_read_v1", "state_agents"], attached: ["child_runs", "child_run_list"] } as const;
type Source = keyof typeof capabilities;
export const sourceNote = {
  catalog: null,
  state: "full agent details need a newer zeta. showing stored agent state.",
  attached: "runs from other sessions need a newer zeta. showing the attached session.",
};
export const unavailable = "child details need a newer zeta.";
export const catalogStatuses = ["running", "idle", "finishing", "suspended", "completed", "failed", "canceled"] as const;
// zeta sends "suspended" only to a client that negotiated this feature; an older zeta rejects it as a catalog filter
export const recoveryFeature = "child_recovery";
const stateStatuses = ["running", "idle", "waiting", "finished", "failed", "cancelled", "unknown"] as const;
export type AgentStatus = typeof catalogStatuses[number] | "waiting" | "unknown";
const statusesForState = { running: "running", idle: "idle", waiting: "waiting", finished: "completed", failed: "failed", cancelled: "canceled", unknown: "unknown" } as const;
export const agentStatuses = [...catalogStatuses, "waiting", "unknown"] as const;
/** The state filter's choices for a read source; "suspended" only when zeta negotiated child recovery. */
export const statusChoices = (source: Source, recovery: boolean) => (source === "catalog" ? catalogStatuses : agentStatuses.filter((state) => source === "attached" ? state !== "waiting" : state !== "finishing"))
  .filter((state) => state !== "suspended" || (recovery && source !== "state"));
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
  acceptsFollowUps?: boolean;
  /** reply and waiting come from the chat's live transcript row (withLiveRow) */
  waiting?: "needs approval" | "needs input";
  reply?: string;
  /** a child zeta paused because its provider failed; times are epoch ms */
  retry?: Retry;
};
export type Retry = { state: "retrying" | "stopped"; startedAt: number; deadlineAt: number; nextAt?: number };
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

// a bad retry field drops the retry facts, not the run
function retryOf(v: Record<string, unknown>): Retry | undefined {
  if (v.status !== "suspended" || v.suspension_reason !== "provider_unavailable" || !date(v.retry_started_at) || !date(v.retry_deadline_at)) return;
  const base = { startedAt: Date.parse(v.retry_started_at), deadlineAt: Date.parse(v.retry_deadline_at) };
  if (v.retry_state === "stopped") return { state: "stopped", ...base };
  if (v.retry_state === "retrying" && date(v.next_retry_at)) return { state: "retrying", ...base, nextAt: Date.parse(v.next_retry_at) };
}

function rich(v: unknown): AgentRun | undefined {
  const id = runIdentity(v);
  if (!id || !object(v) || !text(v.status) || typeof v.agent_type !== "string" || typeof v.description !== "string" ||
      typeof v.current_step !== "string" || typeof v.accepts_follow_ups !== "boolean" || !count(v.turns_used) ||
      !count(v.tool_count) || !finite(v.elapsed_seconds) || !date(v.started_at) || (v.finished_at !== null && !date(v.finished_at))) return;
  const retry = retryOf(v);
  return { ...id, agentType: v.agent_type || undefined, status: catalogStatuses.find((s) => s === v.status) ?? "unknown",
    description: v.description, acceptsFollowUps: v.accepts_follow_ups, currentStep: v.current_step, turnsUsed: v.turns_used, toolCount: v.tool_count,
    elapsedSeconds: v.elapsed_seconds, startedAt: Date.parse(v.started_at), finishedAt: v.finished_at === null ? undefined : Date.parse(v.finished_at), ...(retry && { retry }) };
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

// fulcrum's row parser drops zeta's retry fields, so they come from the raw row with the same run id
function attachedRow(v: ChildRunRow, raw: Record<string, unknown> = {}): AgentRun | undefined {
  return rich({ ...raw, run_id: v.runId, session_id: v.sessionId, parent_run_id: v.parentRunId, agent_type: v.agentType,
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

/**
 * Owns the selected read source, report and continuation generation, and each run row: the report's row with the
 * run's live row (child_run_events) from this client's session store laid over it. Refresh retains the last valid report.
 */
export function createAgentRunsReader(client: ZetaClient, advertised = (method: string) => supportsRequest(client, method), now = Date.now) {
  let state: Snapshot = { refreshing: true };
  let snapshot = state;
  let pending: AbortController | undefined;
  let continuation: Cursor | undefined;
  let seen = new Set<Cursor>();
  // one reread per distinct retry time, after zeta's probe had time to land; children on one account share the time
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const rechecked = new Set<number>();
  const denied = new Set<Source>();
  const listeners = new Set<() => void>();
  // per run: when its live row last changed, the stop for that watch, and whether its end was reread
  const liveAt = new Map<string, number>();
  const watches = new Map<string, { store: SessionStore; stop: () => void }>();
  const reread = new Set<string>();
  const liveItem = (row: AgentRun) => {
    const item = client.stores?.get(row.sessionId)?.getItem(`sub-agent:${row.runId}`);
    return item?.type === "sub_agent" ? item : undefined;
  };
  const show = () => {
    const report = state.report;
    const rows = report?.rows.map((row) => {
      const at = liveAt.get(rowKey(row.sessionId, row.runId));
      return withLiveRow(row, liveItem(row), at !== undefined && at > report.reportedAt ? (at - report.reportedAt) / 1000 : undefined);
    });
    snapshot = report && rows?.some((row, index) => row !== report.rows[index]) ? { ...state, report: { ...report, rows } } : state;
    listeners.forEach((fn) => fn());
    // a run that ended after the report: read its outcome once; a failed reread keeps the report, it does not retry
    const ended = report?.rows.find((row) => !isTerminal(row.status) && ["done", "error", "canceled"].includes(liveItem(row)?.status ?? "") && !reread.has(rowKey(row.sessionId, row.runId)));
    if (ended && !state.refreshing) { reread.add(rowKey(ended.sessionId, ended.runId)); queueMicrotask(() => void request(report!.filters)); }
  };
  const watch = () => {
    const keys = new Set((state.report?.rows ?? []).map((row) => rowKey(row.sessionId, row.runId)));
    for (const [key, { stop }] of watches) if (!keys.has(key)) { stop(); watches.delete(key); }
    // a replay rejoin replaces a session's store: follow the current one. fulcrum has no stores-changed event, so this
    // runs on each report and when a view sees its store change (`storesChanged`)
    // shortcut: the Agents place has no store of its own, so it follows a replaced or later-opened store at the next report
    for (const row of state.report?.rows ?? []) {
      const key = rowKey(row.sessionId, row.runId);
      const store = client.stores?.get(row.sessionId);
      const current = watches.get(key);
      if (current?.store === store) continue;
      current?.stop();
      watches.delete(key);
      if (store) watches.set(key, { store, stop: store.subscribe(`sub-agent:${row.runId}`, () => { liveAt.set(key, now()); show(); }) });
    }
  };
  const publish = (next: Snapshot) => { state = next; watch(); show(); };
  const sources = (Object.keys(capabilities) as Source[]).filter((source) => {
    const [feature, method] = capabilities[source];
    return supportsFeature(client, feature) && advertised(method);
  });
  const load = async (source: Source, { root, status }: AgentFilters, attached: string | null, cursor: Cursor | undefined, signal: AbortSignal): Promise<Page> => {
    signal.throwIfAborted();
    if (source === "attached") {
      if (!attached || root && root !== attached) return { rows: [], omitted: 0 };
      let reply: unknown;
      const reading = { features: client.features, request: (...call: Parameters<ZetaClient["request"]>) => client.request(...call).then((value) => reply = value) };
      const result = await listChildRuns(reading, attached, { limit: 100, offset: typeof cursor === "number" ? cursor : 0, signal, timeoutMs: 12000 });
      if (result.kind !== "page") throw bad();
      const raw = new Map(object(reply) && Array.isArray(reply.runs) ? reply.runs.flatMap((row) => object(row) && text(row.run_id) ? [[row.run_id, row] as const] : []) : []);
      const rows = result.runs.flatMap((value) => {
        const row = attachedRow(value, raw.get(value.runId));
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
  // shortcut: in the Agents place, a recovery from a sent message or a slow probe shows at the next refresh (the chat
  // dialog also rereads on the paused and resumed notices); upgrade: when the run catalog has a change stream
  const scheduleRecheck = () => {
    clearTimeout(recheck);
    recheck = undefined;
    const next = Math.min(...(state.report?.rows ?? []).flatMap(({ retry }) => retry?.nextAt !== undefined && !rechecked.has(retry.nextAt) ? [retry.nextAt] : []));
    if (!Number.isFinite(next)) return;
    recheck = setTimeout(() => {
      recheck = undefined;
      rechecked.add(next);
      if (pending) return;
      void request(state.report?.filters ?? {});
    }, Math.min(2 ** 31 - 1, Math.max(0, next + RECHECK_AFTER_MS - now())));
  };
  const request = async (filters: AgentFilters, more = false) => {
    const base = state.report;
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
      scheduleRecheck();
    };
    publish({ ...state, refreshing: !more, paging: more, warning: undefined });
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
          publish({ ...state, refreshing: true, paging: false });
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
    more: () => request(state.report?.filters ?? {}, true),
    stop() { pending?.abort(); pending = undefined; clearTimeout(recheck); recheck = undefined; watches.forEach(({ stop }) => stop()); watches.clear(); },
    /** a view's session store changed (a replay rejoin installed a new one): watch the current stores and show them */
    storesChanged: () => { watch(); show(); },
  };
}

/** A control result needs a complete, exact-root read, not a partial display snapshot. */
export async function readControlRoot(client: ZetaClient, root: string, signal: AbortSignal) {
  const rows = new Map<string, AgentRun>();
  const seen = new Set<Cursor>();
  let cursor: Cursor | undefined;
  do {
    signal.throwIfAborted();
    const result = page(await client.request("agent_run_catalog", { root_session_id: root, limit: 100,
      ...(cursor === undefined ? {} : { cursor }) }, { signal, timeoutMs: 5000 }), "catalog", root);
    if (result.omitted || (result.next !== undefined && seen.has(result.next))) throw bad();
    for (const run of result.rows) rows.set(run.runId, run);
    cursor = result.next;
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined && seen.size < 20);
  if (cursor !== undefined) throw bad();
  return [...rows.values()];
}
