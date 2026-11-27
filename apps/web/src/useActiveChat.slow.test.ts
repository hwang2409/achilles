import "./test-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { chatQueues } from "./composer/chatQueues";
import { MAYBE_SENT } from "./composer/composer-machine";
import { draftStore } from "./draftStore";
import * as activeChat from "./useActiveChat";
import { useActiveChat } from "./useActiveChat";
import { TOO_MANY_CHATS } from "./zeta/session";
import { parkedRows, takeParkedEvent } from "./zeta/parked";
import type { Chat } from "./surface/AgentNavAdapter";


const EXPECTED_ATTACH_SLOW_MS = 15_000;
const originalGlobals = {
  localStorage: globalThis.localStorage,
  location: globalThis.location,
  history: globalThis.history,
  addEventListener: globalThis.addEventListener,
  removeEventListener: globalThis.removeEventListener,
  fetch: globalThis.fetch,
};
let mounted: RenderResult | null = null;

// happy-dom defines location/history/localStorage as getter-only accessors, so a plain
// assignment throws; override each property descriptor instead of using Object.assign.
function setGlobals(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// each test is a fresh tab: no chats held from an earlier test for the reload reclaim to take back
beforeEach(() => { sessionStorage.clear(); });
afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  setGlobals(originalGlobals);
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class ManualClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: TimerHandler, delay = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback: callback as () => void });
    return id;
  };
  clearTimeout = (id: number | undefined) => { if (id !== undefined) this.timers.delete(id); };
  advance(ms: number) {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) { this.timers.delete(id); timer.callback(); }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const page = { id: "home", route: "/", title: "home", zeta_session_id: "chat", workspace: "/tmp", create_mode: false, approval_mode: "allow", layout: { blocks: [] } };
const chat = { purpose: "chat" as const, session_id: "chat", page_id: "home", title: "chat", last_state: "idle" };

function client(firstResume?: Promise<unknown>) {
  let resumes = 0;
  return {
    get resumes() { return resumes; },
    features: ["session_mcp_bindings", "session_replay_seq"],
    request: async (method: string) => {
      if (method === "resume") {
        resumes += 1;
        if (resumes === 1 && firstResume) return firstResume;
        return { session: { name: "new attachment" } };
      }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "chat" }, state: "idle" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => {
      await refresh();
      return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} };
    },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
}

async function flushUntil(done: () => boolean) {
  for (let attempt = 0; attempt < 20 && !done(); attempt += 1) await act(async () => {});
  expect(done()).toBe(true);
}

test("a slow attachment can retry without accepting its late answer", async () => {
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "?chat=chat", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [chat], next: null });
      if (url === "/api/chats/chat") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const firstResume = deferred<unknown>();
  const slowClient = client(firstResume.promise);
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(slowClient as never, true, clock as never, true); return null; };
  let renderer!: RenderResult;

  await act(async () => { renderer = render(createElement(Harness)); mounted = renderer; });
  await flushUntil(() => slowClient.resumes === 1);
  expect(active.attachSlow ?? false).toBe(false);
  await act(async () => { clock.advance(EXPECTED_ATTACH_SLOW_MS); });
  expect(active.attachSlow).toBe(true);

  await act(async () => { active.retryAttachment(); });
  await flushUntil(() => slowClient.resumes === 2 && active.state.phase === "ready");
  expect(active.state).toMatchObject({ phase: "ready", title: "new attachment" });

  firstResume.resolve({ session: { name: "late old attachment" } });
  await act(async () => {});
  expect(active.state).toMatchObject({ phase: "ready", title: "new attachment" });
  await act(async () => { renderer.unmount(); mounted = null; });

  const normalClock = new ManualClock();
  const normalClient = client();
  const NormalHarness = () => { active = useActiveChat(normalClient as never, true, normalClock as never); return null; };
  await act(async () => { renderer = render(createElement(NormalHarness)); mounted = renderer; });
  await flushUntil(() => active.state.phase === "ready");
  await act(async () => { normalClock.advance(EXPECTED_ATTACH_SLOW_MS); });
  expect(active.attachSlow).toBe(false);
  await act(async () => { renderer.unmount(); mounted = null; });
});

// An empty page whose first tool refreshes fail; later refreshes wait on `lastRefresh`.
async function refreshFailureHarness(failures: number) {
  const emptyPage = { ...page, zeta_session_id: null as string | null };
  const requests: string[] = [];
  const state = { refreshes: 0, serverCreateMode: false, created: false };
  const lastRefresh = deferred<void>();
  const listeners = new Map<string, () => void>();
  const assigned: string[] = [];
  const location = { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign(url: string) { assigned.push(url); } };
  setGlobals({
    localStorage: new MemoryStorage(),
    location,
    history: { pushState() {}, replaceState() {} },
    addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
    removeEventListener(type: string, listener: () => void) { if (listeners.get(type) === listener) listeners.delete(type); },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json({ ...emptyPage, create_mode: state.serverCreateMode });
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      if (url === "/api/pages/home/session") { emptyPage.zeta_session_id = "fresh"; return Response.json({ session_id: "fresh" }); }
      if (url === "/api/pages/home/create-mode") {
        state.serverCreateMode = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
        return Response.json({ create_mode: state.serverCreateMode });
      }
      if (url.startsWith("/api/chats?")) return Response.json({ chats: state.created ? [{ ...chat, session_id: "fresh" }] : [], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq", "mcp_refresh_tools"],
    request: async (method: string) => {
      requests.push(method);
      // the first chat is "fresh"; a later "new chat" makes "second"
      if (method === "new_session") { const id = state.created ? "second" : "fresh"; state.created = true; return { session: { session_id: id } }; }
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "fresh" }, state: "idle" };
      if (method === "mcp_refresh_tools") {
        state.refreshes += 1;
        if (state.refreshes <= failures) throw Object.assign(new Error("refresh failed"), { code: -32005, data: { reason: "MCP tools/list timed out after 10s" } });
        await lastRefresh.promise;
        return { session_id: "fresh", servers: ["achilles"] };
      }
      if (method === "send") return { accepted: true };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  const Harness = () => { harness.active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  // a page load (reload, or a page switch's location.assign): a new hook with nothing kept in memory
  const load = async () => {
    if (mounted) await act(async () => { mounted?.unmount(); });
    await act(async () => { mounted = render(createElement(Harness)); });
  };
  const harness = { active: null as unknown as ReturnType<typeof useActiveChat>, requests, state, lastRefresh, listeners, assigned, location, load };
  await load();
  await flushUntil(() => harness.active.state.phase === "empty");
  return harness;
}

test("a failed tool refresh on the first send keeps the new chat with a retry notice", async () => {
  const harness = await refreshFailureHarness(2);
  const { requests, lastRefresh } = harness;
  await act(async () => { await harness.active.toggle(); });

  draftStore.set("new:home", "typed by hand"); // a starter-button send must not erase composer text
  let sent: Promise<void> | null = null;
  await act(async () => { sent = harness.active.send("make a reading list", { steer: false }, () => {}); await sent.catch(() => {}); });
  let active = harness.active;
  expect(active.creationError).toBeNull();
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh", page: { create_mode: false } });
  await expect(sent!).rejects.toThrow("send is off until page tools refresh");
  expect(active.toggleError).toContain("zeta could not refresh page tools: MCP tools/list timed out after 10s");
  expect([active.toggleBlocked, active.toggleRetryable]).toEqual([true, true]);
  expect(draftStore.get("fresh")).toBe("make a reading list");
  expect(draftStore.get("new:home")).toBe("typed by hand");
  draftStore.set("new:home", "");

  await act(async () => { await harness.active.toggle(); });
  active = harness.active;
  expect(active.toggleError).toContain("timed out");
  expect([active.toggleBlocked, active.toggling]).toEqual([true, false]);

  let retried: Promise<void> | null = null;
  await act(async () => { retried = harness.active.toggle(); });
  await flushUntil(() => harness.state.refreshes === 3);
  active = harness.active;
  expect([active.toggling, active.toggleBlocked]).toEqual([true, true]);
  expect(active.toggleError).toContain("timed out");
  lastRefresh.resolve();
  await act(async () => { await retried; });
  active = harness.active;
  expect([active.toggleError, active.toggleBlocked]).toEqual([null, false]);
  expect(active.state).toMatchObject({ phase: "ready", page: { create_mode: true } });
  expect(requests.filter((method) => method === "mcp_refresh_tools")).toHaveLength(3);
  await act(async () => { await harness.active.send("make a reading list", { steer: false }, () => {}); });
  expect(requests.at(-1)).toBe("send");
});

test("a failed tool refresh on the new chat button keeps its notice, and the new chat is attached once", async () => {
  const harness = await refreshFailureHarness(1);
  const { requests, lastRefresh } = harness;
  await act(async () => { await harness.active.toggle(); });
  await act(async () => { await harness.active.newChat(); });
  // publishReady selects the new chat; the attach effect does not resume it a second time
  await flushUntil(() => harness.active.selectedId === "fresh" && harness.active.state.phase === "ready");
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  expect(requests.filter((method) => method === "resume")).toHaveLength(1);
  let active = harness.active;
  expect(active.creationError).toBeNull();
  expect(active.toggleError).toContain("zeta could not refresh page tools: MCP tools/list timed out after 10s");
  expect([active.toggleBlocked, active.toggleRetryable]).toEqual([true, true]);
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh", page: { create_mode: false } });
  await expect(harness.active.send("hello", { steer: false }, () => {})).rejects.toThrow("send is off until page tools refresh");
  expect(requests.filter((method) => method === "new_session")).toHaveLength(1);

  lastRefresh.resolve();
  await act(async () => { await harness.active.toggle(); });
  active = harness.active;
  expect([active.toggleError, active.toggleBlocked]).toEqual([null, false]);
  expect(active.state).toMatchObject({ phase: "ready", page: { create_mode: true } });
  expect(requests.filter((method) => method === "mcp_refresh_tools")).toHaveLength(2);
});

type Harness = Awaited<ReturnType<typeof refreshFailureHarness>>;
const other = { ...chat, session_id: "other", page_route: "/" };
// the first chat's first turn runs; then the user does `move`. the turn end selects that chat only when nobody moved.
const pendingSelectionRows: { name: string; move: (harness: Harness) => Promise<void>; selected: string | null }[] = [
  { name: "no navigation selects the chat when its first turn ends", move: async () => {}, selected: "fresh" },
  { name: "new chat", move: async (harness) => { await harness.active.newChat(); }, selected: "second" },
  { name: "a sidebar click on another chat", move: async (harness) => { harness.active.selectChat(other); }, selected: "other" },
  { name: "back/forward to another chat", move: async (harness) => { harness.location.search = "?chat=other"; harness.listeners.get("popstate")?.(); }, selected: "other" },
  { name: "a page switch loads another page", move: async (harness) => {
    harness.active.selectChat({ ...other, page_route: "/notes" });
    expect(harness.assigned).toEqual(["/notes?chat=other"]);
    await harness.load();
  }, selected: null },
  { name: "a reload", move: async (harness) => { harness.location.search = "?chat=fresh"; await harness.load(); }, selected: "fresh" },
  { name: "a second chat's turn ending", move: async (harness) => {
    harness.active.selectChat(other);
    await act(async () => {});
    harness.active.recordLastState("running"); // the other chat's own turn runs, then ends (the "idle" below)
  }, selected: "other" },
];

test.each(pendingSelectionRows)("the first turn's end selects its chat only if the user stayed: $name", async (row) => {
  const harness = await refreshFailureHarness(0);
  harness.lastRefresh.resolve();
  await act(async () => { await harness.active.send("make a reading list", { steer: false }, () => {}); });
  expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "fresh" });
  expect(harness.active.selectedId).toBeNull();
  await act(async () => { harness.active.recordLastState("running"); });
  await act(async () => { await row.move(harness); });
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  await act(async () => { harness.active.recordLastState("idle"); });
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  expect(harness.active.selectedId).toBe(row.selected);
});

test("a page refresh keeps the header create mode while the tool refresh still fails", async () => {
  const harness = await refreshFailureHarness(1);
  await act(async () => { await harness.active.toggle(); });
  await act(async () => { await harness.active.newChat(); });
  await flushUntil(() => harness.active.selectedId === "fresh" && harness.active.state.phase === "ready" && harness.active.toggleBlocked);
  expect(harness.state.serverCreateMode).toBe(true); // the server stored create mode before zeta's refresh failed
  expect(harness.active.state).toMatchObject({ page: { create_mode: false } });

  await act(async () => { await harness.active.refreshPage(); }); // a form write, a finished turn, or update_layout
  expect(harness.active.toggleBlocked).toBe(true);
  expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "fresh", page: { create_mode: false } });
});

