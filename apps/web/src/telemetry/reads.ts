import { useEffect, useMemo, useRef, useState } from "react";
import { ZetaError, type ZetaClient } from "@fulcrum/zeta";
import { errorKey, mergePage, modelKey, modelTrends, toolKey, type AggregateTab } from "./aggregates";
import { readDetail, type DetailData, type DetailTarget } from "./detail-read";
import type { SessionsQuery } from "./Sessions";
import { telemetryClient, type Window } from "./telemetry-client";
import type { ErrorPage, ErrorRow, ModelRow, Operation, Page, SeriesPoint, SeriesRow, TelemetryOverview, TelemetrySession, TelemetryStatus, ToolRow } from "./telemetry-types";

export const POLL_MS = 5_000;

export type Tab = "overview" | "sessions" | AggregateTab;
export type Range = "24h" | "7d";
export const RANGES: Record<Range, { label: string; ms: number; bucket: "hour" | "day" }> = {
  "24h": { label: "last 24 hours", ms: 24 * 3600_000, bucket: "hour" },
  "7d": { label: "last 7 days", ms: 7 * 24 * 3600_000, bucket: "day" },
};
const windowOf = (range: Range, nowMs = Date.now()): Window => ({ start_ns: (nowMs - RANGES[range].ms) * 1e6, end_ns: nowMs * 1e6 });

/**
 * What a read asks for: a new object per user choice, so a reply answers the choice on screen only when its `ask` is
 * that object. `window` is set while paging, because zeta ties a cursor to the window and filters that issued it.
 */
export type Ask = { tab: Tab; range: Range; query: SessionsQuery; window: Window | null; aggregate?: AggregateChoice; detail?: DetailTarget };

type AggregatePage =
  | { tab: "models"; page: Page<ModelRow>; trends: ReturnType<typeof modelTrends> }
  | { tab: "tools"; page: Page<ToolRow> }
  | { tab: "errors"; page: Page<ErrorRow>; classes: ErrorPage["classes"] };
export type AggregateLoaded = AggregatePage & { ask: Ask; status: TelemetryStatus; window: Window; total: number; totals: SeriesPoint };
type AggregateChoice = { tab: Tab; operation: Operation | null; prefix?: AggregateLoaded };

export type Loaded =
  | AggregateLoaded
  | ({ ask: Ask; tab: "detail" } & DetailData)
  | { ask: Ask; tab: "overview"; status: TelemetryStatus; overview: TelemetryOverview }
  | { ask: Ask; tab: "sessions"; status: TelemetryStatus; total: number; page: Page<TelemetrySession>; window: Window };

export type ReadEnv = {
  visible(): boolean;
  /** Calls `listener` when the page becomes visible or hidden, or gains focus; returns the unsubscribe. */
  watch(listener: (event: "visible" | "hidden" | "focus") => void): () => void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

export const browserEnv: ReadEnv = {
  visible: () => document.visibilityState === "visible",
  watch(listener) {
    const visibility = () => listener(document.visibilityState === "visible" ? "visible" : "hidden");
    const focus = () => listener("focus");
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus); };
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** The newest reply (`data`, read at `updatedAt`, epoch ms) stays after a failed or running read. */
type Snapshot = { data?: Loaded; updatedAt?: number; error?: unknown; errorAsk?: Ask; retrying?: boolean; reading: boolean; hidden: boolean };

/** A read can heal after a dropped connection, timeout, or a transient serve error. */
function canRetryRead(error: unknown): boolean {
  if (error instanceof ZetaError) return error.kind === "closed" || error.kind === "output_overflow";
  const rpc = error as { code?: unknown; data?: { retryable?: unknown; reason?: unknown } } | null;
  switch (rpc?.code) {
    case -32004: return rpc.data?.reason !== "parked_limit"; // active work can finish
    case -32005: // unavailable state (including telemetry not yet initialized)
    case -32008: // account lock timeout, not an observer permission error
    case -32009: return rpc.data?.retryable === true; // stale snapshot or settings writer, not a stale revision
    case -32011: return true; // output overflow closes the socket
    default: return rpc?.code === undefined && error instanceof Error
      && (error.message === "transport closed" || error.message === "request timed out");
  }
}

/**
 * The one owner of telemetry reads. It reads the current ask now, then every `POLL_MS` while the page is visible, and
 * again on focus, `want()` or a new ask. At most one read runs: anything asked for during a read becomes one follow-up
 * read after it. A hidden page reads nothing and drops that follow-up. A non-retryable error waits for `want()` or
 * a new ask, even after focus or visibility changes. `stop()` drops the reply in flight.
 */
function createReader(load: (ask: Ask) => Promise<Loaded>, ask: Ask, env: ReadEnv, onChange: (snapshot: Snapshot) => void) {
  let snapshot: Snapshot = { reading: false, hidden: !env.visible() };
  let queued: "auto" | "explicit" | undefined;
  let timer: unknown = null;
  let stopped = false;
  const emit = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch, hidden: !env.visible() }; onChange(snapshot); };
  const clear = () => { if (timer !== null) { env.clearTimer(timer); timer = null; } };
  const autoAllowed = () => snapshot.errorAsk !== ask || snapshot.retrying;
  const want = (explicit = true) => {
    if (stopped) return;
    clear();
    if (!env.visible()) { queued = undefined; emit({}); return; }
    if (snapshot.reading) { queued = explicit ? "explicit" : queued ?? "auto"; return; }
    if (!explicit && !autoAllowed()) { emit({}); return; }
    void read();
  };
  const read = async () => {
    queued = undefined;
    emit({ reading: true });
    const request = ask;
    let result: Partial<Snapshot>;
    try { result = { data: await load(request), updatedAt: Date.now(), error: undefined, errorAsk: undefined, retrying: false }; }
    catch (error) { result = { error, errorAsk: request, retrying: canRetryRead(error) }; }
    if (stopped) return;
    emit({ ...result, reading: false });
    if (queued) want(queued === "explicit");
    else if (env.visible() && autoAllowed()) timer = env.setTimer(() => { timer = null; want(false); }, POLL_MS);
  };
  const unwatch = env.watch((event) => {
    if (event !== "hidden") return want(false);
    clear();
    queued = undefined;
    emit({});
  });
  want();
  return {
    snapshot: () => snapshot,
    want,
    ask(next: Ask) { if (next !== ask) { ask = next; want(); } },
    stop() { stopped = true; clear(); unwatch(); },
  };
}

