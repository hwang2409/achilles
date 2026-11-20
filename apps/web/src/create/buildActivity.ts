import { useEffect, useMemo, useState } from "react";
import type { Chat, PageLink } from "../surface/AgentNavAdapter";
import type { ZetaClient } from "@fulcrum/zeta";

type BuildState = "building" | "needs you" | "unfinished" | "failed" | "done";
type Snapshot = { state: BuildState; routes: string[]; tools: string[]; stale: boolean };
const unfinished: Snapshot = { state: "unfinished", routes: [], tools: [], stale: false };
const active = (state: BuildState) => state === "building" || state === "needs you";
const fallback = (chat: Chat): Snapshot => ({ ...unfinished, state: chat.last_state === "running" ? "building" : chat.last_state === "approval" ? "needs you" : chat.last_state === "failed" ? "failed" : "unfinished" });
const recentBuilds = (chats: readonly Chat[]) => chats.filter((chat) => chat.purpose === "page_build").slice(0, 4);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function fromHistory(status: Record<string, unknown>, history: unknown): Snapshot {
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
      if (typeof route === "string" && /^\/(?!\/)[^?#\\\s]+$/.test(route)) {
        routes.add(route);
        lastCreateFailed = false;
      }
    } catch { /* an unknown result is not a page */ }
  }
  const pending = array(status.pending_approvals);
  const state: BuildState = pending.length ? "needs you"
    : status.state === "running" || status.state === "tool" ? "building"
    : status.state !== "idle" ? "unfinished"
    : typeof latestEnd?.turn_id === "string" && latestEnd.turn_id === object(status.last_turn_outcome)?.turn_id
      ? latestEnd.reason === "error" || lastCreateFailed ? "failed" : routes.size ? "done" : "unfinished"
      : "unfinished";
  const pendingTools = pending.map((raw) => object(object(raw)?.tool_call)?.name).filter((name): name is string => typeof name === "string");
  return { state, routes: [...routes], tools: active(state) ? [...new Set([...pendingTools, ...calls.values()])] : [], stale: false };
}

type Snapshots = ReadonlyMap<string, Snapshot>;
type Request = ZetaClient["request"];

export function createBuildReader(publish: (snapshots: Snapshots) => void, reloadPages: (routes: string[]) => void) {
  const observed = new Map<string, Snapshot>();
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
    const builds = recentBuilds(chats);
    const next = new Map<string, Snapshot>();
    for (const chat of builds) {
      const known = observed.get(chat.session_id);
      next.set(chat.session_id, { ...(known ?? (request ? unfinished : fallback(chat))), stale: true });
    }
    let live: Snapshot | undefined;
    let id: unknown;
    controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 8000 };
    if (request && builds.length) {
      try {
        const status = object(await request("status", {}, options));
        id = object(status?.session)?.session_id;
        if (status && typeof id === "string" && next.has(id) && !options.signal.aborted) {
          // The pinned server can read only the runtime's current session. Its null cursor selects one bounded tail page.
          const history = await request("session_history", { session_id: id, before: null }, options);
          live = fromHistory(status, history);
          next.set(id, live);
        }
      } catch {
        const catalog = builds.find((chat) => chat.session_id === id);
        for (const row of catalog ? [catalog] : builds) {
          if (!observed.has(row.session_id)) next.set(row.session_id, { ...fallback(row), stale: true });
        }
      }
    }
    if (current !== generation) return;
    for (const previous of observed.keys()) if (!next.has(previous)) observed.delete(previous);
    if (live && typeof id === "string") observed.set(id, live);
    publish(next);
    if (live?.routes.length) reloadPages(live.routes);
    if (live && active(live.state)) timer = setTimeout(() => void refresh(chats, request), 2000);
  };
  return { refresh, stop };
}

type Ack = Pick<Storage, "getItem" | "setItem">;
const receiptKey = (id: string, route: string) => `achilles:build-receipt:${JSON.stringify([id, route])}`;
export function buildAcknowledgements(storage: () => Ack) {
  const seen = new Set<string>();
  return {
    has(id: string, route: string) {
      const key = receiptKey(id, route);
      try { return seen.has(key) || storage().getItem(key) === "1"; } catch { return seen.has(key); }
    },
    add(id: string, route: string) {
      const key = receiptKey(id, route);
      seen.add(key);
      try { storage().setItem(key, "1"); } catch { /* storage may be disabled */ }
    },
  };
}

export function projectBuilds(chats: readonly Chat[], pages: readonly PageLink[], snapshots: Snapshots, seen: ReturnType<typeof buildAcknowledgements>) {
  let latestReceipt: { chat: Chat; page: PageLink } | null = null;
  const rows = [];
  for (const chat of recentBuilds(chats)) {
    const value = snapshots.get(chat.session_id) ?? { ...fallback(chat), stale: true };
    const results = value.routes.flatMap((route) => pages.find((page) => page.route === route) ?? []);
    const state = value.state === "done" && !results.length ? "unfinished" : value.state;
    if (!latestReceipt && state === "done") {
      const page = results.find((page) => page.route === value.routes[0]);
      if (page && !seen.has(chat.session_id, page.route)) latestReceipt = { chat, page };
    }
    rows.push({ chat, state, results, stale: value.stale, tools: value.tools });
  }
  return { rows, latestReceipt, building: rows.filter((row) => row.state === "building").length, needsYou: rows.filter((row) => row.state === "needs you").length };
}

export function useBuildActivity({ client, chats, pages, reloadPages }: {
  client: ZetaClient | null; chats: readonly Chat[]; pages: readonly PageLink[]; reloadPages: () => void;
}) {
  const [snapshots, setSnapshots] = useState<Snapshots>(() => new Map());
  const [seen] = useState(() => buildAcknowledgements(() => sessionStorage));
  const [revision, setRevision] = useState(0);
  const [pageCheck] = useState(() => ({ pages, reloadPages, requested: new Set<string>() }));
  pageCheck.pages = pages;
  pageCheck.reloadPages = reloadPages;
  const [reader] = useState(() => createBuildReader(setSnapshots, (routes) => {
    const missing = routes.filter((route) => !pageCheck.requested.has(route) && !pageCheck.pages.some((page) => page.route === route));
    if (!missing.length) return;
    missing.forEach((route) => pageCheck.requested.add(route));
    pageCheck.reloadPages();
  }));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void reader.refresh(chats, client?.request);
    return reader.stop;
  }, [chats, client, reader, retry]);
  const activity = useMemo(() => projectBuilds(chats, pages, snapshots, seen), [chats, pages, snapshots, seen, revision]);
  return { ...activity,
    refresh: () => { pageCheck.requested.clear(); pageCheck.reloadPages(); setRetry((value) => value + 1); },
    dismissReceipt: () => {
      if (!activity.latestReceipt) return;
      seen.add(activity.latestReceipt.chat.session_id, activity.latestReceipt.page.route);
      setRevision((value) => value + 1);
    },
  };
}

export type BuildActivity = ReturnType<typeof useBuildActivity>;
