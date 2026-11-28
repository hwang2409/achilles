import { fromZetaHistory, type ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { HISTORY_READ_FEATURE, readOtherHistory, rpcCode } from "../zeta/historyRead";

const paging = "list_sessions_paging";
const stateRead = "state_read_v1";
const backward = "session_history_backward";
const oldState = "session state needs a newer zeta";
const oldHistory = "needs a newer zeta to read this transcript without opening the session";
const oldAttention = "the attention list needs a newer zeta";
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
      !count(v.child_count) || !count(v.background_count) || !count(v.attention_open)) return;
  return { id: v.session_id, status: v.status as SessionStatus, children: v.child_count, tasks: v.background_count,
    attention: v.attention_open, profile: text(v.profile) };
}

function metadata(v: unknown) {
  if (!isObject(v) || !nonempty(v.session_id) || (v.project_id !== undefined && project(v.project_id) === undefined) ||
      (v.in_use !== undefined && typeof v.in_use !== "boolean") || (v.resident !== undefined && typeof v.resident !== "boolean") ||
      (v.parent_session_id !== undefined && project(v.parent_session_id) === undefined) ||
      ["name", "model", "provider", "cwd", "first_message_preview"].some((key) => v[key] != null && typeof v[key] !== "string")) return;
  return { id: v.session_id, title: text(v.name) ?? text(v.first_message_preview) ?? `no user message · ${v.session_id.slice(0, 8)}`, preview: text(v.first_message_preview), project: project(v.project_id),
    model: text(v.model), provider: text(v.provider), cwd: text(v.cwd), created: date(v.created_at), updated: date(v.updated_at),
    parent: project(v.parent_session_id), inUse: v.in_use === true, resident: v.resident === true };
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

// zeta's split (#1597): "action" lists open decisions and deferred items, "fyi" open answers and decided notes
// nanosecond times pass the safe-integer range; millisecond precision is enough for a label
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const attentionLists = { action: ["decision", "deferred"], fyi: ["answer", "decided"] } as const;
type AttentionList = keyof typeof attentionLists;
function attentionRow(v: unknown, list: AttentionList) {
  if (!isObject(v) || !nonempty(v.attention_id) || !nonempty(v.session_id) || v.status !== "open" || v.requires_action !== (list === "action") ||
      !(attentionLists[list] as readonly unknown[]).includes(v.kind) || !nonempty(v.title) || !time(v.created_ns)) return;
  return { id: v.attention_id, session: v.session_id, kind: v.kind as string, title: v.title, created: new Date(v.created_ns / 1e6).toISOString() };
}
export type AttentionItem = NonNullable<ReturnType<typeof attentionRow>>;

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

type Cursors = { other: string; forward: number; backward: { before: number; validator: Record<string, unknown> } };
type Mode = keyof Cursors;
type TranscriptCursor = { [K in Mode]: { kind: K; cursor: Cursors[K] } }[Mode];
export type Transcript = { id: string; rows: readonly unknown[]; omitted: number; next: TranscriptCursor | null; reportedAt: number; restarted: boolean };

function historyPage(v: unknown, next: TranscriptCursor | null) {
  if (!isObject(v) || !Array.isArray(v.messages)) throw invalid();
  // Validate one row at a time, then project the retained rows together so calls and results stay linked.
  const rows = v.messages.filter((row) => !fromZetaHistory([row]).some((e) => e.type === "error" && e.error.code === "adapter_invalid_payload"));
  return { rows, omitted: v.messages.length - rows.length, next };
}

type HistoryRequest = (method: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
function historyReaders(client: ZetaClient, request: HistoryRequest) {
  return {
    async other(id: string, next: TranscriptCursor | undefined, signal: AbortSignal) {
      const cursor = next?.kind === "other" ? next.cursor : undefined;
      const v = await readOtherHistory(client, { session_id: id, limit: 64, ...(cursor ? { cursor } : {}) }, { signal });
      signal.throwIfAborted();
      if (!isObject(v) || (v.next_cursor !== null && (!nonempty(v.next_cursor) || v.next_cursor === cursor))) throw invalid();
      return historyPage(v, v.next_cursor === null ? null : { kind: "other", cursor: v.next_cursor });
    },
    async forward(id: string, next: TranscriptCursor | undefined, signal: AbortSignal) {
      const offset = next?.kind === "forward" ? next.cursor : 0;
      const v = await request("session_history", { session_id: id, offset }, signal);
      if (!isObject(v) || (v.next_offset !== null && (!count(v.next_offset) || v.next_offset <= offset))) throw invalid();
      return historyPage(v, v.next_offset === null ? null : { kind: "forward", cursor: v.next_offset });
    },
    async backward(id: string, next: TranscriptCursor | undefined, signal: AbortSignal) {
      const cursor = next?.kind === "backward" ? next.cursor : undefined;
      const v = await request("session_history", { session_id: id, before: cursor?.before ?? null, ...(cursor ? { history_validator: cursor.validator } : {}) }, signal);
      if (!isObject(v)) throw invalid();
      const validator = v.history_validator;
      if (!isObject(validator) || !count(validator.end) || (validator.entry_id !== null && !nonempty(validator.entry_id))) throw invalid();
      if (cursor && ["end", "entry_id", "repair_generation"].some((key) => validator[key] !== cursor.validator[key])) throw invalid();
      if (v.next_before !== null && (!count(v.next_before) || v.next_before >= (cursor?.before ?? validator.end))) throw invalid();
      return historyPage(v, v.next_before === null ? null : { kind: "backward", cursor: { before: v.next_before, validator } });
    },
  };
}

function readSessionMetadata(client: ZetaClient, signal: AbortSignal) {
  const paged = supportsFeature(client, paging);
  return walk(async (offset: number | null) => {
    signal.throwIfAborted();
    const v = await client.request("list_sessions", paged ? { offset: offset ?? 0, limit: 50 } : {}, { signal, timeoutMs: 12000 });
    if (!isObject(v) || !Array.isArray(v.sessions) || (v.truncated !== undefined && typeof v.truncated !== "boolean")) throw invalid();
    if (!paged) return { rows: v.sessions, next: null, warning: v.truncated ? "zeta returned only the first sessions; update zeta for paging" : undefined };
    if (v.next_offset !== null && (!count(v.next_offset) || v.next_offset <= (offset ?? 0))) throw invalid();
    return { rows: v.sessions, next: v.next_offset };
  }, metadata);
}

export async function readSessionTitles(client: ZetaClient, signal: AbortSignal) {
  const { items } = await readSessionMetadata(client, signal);
  return new Map([...items].flatMap(([id, row]) => row.title !== id ? [[id, row.title] as const] : []));
}

export function createSessionsReader(client: ZetaClient, advertised = (method: string) => supportsRequest(client, method)) {
  const grant = (feature: string, method: string) => supportsFeature(client, feature) && advertised(method);
  const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const result = await client.request(method, params, { signal, timeoutMs: 12000 });
    signal.throwIfAborted();
    return result;
  };
  const history = historyReaders(client, request);
  const transcriptMode = async (row: SessionRow, signal: AbortSignal) => {
    const status = await request("status", {}, signal);
    if (!isObject(status)) throw invalid();
    const attached = status.session;
    if (attached !== null && (!isObject(attached) || !nonempty(attached.session_id))) throw invalid();
    if (attached?.session_id === row.id) return supportsFeature(client, backward) ? "backward" : "forward";
    if (!grant(HISTORY_READ_FEATURE, "session_history_read")) throw new ReadLimit(oldHistory);
    return "other";
  };
  let generation = 0;
  let lastOverlay: { items: Map<string, SessionState>; reportedAt: number } | undefined;
  return {
    transcriptMode,
    async catalog(signal: AbortSignal) {
      const mine = ++generation;
      const [durable, overlay] = await Promise.all([
        readSessionMetadata(client, signal),
        grant(stateRead, "state_sessions") ? walk(async (cursor: string | null) => cursorPage(await request("state_sessions", { cursor, limit: 100 }, signal)), state)
          .then((result) => ({ result, warning: undefined }), (e: unknown) => ({ result: undefined, warning: rpcCode(e) === -32601 ? oldState : readError(e) }))
          : Promise.resolve({ result: undefined, warning: oldState }),
      ]);
      if (mine !== generation) throw new DOMException("superseded", "AbortError");
      signal.throwIfAborted();
      // The pinned catalog also reports this serve's own attached lease as in use.
      let attached: unknown;
      if ([...durable.items.values()].some((row) => row.inUse)) {
        const status = await request("status", {}, signal).catch(() => null);
        if (isObject(status) && isObject(status.session)) attached = status.session.session_id;
        if (mine !== generation) throw new DOMException("superseded", "AbortError");
        signal.throwIfAborted();
      }
      const reportedAt = Date.now();
      if (overlay.result) lastOverlay = { items: overlay.result.items, reportedAt };
      const staleState = !overlay.result && overlay.warning !== oldState ? lastOverlay?.reportedAt : undefined;
      const stateRows = overlay.result?.items ?? (staleState !== undefined ? lastOverlay?.items : undefined);
      const items: SessionRow[] = [...durable.items.values()].map((row) => {
        const snapshot = stateRows?.get(row.id);
        return { ...row, inUse: row.inUse && row.id !== attached, status: snapshot?.status ?? "unknown", state: snapshot };
      });
      return { items, reportedAt, staleState, warnings: [durable.warning, overlay.warning].filter(nonempty),
        omitted: durable.omitted + (overlay.result?.omitted ?? 0), complete: durable.complete };
    },
    /**
     * The session's open attention, read from zeta's own two lists. `decisions` holds exactly what the session's
     * `attention_open` counts: open decision and deferred items owned by this top-level session and its project.
     */
    attention: grant(stateRead, "state_attention") ? async (row: SessionRow, signal: AbortSignal) => {
      const read = (list: AttentionList) => walk(async (cursor: string | null) => cursorPage(await request("state_attention",
        { list, ...(row.project ? { project_id: row.project } : {}), cursor, limit: 200 }, signal)), (v) => attentionRow(v, list));
      try {
        const [decisions, notes] = await Promise.all([read("action"), read("fyi")]);
        // the lists are the project's whole queue: keep this session's items
        const own = (items: Map<string, AttentionItem>) => [...items.values()].filter((item) => item.session === row.id);
        return { decisions: own(decisions.items), notes: own(notes.items), omitted: decisions.omitted + notes.omitted, reportedAt: Date.now() };
      } catch (error) {
        // a zeta before the split refuses `list` as an invalid param
        if (rpcCode(error) === -32601 || rpcCode(error) === -32602) throw new ReadLimit(oldAttention);
        throw error;
      }
    } : undefined,
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
        const next = prior?.next?.kind === kind ? prior.next : undefined;
        try {
          const page = await history[kind](row.id, next, signal);
          const retained = next ? prior!.rows : [];
          return { id: row.id, rows: kind === "forward" ? [...retained, ...page.rows] : [...page.rows, ...retained],
            omitted: page.omitted + (next ? prior!.omitted : 0), next: page.next, reportedAt: Date.now(), restarted: attempt > 0 || (!!prior && !next) };
        } catch (error) {
          if (rpcCode(error) === -32009 && attempt === 0) { prior = undefined; continue; }
          if (rpcCode(error) === -32601 && kind === "other") throw new ReadLimit(oldHistory);
          if (rpcCode(error) === -32602 && kind === "other" && isObject(error) && isObject(error.data) &&
              error.data.code === "session_not_found") throw new ReadLimit("the transcript is not available");
          throw error;
        }
      }
    },
  };
}

export type SessionsReader = ReturnType<typeof createSessionsReader>;
