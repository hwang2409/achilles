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

// Returns null when the history does not prove how the last turn ended.
function fromHistory(status: Record<string, unknown>, history: unknown): (Observation & { tools: string[] }) | null {
  const messages = object(history)?.messages;
  if (!Array.isArray(messages)) throw new Error("missing build history");
  const calls = new Map<string, string>();
  const routes = new Set<string>();
  let lastCreateFailed = false;
  let latestEnd: Record<string, unknown> | undefined;
  for (const raw of messages) {
    const row = object(raw);
    if (row?.role === "user") latestEnd = undefined;
    if (row?.role === "system" && row.event === "served_turn_end") latestEnd = object(row.data);
    if (row?.role === "assistant") {
      for (const rawBlock of array(row.content)) {
        const block = object(rawBlock);
        const call = block?.type === "tool_use" && object(block.tool_call);
        if (call && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, call.name);
      }
    }
    if (row?.role !== "tool_result") continue;
    const result = object(row.tool_result);
    if (!result || typeof result.tool_call_id !== "string") continue;
    const name = calls.get(result.tool_call_id);
    calls.delete(result.tool_call_id);
    if (name !== "achilles__create_page") continue;
    if (result.is_error === true) lastCreateFailed = true;
    if (result.is_error !== false || typeof result.content !== "string") continue;
    try {
      const route = object(JSON.parse(result.content))?.route;
      if (isRoute(route)) {
        routes.add(route);
        lastCreateFailed = false;
      }
    } catch { /* an unknown result is not a page */ }
  }
  const pending = array(status.pending_approvals);
  const ended = status.state === "idle" && typeof latestEnd?.turn_id === "string" && latestEnd.turn_id === object(status.last_turn_outcome)?.turn_id;
  const state: BuildState | null = pending.length ? "needs you"
    : status.state === "running" || status.state === "tool" ? "building"
    : !ended ? null
    : latestEnd!.reason === "error" || lastCreateFailed ? "failed" : routes.size ? "done" : "unfinished";
  if (!state) return null;
  const pendingTools = pending.map((raw) => object(object(raw)?.tool_call)?.name).filter((name): name is string => typeof name === "string");
  return { state, routes: [...routes], tools: active(state) ? [...new Set([...pendingTools, ...calls.values()])] : [] };
}

type Store = Pick<Storage, "getItem" | "setItem">;
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

function createBuildReader(memory: Memory, publish: (live: Live) => void, reloadPages: (routes: string[]) => void) {
  let generation = 0;
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
    controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 8000 };
    let live: Live = { current: null, reason: "not the current session" };
    try {
      const status = object(await request("status", {}, options));
      const id = object(status?.session)?.session_id;
      if (status && typeof id === "string" && chats.some((chat) => isBuild(chat) && chat.session_id === id) && !options.signal.aborted) {
        // The pinned server can read only the runtime's current session. Its null cursor selects one bounded tail page.
        const history = await request("session_history", { session_id: id, before: null }, options);
        live = { current: id, observed: fromHistory(status, history) ?? undefined, reason: null };
      }
    } catch (error) {
      // A runtime switch between status and history returns NO_ACTIVE_SESSION.
      live = { current: null, reason: object(error)?.code === -32003 ? "not the current session" : "zeta offline" };
    }
    if (current !== generation) return;
    if (live.current && live.observed) memory.observe(live.current, live.observed);
    publish(live);
    if (live.observed?.routes.length) reloadPages(live.observed.routes);
    if (live.observed && active(live.observed.state)) timer = setTimeout(() => void refresh(chats, request), 2000);
  };
  return { refresh, stop };
}

export type BuildRow = { chat: Chat; state: BuildState | null; reason: BuildReason | null; results: PageLink[]; tools: string[] };
// A reason marks a remembered state that is not live now; it is never counted.
export const buildLabel = ({ state, reason }: Pick<BuildRow, "state" | "reason">) => state === null ? null : reason ? `last known ${state} · ${reason}` : state;

function projectBuilds(chats: readonly Chat[], pages: readonly PageLink[] | null, live: Live, memory: Memory) {
  let latestReceipt: { chat: Chat; page: PageLink } | null = null;
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
    if (!latestReceipt && state === "done") {
      const page = results.find((page) => page.route === known.routes[0]);
      if (page && !memory.seen(chat.session_id, page.route)) latestReceipt = { chat, page };
    }
    rows.push({ chat, state, reason, results, tools });
  }
  const count = (state: BuildState) => rows.filter((row) => row.state === state && !row.reason).length;
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
