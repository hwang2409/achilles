import { useEffect, useMemo, useState } from "react";
import { titleOf, type Chat, type PageLink } from "../surface/AgentNavAdapter";
import type { ZetaClient } from "@fulcrum/zeta";

// The one owner of displayed page-build state. Nothing else reads chat.last_state for page_build chats.
export type BuildState = "building" | "needs you" | "done" | "unfinished" | "failed";
export type BuildReason = "zeta offline" | "not the current session" | "checking zeta";
type Observation = { state: BuildState; routes: string[] };
type Live = { current: string | null; observed?: Observation & { tools: string[] }; reason: BuildReason | null };
const states: readonly BuildState[] = ["building", "needs you", "done", "unfinished", "failed"];
const active = (state: BuildState) => state === "building" || state === "needs you";
const isBuild = (chat: Chat) => chat.purpose === "page_build";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isRoute = (route: unknown): route is string => typeof route === "string" && /^\/(?!\/)[^?#\\\s]+$/.test(route);

type Collected = { routes: string[]; openCalls: string[]; lastCreateFailed: boolean; latestEnd?: Record<string, unknown> };

// Successful create_page routes, in result order, from one history page. Unknown shapes are not pages.
export function collectCreateRoutes(messages: readonly unknown[]): Collected {
  const calls = new Map<string, string>();
  const routes = new Set<string>();
  let lastCreateFailed = false;
  let latestEnd: Record<string, unknown> | undefined;
  for (const raw of messages) {
    const row = object(raw);
    if (row?.role === "user") latestEnd = undefined;
    if (row?.role === "system" && row.event === "served_turn_end") latestEnd = object(row.data);
    if (row?.role === "assistant") {
      for (const block of array(row.content).map(object)) {
        const call = block?.type === "tool_use" && object(block.tool_call);
        if (call && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, call.name);
      }
    }
    const result = row?.role === "tool_result" ? object(row.tool_result) : undefined;
    if (!result || typeof result.tool_call_id !== "string") continue;
    const name = calls.get(result.tool_call_id);
    calls.delete(result.tool_call_id);
    if (name !== "achilles__create_page") continue;
    const route = result.is_error === false ? createdRoute(result.content) : undefined;
    if (route) routes.add(route);
    if (route || result.is_error === true) lastCreateFailed = !route;
  }
  return { routes: [...routes], openCalls: [...calls.values()], lastCreateFailed, latestEnd };
}

function createdRoute(content: unknown) {
  try {
    const route = typeof content === "string" ? object(JSON.parse(content))?.route : undefined;
    return isRoute(route) ? route : undefined;
  } catch { return undefined; }
}

// The state the live status and history prove, or null when they do not show how the last turn ended.
export function classify(status: Record<string, unknown>, { routes, lastCreateFailed, latestEnd }: Collected): BuildState | null {
  if (array(status.pending_approvals).length) return "needs you";
  if (status.state === "running" || status.state === "tool") return "building";
  const ended = status.state === "idle" && typeof latestEnd?.turn_id === "string" && latestEnd.turn_id === object(status.last_turn_outcome)?.turn_id;
  if (!ended) return null;
  return latestEnd!.reason === "error" || lastCreateFailed ? "failed" : routes.length ? "done" : "unfinished";
}

function fromHistory(status: Record<string, unknown>, history: unknown): (Observation & { tools: string[] }) | null {
  const messages = object(history)?.messages;
  if (!Array.isArray(messages)) throw new Error("missing build history");
  const collected = collectCreateRoutes(messages);
  const state = classify(status, collected);
  if (!state) return null;
  const pendingTools = array(status.pending_approvals).map((raw) => object(object(raw)?.tool_call)?.name).filter((name): name is string => typeof name === "string");
  return { state, routes: collected.routes, tools: active(state) ? [...new Set([...pendingTools, ...collected.openCalls])] : [] };
}

type Store = Pick<Storage, "getItem" | "setItem">;
type Receipt = { chat: Chat; page: PageLink };
const receiptKey = (id: string, route: string) => `achilles:build-receipt:${JSON.stringify([id, route])}`;
const observationKey = (id: string) => `achilles:build-observed:${id}`;

// Per-tab memory: what this tab observed live, and which receipts it acknowledged (Q1).
// shortcut: entries are never pruned; a tab's session storage holds one small row per build it watched.
export function buildMemory(storage: () => Store) {
  const local = new Map<string, string>();
  const read = (key: string) => { try { return storage().getItem(key) ?? local.get(key) ?? null; } catch { return local.get(key) ?? null; } };
  const write = (key: string, value: string) => { local.set(key, value); try { storage().setItem(key, value); } catch { /* storage may be disabled */ } };
  return {
    observed(id: string): Observation | undefined {
      try {
        const value = object(JSON.parse(read(observationKey(id)) ?? "null"));
        const routes = array(value?.routes);
        if (states.includes(value?.state as BuildState) && routes.every(isRoute)) return { state: value!.state as BuildState, routes: routes as string[] };
      } catch { /* an unknown row is no observation */ }
      return undefined;
    },
    observe: (id: string, { state, routes }: Observation) => write(observationKey(id), JSON.stringify({ state, routes })),
    seen: (id: string, route: string) => read(receiptKey(id, route)) === "1",
    // The last receipt this tab showed, so a reload can show it on the first render, before any catalog or zeta read.
    receipt(): Receipt | undefined {
      try {
        const value = object(JSON.parse(read("achilles:build-receipt-shown") ?? "null"));
        const chat = object(value?.chat), page = object(value?.page);
        if (typeof chat?.session_id === "string" && typeof page?.id === "string" && isRoute(page.route)) return { chat: chat as Chat, page: page as PageLink };
      } catch { /* an unknown row is no receipt */ }
      return undefined;
    },
    keepReceipt: (receipt: Receipt) => write("achilles:build-receipt-shown", JSON.stringify(receipt)),
    acknowledge: (id: string, route: string) => write(receiptKey(id, route), "1"),
    // True only the first time this tab asks, so a receipt is announced once and not on every route load.
    announce(id: string, route: string) {
      const key = `${receiptKey(id, route)}:announced`;
      if (read(key) === "1") return false;
      write(key, "1");
      return true;
    },
  };
}
type Memory = ReturnType<typeof buildMemory>;
type Request = ZetaClient["request"];
const POLL_MS = 2000;
const RETRY_MS = [2000, 5000, 10000];

// One status (and, for a current build, one history) read per refresh; one timer at most.
async function readLive(chats: readonly Chat[], request: Request, signal: AbortSignal): Promise<Live> {
  const options = { signal, timeoutMs: 8000 };
  try {
    const status = object(await request("status", {}, options));
    const id = object(status?.session)?.session_id;
    if (!status || typeof id !== "string" || !chats.some((chat) => isBuild(chat) && chat.session_id === id) || signal.aborted) return { current: null, reason: "not the current session" };
    // The pinned server can read only the runtime's current session. Its null cursor selects one bounded tail page.
    const history = await request("session_history", { session_id: id, before: null }, options);
    return { current: id, observed: fromHistory(status, history) ?? undefined, reason: null };
  } catch (error) {
    // A runtime switch between status and history returns NO_ACTIVE_SESSION.
    return { current: null, reason: object(error)?.code === -32003 ? "not the current session" : "zeta offline" };
  }
}

function createBuildReader(memory: Memory, publish: (live: Live) => void, reloadPages: (routes: string[]) => void) {
  let generation = 0;
  let misses = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    controller?.abort();
  };
  const refresh = async (chats: readonly Chat[], request?: Request) => {
    stop();
    const current = generation;
    if (!request) return publish({ current: null, reason: "zeta offline" });
    // No page builds: nothing to read, and no extra status call.
    if (!chats.some(isBuild)) return publish({ current: null, reason: "not the current session" });
    controller = new AbortController();
    const live = await readLive(chats, request, controller.signal);
    if (current !== generation) return;
    if (live.current && live.observed) memory.observe(live.current, live.observed);
    publish(live);
    if (live.observed?.routes.length) reloadPages(live.observed.routes);
    const again = () => void refresh(chats, request);
    // Poll a live active build; after an outage, retry with backoff while this tab remembers an active build.
    const waiting = live.reason === "zeta offline" && chats.some((chat) => isBuild(chat) && active(memory.observed(chat.session_id)?.state ?? "done"));
    misses = live.reason === "zeta offline" ? misses + 1 : 0;
    if (live.observed && active(live.observed.state)) timer = setTimeout(again, POLL_MS);
    else if (waiting) timer = setTimeout(again, RETRY_MS[Math.min(misses, RETRY_MS.length) - 1]);
  };
  return { refresh, stop };
}

