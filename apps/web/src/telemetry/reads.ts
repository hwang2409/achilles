import { useEffect, useMemo, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { readDetail, type DetailData, type DetailTarget } from "./detail-read";
import type { SessionsQuery } from "./Sessions";
import { telemetryClient, type Window } from "./telemetry-client";
import type { Page, TelemetryOverview, TelemetrySession, TelemetryStatus } from "./telemetry-types";

export const POLL_MS = 5_000;

export type Tab = "overview" | "sessions";
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
export type Ask = { tab: Tab; range: Range; query: SessionsQuery; window: Window | null; detail?: DetailTarget };

export type Loaded =
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
type Snapshot = { data?: Loaded; updatedAt?: number; error?: unknown; errorAsk?: Ask; reading: boolean; hidden: boolean };

/**
 * The one owner of telemetry reads. It reads the current ask now, then every `POLL_MS` while the page is visible, and
 * again on focus, `want()` or a new ask. At most one read runs: anything asked for during a read becomes one follow-up
 * read after it. A hidden page reads nothing and drops that follow-up; showing it again reads at once. `stop()` drops
 * the reply in flight.
 */
function createReader(load: (ask: Ask) => Promise<Loaded>, ask: Ask, env: ReadEnv, onChange: (snapshot: Snapshot) => void) {
  let snapshot: Snapshot = { reading: false, hidden: !env.visible() };
  let queued = false;
  let timer: unknown = null;
  let stopped = false;
  const emit = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch, hidden: !env.visible() }; onChange(snapshot); };
  const clear = () => { if (timer !== null) { env.clearTimer(timer); timer = null; } };
  const want = () => {
    if (stopped) return;
    clear();
    if (!env.visible()) { queued = false; emit({}); return; }
    if (snapshot.reading) { queued = true; return; }
    void read();
  };
  const read = async () => {
    queued = false;
    emit({ reading: true });
    const request = ask;
    let result: Partial<Snapshot>;
    try { result = { data: await load(request), updatedAt: Date.now(), error: undefined, errorAsk: undefined }; }
    catch (error) { result = { error, errorAsk: request }; }
    if (stopped) return;
    emit({ ...result, reading: false });
    if (queued) want();
    else if (env.visible()) timer = env.setTimer(() => { timer = null; want(); }, POLL_MS);
  };
  const unwatch = env.watch((event) => {
    if (event !== "hidden") return want();
    clear();
    queued = false;
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

async function loadTelemetry(client: ZetaClient, ask: Ask): Promise<Loaded> {
  const reads = telemetryClient(client);
  const { range, query } = ask;
  if (ask.detail) return { ask, tab: "detail", ...await readDetail(reads, ask.detail) };
  if (ask.tab === "overview") {
    const overview = await reads.overview(windowOf(range), RANGES[range].bucket);
    return { ask, tab: "overview", status: overview.status, overview };
  }
  // The count comes from overview totals for the same window, so overview and sessions show one number.
  const window = ask.window ?? windowOf(range);
  const [overview, page] = await Promise.all([reads.overview(window, RANGES[range].bucket), reads.sessions({ ...window, cursor: query.cursors.at(-1), errorsOnly: query.errorsOnly, profile: query.profile, model: query.model })]);
  return { ask, tab: "sessions", status: overview.status, total: overview.totals.sessions, page, window };
}

const firstPage: SessionsQuery = { cursors: [null], errorsOnly: false, profile: null, model: null };
type Choice = Omit<Ask, "tab" | "detail">;

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
  const ask = useMemo<Ask>(() => ({ ...choice, tab, detail }), [choice, tab, detail]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ reading: false, hidden: false });
  const reader = useRef<ReturnType<typeof createReader> | null>(null);
  const latest = useRef(ask);
  latest.current = ask;
  useEffect(() => {
    const current = createReader((next) => loadTelemetry(client, next), latest.current, env, setSnapshot);
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
    updatedAt: snapshot.updatedAt,
    range: choice.range,
    query: choice.query,
    refresh: () => reader.current?.want(),
    chooseRange: (range: Range) => restart({ range }),
    setFilters: (filters: Partial<SessionsQuery>) => restart({}, filters),
    next: page?.page.next_cursor
      ? () => setChoice({ ...choice, query: { ...choice.query, cursors: [...choice.query.cursors, page.page.next_cursor] }, window: page.window })
      : undefined,
    previous: answered && choice.query.cursors.length > 1
      ? () => { const cursors = choice.query.cursors.slice(0, -1); setChoice({ ...choice, query: { ...choice.query, cursors }, window: cursors.length === 1 ? null : choice.window }); }
      : undefined,
  };
}