test("a reload during a pending approval re-binds the page tools, so the approved page tool runs", async () => {
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "?chat=chat", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ ...chat, last_state: "approval" }], next: null });
      if (url === "/api/chats/chat") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  // zeta after a reload: the turn waits for approval of a page tool, and the page binding left with the old socket
  let bound = false;
  const waiting = { state: "tool", pending_approvals: [{ request_id: "c1", tool_call: { id: "t1", name: "achilles__list_pages", arguments: {} }, delegated: false }] };
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach"],
    request: async (method: string, params?: { session_id?: string; mcp_bindings?: unknown[] }) => {
      if (method === "resume") {
        if (params?.session_id !== "chat") throw Object.assign(new Error("a turn is already running"), { code: -32004 });
        bound = Boolean(params.mcp_bindings?.length);
        return { session: { session_id: "chat", name: null }, attached: "live_turn" };
      }
      if (method === "status") return { session: { session_id: "chat" }, ...waiting };
      if (method === "session_settings") return { model: "offline", approval_mode: "ask" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, history_validator: { end: 0, entry_id: null, repair_generation: null }, status: waiting };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase !== "loading");
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
  // the user approves now: zeta runs achilles__list_pages with the page binding, or returns a tool error without it
  expect(bound ? "tool ran" : "tool error: MCP server achilles is not attached").toBe("tool ran");
});

// zeta for the turn-end table: one chat in the forced ask mode (achilles serve with ACHILLES_APPROVAL=ask) whose
// session is still in allow. phase "setup" is a woken turn before turn_start; "finishing" is just after agent_end,
// when zeta reports idle but still refuses settings.
type TurnPhase = "idle" | "setup" | "running" | "finishing";
type Row = {
  name: string;
  phase: TurnPhase;
  // zeta 461b9490 reports idle during a woken turn's setup; f858c5c1 reports running
  setupStatus?: "idle" | "running";
  resumeAttach?: boolean;
  drive: (zeta: TurnZeta) => Promise<void>;
  sets: number; // set_settings requests zeta answered with the change applied
  refused?: number; // set_settings requests zeta refused with -32004
};
type TurnZeta = ReturnType<typeof turnZeta>;
const TURN_RUNNING_ERROR = () => Object.assign(new Error("a turn is already running"), { code: -32004 });
// zeta parks this tab's busy chat on a swap (session_park), but refuses a 4th: the tab already keeps 3 chats running
const PARKED_LIMIT_ERROR = () => Object.assign(new Error("parked limit"), { code: -32004, data: { reason: "parked_limit", parked: ["p1", "p2", "p3"] } });

function turnZeta(row: Row) {
  const state = { phase: row.phase, mode: "allow", sets: 0, refused: 0, refuseNext: 0, beforeJoin: null as null | (() => void) };
  const running = () => state.phase === "running" || (state.phase === "setup" && (row.setupStatus ?? "running") === "running");
  const status = () => ({ session: { session_id: "chat" }, state: running() ? "running" : "idle", pending_approvals: [] });
  const make = () => ({
    features: ["session_mcp_bindings", "session_replay_seq", ...(row.resumeAttach === false ? [] : ["resume_attach"])],
    request: async (method: string, params?: { session_id?: string; approval_mode?: string }) => {
      if (method === "status") return status();
      if (method === "resume") {
        if (state.phase !== "idle" && row.resumeAttach === false) throw TURN_RUNNING_ERROR();
        return { session: { session_id: "chat", name: null }, attached: state.phase === "idle" ? null : "live_turn" };
      }
      if (method === "session_settings") return { model: "offline", approval_mode: state.mode };
      if (method === "set_settings") {
        if (state.phase !== "idle" || state.refuseNext > 0) { state.refuseNext = Math.max(0, state.refuseNext - 1); state.refused += 1; throw TURN_RUNNING_ERROR(); }
        state.sets += 1; state.mode = params!.approval_mode!;
        return { model: "offline", approval_mode: state.mode };
      }
      if (method === "session_history_and_subscribe") { state.beforeJoin?.(); state.beforeJoin = null; return { messages: [], next_before: null, history_validator: { end: 0, entry_id: null, repair_generation: null }, status: status() }; }
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  });
  let client = make();
  return {
    state,
    get client() { return client; },
    reconnect() { client = make(); return client; },
    /** zeta's event frames for this chat, as they arrive on the socket */
    async frames(...events: string[]) {
      // read inside the test, so the base without the owner still reaches the behavior assertions
      const owner = await import("./zeta/turnEnd").catch(() => null);
      let deliver = (_text: string) => {};
      owner?.teeRunEnds({ send() {}, close() {}, onMessage: (callback) => { deliver = callback; } }, () => client).onMessage(() => {});
      for (const event of events) await act(async () => { deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event, session_id: "chat" } })); });
    },
    /** the turn ends: zeta is idle, then sends turn_end and agent_end */
    async end() { state.phase = "idle"; await this.frames("turn_end", "agent_end"); },
  };
}

const turnEndRows: Row[] = [
  { name: "normal turn end (reload during a turn, zeta without resume_attach: rebind, then the mode)", phase: "running", resumeAttach: false, sets: 1, drive: async (zeta) => { await zeta.frames("turn_start"); await zeta.end(); } },
  { name: "turn end after a reload attached to the live turn", phase: "running", sets: 1, drive: (zeta) => zeta.end() },
  { name: "woken turn joined during its setup (status running), then it runs and ends", phase: "setup", sets: 1, drive: async (zeta) => { zeta.state.phase = "running"; await zeta.frames("agent_start", "turn_start"); await zeta.end(); } },
  { name: "-32004 during the woken turn's setup (status idle), then applied at the turn end", phase: "setup", setupStatus: "idle", sets: 1, refused: 2, drive: async (zeta) => { zeta.state.phase = "running"; await zeta.frames("agent_start", "turn_start", "tool_start", "tool_end", "turn_start"); await zeta.end(); } },
  { name: "turn already ended before the attach (attached null)", phase: "idle", sets: 1, drive: async () => {} },
  { name: "agent_end before the owner exists (the turn ends while the page loads its history)", phase: "running", sets: 1, drive: async () => {} },
  { name: "disconnect mid-turn, then reattach while it still runs", phase: "running", sets: 1, drive: async () => {} },
  { name: "duplicate turn_end and agent_end apply the mode once", phase: "running", sets: 1, drive: async (zeta) => { await zeta.end(); await zeta.frames("turn_end", "agent_end", "agent_end"); } },
  // an agent_end only wakes the owner; zeta decides: during the setup it refuses (one more refusal), the mode stays pending
  { name: "a replayed agent_end of an older turn during the setup does not settle early", phase: "setup", setupStatus: "idle", sets: 1, refused: 3, drive: async (zeta) => { await zeta.frames("agent_end"); zeta.state.phase = "running"; await zeta.frames("agent_start", "turn_start"); await zeta.end(); } },
  { name: "the settle is refused with -32004 once after the turn end, then retried", phase: "running", sets: 1, refused: 1, drive: async (zeta) => { zeta.state.refuseNext = 1; await zeta.end(); } },
];