export type BuildRow = { chat: Chat; state: BuildState | null; reason: BuildReason | null; results: PageLink[]; tools: string[] };
// A reason marks a remembered state that is not live now; it is never counted.
export const buildLabel = ({ state, reason }: Pick<BuildRow, "state" | "reason">) => state === null ? null : reason ? `last known ${state} · ${reason}` : state;

function projectBuilds(chats: readonly Chat[], pages: readonly PageLink[] | null, live: Live, memory: Memory) {
  let latestReceipt: Receipt | null = null;
  const rows: BuildRow[] = [];
  for (const chat of chats.filter(isBuild)) {
    const isLive = live.current === chat.session_id;
    const known = isLive ? live.observed : memory.observed(chat.session_id);
    const tools = isLive ? live.observed?.tools ?? [] : [];
    if (!known || (known.routes.length && known.state === "done" && pages === null)) {
      rows.push({ chat, state: null, reason: null, results: [], tools });
      continue;
    }
    const results = known.routes.flatMap((route) => pages?.find((page) => page.route === route) ?? []);
    const state = known.state === "done" && !results.length ? "unfinished" : known.state;
    const reason = !isLive && active(state) ? live.reason ?? "not the current session" : null;
    // Q3: the first result route that the catalog confirms names the compact receipt.
    if (!latestReceipt && state === "done" && !memory.seen(chat.session_id, results[0]!.route)) latestReceipt = { chat, page: results[0]! };
    rows.push({ chat, state, reason, results, tools });
  }
  const count = (state: BuildState) => rows.filter((row) => row.state === state && !row.reason).length;
  // Until both catalogs load, the receipt this tab last showed stands in, so it renders at once and nothing shifts.
  const kept = !latestReceipt && (!chats.length || pages === null) ? memory.receipt() : undefined;
  if (kept && !memory.seen(kept.chat.session_id, kept.page.route)) latestReceipt = kept;
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
  }));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void reader.refresh(chats, client?.request);
    return reader.stop;
  }, [chats, client, reader, retry]);
  const activity = useMemo(() => projectBuilds(chats, pages, live, memory), [chats, pages, live, memory, revision]);
  // The shell mounts its status region empty; the text arrives later so screen readers announce it.
  const [announcement, setAnnouncement] = useState("");
  const receipt = activity.latestReceipt;
  useEffect(() => { if (receipt) memory.keepReceipt(receipt); }, [receipt, memory]);
  useEffect(() => {
    if (receipt && memory.announce(receipt.chat.session_id, receipt.page.route)) setAnnouncement(`${titleOf(receipt.chat)} finished · ${receipt.page.route} is ready`);
  }, [receipt?.chat.session_id, receipt?.page.route, memory]);
  return { ...activity, announcement,
    refresh: () => { pageCheck.requested.clear(); pageCheck.reloadPages(); setRetry((value) => value + 1); },
    dismissReceipt: () => {
      if (!activity.latestReceipt) return;
      memory.acknowledge(activity.latestReceipt.chat.session_id, activity.latestReceipt.page.route);
      setRevision((value) => value + 1);
    },
  };
}

export type BuildActivity = ReturnType<typeof useBuildActivity>;