async function loadTelemetry(reads: ReturnType<typeof telemetryClient>, ask: Ask): Promise<Loaded> {
  const { range, query } = ask;
  if (ask.detail) return { ask, tab: "detail", ...await readDetail(reads, ask.detail) };
  if (ask.tab === "overview") {
    const overview = await reads.overview(windowOf(range), RANGES[range].bucket);
    return { ask, tab: "overview", status: overview.status, overview };
  }
  if (ask.tab !== "sessions") return loadAggregate(reads, ask, ask.tab);
  // The count comes from overview totals for the same window, so overview and sessions show one number.
  const window = ask.window ?? windowOf(range);
  const [overview, page] = await Promise.all([reads.overview(window, RANGES[range].bucket), reads.sessions({ ...window, cursor: query.cursors.at(-1), errorsOnly: query.errorsOnly, profile: query.profile, model: query.model })]);
  return { ask, tab: "sessions", status: overview.status, total: overview.totals.sessions, page, window };
}

async function loadAggregate(reads: ReturnType<typeof telemetryClient>, ask: Ask, tab: AggregateTab): Promise<AggregateLoaded> {
  const prefix = ask.aggregate?.prefix;
  const window = prefix?.window ?? windowOf(ask.range);
  const bucket = RANGES[ask.range].bucket;
  const overviewRead = reads.overview(window, bucket);
  const query = { ...window, cursor: prefix?.page.next_cursor, limit: tab === "errors" ? 7 : 10 };
  if (tab === "models") {
    const [overview, page, trends] = await Promise.all([
      overviewRead, reads.models(query), loadModelTrends(reads, window, bucket),
    ]);
    return { ask, window, tab, status: overview.status, total: overview.active_models, totals: overview.totals, trends, page: mergePage(prefix?.tab === tab ? prefix.page.items : [], page, modelKey) };
  }
  if (tab === "tools") {
    const [overview, page] = await Promise.all([overviewRead, reads.tools(query)]);
    return { ask, window, tab, status: overview.status, total: overview.active_tools, totals: overview.totals, page: mergePage(prefix?.tab === tab ? prefix.page.items : [], page, toolKey) };
  }
  const [overview, page] = await Promise.all([overviewRead, reads.errors({ ...query, operation: ask.aggregate?.operation ?? null })]);
  return { ask, window, tab, status: overview.status, total: overview.totals.errors, totals: overview.totals, classes: page.classes, page: mergePage(prefix?.tab === tab ? prefix.page.items : [], page, errorKey) };
}