test.each(turnEndRows)("a pending ask mode is applied when the turn ends: $name", async (row) => {
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "?chat=chat", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json({ ...page, approval_mode: "ask" });
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [chat], next: null });
      if (url === "/api/chats/chat") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = turnZeta(row);
  if (row.name.startsWith("agent_end before the owner")) zeta.state.beforeJoin = () => { zeta.state.phase = "idle"; void zeta.frames("turn_end", "agent_end"); };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = ({ client, connected }: { client: unknown; connected: boolean }) => { active = useActiveChat(client as never, connected, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness, { client: zeta.client, connected: true })); });
  await flushUntil(() => active.state.phase === "ready");
  if (row.name.startsWith("disconnect")) {
    await act(async () => { mounted!.rerender(createElement(Harness, { client: null, connected: false })); });
    await act(async () => { mounted!.rerender(createElement(Harness, { client: zeta.reconnect(), connected: true })); });
    await flushUntil(() => active.state.phase === "ready");
    await zeta.end();
  }
  await row.drive(zeta);
  for (let tick = 0; tick < 3; tick += 1) await act(async () => { clock.advance(300); });
  for (let flush = 0; flush < 20 && active.state.phase === "ready" && active.state.page.approval_mode !== "ask"; flush += 1) await act(async () => {});
  expect(active.state).toMatchObject({ phase: "ready", page: { approval_mode: "ask" }, pendingApprovalMode: null });
  expect({ sets: zeta.state.sets, refused: zeta.state.refused }).toEqual({ sets: row.sets, refused: row.refused ?? 0 });
});

test("a settle zeta keeps refusing after the turn end retries a bounded number of times, then waits for the next turn end", async () => {
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "?chat=chat", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json({ ...page, approval_mode: "ask" });
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [chat], next: null });
      if (url === "/api/chats/chat") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = turnZeta({ name: "bound", phase: "running", sets: 0, drive: async () => {} });
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta.client as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "ready");
  zeta.state.phase = "finishing"; // reports idle, refuses every settings change
  await zeta.frames("turn_end", "agent_end");
  for (let tick = 0; tick < 20; tick += 1) await act(async () => { clock.advance(1_000); });
  const { TURN_END_RETRY_LIMIT } = await import("./zeta/turnEnd");
  expect(zeta.state.refused).toBe(1 + TURN_END_RETRY_LIMIT);
  expect(active.state).toMatchObject({ phase: "ready", page: { approval_mode: "allow" }, pendingApprovalMode: "ask" });
  await zeta.end();
  await flushUntil(() => active.state.phase === "ready" && active.state.page.approval_mode === "ask");
  expect(zeta.state.sets).toBe(1);
});

// The first chat of a page, through the page hook and the composer queue that App renders. zeta serves one attached
// session: `new_session` and `resume` move it, and a request naming another session is refused. "back" opens the older
// unsent chat s0 (?chat=s0); "forth" opens the page again with no chat named. `nth` counts calls with the same name.
type Stage = { call: string; nth?: number };
type CreateRow = {
  name: string;
  home?: string; // the page's home chat at load (default: none, so the page opens empty)
  hold?: Stage; // this call's reply waits until the moves are done
  moves?: Array<"back" | "forth">;
  fail?: Stage; // this call fails once, with the user still on the page
  retry?: boolean; // then "retry creating chat"
  // where the first message ends up once the page opens again with no chat named: sent to s1, or visible in the shown
  // composer (box text or a row); `shown` is that composer's chat
  message: "sent" | "visible" | "none";
  shown: "s0" | "s1" | "new";
};
const BACK_FORTH_CYCLES = 4;
const createRows: CreateRow[] = [
  { name: "success", message: "sent", shown: "s1" },
  { name: "stale before new_session", hold: { call: "GET /api/pages/home", nth: 2 }, moves: ["back"], message: "visible", shown: "new" },
  { name: "stale after new_session", hold: { call: "new_session" }, moves: ["back"], message: "visible", shown: "new" },
  { name: "stale after register", hold: { call: "POST /api/pages/home/chats" }, moves: ["back"], message: "visible", shown: "new" },
  { name: "stale after settings", hold: { call: "session_settings s1" }, moves: ["back"], message: "visible", shown: "new" },
  { name: "stale after mapping", hold: { call: "PUT /api/pages/home/session" }, moves: ["back"], message: "visible", shown: "s1" },
  { name: "stale during attach resume", hold: { call: "resume s1" }, moves: ["back"], message: "visible", shown: "s1" },
  { name: "stale during attach settings", hold: { call: "session_settings s1", nth: 2 }, moves: ["back"], message: "visible", shown: "s1" },
  { name: "stale during attach history", hold: { call: "session_history_and_subscribe s1" }, moves: ["back"], message: "visible", shown: "s1" },
  { name: "failure at new_session", fail: { call: "new_session" }, message: "visible", shown: "new" },
  { name: "failure at register, then retry", fail: { call: "POST /api/pages/home/chats" }, retry: true, message: "visible", shown: "s1" },
  { name: "failure at settings, then retry", fail: { call: "session_settings s1" }, retry: true, message: "visible", shown: "s1" },
  { name: "failure at mapping, then retry", fail: { call: "PUT /api/pages/home/session" }, retry: true, message: "visible", shown: "s1" },
  { name: "failure at attach, then retry", fail: { call: "resume s1" }, retry: true, message: "visible", shown: "s1" },
  { name: "an attachment that went stale on a lost home chat creates nothing", home: "lost", hold: { call: "resume lost" }, moves: ["back"], message: "none", shown: "s0" },
  { name: "the page opened again joins the running create", hold: { call: "resume s1" }, moves: ["back", "forth"], message: "visible", shown: "s1" },
  { name: "back and forth quickly", hold: { call: "resume s1" }, moves: Array.from({ length: BACK_FORTH_CYCLES }, () => ["back", "forth"] as const).flat(), message: "visible", shown: "s1" },
];

