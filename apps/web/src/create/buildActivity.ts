import { useEffect, useMemo, useState } from "react";
import { titleOf, type Chat, type PageLink } from "../surface/AgentNavAdapter";
import type { ZetaClient } from "@fulcrum/zeta";
import { onRunEnd } from "../zeta/turnEnd";
import { supportsFeature } from "../zeta/connection";

// The one owner of displayed page-build state. Nothing else reads chat.last_state for page_build chats.
export type BuildState = "building" | "needs you" | "done" | "unfinished" | "failed";
export type BuildReason = "zeta offline" | "not the current session" | "checking zeta";
// `turn` is the turn end that made a build done; `done` orders completions in this tab: a counter taken when this tab first saw that turn end.
type Observation = { state: BuildState; routes: string[]; turn?: string; done?: number };
// `unproven`: the turn ended with no route in view, but the page does not hold the whole history (Q2: no evidence, no claim).
type Seen = Observation & { tools: string[]; unproven?: boolean };
type Live = { current: string | null; observed?: Seen; reason: BuildReason | null };
const states: readonly BuildState[] = ["building", "needs you", "done", "unfinished", "failed"];
const active = (state: BuildState) => state === "building" || state === "needs you";
const isBuild = (chat: Chat) => chat.purpose === "page_build";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isRoute = (route: unknown): route is string => typeof route === "string" && /^\/(?!\/)[^?#\\\s]+$/.test(route);

type Collected = { routes: string[]; openCalls: string[]; calledCreate: boolean; lastCreateFailed: boolean; latestEnd?: Record<string, unknown> };
// Q2: a call that never ran is not a failure: the user denied it, zeta canceled it, or zeta asks again after a restart.
const notRun = ["tool execution denied", "tool execution canceled", "tool changed after approval"];
const notFailure = (content: unknown) => typeof content === "string" && notRun.some((prefix) => content.startsWith(prefix));

// Successful create_page routes, in result order, from one history page. Unknown shapes are not pages.
function collectCreateRoutes(messages: readonly unknown[]): Collected {
  const calls = new Map<string, string>();
  const routes = new Set<string>();
  let lastCreateFailed = false;
  let calledCreate = false;
  let latestEnd: Record<string, unknown> | undefined;
  for (const raw of messages) {
    const row = object(raw);
    if (row?.role === "user") latestEnd = undefined;
    if (row?.role === "system" && row.event === "served_turn_end") latestEnd = object(row.data);
    if (row?.role === "assistant") {
      for (const block of array(row.content).map(object)) {
        const call = block?.type === "tool_use" && object(block.tool_call);
        if (call && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, call.name);
        if (call && call.name === "achilles__create_page") calledCreate = true;
      }
    }
    const result = row?.role === "tool_result" ? object(row.tool_result) : undefined;
    if (!result || typeof result.tool_call_id !== "string") continue;
    const name = calls.get(result.tool_call_id);
    calls.delete(result.tool_call_id);
    if (name !== "achilles__create_page") continue;
    const route = result.is_error === false ? createdRoute(result.content) : undefined;
    if (route) routes.add(route);
    if (route || (result.is_error === true && !notFailure(result.content))) lastCreateFailed = !route;
  }
  return { routes: [...routes], openCalls: [...calls.values()], calledCreate, lastCreateFailed, latestEnd };
}

function createdRoute(content: unknown) {
  try {
    const route = typeof content === "string" ? object(JSON.parse(content))?.route : undefined;
    return isRoute(route) ? route : undefined;
  } catch { return undefined; }
}

// The state the live status and history prove, or null when they do not show how the last turn ended.
// With no status (a session that is not current), rows prove only a terminal state: a turn end after the last user row.
function classify(status: Record<string, unknown> | null, { routes, lastCreateFailed, latestEnd }: Collected): BuildState | null {
  if (array(status?.pending_approvals).length) return "needs you";
  if (status?.state === "running" || status?.state === "tool") return "building";
  const ended = typeof latestEnd?.turn_id === "string" && (!status || (status.state === "idle" && latestEnd.turn_id === object(status.last_turn_outcome)?.turn_id));
  if (!ended) return null;
  return latestEnd!.reason === "error" || lastCreateFailed ? "failed" : routes.length ? "done" : "unfinished";
}

// `more`: the reply field that is null when the page holds the whole history (session_history: next_before, session_history_read: next_cursor).
function fromHistory(status: Record<string, unknown> | null, history: unknown, more: "next_before" | "next_cursor" = "next_before"): Seen | null {
  const page = object(history);
  const messages = page?.messages;
  if (!Array.isArray(messages)) throw new Error("missing build history");
  const collected = collectCreateRoutes(messages);
  const state = classify(status, collected);
  if (!state) return null;
  // A missing create_page call is evidence only when the page holds the whole history.
  const unproven = state === "unfinished" && !collected.calledCreate && page![more] !== null;
  const pendingTools = array(status?.pending_approvals).map((raw) => object(object(raw)?.tool_call)?.name).filter((name): name is string => typeof name === "string");
  const turn = active(state) ? undefined : collected.latestEnd!.turn_id as string;
  return { state, routes: collected.routes, turn, unproven, tools: active(state) ? [...new Set([...pendingTools, ...collected.openCalls])] : [] };
}

type Store = Pick<Storage, "getItem" | "setItem">;
// A confirmed route from a non-error create_page result. Done never waits for the page catalog.
type Receipt = { chat: Chat; route: string; turn: string; done: number };
const observationKey = (id: string) => `achilles:build-observed:${id}`;

// Per-tab memory: what this tab observed live, and which receipts it acknowledged (Q1).
// shortcut: entries are never pruned; a tab's session storage holds one small row per build it watched.
function buildMemory(storage: () => Store) {
  const local = new Map<string, string>();
  const read = (key: string) => { try { return storage().getItem(key) ?? local.get(key) ?? null; } catch { return local.get(key) ?? null; } };
  const write = (key: string, value: string) => { local.set(key, value); try { storage().setItem(key, value); } catch { /* storage may be disabled */ } };
  const observed = (id: string): Observation | undefined => {
    try {
      const value = object(JSON.parse(read(observationKey(id)) ?? "null"));
      const routes = array(value?.routes);
      const done = typeof value?.done === "number" ? value.done : undefined;
      const turn = typeof value?.turn === "string" ? value.turn : undefined;
      if (states.includes(value?.state as BuildState) && routes.every(isRoute)) return { state: value!.state as BuildState, routes: routes as string[], turn, done };
    } catch { /* an unknown row is no observation */ }
    return undefined;
  };
  const nextDone = () => {
    const done = Number(read("achilles:build-done-counter") ?? 0) + 1;
    write("achilles:build-done-counter", String(done));
    return done;
  };
  // Q1: acknowledging one receipt acknowledges every completion this tab saw at or before it.
  const seen = (done: number) => done <= Number(read("achilles:build-acked-through") ?? 0);
  return {
    observed,
    seen,
    // A live observation merged with what this tab remembers: a confirmed route is never downgraded (Q2).
    // Each turn end that leaves the build done is one completion, numbered when this tab first sees it.
    // `quiet`: a completion this tab never saw run is stored as done 0, which is always seen, so it never shows a receipt.
    observe(id: string, live: Observation & { unproven?: boolean }, quiet = false): Observation | undefined {
      const before = observed(id);
      const routes = [...new Set([...before?.routes ?? [], ...live.routes])];
      if (live.unproven && !routes.length) {
        if (before && active(before.state)) write(observationKey(id), "null");
        return before && !active(before.state) ? before : undefined;
      }
      const state = live.state === "unfinished" && routes.length ? "done" : live.state;
      const turn = state === "done" ? live.turn : undefined;
      const done = state !== "done" ? undefined : before?.state === "done" && before.turn === turn && before.done !== undefined ? before.done : quiet ? 0 : nextDone();
      const next = { state, routes, turn, done };
      write(observationKey(id), JSON.stringify(next));
      return next;
    },
    // The tab saw the session idle with no proof of how its turn ended: an old building/needs-you is no longer known.
    forgetActive: (id: string) => { if (active(observed(id)?.state ?? "done")) write(observationKey(id), "null"); },
    // The last receipt this tab showed, so a reload can show it on the first render, before any catalog or zeta read.
    receipt(): Receipt | undefined {
      try {
        const value = object(JSON.parse(read("achilles:build-receipt-shown") ?? "null"));
        const chat = object(value?.chat);
        if (typeof chat?.session_id === "string" && isRoute(value?.route) && typeof value.turn === "string" && typeof value.done === "number") return { chat: chat as Chat, route: value.route, turn: value.turn, done: value.done };
      } catch { /* an unknown row is no receipt */ }
      return undefined;
    },
    keepReceipt: (receipt: Receipt) => write("achilles:build-receipt-shown", JSON.stringify(receipt)),
    acknowledge: ({ done }: Receipt) => { if (!seen(done)) write("achilles:build-acked-through", String(done)); },
    // A receipt is announced once per completion; the shell marks it only after it set the text in a live region that can speak.
    announced: ({ chat, turn }: Receipt) => read(`achilles:build-announced:${JSON.stringify([chat.session_id, turn])}`) === "1",
    markAnnounced: ({ chat, turn }: Receipt) => write(`achilles:build-announced:${JSON.stringify([chat.session_id, turn])}`, "1"),
  };
}
type Memory = ReturnType<typeof buildMemory>;
type Request = ZetaClient["request"];
const POLL_MS = 2000;
const RETRY_MS = [2000, 5000, 10000];
const READ_FEATURE = "session_history_read_v1";
const BUSY_TRIES = 3;
const errorCode = (error: unknown) => object(error)?.code;
const errorData = (error: unknown) => object(object(error)?.data);
// A run-end read of a build that status says is not current: its rows (null: no turn end in view), or no reply.
type Ended = { id: string; seen: Seen | null } | { id: string; failed: true };

// One status read per pass, and one history read of the current build. A build whose run just ended is read together
// with status, not after it: a chat waiting for zeta attaches on the same agent_end, and the pinned server then cannot read it.
async function readLive(chats: readonly Chat[], request: Request, signal: AbortSignal, ended?: string): Promise<Live & { ended?: Ended }> {
  const options = { signal, timeoutMs: 8000 };
  const endedHistory = ended === undefined ? undefined : request("session_history", { session_id: ended, before: null }, options);
  const endedRead = endedHistory?.then((history): Ended => ({ id: ended!, seen: fromHistory(null, history) }), (): Ended => ({ id: ended!, failed: true }));
  endedRead?.catch(() => ({})); // a malformed reply is read below; it is never an unhandled rejection
  try {
    const status = object(await request("status", {}, options));
    const id = object(status?.session)?.session_id;
    const other = ended !== undefined && ended !== id ? await endedRead!.catch((): Ended => ({ id: ended, failed: true })) : undefined;
    if (!status || typeof id !== "string" || !chats.some((chat) => isBuild(chat) && chat.session_id === id) || signal.aborted) return { current: null, reason: "not the current session", ended: other };
    // The pinned server can read only the runtime's current session. Its null cursor selects one bounded tail page.
    const history = await (id === ended ? endedHistory! : request("session_history", { session_id: id, before: null }, options));
    return { current: id, observed: fromHistory(status, history) ?? undefined, reason: null, ended: other };
  } catch (error) {
    // A runtime switch between status and history returns NO_ACTIVE_SESSION.
    return { current: null, reason: errorCode(error) === -32003 ? "not the current session" : "zeta offline" };
  }
}

// The live pass (status, the current build) and, when zeta granted session_history_read_v1, a serial queue that reads
// builds that are not current, on demand only: first sight, a new turn (updated_at moved), its run end, a manual refresh.
// A trigger during a pass runs one more pass after it; only a client change or unmount aborts.
// shortcut: this is the only session_history_read caller; a second caller must move the queue to one per-client owner, so
// the server's one-read-in-flight budget stays in one place.
function createBuildReader(memory: Memory, publish: (live: Live) => void, reloadPages: (routes: string[]) => void, changed: () => void) {
  let generation = 0;
  let misses = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();
  let latest: { chats: readonly Chat[]; client: ZetaClient | null } = { chats: [], client: null };
  let running = false;
  let again = false;
  const ended = new Set<string>();
  // The session the last live pass proved current, and a stamp each time a pass saw a session current.
  let current: string | null = null;
  let stamps = 0;
  const liveSeen = new Map<string, number>();
  // The queue. `epoch` moves on a client change, unmount, and manual refresh; a reply from an older epoch is dropped.
  let epoch = 0;
  let reads = true;
  let queue: string[] = [];
  let inFlight: { id: string; epoch: number; stamp?: number } | undefined;
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  const readKeys = new Map<string, string | undefined>();
  const busyTries = new Map<string, number>();
  const updatedAt = (id: string) => latest.chats.find((chat) => chat.session_id === id)?.updated_at;

  // Rows prove only a turn end. 4.5: a completion this tab never saw run is quiet (no receipt).
  const prove = (id: string, seen: Seen | null) => {
    if (!seen) return;
    const merged = memory.observe(id, seen, !active(memory.observed(id)?.state ?? "done"));
    changed();
    if (merged?.routes.length) reloadPages(merged.routes);
  };
  const enqueue = (forced: readonly string[]) => {
    const { chats, client } = latest;
    if (!client || !reads || !supportsFeature(client, READ_FEATURE)) return;
    const builds = chats.filter(isBuild);
    // The same four builds /create shows, and any build this tab last knew as active.
    const shown = new Set(builds.slice(0, 4).map((chat) => chat.session_id));
    for (const chat of builds) {
      const id = chat.session_id;
      if (id === current || queue.includes(id)) continue;
      const wanted = shown.has(id) || active(memory.observed(id)?.state ?? "done");
      if (forced.includes(id) || (wanted && readKeys.get(id) !== chat.updated_at)) queue.push(id);
    }
    pump();
  };
  const pump = () => {
    const { client } = latest;
    if (inFlight || busyTimer || !client) return;
    const id = queue.shift();
    if (id === undefined) return;
    const sent = inFlight = { id, epoch, stamp: liveSeen.get(id) };
    readKeys.set(id, updatedAt(id));
    client.request("session_history_read", { session_id: id, limit: 128 }, { signal: controller.signal, timeoutMs: 12000 })
      .then((page) => settle(sent, page), (error) => settle(sent, undefined, error ?? Error("read failed")));
  };
  const settle = (sent: NonNullable<typeof inFlight>, page: unknown, error?: unknown) => {
    if (inFlight !== sent) return;
    inFlight = undefined;
    const { id } = sent;
    const code = errorCode(error);
    if (sent.epoch !== epoch) { /* a manual refresh cleared the keys: the next pass asks again */ }
    else if (error === undefined) {
      // A stale read: the live pass saw this session current since it was sent. The next pass asks again.
      if (id === current || liveSeen.get(id) !== sent.stamp) readKeys.delete(id);
      else {
        busyTries.delete(id);
        try { prove(id, fromHistory(null, page, "next_cursor")); } catch { /* an unknown reply is no claim */ }
      }
    } else if (code === -32004) {
      // Another read is in flight on this serve (another tab or client): wait at least what zeta asks, with jitter.
      const tries = (busyTries.get(id) ?? 0) + 1;
      busyTries.set(id, tries);
      if (tries < BUSY_TRIES) {
        const wait = Math.max(2000, Number(errorData(error)?.retry_after_ms) || 0) + Math.random() * 500;
        busyTimer = setTimeout(() => { busyTimer = undefined; if (!queue.includes(id)) queue.unshift(id); pump(); }, wait);
      }
    } else if (code === -32601) { reads = false; queue = []; }
    // The build became zeta's attached session: the live pass reads it now.
    else if (code === -32602 && errorData(error)?.code !== "session_not_found") run();
    pump();
  };

  const once = async (mine: number) => {
    clearTimeout(timer);
    const { chats, client } = latest;
    const runEnds = [...ended].filter((id) => chats.some((chat) => isBuild(chat) && chat.session_id === id));
    ended.clear();
    if (!client) return publish({ current: current = null, reason: "zeta offline" });
    // No page builds: nothing to read, and no extra status call.
    if (!chats.some(isBuild)) return publish({ current: current = null, reason: "not the current session" });
    const read = await readLive(chats, client.request, controller.signal, runEnds.at(-1));
    if (mine !== generation) return;
    current = read.current;
    if (read.current) liveSeen.set(read.current, ++stamps);
    if (read.current && !read.observed) memory.forgetActive(read.current);
    const merged = read.current && read.observed ? memory.observe(read.current, read.observed) : undefined;
    const live = { current: read.current, reason: read.reason, observed: merged && { ...read.observed!, ...merged } };
    publish(live);
    if (live.observed?.routes.length) reloadPages(live.observed.routes);
    // A terminal state proven live needs no read when the build stops being current, until a new turn starts.
    if (read.current && live.observed && !active(live.observed.state)) readKeys.set(read.current, updatedAt(read.current));
    const proven = read.ended && "seen" in read.ended ? read.ended : undefined;
    if (proven) { prove(proven.id, proven.seen); readKeys.set(proven.id, updatedAt(proven.id)); }
    enqueue(runEnds.filter((id) => id !== read.current && id !== proven?.id));
    // Poll a live active build; after an outage, retry with backoff while this tab remembers an active build.
    const waiting = live.reason === "zeta offline" && chats.some((chat) => isBuild(chat) && active(memory.observed(chat.session_id)?.state ?? "done"));
    misses = live.reason === "zeta offline" ? misses + 1 : 0;
    if (live.observed && active(live.observed.state)) timer = setTimeout(run, POLL_MS);
    else if (waiting) timer = setTimeout(run, RETRY_MS[Math.min(misses, RETRY_MS.length) - 1]);
  };
  function run() {
    if (running) { again = true; return; }
    running = true;
    const mine = generation;
    void (async () => {
      try { do { again = false; await once(mine); } while (again && mine === generation); }
      finally { if (mine === generation) running = false; }
    })();
  }
  const stop = () => {
    generation++;
    epoch++;
    running = again = false;
    ended.clear();
    clearTimeout(timer);
    clearTimeout(busyTimer);
    busyTimer = undefined;
    controller.abort();
    controller = new AbortController();
    queue = [];
    inFlight = undefined;
    readKeys.clear();
    busyTries.clear();
    reads = true;
  };
  return {
    refresh(chats: readonly Chat[], client: ZetaClient | null, endedId?: string) {
      latest = { chats, client };
      if (endedId !== undefined) ended.add(endedId);
      run();
    },
    stop,
    // A manual refresh: every wanted build is read again (one at a time).
    forget: () => { epoch++; readKeys.clear(); busyTries.clear(); },
  };
}

export type BuildRow = { chat: Chat; state: BuildState | null; reason: BuildReason | null; results: string[]; tools: string[] };
// A reason marks a remembered state that is not live now; it is never counted.
export const buildLabel = ({ state, reason }: Pick<BuildRow, "state" | "reason">) => state === null ? null : reason ? `last known ${state} · ${reason}` : state;
// The chat-list state class for a build row: only live states get a live tone.
export const buildTone = (row?: BuildRow) => !row?.state || row.reason ? null : row.state === "building" ? "running" : row.state === "needs you" ? "approval" : row.state;

function projectBuilds(chats: readonly Chat[], live: Live, memory: Memory) {
  let latestReceipt: Receipt | null = null;
  const rows: BuildRow[] = [];
  for (const chat of chats.filter(isBuild)) {
    const isLive = live.current === chat.session_id;
    // With no proof from the live read, what this tab remembers stands (active states were dropped when it saw the session idle).
    const known = (isLive && live.observed) || memory.observed(chat.session_id);
    const tools = isLive ? live.observed?.tools ?? [] : [];
    if (!known) {
      rows.push({ chat, state: null, reason: null, results: [], tools });
      continue;
    }
    const { state, turn, done, routes: results } = known;
    const reason = !isLive && active(state) ? live.reason ?? "not the current session" : null;
    // Q1: the newest completion this tab saw and has not acknowledged; Q3: its first result names the receipt.
    if (state === "done" && turn !== undefined && done !== undefined && results.length && !memory.seen(done) && done > (latestReceipt?.done ?? 0)) latestReceipt = { chat, route: results[0]!, turn, done };
    rows.push({ chat, state, reason, results, tools });
  }
  const count = (state: BuildState) => rows.filter((row) => row.state === state && !row.reason).length;
  // Until the chat list loads, the receipt this tab last showed stands in, so it renders at once and nothing shifts.
  const kept = !latestReceipt && !chats.length ? memory.receipt() : undefined;
  if (kept && !memory.seen(kept.done)) latestReceipt = kept;
  return { rows, latestReceipt, building: count("building"), needsYou: count("needs you") };
}

export function useBuildActivity({ client, chats, pages, reloadPages }: {
  client: ZetaClient | null; chats: readonly Chat[]; pages: readonly PageLink[] | null; reloadPages: () => void;
}) {
  const [live, setLive] = useState<Live>({ current: null, reason: "checking zeta" });
  const [memory] = useState(() => buildMemory(() => sessionStorage));
  const [revision, setRevision] = useState(0);
  const [pageCheck] = useState(() => ({ pages, reloadPages, requested: new Set<string>() }));
  pageCheck.pages = pages;
  pageCheck.reloadPages = reloadPages;
  const [reader] = useState(() => createBuildReader(memory, setLive, (routes) => {
    const missing = routes.filter((route) => !pageCheck.requested.has(route) && !pageCheck.pages?.some((page) => page.route === route));
    if (!missing.length) return;
    missing.forEach((route) => pageCheck.requested.add(route));
    pageCheck.reloadPages();
  }, () => setRevision((value) => value + 1)));
  const [retry, setRetry] = useState(0);
  const [latest] = useState(() => ({ chats }));
  latest.chats = chats;
  // Only a client change or unmount aborts reads; a new chat list or a retry joins the reads in flight.
  useEffect(() => reader.stop, [client, reader]);
  useEffect(() => reader.refresh(chats, client), [chats, client, reader, retry]);
  // A build's run end is read at once: a chat waiting for zeta attaches on the same frame, and after that switch the
  // pinned server can no longer read the build. Subscribed once per client, so it runs before later waiting chats.
  useEffect(() => client ? onRunEnd(client, (id) => {
    if (latest.chats.some((chat) => isBuild(chat) && chat.session_id === id)) reader.refresh(latest.chats, client, id);
  }) : undefined, [client, latest, reader]);
  const activity = useMemo(() => projectBuilds(chats, live, memory), [chats, live, memory, revision]);
  // Same-document navigation (back/forward) can land on the receipt's page.
  useEffect(() => {
    const moved = () => setRevision((value) => value + 1);
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);
  const shown = activity.latestReceipt;
  // A receipt for the page this tab is on is already seen. Read at each render: every pushState here comes with a state update.
  const onItsPage = shown?.route === location.pathname;
  useEffect(() => { if (shown && onItsPage) { memory.acknowledge(shown); setRevision((value) => value + 1); } }, [shown, onItsPage, memory]);
  const receipt = onItsPage ? null : shown;
  useEffect(() => { if (receipt) memory.keepReceipt(receipt); }, [receipt, memory]);
  return { ...activity, latestReceipt: receipt,
    // The text the shell's live region should speak once, or null when this completion was already announced.
    announcement: receipt && !memory.announced(receipt) ? `${titleOf(receipt.chat)} finished · ${receipt.route} is ready` : null,
    markAnnounced: () => { if (receipt) memory.markAnnounced(receipt); },
    refresh: () => { reader.forget(); pageCheck.requested.clear(); pageCheck.reloadPages(); setRetry((value) => value + 1); },
    dismissReceipt: () => {
      if (!receipt) return;
      memory.acknowledge(receipt);
      setRevision((value) => value + 1);
    },
  };
}

export type BuildActivity = ReturnType<typeof useBuildActivity>;
