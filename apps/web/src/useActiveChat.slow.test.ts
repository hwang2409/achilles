import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useActiveChat } from "./useActiveChat";

const EXPECTED_ATTACH_SLOW_MS = 15_000;
const originalGlobals = {
  localStorage: globalThis.localStorage,
  location: globalThis.location,
  history: globalThis.history,
  addEventListener: globalThis.addEventListener,
  removeEventListener: globalThis.removeEventListener,
  fetch: globalThis.fetch,
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