test.each(createRows)("first chat of a page: $name", async (row) => {
  const storage = new MemoryStorage();
  const popListeners: Array<() => void> = [];
  const location = { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} };
  const emptyPage = { ...page, zeta_session_id: (row.home ?? null) as string | null };
  const unsent = { ...chat, session_id: "s0", message_sent: false };
  const counts = new Map<string, number>();
  const held = deferred<void>();
  let holding = false;
  const failed = new Set<string>();
  const requests: string[] = [];
  // counts the call; holds its reply or fails it once when the row names it
  const gate = async (call: string) => {
    requests.push(call);
    const nth = (counts.get(call) ?? 0) + 1;
    counts.set(call, nth);
    const named = (stage?: Stage) => stage?.call === call && (stage.nth ?? 1) === nth;
    if (named(row.hold)) { holding = true; await held.promise; }
    if (named(row.fail) && !failed.has(call)) { failed.add(call); return true; }
    return false;
  };
  setGlobals({
    localStorage: storage,
    location,
    history: { pushState() {}, replaceState() {} },
    addEventListener: (type: string, listener: () => void) => { if (type === "popstate") popListeners.push(listener); },
    removeEventListener() {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      // the server writes the home mapping when the request arrives; a held reply comes later
      if (method === "PUT" && url === "/api/pages/home/session" && !(row.fail?.call === `PUT ${url}` && !failed.has(`PUT ${url}`))) emptyPage.zeta_session_id = "s1";
      if (await gate(`${method} ${url}`)) return new Response(null, { status: 503 });
      if (url === "/api/pages/home") return Response.json(emptyPage);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      if (url === "/api/pages/home/session") return Response.json({ session_id: "s1" });
      // unsent chats are not listed; `include` finds one by id
      if (url.startsWith("/api/chats?")) return Response.json({ chats: url.includes("include=s0") ? [unsent] : url.includes("include=s1") ? [{ ...unsent, session_id: "s1" }] : [], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  let attached: string | null = null;
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq"],
    request: async (method: string, params: { session_id?: string } = {}) => {
      if (method === "resume" && params.session_id === "lost") {
        await gate("resume lost");
        throw Object.assign(new Error("gone"), { data: { code: "session_not_found" } });
      }
      if (method === "new_session" || method === "resume") attached = params.session_id ?? "s1"; // zeta moves when it gets the call
      if (await gate(method === "new_session" ? method : `${method} ${params.session_id ?? ""}`)) throw new Error(`forced ${method} failure`);
      if (method === "new_session") return { session: { session_id: "s1" } };
      if (method === "resume") return { session: { name: null } };
      if (params.session_id && params.session_id !== attached) throw Object.assign(new Error("session is not active"), { code: -32005 });
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: attached }, state: "idle" };
      if (method === "send") return { accepted: true };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  let active!: ReturnType<typeof useActiveChat>;
  const clock = new ManualClock();
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never, true); return null; };

  // the composer App shows (none while loading or while a create error is shown), with its owner in `chatQueues`
  let view: { key: string; owner: ReturnType<typeof chatQueues.open>; detach: () => void } | null = null;
  const shownKey = () => active.creationError ? null : active.state.phase === "ready" ? active.state.sessionId : active.state.phase === "empty" ? "new:home" : null;
  const commit = () => {
    const key = shownKey();
    if (key !== view?.key) {
      const fromNewChat = active.state.phase === "ready" && !active.state.sent ? "new:home" : undefined;
      const owner = key ? chatQueues.open(key, {
        state: "idle",
        defaultValue: draftStore.get(key),
        onDraftChange: (text) => draftStore.set(key, text),
        onDraftSubmit: (text) => draftStore.confirm(key, text),
        onSubmit: (text, intent, track) => active.send(text, intent, track ?? (() => {})),
      }, fromNewChat) : null;
      view?.detach();
      view = key && owner ? { key, owner, detach: owner.attach() } : null;
      if (key) owner?.sync("idle", draftStore.get(key));
    }
    chatQueues.settle();
  };
  const settle = async (done: () => boolean = () => false) => {
    commit();
    for (let flush = 0; flush < 40 && !done(); flush += 1) { await act(async () => {}); commit(); }
  };
  const navigate = async (search: string) => {
    location.search = search;
    await act(async () => { popListeners.forEach((listener) => listener()); });
    commit();
  };

  try {
    await act(async () => { mounted = render(createElement(Harness)); });
    if (row.home) await settle(() => holding);
    else {
      await settle(() => view?.key === "new:home");
      expect(view?.key).toBe("new:home");
      await act(async () => { view!.owner.edit("x1"); void view!.owner.submit(); });
      await settle(() => holding || active.state.phase === "ready" || Boolean(active.creationError) || view?.owner.getModel().queue.some((item) => item.failed) === true);
    }
    for (const move of row.moves ?? []) {
      await navigate(move === "back" ? "?chat=s0" : "");
      await settle(() => move === "back" ? active.state.phase === "ready" : false);
    }
    const released = requests.length;
    await act(async () => { held.resolve(); });
    await settle();
    if (row.moves?.at(-1) === "back") {
      // the stopped create sent nothing more for s1, and zeta still serves the shown chat
      expect(active.state).toMatchObject({ phase: "ready", sessionId: "s0" });
      expect(attached).toBe("s0");
      expect(requests.slice(released).filter((call) => call.endsWith(" s1") || call === "new_session")).toEqual([]);
      if (row.message !== "none") await navigate("");
    }
    if (row.retry) {
      expect(active.creationError).not.toBeNull();
      await act(async () => { active.retrySaving(); });
    }
    await settle(() => shownKey() !== null && (row.message !== "sent" || requests.includes("send s1")));
    expect(active.creationError).toBeNull();
    expect(shownKey()).toBe(row.shown === "new" ? "new:home" : row.shown);
    const sends = requests.filter((call) => call.startsWith("send "));
    if (row.message === "sent") {
      expect(sends).toEqual(["send s1"]);
      expect(view!.owner.getModel().queue).toEqual([]);
    } else {
      expect(sends).toEqual([]);
      expect(requests.filter((call) => call === "new_session").length).toBeLessThanOrEqual(row.message === "none" ? 0 : 1);
      if (row.message === "visible") {
        const key = shownKey()!;
        const shown = draftStore.get(key).includes("x1") || view?.owner.getModel().queue.some((item) => item.text === "x1") === true;
        expect({ key, shown }).toEqual({ key, shown: true });
      }
    }
    // bounded: one create, and each page open attaches s1 at most once
    expect(requests.filter((call) => call === "resume s1").length).toBeLessThanOrEqual(3);
    expect(storage.getItem("achilles-pending-chats")).toBeNull();
  } finally {
    held.resolve();
    view?.detach();
    view = null;
    for (const key of ["new:home", "s0", "s1"]) draftStore.set(key, "");
    chatQueues.settle();
  }
});

// unsent rows across a page load, through the page: chatQueues keeps every chat's rows (the new-chat box's too) in browser
// storage, so a reload shows them as failed rows (retry, edit, x). never in another chat, never sent before the user acts,
// never twice, never merged into a box
type UnsentRow = {
  name: string;
  // "refused": Enter in the new-chat box while this tab keeps 3 chats running (parked_limit); "failed": the first send to the created chat fails
  start: "refused" | "failed";
  // "failed": the user types this into the created chat's box before the reload
  box?: string;
};
const unsentRows: UnsentRow[] = [
  { name: "a refused create, then a reload: the row waits for a new chat, then goes there once", start: "refused" },
  { name: "the first send fails, then a reload: the row is back in the created chat", start: "failed" },
  // a5e0c5b dropped the first message when the box held a longer text containing it
  { name: "the first send fails, the box holds a longer text containing it, then a reload: both stay", start: "failed", box: "this works" },
];
const UNSENT_TEXT = "hi";

test.each(unsentRows)("unsent rows across a page load: $name", async (row) => {
  const storage = new MemoryStorage();
  let running = row.start === "refused";
  let failSend = row.start === "failed";
  let created = 0;
  const listed = [chat.session_id];
  const delivered: { method: string; session?: string; text?: string }[] = [];
  const requests: string[] = [];
  setGlobals({
    localStorage: storage,
    location: { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      // newest first, the way the sidebar orders them
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [...listed].reverse().map((id) => ({ ...chat, session_id: id, last_state: running && id === "chat" ? "running" : "idle" })), next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "turn_reconnect"],
    request: async (method: string, params?: { session_id?: string; text?: string }) => {
      requests.push(method);
      if (method === "new_session") {
        if (running) throw PARKED_LIMIT_ERROR();
        created += 1; listed.push(`s${created}`);
        return { session: { session_id: `s${created}` } };
      }
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings" || method === "set_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: running ? "running" : "idle", pending_approvals: [] } };
      if (method === "status") return running ? { session: { session_id: "chat" }, state: "running" } : { state: "idle" };
      if (method === "send" || method === "steer") {
        if (failSend) throw new Error("connection closed");
        delivered.push({ method, session: params?.session_id, text: params?.text }); return { accepted: true };
      }
      if (method === "delivery_status") return { status: "delivered" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const harness = { active: null as unknown as ReturnType<typeof useActiveChat> };
  const clock = new ManualClock();
  const Harness = () => { harness.active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  // the composer of `box`, wired the way App wires it; `close` detaches it, the way a page unload or chat switch does
  let close = () => {};
  const composer = (box: string, fromNewChat?: string) => {
    close();
    const owner = chatQueues.open(box, {
      state: "idle", defaultValue: draftStore.get(box),
      onDraftChange: (text) => draftStore.set(box, text), onDraftSubmit: (text) => draftStore.confirm(box, text),
      onSubmit: (text, intent, track) => harness.active.send(text, intent, track),
    }, fromNewChat);
    const detach = owner.attach();
    close = () => { detach(); chatQueues.settle(); close = () => {}; };
    return owner;
  };
  // a page load: a fresh hook over the same browser storage. the old page's owners hold only failed rows, so they leave
  // memory (chatQueues.settle) and the new page reads its rows back from storage
  const load = async () => {
    close();
    if (mounted) await act(async () => { mounted?.unmount(); });
    await act(async () => { mounted = render(createElement(Harness)); });
    await flushUntil(() => harness.active.state.phase === "ready");
  };
  const rowsOf = (owner: ReturnType<typeof chatQueues.open>) => owner.getModel().queue.map((item) => `${item.text}: ${item.failed ?? "unsent"}`);
  const sendsOfText = () => delivered.filter((item) => item.text === UNSENT_TEXT);
  try {
    await load();
    if (row.start === "refused") {
      // a refused "new chat" keeps the shown chat (no box to type in); the page's new-chat box (the unsent-rows notice's
      // "open") is where text for a new chat is written
      await act(async () => { harness.active.openNewChat(); });
      await flushUntil(() => harness.active.state.phase === "empty");
      const box = composer("new:home");
      box.edit(UNSENT_TEXT);
      await act(async () => { await box.submit(); });
      expect(box.getModel().queue).toMatchObject([{ text: UNSENT_TEXT, failed: expect.stringContaining("this tab already keeps") }]);
      expect(draftStore.get("new:home")).toBe("");
      await load();
      // the page opens its newest chat (the running one): the row was written for a new chat, so it is not there
      expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
      expect(rowsOf(composer("chat"))).toEqual([]);
      expect(sendsOfText(), "text written for the new chat reached the running chat").toEqual([]);
      expect(created, "a chat was made while zeta refused").toBe(0);
      // the turn ends; the notice's "open" shows the new-chat box with the row, still unsent, and makes no chat
      running = false;
      await act(async () => { harness.active.openNewChat(); });
      expect(created, "open made a chat").toBe(0);
      await flushUntil(() => harness.active.state.phase === "empty");
      const box2 = composer("new:home");
      expect(box2.getModel().queue).toMatchObject([{ text: UNSENT_TEXT, failed: expect.stringContaining("this tab already keeps") }]);
      expect(sendsOfText()).toEqual([]);
      // retry makes the chat the text was written for, and sends it there once
      await act(async () => { await box2.retry(box2.getModel().queue[0]!.id); });
      await flushUntil(() => harness.active.state.phase === "ready" && harness.active.state.sessionId === "s1");
      expect(created).toBe(1);
      expect(sendsOfText(), "sent other than once, to the new chat").toEqual([{ method: "send", session: "s1", text: UNSENT_TEXT }]);
      // zeta took it: a later page load shows it nowhere and sends nothing
      await load();
      expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "s1" });
      expect(rowsOf(composer("s1"))).toEqual([]);
      expect(sendsOfText()).toHaveLength(1);
      return;
    }
    // "new chat" makes s1; the first send there fails
    await act(async () => { await harness.active.newChat(); });
    await flushUntil(() => harness.active.state.phase === "ready" && harness.active.state.sessionId === "s1");
    const first = composer("s1");
    first.edit(UNSENT_TEXT);
    await act(async () => { await first.submit(); });
    expect(first.getModel().queue).toMatchObject([{ text: UNSENT_TEXT, failed: MAYBE_SENT }]);
    if (row.box) first.edit(row.box);
    await load();
    expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "s1" });
    const s1 = composer("s1");
    // shown once, as its own failed row; the box keeps what the user typed after it
    expect(rowsOf(s1), "the unsent message was lost or changed").toEqual([`${UNSENT_TEXT}: ${MAYBE_SENT}`]);
    expect(s1.getModel().draft).toBe(row.box ?? "");
    expect(sendsOfText()).toEqual([]);
    failSend = false;
    await act(async () => { await s1.retry(s1.getModel().queue[0]!.id); });
    expect(sendsOfText()).toEqual([{ method: "send", session: "s1", text: UNSENT_TEXT }]);
    expect(s1.getModel().draft).toBe(row.box ?? "");
  } finally {
    close();
    for (const key of ["new:home", "chat", "s1"]) draftStore.set(key, "");
  }
});

