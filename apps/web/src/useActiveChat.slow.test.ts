import "./test-dom";
import { afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { chatQueues } from "./composer/chatQueues";
import { MAYBE_SENT } from "./composer/composer-machine";
import { draftStore } from "./draftStore";
import { useActiveChat } from "./useActiveChat";
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
const chat = { session_id: "chat", page_id: "home", title: "chat", last_state: "idle" };

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

test("a failed tool refresh on the new chat button keeps its notice across the chat's own re-attach", async () => {
  const harness = await refreshFailureHarness(1);
  const { requests, lastRefresh } = harness;
  await act(async () => { await harness.active.toggle(); });
  await act(async () => { await harness.active.newChat(); });
  // publishReady selects the new chat, so the attach effect runs again for it and resumes it.
  await flushUntil(() => harness.active.selectedId === "fresh" && requests.filter((method) => method === "resume").length === 2 && harness.active.state.phase === "ready");
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
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

// zeta refuses new_session (-32004) while another chat's turn runs. the text typed after "new chat" was written for a new
// chat: it must never reach the running chat, whatever zeta allows.
test("new chat while another chat's turn runs keeps the new chat and never sends its text to the running chat", async () => {
  const delivered: { method: string; session: unknown }[] = [];
  const requests: string[] = [];
  setGlobals({
    localStorage: new MemoryStorage(),
    location: { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(page);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ ...chat, last_state: "running" }], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = {
    features: ["session_mcp_bindings", "session_replay_seq", "resume_attach", "turn_reconnect"],
    request: async (method: string, params?: { session_id?: string }) => {
      requests.push(method);
      if (method === "new_session") throw TURN_RUNNING_ERROR();
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history_and_subscribe") return { messages: [], next_before: null, status: { state: "running", pending_approvals: [] } };
      if (method === "status") return { session: { session_id: "chat" }, state: "running" };
      if (method === "send" || method === "steer") { delivered.push({ method, session: params?.session_id }); return { accepted: true }; }
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
  await act(async () => { mounted = render(createElement(Harness)); });
  await flushUntil(() => harness.active.state.phase === "ready");
  await act(async () => { await harness.active.newChat(); });
  await flushUntil(() => harness.active.busy !== null && harness.active.state.phase !== "loading");
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  clock.advance(5_000);
  for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
  // zeta refuses it during a turn and the client repeats a refused one, so achilles asks status first and sends none
  expect(requests.filter((method) => method === "new_session"), "new_session sent while a turn runs").toHaveLength(0);
  // the composer steers when the shown chat runs (App: `turn === "running"`), so send the way it would
  const steer = harness.active.state.phase === "ready";
  let sent: Promise<void> | null = null;
  await act(async () => { sent = harness.active.send("second story", { steer }, () => {}); await sent.catch(() => {}); });
  expect(delivered, "text written for the new chat reached the running chat").toEqual([]);
  expect(requests.filter((method) => method === "new_session"), "new_session sent while a turn runs").toHaveLength(0);
  await expect(sent!).rejects.toThrow("another chat was running");
  expect(harness.active.state.phase).toBe("empty");
  expect(harness.active.busy).toMatchObject({ sessionId: "chat", retry: "new" });
});

// unsent rows across a page load, through the page: chatQueues keeps every chat's rows (the new-chat box's too) in browser
// storage, so a reload shows them as failed rows (retry, edit, x). never in another chat, never sent before the user acts,
// never twice, never merged into a box
type UnsentRow = {
  name: string;
  // "refused": Enter in the new-chat box while another chat's turn runs; "failed": the first send to the created chat fails
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
        if (running) throw TURN_RUNNING_ERROR();
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
      await act(async () => { await harness.active.newChat(); });
      await flushUntil(() => harness.active.state.phase === "empty" && harness.active.busy !== null);
      const box = composer("new:home");
      box.edit(UNSENT_TEXT);
      await act(async () => { await box.submit(); });
      expect(box.getModel().queue).toMatchObject([{ text: UNSENT_TEXT, failed: expect.stringContaining("another chat was running") }]);
      expect(draftStore.get("new:home")).toBe("");
      await load();
      // the page opens its newest chat (the running one): the row was written for a new chat, so it is not there
      expect(harness.active.state).toMatchObject({ phase: "ready", sessionId: "chat" });
      expect(rowsOf(composer("chat"))).toEqual([]);
      expect(sendsOfText(), "text written for the new chat reached the running chat").toEqual([]);
      expect(requests.filter((method) => method === "new_session"), "new_session sent while a turn runs").toHaveLength(0);
      // the turn ends; the notice's "open" shows the new-chat box with the row, still unsent, and makes no chat
      running = false;
      await act(async () => { harness.active.openNewChat(); });
      expect(requests.filter((method) => method === "new_session"), "open made a chat").toHaveLength(0);
      await flushUntil(() => harness.active.state.phase === "empty");
      const box2 = composer("new:home");
      expect(box2.getModel().queue).toMatchObject([{ text: UNSENT_TEXT, failed: expect.stringContaining("another chat was running") }]);
      expect(sendsOfText()).toEqual([]);
      // retry makes the chat the text was written for, and sends it there once
      await act(async () => { await box2.retry(box2.getModel().queue[0]!.id); });
      await flushUntil(() => harness.active.state.phase === "ready" && harness.active.state.sessionId === "s1");
      expect(requests.filter((method) => method === "new_session")).toHaveLength(1);
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
