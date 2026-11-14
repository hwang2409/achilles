import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { draftStore } from "./draftStore";
import { useActiveChat } from "./useActiveChat";

const EXPECTED_ATTACH_SLOW_MS = 15_000;
const originalGlobals = {
  localStorage: globalThis.localStorage,
  location: globalThis.location,
  history: globalThis.history,
  addEventListener: globalThis.addEventListener,
  removeEventListener: globalThis.removeEventListener,
  fetch: globalThis.fetch,
  document: globalThis.document,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
let mounted: ReactTestRenderer | null = null;

afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  Object.assign(globalThis, originalGlobals);
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
    features: ["session_mcp_bindings"],
    request: async (method: string) => {
      if (method === "resume") {
        resumes += 1;
        if (resumes === 1 && firstResume) return firstResume;
        return { session: { name: "new attachment" } };
      }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history") return { messages: [], next_offset: null };
      if (method === "status") return { session: { session_id: "chat" }, state: "idle" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => {
      await refresh();
      return { store: { resync() {} }, release() {} };
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
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
  const Harness = () => { active = useActiveChat(slowClient as never, true, clock as never); return null; };
  let renderer!: ReactTestRenderer;

  await act(async () => { renderer = create(createElement(Harness)); mounted = renderer; });
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
  await act(async () => { renderer = create(createElement(NormalHarness)); mounted = renderer; });
  await flushUntil(() => active.state.phase === "ready");
  await act(async () => { normalClock.advance(EXPECTED_ATTACH_SLOW_MS); });
  expect(active.attachSlow).toBe(false);
  await act(async () => { renderer.unmount(); mounted = null; });
});

test("a failed tool refresh on the first send keeps the new chat with a retry notice", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const emptyPage = { ...page, zeta_session_id: null };
  const requests: string[] = [];
  let refreshes = 0;
  const lastRefresh = deferred<void>();
  Object.assign(globalThis, {
    localStorage: new MemoryStorage(),
    document: { activeElement: null },
    location: { pathname: "/", search: "", href: "http://achilles.test/", origin: "http://achilles.test", assign() {} },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/pages/home") return Response.json(emptyPage);
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return Response.json({}, { status: 201 });
      if (url === "/api/pages/home/session") return Response.json({ session_id: "fresh" });
      if (url === "/api/pages/home/create-mode") return Response.json({ create_mode: true });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      if (url.startsWith("/api/chats/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const zeta = {
    features: ["session_mcp_bindings", "mcp_refresh_tools"],
    request: async (method: string) => {
      requests.push(method);
      if (method === "new_session") return { session: { session_id: "fresh" } };
      if (method === "resume") return { session: { name: null } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history") return { messages: [], next_offset: null };
      if (method === "status") return { session: { session_id: "fresh" }, state: "idle" };
      if (method === "mcp_refresh_tools") {
        refreshes += 1;
        if (refreshes <= 2) throw Object.assign(new Error("refresh failed"), { code: -32005, data: { reason: "MCP tools/list timed out after 10s" } });
        await lastRefresh.promise;
        return { session_id: "fresh", servers: ["achilles"] };
      }
      if (method === "send") return {};
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
  let active!: ReturnType<typeof useActiveChat>;
  const clock = new ManualClock();
  const Harness = () => { active = useActiveChat(zeta as never, true, clock as never); return null; };
  await act(async () => { mounted = create(createElement(Harness)); });
  await flushUntil(() => active.state.phase === "empty");
  await act(async () => { await active.toggle(); });

  let sent: Promise<void> | null = null;
  await act(async () => { sent = active.send("make a reading list", { steer: false }, () => {}); await sent.catch(() => {}); });
  expect(active.creationError).toBeNull();
  expect(active.state).toMatchObject({ phase: "ready", sessionId: "fresh", page: { create_mode: false } });
  await expect(sent!).rejects.toThrow("send is off until page tools refresh");
  expect(active.toggleError).toContain("zeta could not refresh page tools: MCP tools/list timed out after 10s");
  expect([active.toggleBlocked, active.toggleRetryable]).toEqual([true, true]);
  expect(draftStore.get("fresh")).toBe("make a reading list");

  await act(async () => { await active.toggle(); });
  expect(active.toggleError).toContain("timed out");
  expect([active.toggleBlocked, active.toggling]).toEqual([true, false]);

  let retried: Promise<void> | null = null;
  await act(async () => { retried = active.toggle(); });
  await flushUntil(() => refreshes === 3);
  expect([active.toggling, active.toggleBlocked]).toEqual([true, true]);
  expect(active.toggleError).toContain("timed out");
  lastRefresh.resolve();
  await act(async () => { await retried; });
  expect([active.toggleError, active.toggleBlocked]).toEqual([null, false]);
  expect(active.state).toMatchObject({ phase: "ready", page: { create_mode: true } });
  expect(requests.filter((method) => method === "mcp_refresh_tools")).toHaveLength(3);
  await act(async () => { await active.send("make a reading list", { steer: false }, () => {}); });
  expect(requests.at(-1)).toBe("send");
});