test.each([
  "success",
  "rename then stale attach",
  "stale takeover refusal after a newer selection",
  "duplicate ready",
  "failed attach after a rename, then retry",
  "switch chat during attach",
] as const)("active chat publication: %s", async (row) => {
  const old: Chat = { ...chat, title: "old title", page_route: "/", page_title: "home", titled_by_user: true, created_at: "", updated_at: "", last_state: "idle" };
  const other = { ...old, session_id: "other", title: "other title" };
  let stored = old;
  const duplicate = row === "duplicate ready";
  const storage = new MemoryStorage();
  if (duplicate) storage.setItem("achilles-pending-chats", JSON.stringify([{ sessionId: "chat", pageId: "home", mode: "allow", stage: "attached" }]));
  let holdCatalogue = duplicate;
  let pushes = 0;
  let reads = 0;
  let heldCatalogue = false;
  let heldResume = false;
  let canWrite = row !== "stale takeover refusal after a newer selection";
  const catalogue = deferred<void>();
  const resume = deferred<void>();
  setGlobals({
    localStorage: storage,
    location: { pathname: "/", search: duplicate ? "" : "?chat=chat", href: "http://achilles.test/" },
    history: { pushState() { pushes += 1; }, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) {
        const snapshot = Response.json({ chats: [stored, other], next: null });
        if (url.includes("include=chat")) reads += 1;
        if (holdCatalogue && reads >= (duplicate ? 2 : 1) && url.includes("include=chat")) {
          holdCatalogue = false; heldCatalogue = true;
          await catalogue.promise;
          if (row === "failed attach after a rename, then retry") throw new Error("forced catalogue failure");
        }
        return snapshot;
      }
      if (url === "/api/chats/chat" && init?.method === "PATCH") {
        stored = { ...stored, ...JSON.parse(String(init.body)) };
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const base = client();
  const zeta = {
    ...base,
    request: async (method: string, params?: { session_id?: string }) => {
      if (row === "stale takeover refusal after a newer selection" && method === "resume" && params?.session_id === "chat") {
        heldResume = true;
        await resume.promise;
        throw TURN_RUNNING_ERROR();
      }
      return base.request(method);
    },
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never, canWrite); return null; };
  const expectTitle = (title: string) => expect(active.state).toMatchObject({ phase: "ready", title });
  try {
    await act(async () => { mounted = render(createElement(Harness)); });
    await flushUntil(() => active.state.phase === "ready");
    expectTitle("old title");
    if (row === "success") return;
    if (duplicate) {
      // Recovery publishes ready in its handoff and returns that same ready to the attach effect.
      await flushUntil(() => heldCatalogue);
      expect(pushes).toBe(1);
      expect(active.listRefresh).toBe(1);
      expect(active.selectedId).toBe("chat");
      return;
    }

    if (row === "stale takeover refusal after a newer selection") {
      canWrite = true;
      await act(async () => { mounted!.rerender(createElement(Harness)); });
      await flushUntil(() => heldResume);
    } else {
      holdCatalogue = true;
      await act(async () => { active.retryAttachment(); });
      await flushUntil(() => heldCatalogue);
    }
    const renamed = row === "rename then stale attach" || row === "failed attach after a rename, then retry";
    if (renamed) {
      await act(async () => { expect(await active.rename("chat", "new title")).toBe(true); });
      expectTitle("new title");
    }
    const switched = row === "switch chat during attach" || row === "stale takeover refusal after a newer selection";
    if (switched) {
      await act(async () => { active.selectChat(other); });
      await flushUntil(() => active.state.phase === "ready" && active.state.sessionId === "other");
    }
    await act(async () => { catalogue.resolve(); resume.resolve(); });
    if (row === "failed attach after a rename, then retry") {
      expect(active.state).toEqual({ phase: "error", error: "forced catalogue failure" });
      await act(async () => { active.retryAttachment(); });
      await flushUntil(() => active.state.phase === "ready");
    }
    expectTitle(switched ? "other title" : renamed ? "new title" : "old title");
    expect(active.busy).toBeNull();
  } finally {
    await act(async () => { catalogue.resolve(); resume.resolve(); });
  }
});

test.each([
  ["double new chat", "new", "new", false],
  ["build leaves a failed ordinary chat for its own retry", "build", "new", true],
  ["build registers purpose before its first send", "build", "new", true],
  ["new chat then build", "new", "build", false],
  ["build then new chat", "build", "new", false],
  ["Enter and click in the same tick", "new", "new", true],
  ["refused build permits retry", "build", "build", false],
] as const)("chat creation guard: %s", async (name, first, second, sameTick) => {
  const draft = "  make a reading list\nwith tags  ";
  const location = new URL("http://achilles.test/create");
  const mode: unknown[] = [];
  const registrations: { session_id: string; purpose?: Chat["purpose"] }[] = [];
  const deliveries: Array<{ session_id: string; delivery_id: string; text: string }> = [];
  const firstDelivery = deferred<unknown>();
  const registered = deferred<Response>();
  const navigations: string[] = [];
  const refused = name === "refused build permits retry";
  const failedOrdinary = name === "build leaves a failed ordinary chat for its own retry";
  let ordinaryAttempts = 0;
  let sessions = 0;
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { pushState(_state: unknown, _title: string, path: string) { navigations.push(path); location.href = new URL(path, location.href).href; } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") {
        const payload = JSON.parse(String(init?.body));
        registrations.push(payload);
        if (failedOrdinary && payload.session_id === "ordinary-chat") return Response.json({}, { status: ordinaryAttempts++ === 0 ? 500 : 201 });
        return registered.promise;
      }
      if (url === "/api/pages/home/create-mode") { mode.push(JSON.parse(String(init?.body))); return Response.json({ create_mode: true }); }
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ ...chat, session_id: "build-chat", purpose: first === "build" ? "page_build" : "chat" }], next: null });
      if (url === "/api/chats/build-chat" || (failedOrdinary && url === "/api/chats/ordinary-chat")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const underlying = client();
  const zeta = { ...underlying, async request(method: string, params: typeof deliveries[number]) {
    if (method === "new_session") { sessions++; return { session: { session_id: failedOrdinary && sessions === 1 ? "ordinary-chat" : "build-chat" } }; }
    if (method === "send") { deliveries.push(params); return refused && deliveries.length === 1 ? firstDelivery.promise : { accepted: true }; }
    return underlying.request(method);
  } };
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta as never, true, undefined, true, undefined, "/create"); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "empty");
  expect(sessions).toBe(0);
  expect(underlying.resumes).toBe(0);
  await act(async () => { active.build.setDraft(draft); });
  const call = (kind: "new" | "build") => kind === "new" ? active.newChat() : active.build.start();
  if (failedOrdinary) await act(async () => { await active.newChat(); });
  let start: Promise<void> | undefined;
  let duplicate: Promise<void> | undefined;
  try {
    await act(async () => { start = call(first); if (sameTick) duplicate = call(second); });
    await flushUntil(() => registrations.length > (failedOrdinary ? 1 : 0));
    if (failedOrdinary) {
      expect(registrations.map((row) => row.session_id)).toEqual(["ordinary-chat", "build-chat"]);
      expect(registrations[1]).toEqual({ session_id: "build-chat", purpose: "page_build" });
    }
    if (name === "build registers purpose before its first send") {
      expect(registrations).toEqual([{ session_id: "build-chat", purpose: "page_build" }]);
      expect(deliveries).toEqual([]);
    }
    await act(async () => {
      if (!sameTick) duplicate = call(second);
      await Promise.resolve();
      registered.resolve(Response.json({}, { status: 201 }));
    });
    if (refused) {
      await flushUntil(() => deliveries.length === 1);
      expect(navigations).toEqual([]);
      firstDelivery.resolve({ accepted: false });
      await act(async () => { await Promise.all([start, duplicate]); });
      expect(active.build.error).toContain("did not accept");
      expect(active.build.draft).toBe(draft);
      await act(async () => { await active.build.start(); });
      expect(deliveries).toEqual([deliveries[0], deliveries[0]]);
    } else {
      await act(async () => { await Promise.all([start, duplicate]); });
    }
    expect(sessions).toBe(failedOrdinary ? 2 : 1);
    expect(registrations).toEqual([
      ...(failedOrdinary ? [{ session_id: "ordinary-chat" }] : []),
      { session_id: "build-chat", ...(first === "build" ? { purpose: "page_build" } : {}) },
    ]);
    expect(navigations).toEqual(["/?chat=build-chat"]);
    expect(location.pathname + location.search).toBe("/?chat=build-chat");
    expect(active.state).toMatchObject({ phase: "ready", sessionId: "build-chat", page: { id: "home", create_mode: first === "build" } });
    expect(mode).toEqual(first === "build" ? [{ enabled: true }] : []);
    if (first === "build") {
      expect(deliveries[0]).toEqual({ session_id: "build-chat", delivery_id: expect.any(String), text: draft });
      expect(deliveries[0].delivery_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(deliveries).toHaveLength(refused ? 2 : 1);
      expect(active.build.draft).toBe("");
    } else expect(deliveries).toEqual([]);
    if (failedOrdinary) {
      await act(async () => { await active.newChat(); });
      expect(registrations[2]).toEqual({ session_id: "ordinary-chat" });
      expect(sessions).toBe(2);
    }
  } finally {
    registered.resolve(Response.json({}, { status: 201 }));
    firstDelivery.resolve({ accepted: false });
    await Promise.all([start, duplicate]);
  }
});

test("a default attach names its chat in the url, so a reload or reconnect reopens this tab's chat, not the page's newest", async () => {
  let chats = [chat];
  const replaced: string[] = [];
  const pushed: string[] = [];
  const location = { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} };
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { state: null, pushState(_state: unknown, _title: string, path: string) { pushed.push(path); },
      replaceState(_state: unknown, _title: string, path: string) { replaced.push(path); const url = new URL(path, location.href); location.search = url.search; location.href = url.href; } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats, next: null });
      if (url === "/api/chats/chat" && init?.method === "PATCH") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const resumed: string[] = [];
  const recording = () => {
    const zeta = client();
    return { ...zeta, request: (method: string, params?: { session_id?: string }) => { if (method === "resume") resumed.push(params?.session_id ?? ""); return zeta.request(method); } };
  };
  const Harness = ({ zeta }: { zeta: unknown }) => { active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness, { zeta: recording() })); });
  await flushUntil(() => active.state.phase === "ready");
  expect(replaced, "the default attach left the url without ?chat=").toEqual(["/?chat=chat"]);
  expect(location.search).toBe("?chat=chat");
  expect(pushed, "a default attach adds no history entry").toEqual([]);
  // another tab's chat is now the page's newest; a reconnect (a new client) must still resume this tab's chat
  chats = [{ ...chat, session_id: "other", title: "other" }, chat];
  await act(async () => { mounted!.rerender(createElement(Harness, { zeta: recording() })); });
  await flushUntil(() => resumed.length === 2 && active.state.phase === "ready");
  expect(resumed.at(-1), "the reconnect resumed the page's newest chat, not the url's").toBe("chat");
});