async function loadModelTrends(reads: ReturnType<typeof telemetryClient>, window: Window, bucket: "hour" | "day") {
  const points: SeriesRow[] = [];
  let cursor: string | null = null;
  do {
    const page = await reads.modelSeries({ ...window, bucket, cursor });
    points.push(...page.points);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return modelTrends(points, window, bucket);
}

const firstPage: SessionsQuery = { cursors: [null], errorsOnly: false, profile: null, model: null };
type Choice = Omit<Ask, "tab" | "detail" | "aggregate">;

/**
 * The read state of the telemetry pages. `phase` is `loading` (a read runs and this tab has nothing to show),
 * `refreshing` (a read runs over shown data), `idle` (waiting for the next poll) or `hidden` (the page is hidden and
 * reads nothing). `shown` is this tab's newest reply, labelled from the ask it answers; it is `stale` while that ask is
 * not the current one or the last read failed. Every range or filter change starts again from the first page and a
 * fresh window; paging is off until the reply for the current ask arrives, and a cursor goes out only with the
 * filters and window of the page that issued it.
 */
export function useTelemetryReads(client: ZetaClient, tab: Tab, env: ReadEnv = browserEnv, detail?: DetailTarget) {
  const [choice, setChoice] = useState<Choice>({ range: "24h", query: firstPage, window: null });
  const [aggregate, setAggregate] = useState<AggregateChoice>({ tab, operation: null });
  const ask = useMemo<Ask>(() => ({ ...choice, tab, detail, aggregate: aggregate.tab === tab ? aggregate : undefined }), [choice, tab, detail, aggregate]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ reading: false, hidden: false });
  const reader = useRef<ReturnType<typeof createReader> | null>(null);
  const latest = useRef(ask);
  latest.current = ask;
  useEffect(() => {
    const reads = telemetryClient(client);
    const current = createReader((next) => loadTelemetry(reads, next), latest.current, env, setSnapshot);
    reader.current = current;
    return () => { current.stop(); reader.current = null; };
  }, [client, env]);
  useEffect(() => reader.current?.ask(ask), [ask]);

  const matchesRoute = (other?: Ask) => other?.tab === tab && other.detail?.sessionId === detail?.sessionId;
  const data = snapshot.data;
  const error = detail || snapshot.errorAsk?.detail
    ? (snapshot.errorAsk === ask ? snapshot.error : undefined)
    : snapshot.error;
  const mine = data && matchesRoute(data.ask) ? data : undefined;
  const shown = mine && { data: mine, stale: mine.ask !== ask || error !== undefined, label: RANGES[mine.ask.range].label, bucket: RANGES[mine.ask.range].bucket };
  const phase = snapshot.reading ? (mine ? "refreshing" : "loading") : snapshot.hidden ? "hidden" : "idle";
  const answered = mine?.ask === ask ? mine : undefined;
  const restart = (patch: Partial<Choice>, filters: Partial<SessionsQuery> = {}) => setChoice({ ...choice, ...patch, query: { ...choice.query, ...filters, cursors: [null] }, window: null });
  const page = answered?.tab === "sessions" ? answered : undefined;
  return {
    phase,
    /** The newest reply of any tab: its status is the receiver state. */
    data,
    shown,
    error,
    retrying: error !== undefined && snapshot.retrying === true,
    updatedAt: snapshot.updatedAt,
    range: choice.range,
    query: choice.query,
    refresh: () => reader.current?.want(),
    chooseRange: (range: Range) => { setAggregate({ tab, operation: aggregate.tab === tab ? aggregate.operation : null }); restart({ range }); },
    operation: ask.aggregate?.operation ?? null,
    chooseOperation: (operation: Operation | null) => setAggregate({ tab, operation }),
    aggregateNext: answered && answered.tab !== "overview" && answered.tab !== "sessions" && answered.tab !== "detail" && answered.page.next_cursor
      ? () => {
        // The original cursor owns both the already displayed prefix and its fixed window.
        const prefix = { ...answered, ask: { ...answered.ask, aggregate: undefined } };
        setAggregate({ tab, operation: ask.aggregate?.operation ?? null, prefix });
      }
      : undefined,
    aggregateLatest: ask.aggregate?.prefix ? () => setAggregate({ tab, operation: ask.aggregate!.operation }) : undefined,
    setFilters: (filters: Partial<SessionsQuery>) => restart({}, filters),
    next: page?.page.next_cursor
      ? () => setChoice({ ...choice, query: { ...choice.query, cursors: [...choice.query.cursors, page.page.next_cursor] }, window: page.window })
      : undefined,
    previous: answered && choice.query.cursors.length > 1
      ? () => { const cursors = choice.query.cursors.slice(0, -1); setChoice({ ...choice, query: { ...choice.query, cursors }, window: cursors.length === 1 ? null : choice.window }); }
      : undefined,
  };
}
