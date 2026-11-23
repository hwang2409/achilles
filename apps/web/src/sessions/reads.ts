import type { ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { HISTORY_READ_FEATURE, readOtherHistory, rpcCode } from "../zeta/historyRead";

const paging = "list_sessions_paging";
const stateRead = "state_read_v1";
const backward = "session_history_backward";
const oldState = "session state needs a newer zeta";
const oldHistory = "needs a newer zeta to read this transcript without opening the session";
const projectLimit = "zeta can only read other top-level transcripts in the attached session’s project";
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const text = (v: unknown) => nonempty(v) ? v : undefined;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown) => nonempty(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
const project = (v: unknown) => v === null ? null : text(v);
const invalid = () => new Error("zeta returned an invalid response");

const statuses = ["running", "approval", "idle", "failed", "unknown"] as const;
type SessionStatus = typeof statuses[number];
function state(v: unknown) {
  if (!isObject(v) || !nonempty(v.session_id) || !statuses.includes(v.status as SessionStatus) ||
      !count(v.child_count) || !count(v.background_count) || (v.attention_count !== undefined && !count(v.attention_count))) return;
  return { id: v.session_id, status: v.status as SessionStatus, children: v.child_count, tasks: v.background_count,
    attention: v.attention_count as number | undefined, profile: text(v.profile) };
}

function metadata(v: unknown) {
  if (!isObject(v) || !nonempty(v.session_id) || (v.project_id !== undefined && project(v.project_id) === undefined) ||
      (v.parent_session_id !== undefined && project(v.parent_session_id) === undefined) ||
      ["name", "model", "provider", "cwd", "first_message_preview"].some((key) => v[key] != null && typeof v[key] !== "string")) return;
  return { id: v.session_id, title: text(v.name) ?? text(v.first_message_preview) ?? v.session_id, preview: text(v.first_message_preview), project: project(v.project_id),
    model: text(v.model), provider: text(v.provider), cwd: text(v.cwd), created: date(v.created_at), updated: date(v.updated_at),
    parent: project(v.parent_session_id) };
}

type SessionState = NonNullable<ReturnType<typeof state>>;
export type SessionRow = NonNullable<ReturnType<typeof metadata>> & { status: SessionStatus; state?: SessionState };
export type Collection = "agents" | "background_tasks";
const collectionStatuses = ["running", "idle", "waiting", "finished", "failed", "cancelled", "unknown"];
function collectionRow(v: unknown, kind: Collection, sessionId: string) {
  if (!isObject(v) || v.session_id !== sessionId || !nonempty(v.status) || !collectionStatuses.includes(v.status)) return;
  const id = kind === "agents" ? v.run_id : v.task_id;
  if (!nonempty(id)) return;
  return { id, label: text(kind === "agents" ? v.profile : v.kind), status: v.status };
}

export function readError(error: unknown) {
  switch (rpcCode(error)) {
    case -32000: return "zeta could not read the stored data";
    case -32004: return "zeta is busy reading a transcript · retry later";
    case -32005: return "zeta could not read this data right now";
    case -32007: return "zeta could not fit this data in a reply";
    case -32009: return "zeta’s snapshot kept changing · retry";
    default: return error instanceof ReadLimit || (error instanceof Error && error.message === invalid().message)
      ? error.message : "could not read from zeta";
  }
}
export class ReadLimit extends Error {}

// A continuation can be invalidated by a live catalog change. Restart the walk once, never publish a mixed generation.
async function walk<T extends { id: string }, C extends string | number>(load: (cursor: C | null) => Promise<{
  rows: unknown[]; next: C | null; warning?: string;
}>, parse: (row: unknown) => T | undefined) {
  for (let attempt = 0; ; attempt++) {
    const items = new Map<string, T>();
    const cursors = new Set<C>();
    let omitted = 0;
    let cursor: C | null = null;
    let warning: string | undefined;
    try {
      do {
        const page = await load(cursor);
        for (const row of page.rows) {
          const safe = parse(row);
          if (safe) items.set(safe.id, safe); else omitted++;
        }
        warning = page.warning;
        cursor = page.next;
        if (cursor !== null && cursors.has(cursor)) throw Object.assign(invalid(), { code: -32009 });
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      return { items, omitted, warning, complete: !warning && omitted === 0 };
    } catch (error) {
      const code = rpcCode(error);
      if (attempt === 0 && (code === -32009 || (cursor !== null && code === -32602))) continue;
      throw error;
    }
  }
}

function cursorPage(v: unknown) {
  if (!isObject(v) || !Array.isArray(v.items) || (v.next_cursor !== null && !nonempty(v.next_cursor))) throw invalid();
  return { rows: v.items as unknown[], next: v.next_cursor };
}

type TranscriptCursor = { kind: "other"; cursor: string } | { kind: "forward"; cursor: number } |
  { kind: "backward"; cursor: number; validator: Record<string, unknown> };
export type Transcript = { id: string; rows: readonly unknown[]; next: TranscriptCursor | null; reportedAt: number; restarted: boolean };

export function createSessionsReader(client: ZetaClient, advertised = (method: string) => supportsRequest(client, method)) {
  const grant = (feature: string, method: string) => supportsFeature(client, feature) && advertised(method);
  const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const result = await client.request(method, params, { signal, timeoutMs: 12000 });
    signal.throwIfAborted();
    return result;
  };
  const transcriptMode = async (row: SessionRow, signal: AbortSignal) => {
    const status = await request("status", {}, signal);
    if (!isObject(status) || (status.session !== null && !isObject(status.session))) throw invalid();
    const attached = status.session;
    if (!isObject(attached) || !nonempty(attached.session_id)) throw new ReadLimit("zeta has no attached session · open a chat to read other transcripts");
    const active = attached.session_id === row.id;
    if (!active) {
      if (!grant(HISTORY_READ_FEATURE, "session_history_read")) throw new ReadLimit(oldHistory);
      if (row.project === undefined || row.project !== project(attached.project_id)) throw new ReadLimit(projectLimit);
    }
    return !active ? "other" : supportsFeature(client, backward) ? "backward" : "forward";
  };
  let generation = 0;
  let lastOverlay: { items: Map<string, SessionState>; reportedAt: number } | undefined;
  return {
    transcriptMode,
    async catalog(signal: AbortSignal) {
      const mine = ++generation;
      const paged = supportsFeature(client, paging);
      const [durable, overlay] = await Promise.all([
        walk(async (offset: number | null) => {
          const v = await request("list_sessions", paged ? { offset: offset ?? 0, limit: 50 } : {}, signal);
          if (!isObject(v) || !Array.isArray(v.sessions) || (v.truncated !== undefined && typeof v.truncated !== "boolean")) throw invalid();
          if (!paged) return { rows: v.sessions, next: null, warning: v.truncated ? "zeta returned only the first sessions; update zeta for paging" : undefined };
          if (v.next_offset !== null && (!count(v.next_offset) || v.next_offset <= (offset ?? 0))) throw invalid();
          return { rows: v.sessions, next: v.next_offset };
        }, metadata),
        grant(stateRead, "state_sessions") ? walk(async (cursor: string | null) => cursorPage(await request("state_sessions", { cursor, limit: 100 }, signal)), state)
          .then((result) => ({ result, warning: undefined }), (e: unknown) => ({ result: undefined, warning: rpcCode(e) === -32601 ? oldState : readError(e) }))
          : Promise.resolve({ result: undefined, warning: oldState }),
      ]);
      if (mine !== generation) throw new DOMException("superseded", "AbortError");
      signal.throwIfAborted();
      const reportedAt = Date.now();
      if (overlay.result) lastOverlay = { items: overlay.result.items, reportedAt };
      const staleState = !overlay.result && overlay.warning !== oldState ? lastOverlay?.reportedAt : undefined;
      const stateRows = overlay.result?.items ?? (staleState !== undefined ? lastOverlay?.items : undefined);
      const items: SessionRow[] = [...durable.items.values()].map((row) => {
        const snapshot = stateRows?.get(row.id);
        return { ...row, status: snapshot?.status ?? "unknown", state: snapshot };
      });
      return { items, reportedAt, staleState, warnings: [durable.warning, overlay.warning].filter(nonempty),
        omitted: durable.omitted + (overlay.result?.omitted ?? 0), complete: durable.complete };
    },
    async collection(id: string, kind: Collection, signal: AbortSignal) {
      if (!grant(stateRead, "state_session")) throw new ReadLimit(oldState);
      let snapshot: SessionState | undefined;
      try {
        const page = await walk(async (cursor: string | null) => {
          const v = await request("state_session", { session_id: id, collection: kind, cursor, limit: 100 }, signal);
          if (!isObject(v) || v.collection !== kind) throw invalid();
          const parsed = state(v.session);
          if (parsed?.id !== id) throw invalid();
          if (cursor === null) snapshot = parsed;
          return cursorPage(v);
        }, (v) => collectionRow(v, kind, id));
        return { ...page, items: [...page.items.values()], state: snapshot, reportedAt: Date.now() };
      } catch (error) {
        if (rpcCode(error) === -32601) throw new ReadLimit(oldState);
        throw error;
      }
    },
    async transcript(row: SessionRow, previous: Transcript | undefined, signal: AbortSignal): Promise<Transcript> {
      let prior = previous?.id === row.id ? previous : undefined;
      for (let attempt = 0; ; attempt++) {
        const kind = await transcriptMode(row, signal);
        const active = kind !== "other";
        const next = prior?.next?.kind === kind ? prior.next : undefined;
        try {
          const v = kind === "other" ? await readOtherHistory(client, { session_id: row.id, limit: 64,
            ...(next?.kind === "other" ? { cursor: next.cursor } : {}) }, { signal })
            : await request("session_history", { session_id: row.id, ...(kind === "forward" ? { offset: next?.cursor ?? 0 }
              : { before: next?.cursor ?? null, ...(next?.kind === "backward" ? { history_validator: next.validator } : {}) }) }, signal);
          signal.throwIfAborted();
          if (!isObject(v) || !Array.isArray(v.messages)) throw invalid();
          let continuation: TranscriptCursor | null = null;
          if (kind === "other") {
            if (v.next_cursor !== null && (!nonempty(v.next_cursor) || v.next_cursor === next?.cursor)) throw invalid();
            if (v.next_cursor !== null) continuation = { kind, cursor: v.next_cursor };
          } else if (kind === "forward") {
            if (v.next_offset !== null && (!count(v.next_offset) || v.next_offset <= Number(next?.cursor ?? 0))) throw invalid();
            if (v.next_offset !== null) continuation = { kind, cursor: v.next_offset };
          } else {
            const validator = v.history_validator;
            if (!isObject(validator) || !count(validator.end) || (validator.entry_id !== null && !nonempty(validator.entry_id)) ||
                (next?.kind === "backward" && (validator.end !== next.validator.end || validator.entry_id !== next.validator.entry_id || validator.repair_generation !== next.validator.repair_generation)) ||
                (v.next_before !== null && (!count(v.next_before) || v.next_before >= Number(next?.cursor ?? validator.end)))) throw invalid();
            if (v.next_before !== null) continuation = { kind, cursor: v.next_before, validator };
          }
          const retained = next ? prior!.rows : [];
          return { id: row.id, rows: kind === "forward" ? [...retained, ...v.messages] : [...v.messages, ...retained],
            next: continuation, reportedAt: Date.now(), restarted: attempt > 0 || (!!prior && !next) };
        } catch (error) {
          if (rpcCode(error) === -32009 && attempt === 0) { prior = undefined; continue; }
          if (rpcCode(error) === -32601 && !active) throw new ReadLimit(oldHistory);
          if (rpcCode(error) === -32602 && !active) throw new ReadLimit(`${projectLimit} · the transcript is not available`);
          throw error;
        }
      }
    },
  };
}

export type SessionsReader = ReturnType<typeof createSessionsReader>;