test("a new tab whose default chat is open in another tab gets its own new chat, not zeta's refusal, and Back leaves", async () => {
  const location = { pathname: "/", search: "", hash: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} };
  const go = (path: string) => { const url = new URL(path, location.href); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href }); };
  // the tab's history: the entry it arrived on, plus any it pushes
  const entries = ["/"];
  let current = 0;
  const pops: (() => void)[] = [];
  let creates = 0;
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: {
      state: null,
      pushState(_state: unknown, _title: string, path: string) { entries.splice(current + 1, Infinity, path); current += 1; go(path); },
      replaceState(_state: unknown, _title: string, path: string) { entries[current] = path; go(path); },
    },
    addEventListener: (type: string, listener: () => void) => { if (type === "popstate") pops.push(listener); },
    removeEventListener: (type: string, listener: () => void) => { if (type === "popstate") pops.splice(pops.indexOf(listener), 1); },
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      // like achilles, the default list hides the fresh chat until it has a sent message, so the default chat stays the held one
      if (url.startsWith("/api/chats?")) return Response.json({ chats: url.includes("include=fresh") ? [{ ...chat, session_id: "fresh" }, chat] : [chat], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const resumed: string[] = [];
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq"],
    request: async (method: string, params?: { session_id?: string }) => {
      if (method === "resume") {
        resumed.push(params?.session_id ?? "");
        if (params?.session_id === "chat") throw Object.assign(new Error("session is controlled by another client"), { code: -32014, data: { code: "session_controlled" } });
        return { session: { name: null } };
      }
      if (method === "new_session") { creates += 1; return { session: { session_id: "fresh" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "fresh" }, state: "idle" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  for (let flush = 0; flush < 40 && !(active.state.phase === "ready" || active.state.phase === "error"); flush += 1) await act(async () => {});
  expect(active.state.phase === "error" ? active.state.error : active.state.phase, "the tab showed zeta's refusal instead of opening a new chat").toBe("ready");
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh" });
  expect(resumed[0]).toBe("chat");
  expect(location.search).toBe("?chat=fresh");
  // Back: go to the previous entry of this tab, if it has one; else the browser leaves achilles
  if (current > 0) {
    current -= 1; go(entries[current]!);
    await act(async () => { for (const pop of [...pops]) pop(); });
    for (let flush = 0; flush < 40; flush += 1) await act(async () => {});
  }
  expect(creates, "Back from the fresh chat created another zeta session").toBe(1);
  expect(entries, "the fresh chat took the entry the tab arrived on").toEqual(["/?chat=fresh"]);
});

test("try again on the too-many-chats screen makes the new chat again, never the page's older chat", async () => {
  const location = { pathname: "/", search: "", hash: "#new-chat", href: "http://achilles.test/#new-chat", origin: "http://achilles.test", assign() {} };
  const go = (path: string) => { const url = new URL(path, location.href); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href }); };
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { state: null, pushState(_state: unknown, _title: string, path: string) { go(path); }, replaceState(_state: unknown, _title: string, path: string) { go(path); } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      // the page has an older chat no tab holds: a plain attach would resume it
      if (url.startsWith("/api/chats?")) return Response.json({ chats: url.includes("include=fresh") ? [{ ...chat, session_id: "fresh" }, chat] : [chat], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const calls: string[] = [];
  let full = true;
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq"],
    request: async (method: string, params?: { session_id?: string }) => {
      calls.push(method === "resume" ? `resume ${params?.session_id}` : method);
      if (method === "new_session") {
        if (full) throw Object.assign(new Error("resident limit"), { code: -32004, data: { reason: "resident_limit" } });
        return { session: { session_id: "fresh" } };
      }
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "fresh" }, state: "idle" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "error");
  expect(active.state).toMatchObject({ phase: "error", error: TOO_MANY_CHATS });
  full = false;
  calls.splice(0);
  await act(async () => { active.retryLimit(); });
  for (let flush = 0; flush < 40 && active.state.phase !== "ready"; flush += 1) await act(async () => {});
  expect(calls.filter((call) => call.startsWith("resume ") && call !== "resume fresh"), "try again resumed an older chat").toEqual([]);
  expect(calls.filter((call) => call === "new_session"), "try again did not retry the new chat").toHaveLength(1);
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh" });
  expect(location.search).toBe("?chat=fresh");
});

// a message sent in the last moment of a turn goes out as a steer; the turn ends before zeta reads it and zeta drops it.
// Forced order: zeta answers the status poll with "dropped" before its delivery_status event (the reason) arrives.
test.each([
  { name: "a new turn starts: it goes out once as a new message", reason: "turn_end", send: () => ({ accepted: true }), sends: 1 },
  { name: "dropped as disconnect while this connection answers: it goes out once as a new message", reason: "disconnect", send: () => ({ accepted: true }), sends: 1 },
  { name: "another turn already started: it stays unsent with the true reason", reason: "disconnect", send: () => { throw TURN_RUNNING_ERROR(); }, sends: 1, error: "the turn ended before zeta read it." },
  { name: "a different refusal stays unsent with zeta's reason", reason: "disconnect", send: () => { throw Object.assign(new Error("host binding required"), { code: -32003 }); }, sends: 1, error: "host binding required", bubbleReason: "disconnect" },
  { name: "a stop dropped it: never resent", reason: "abort", send: () => ({ accepted: true }), sends: 0, error: "zeta dropped this message before reading it." },
])("a steer its turn ended without reading: $name", async (row) => {
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "?chat=chat", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ ...chat, last_state: "running", message_sent: true }], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const store = Object.assign(createRunStore(), { resync() {} });
  const requests: { method: string; text?: string; delivery_id?: string; intent?: string }[] = [];
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "turn_reconnect"],
    request: async (method: string, params?: { text?: string; delivery_id?: string }, options?: { intent?: string }) => {
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "running", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "chat" }, state: "running" };
      requests.push({ method, text: params?.text, delivery_id: params?.delivery_id, intent: options?.intent });
      if (method === "steer") {
        store.dispatch({ type: "user_message", text: params!.text!, mode: "steer", delivery_id: params!.delivery_id!, intent: options?.intent });
        return { accepted: true };
      }
      if (method === "delivery_status") {
        const id = params!.delivery_id!;
        setTimeout(() => store.dispatch({ type: "delivery_status", delivery_id: id, method: "steer", status: "dropped", content: "", reason: row.reason }), 5);
        return { status: "dropped" };
      }
      if (method === "send") {
        const reply = row.send();
        // fulcrum stamps the echo with the request's intent: the resend takes over the steer's row
        store.dispatch({ type: "user_message", text: params!.text!, mode: "send", delivery_id: params!.delivery_id!, intent: options?.intent });
        return reply;
      }
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const harness = { active: null as unknown as ReturnType<typeof useActiveChat> };
  const clock = new ManualClock();
  const Harness = () => { harness.active = useActiveChat(zeta as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => harness.active.state.phase === "ready");
  let failure: unknown = null;
  await act(async () => { await harness.active.send("late", { steer: true }, () => {}).catch((caught) => { failure = caught; }); });
  const [steer] = requests;
  const sends = requests.filter((request) => request.method === "send");
  expect(sends, "a steer its turn did not read was not sent again as a new message").toEqual(Array.from({ length: row.sends }, () => ({ method: "send", text: "late", delivery_id: expect.not.stringMatching(`^${steer!.delivery_id}$`), intent: steer!.delivery_id })));
  expect(steer).toMatchObject({ method: "steer", intent: steer!.delivery_id });
  expect(failure === null ? null : String((failure as Error).message)).toBe(row.error ?? null);
  // one bubble: the delivered resend, or the dropped steer with the reason the composer row gives
  const users = store.getState().outline.map(({ id }) => store.getItem(id)).filter((item) => item?.type === "user");
  expect(users.map((item) => item?.type === "user" && item.event.type === "user_message" ? `${item.event.mode}:${item.event.delivery_status ?? "ok"}:${item.event.delivery_reason ?? ""}` : "")).toEqual([row.sends && !row.error ? "send:ok:" : `steer:dropped:${row.bubbleReason ?? (row.error === TURN_ENDED ? "turn_end" : row.reason)}`]);
});
const TURN_ENDED = "the turn ended before zeta read it.";

// "stop the oldest parked chat and try again": one owner (stopAndRetry) for both refusals of a new chat, parked_limit
// (this tab keeps 3 chats running) and resident_limit (zeta is full). After the stop, the stopped chat is zeta's
// attached session, not a parked one; a refused retry while zeta still has it (it still holds work) is "still
// stopping": the chat the user was on opens again (so the stopped chat parks again and the shown chat is no parked
// row), and the notice offers "try again" (nothing retries by itself). It never offers to stop a second chat.
type Answer = "ok" | { attached?: boolean; listed?: boolean };
type StopRow = {
  name: string;
  // the answer to the repeated new_session: "ok", or a refusal; `attached`: zeta keeps the stopped chat attached;
  // `listed`: the refusal (parked_limit) or status (resident_limit) lists it
  retry?: Answer;
  fail?: "resume" | "abort";
  move?: "away" | "double";
  outcome: "switched" | "still_stopping" | "refused_other" | "stop_failed" | "none";
  // still stopping, then: "try again", "stay", or the user's New chat (answered `again`) while zeta closes the stopped chat
  then?: "try_again" | "stay" | "new_chat";
  again?: Answer;
};
const stopRows: StopRow[] = [
  { name: "the retry switches", retry: "ok", outcome: "switched" },
  { name: "still stopping, then the user's New chat: it opens normally and send works", retry: { attached: true }, outcome: "still_stopping", then: "new_chat", again: "ok" },
  { name: "still stopping, then try again", retry: { attached: true }, outcome: "still_stopping", then: "try_again", again: { attached: true } },
  { name: "still stopping, then stay", retry: { listed: true }, outcome: "still_stopping", then: "stay" },
  { name: "other chats hold the slots", retry: {}, outcome: "refused_other" },
  { name: "the stop fails at resume", fail: "resume", outcome: "stop_failed" },
  { name: "the stop fails at abort", fail: "abort", outcome: "stop_failed" },
  { name: "the user opens another chat mid-stop", move: "away", outcome: "none" },
  { name: "a double click", retry: { attached: true }, move: "double", outcome: "still_stopping", then: "stay" },
];
const stopCases = (["parked_limit", "resident_limit"] as const).flatMap((limit) => stopRows.map((row) => ({ ...row, limit })));

test.each(stopCases)("stop the oldest parked chat and try again, $limit: $name", async (row) => {
  const location = { pathname: "/", search: "?chat=chat", hash: "", href: "http://achilles.test/?chat=chat", origin: "http://achilles.test", assign() {} };
  const go = (path: string) => { const url = new URL(path, location.href); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href }); };
  const listed = ["chat", "p1", "p2", "p3", "other", "fresh"].map((id) => ({ ...chat, session_id: id, title: id, page_route: "/", last_state: id.startsWith("p") ? "running" : "idle" }));
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { state: null, pushState(_state: unknown, _title: string, path: string) { go(path); }, replaceState(_state: unknown, _title: string, path: string) { go(path); } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      if (url === "/api/pages/home/session") return Response.json({ session_id: "fresh" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: listed, next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  // zeta: "chat" attached, p1..p3 parked (oldest first). a resume takes a chat and parks the attached one
  const zeta = { attached: "chat", parked: ["p1", "p2", "p3"], newSessions: 0 };
  const calls: string[] = [];
  const midStop = deferred<void>();
  const userNewChat = deferred<void>();
  const refusal = (parkedIds: string[]) => row.limit === "parked_limit"
    ? Object.assign(new Error("parked limit"), { code: -32004, data: { reason: "parked_limit", parked: parkedIds } })
    : Object.assign(new Error("resident limit"), { code: -32004, data: { reason: "resident_limit" } });
  const client = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "session_park"],
    request: async (method: string, params?: { session_id?: string }) => {
      calls.push(params?.session_id ? `${method} ${params.session_id}` : method);
      if (method === "status") return { session: { session_id: zeta.attached }, state: "idle", parked_sessions: zeta.parked.map((id) => ({ session_id: id, state: "running", pending_approvals: 0 })) };
      if (method === "resume") {
        const id = params!.session_id!;
        if (id === "p1" && row.move === "away") await midStop.promise;
        if (id === "p1" && row.fail === "resume") throw new Error("zeta is restarting");
        if (id !== zeta.attached) { zeta.parked = [...zeta.parked.filter((other) => other !== id), zeta.attached]; zeta.attached = id; }
        return { session: { name: null } };
      }
      if (method === "abort") { if (row.fail === "abort") throw new Error("abort failed"); return {}; }
      if (method === "send") return { accepted: true };
      if (method === "new_session") {
        zeta.newSessions += 1;
        // the user's New chat waits for zeta while the stopped chat closes
        if (zeta.newSessions === 3 && row.then === "new_chat") await userNewChat.promise;
        // the first new chat is refused (the tab keeps 3 chats running, or zeta is full); the retry answers per row
        if (zeta.newSessions === 1) throw refusal(zeta.parked);
        const answer = (zeta.newSessions === 2 ? row.retry : row.again) ?? {};
        if (answer === "ok") { zeta.parked = zeta.parked.filter((id) => id !== zeta.attached); zeta.attached = "fresh"; return { session: { session_id: "fresh" } }; }
        // after the stop zeta has p1 attached and p2, p3, chat parked. attached: p1 still holds work, so zeta keeps it
        // attached; listed: it parked again; neither: p1 closed, and "other" (another tab's chat... here a new
        // parked one) holds the slot
        if (answer.listed) { zeta.parked = ["p1", "p2", "p3"]; zeta.attached = "chat"; }
        else if (!answer.attached) { zeta.parked = ["p2", "p3", "other"]; zeta.attached = "chat"; }
        // still attached (refused): zeta changed nothing; still parked (a later retry): it stays listed
        else if (zeta.attached !== "p1" && !zeta.parked.includes("p1")) throw new Error("p1 is gone");
        throw refusal(zeta.parked);
      }
      if (method === "state_session") return { session: { status: "idle" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(client as never, true, clock as never, true); return null; };
  const settle = async () => { for (let flush = 0; flush < 30; flush += 1) await act(async () => {}); };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "ready");
  await act(async () => { await active.newChat(); });
  await settle();
  // both refusals keep the shown chat under the notice, which lists this tab's parked chats
  expect(active.busy).toMatchObject({ limit: row.limit === "parked_limit" ? "parked" : "resident" });
  expect(active.busy?.parked?.map((entry) => entry.sessionId)).toEqual(["p1", "p2", "p3"]);
  calls.splice(0);

  await act(async () => { void active.stopAndRetry(); if (row.move === "double") void active.stopAndRetry(); });
  if (row.move === "away") {
    expect(active.stop).toMatchObject({ sessionId: "p1", from: "chat", phase: "stopping" });
    await act(async () => { active.selectChat(listed.find((entry) => entry.session_id === "other")!); });
    midStop.resolve();
  }
  await settle();
  clock.advance(5_000);
  await settle();

  const sent = (method: string) => calls.filter((call) => call.startsWith(method));
  expect(sent("resume p1"), "the oldest parked chat (zeta's order) is resumed once").toHaveLength(1);
  expect(sent("abort"), "one chat is aborted at most").toEqual(row.fail === "resume" || row.move === "away" ? [] : ["abort p1"]);
  expect(sent("new_session"), "the refused new chat is repeated once, after the stop").toHaveLength(row.fail || row.move === "away" ? 0 : 1);
  switch (row.outcome) {
    case "switched":
      expect(active.stop).toBeNull();
      expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh" });
      break;
    case "still_stopping":
      expect(active.stop, "the stopped chat is named as still stopping").toMatchObject({ sessionId: "p1", from: "chat", phase: "still_stopping" });
      expect(active.busy, "the notice stays").toMatchObject({ limit: row.limit === "parked_limit" ? "parked" : "resident" });
      stillStopping();
      break;
    case "refused_other":
      expect(active.stop).toBeNull();
      expect(active.busy?.parked?.map((entry) => entry.sessionId)).not.toContain("p1");
      break;
    case "stop_failed":
      expect(active.stop).toMatchObject({ sessionId: "p1", phase: "failed" });
      expect((active.stop as { error: string }).error).toContain(row.fail === "resume" ? "zeta is restarting" : "abort failed");
      // a failed abort left p1 attached and "chat" parked: the list is read again
      if (row.fail === "abort") expect(calls.at(-1)).toBe("status");
      break;
    case "none":
      expect(active.stop).toBeNull();
      break;
  }
  // still stopping: zeta has the chat the user was on attached again, the stopped chat is one of this tab's parked chats
  // (its row says so), and the shown chat is no parked row
  function stillStopping() {
    expect(active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
    expect(zeta.attached, "zeta kept the stopped chat attached while the screen shows the user's chat").toBe("chat");
    const rows = parkedRows(client).map((entry) => entry.session_id);
    expect(rows, "the shown chat still has a parked row").not.toContain("chat");
    expect(rows, "the stopped chat is not one of this tab's parked chats").toContain("p1");
  }
  if (row.then) {
    calls.splice(0);
    if (row.then === "new_chat") {
      // a user swap ends the stop run and its notice at once; zeta closing the stopped chat meanwhile starts nothing
      let created!: Promise<void>;
      await act(async () => { created = active.newChat(); });
      expect(active.stop, "the user's New chat did not end the stop run").toBeNull();
      expect(active.busy).toBeNull();
      zeta.parked = zeta.parked.filter((id) => id !== "p1");
      await act(async () => { takeParkedEvent(client, JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "parked_session_changed", session_id: "p1", data: { state: "closed" } } })); });
      await settle();
      await act(async () => { userNewChat.resolve(); await created; });
      await settle();
      expect(active.state, "the user's New chat did not open").toMatchObject({ phase: "ready", sessionId: "fresh" });
      expect(active.swapping, "send stays off after the New chat landed").toBe(false);
      expect(sent("new_session"), "one New chat, nothing repeated by itself").toHaveLength(1);
      expect(sent("abort")).toEqual([]);
      calls.splice(0);
      await act(async () => { await active.send("hello", { steer: false }, () => {}); });
      expect(sent("send"), "send did not reach the new chat").toEqual(["send fresh"]);
    } else if (row.then === "try_again") {
      // "try again" stays a retry of that stop: refused again, it still names p1 and never aborts a second chat
      await act(async () => { active.retryStopped(); });
      await settle();
      expect(sent("abort")).toEqual([]);
      expect(sent("new_session")).toHaveLength(1);
      expect(active.stop).toMatchObject({ sessionId: "p1", from: "chat", phase: "still_stopping" });
      stillStopping();
    } else {
      // "stay" keeps the chat the user was on, which zeta has again; never the stopped chat, and no second resume
      await act(async () => { await active.stay(); });
      await settle();
      expect(active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
      expect(zeta.attached, "zeta kept the stopped chat attached after stay").toBe("chat");
      expect(sent("resume"), "stay opened the shown chat again").toEqual([]);
      expect(active.busy).toBeNull();
      expect(active.stop).toBeNull();
    }
  }
});

// the notice and the stop both follow zeta's status order (oldest first), not the refusal's list, which has no set order
test("the parked_limit notice and its stop take the oldest chat from status, not from the refusal's list", async () => {
  const location = { pathname: "/", search: "?chat=chat", hash: "", href: "http://achilles.test/?chat=chat", origin: "http://achilles.test", assign() {} };
  const go = (path: string) => { const url = new URL(path, location.href); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href }); };
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { state: null, pushState(_state: unknown, _title: string, path: string) { go(path); }, replaceState(_state: unknown, _title: string, path: string) { go(path); } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: ["chat", "p1", "p2", "p3"].map((id) => ({ ...chat, session_id: id, title: id })), next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const calls: string[] = [];
  const client = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "session_park"],
    request: async (method: string, params?: { session_id?: string }) => {
      calls.push(params?.session_id ? `${method} ${params.session_id}` : method);
      if (method === "status") return { session: { session_id: "chat" }, state: "idle", parked_sessions: ["p2", "p3", "p1"].map((id) => ({ session_id: id, state: "running", pending_approvals: 0 })) };
      if (method === "new_session") throw Object.assign(new Error("parked limit"), { code: -32004, data: { reason: "parked_limit", parked: ["p1", "p2", "p3"] } });
      if (method === "resume") return { session: { name: null } };
      if (method === "abort") throw new Error("abort failed");
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "idle", pending_approvals: [] } };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const Harness = () => { active = useActiveChat(client as never, true, clock as never, true); return null; };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "ready");
  await act(async () => { await active.newChat(); });
  await flushUntil(() => Boolean(active.busy?.parked));
  expect(active.busy?.parked?.map((entry) => entry.sessionId)).toEqual(["p2", "p3", "p1"]);
  calls.splice(0);
  await act(async () => { await active.stopAndRetry(); });
  expect(calls.filter((call) => call.startsWith("resume")), "the stop took the oldest chat in status order").toEqual(["resume p2"]);
});

// The one swap attempt (select a chat, new chat): the shown chat (header, transcript, composer and its draft) stays
// until zeta answers. A switch takes the url with one history entry (Back works); a refusal leaves the url and the
// sidebar as they were and puts its notice above the kept chat; "stop the oldest and switch" lands the swap; "stay"
// keeps the chat. zeta: "chat" attached and running; a swap parks it, unless this tab keeps 3 (parked_limit) or zeta is
// full (resident_limit); the oldest parked chat holds no work, so a stop frees its slot.
// typed: the user types and sends while zeta has not answered yet
type SwapRow = { entry: "select" | "new"; zeta: "parks" | "parked_limit" | "resident_limit"; then: "nothing" | "stop" | "stay"; typed?: true };
const swapRows: SwapRow[] = (["select", "new"] as const).flatMap((entry) => [
  { entry, zeta: "parks" as const, then: "nothing" as const },
  { entry, zeta: "parked_limit" as const, then: "nothing" as const },
  { entry, zeta: "resident_limit" as const, then: "nothing" as const },
  { entry, zeta: "parked_limit" as const, then: "stop" as const },
  { entry, zeta: "parked_limit" as const, then: "stay" as const },
  { entry, zeta: "parked_limit" as const, then: "nothing" as const, typed: true as const },
]);
test.each(swapRows)("a swap keeps the shown chat until zeta answers: $entry, zeta $zeta, then $then (typed: $typed)", async (row) => {
  const location = { pathname: "/", search: "?chat=chat", hash: "", href: "http://achilles.test/?chat=chat", origin: "http://achilles.test", assign() {} };
  const go = (path: string) => { const url = new URL(path, location.href); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href }); };
  const pushes: string[] = [];
  const listed = ["chat", "p1", "p2", "p3", "target", "fresh"].map((id) => ({ ...chat, session_id: id, title: id, page_route: "/" }));
  setGlobals({
    localStorage: new MemoryStorage(), location,
    history: { state: null, pushState(_state: unknown, _title: string, path: string) { pushes.push(path); go(path); }, replaceState(_state: unknown, _title: string, path: string) { go(path); } },
    addEventListener() {}, removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      if (url === "/api/pages/home/session") return Response.json({ session_id: "fresh" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: listed, next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = { attached: "chat", parked: row.zeta === "parks" ? [] as string[] : ["p1", "p2", "p3"], full: row.zeta !== "parks", stopped: "" };
  const refusal = () => row.zeta === "resident_limit"
    ? Object.assign(new Error("resident limit"), { code: -32004, data: { reason: "resident_limit" } })
    : Object.assign(new Error("parked limit"), { code: -32004, data: { reason: "parked_limit", parked: zeta.parked } });
  // a swap parks the attached chat (it runs), or closes it when a stop ended its work
  const swapTo = (id: string) => { if (zeta.attached !== zeta.stopped) zeta.parked = [...zeta.parked, zeta.attached]; zeta.attached = id; };
  const calls: string[] = [];
  const answer = deferred<void>();
  let held = false;
  const client = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "session_park"],
    request: async (method: string, params?: { session_id?: string }) => {
      calls.push(params?.session_id ? `${method} ${params.session_id}` : method);
      // zeta answers the swap only after the user typed and sent
      if (row.typed && (method === "new_session" || (method === "resume" && params?.session_id === "target"))) { held = true; await answer.promise; }
      if (method === "status") return { session: { session_id: zeta.attached }, state: "running", parked_sessions: zeta.parked.map((id) => ({ session_id: id, state: "running", pending_approvals: 0 })) };
      if (method === "resume") {
        const id = params!.session_id!;
        if (id === zeta.attached) return { session: { name: null } };
        // one's own parked chat is never refused
        if (zeta.parked.includes(id)) { zeta.parked = zeta.parked.filter((other) => other !== id); swapTo(id); return { session: { name: null } }; }
        if (zeta.full) throw refusal();
        swapTo(id);
        return { session: { name: null } };
      }
      if (method === "abort") { zeta.stopped = params!.session_id!; zeta.full = false; return {}; }
      if (method === "new_session") { if (zeta.full) throw refusal(); swapTo("fresh"); return { session: { session_id: "fresh" } }; }
      if (method === "state_session") return { session: { status: "idle" }, items: [] };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "running", pending_approvals: [] } };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  const clock = new ManualClock();
  let active!: ReturnType<typeof useActiveChat>;
  const shown: string[] = [];
  // a new chat in progress over a shown chat: the "creating chat…" pane and a read-only composer would hide and lock it
  let creatingOverKept = false;
  const Harness = () => { active = useActiveChat(client as never, true, clock as never, true); shown.push(active.state.phase === "ready" ? active.state.sessionId : active.state.phase); if (active.creatingChat && active.state.phase === "ready") creatingOverKept = true; return null; };
  const settle = async () => { for (let flush = 0; flush < 30; flush += 1) { await act(async () => {}); clock.advance(1_000); } };
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "ready");
  await settle();
  shown.splice(0); pushes.splice(0);

  await act(async () => { if (row.entry === "select") active.selectChat(listed.find((entry) => entry.session_id === "target")!); else void active.newChat(); });
  if (row.typed) {
    for (let flush = 0; flush < 30 && !held; flush += 1) await act(async () => {});
    calls.splice(0);
    let refusedSend: unknown = null;
    await act(async () => { await active.send("meant for the new chat", { steer: false }, () => {}).catch((caught) => { refusedSend = caught; }); });
    expect(calls.filter((call) => call.startsWith("send") || call.startsWith("steer")), "a send typed during the swap reached the kept chat").toEqual([]);
    expect((refusedSend as Error | null)?.message, "the send was not refused (its draft would be lost)").toBe(activeChat.SWAP_SEND_OFF);
    expect(active.swapping, "the composer does not show send as off while a swap is pending").toBe(true);
    await act(async () => { answer.resolve(); });
  }
  await settle();
  // the swap settled (here refused, or landed): send works again
  expect(creatingOverKept, "the kept chat was covered by \"creating chat…\" and locked while zeta answered").toBe(false);
  expect(active.swapping).toBe(false);
  const landed = row.entry === "select" ? "target" : "fresh";
  if (row.zeta !== "parks") {
    expect([...new Set(shown)], "the shown chat was replaced while zeta refused the swap").toEqual(["chat"]);
    expect(location.search, "a refused swap changed the url").toBe("?chat=chat");
    expect(pushes, "a refused swap added a history entry").toEqual([]);
    expect(active.selectedId).toBe("chat");
    expect(active.busy?.limit, "the notice says which limit").toBe(row.zeta === "resident_limit" ? "resident" : "parked");
    expect(active.busy?.parked?.map((entry) => entry.sessionId)).toEqual(["p1", "p2", "p3"]);
    shown.splice(0);
    if (row.then === "stop") { await act(async () => { await active.stopAndRetry(); }); await settle(); }
    if (row.then === "stay") { await act(async () => { await active.stay(); }); await settle(); }
  }
  if (row.zeta === "parks" || row.then === "stop") {
    // the chat on screen changes once, from the kept chat to the new one: nothing blank in between
    expect([...new Set(shown)], "the swap showed something other than the kept chat, then the new one").toEqual(["chat", landed]);
    expect(active.state).toMatchObject({ phase: "ready", sessionId: landed });
    expect(location.search).toBe(`?chat=${landed}`);
    expect(pushes, "a switch takes one history entry, so Back returns to the kept chat").toEqual([`/?chat=${landed}`]);
    expect(active.busy).toBeNull();
    expect(active.stop).toBeNull();
    if (row.then === "stop") expect(calls.filter((call) => call.startsWith("abort")), "the oldest parked chat is stopped once").toEqual(["abort p1"]);
    // the new chat is attached once (its page binding); selecting it after does not resume it again
    if (row.entry === "new") expect(calls.filter((call) => call === "resume fresh"), "the new chat was resumed again after it attached").toHaveLength(1);
  } else {
    expect(shown.filter((id) => id !== "chat"), "the kept chat was replaced").toEqual([]);
    expect(active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
    expect(location.search).toBe("?chat=chat");
    expect(pushes).toEqual([]);
    if (row.then === "stay") expect(active.busy).toBeNull();
  }
});
