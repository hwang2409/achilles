import { describe, expect, test } from "bun:test";
import { createChatCreationOwner, type ChatCreationInput } from "./chatCreation";
import { createComposerDelivery } from "./composer/useComposerDelivery";
import { attachPage, confirmSteerDelivery, createAttachmentOwner, createModeToggleOwner, deliverChatMessage, cutTitle, DroppedSteerDeliveryError, pageDeliverySteer, persistChatState, persistFirstMessage, trackQueuedSteer } from "./useActiveChat";

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  failWrite = 0;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    this.writes += 1;
    if (this.writes === this.failWrite) throw new Error(`forced durable write ${this.writes}`);
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.writes += 1;
    if (this.writes === this.failWrite) throw new Error(`forced durable write ${this.writes}`);
    this.values.delete(key);
  }
}

const input = (client: object, map = false): ChatCreationInput => ({ client: client as never, pageId: "home", credential: "synthetic", cwd: "/tmp", mode: "allow", ...(map ? { mapExpectedSessionId: null } : {}) });
const CONTROLLED_TIMEOUT_MS = 10_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe("create mode tool refresh", () => {
  test.each([
    { name: "successful refresh", reset: false, refreshError: null, sendReady: true },
    { name: "successful refresh after reset keeps the old draft", reset: true, refreshError: null, sendReady: false },
    { name: "blocked refresh after reset", reset: true, refreshError: Object.assign(new Error("failed"), { code: -32005 }), sendReady: false },
  ])("holds send through $name", async ({ reset, refreshError, sendReady: expectedSendReady }) => {
    const refresh = deferred<unknown>();
    const requestReached = deferred<void>();
    let fetches = 0; let requests = 0;
    const owner = createModeToggleOwner(async () => { fetches += 1; return Response.json({ create_mode: true }); });
    const input = { pageId: "home", sessionId: "session", enabled: true, client: { features: ["mcp_refresh_tools"], request: () => { requests += 1; requestReached.resolve(); return refresh.promise; } } };
    const first = owner.run(input); const duplicate = owner.run(input);
    let sendReady = false;
    const send = owner.beforeSend().then(() => { sendReady = true; });
    const cancel = () => refresh.reject(new Error("cancelled controlled refresh"));
    const drain = () => Promise.allSettled([first, send]);
    await waitBounded(requestReached.promise, cancel, drain);
    expect(sendReady).toBe(false);
    expect(duplicate).toBe(first);
    expect(fetches).toBe(1); expect(requests).toBe(1);
    if (reset) owner.reset();
    if (refreshError) refresh.reject(refreshError);
    else refresh.resolve({ session_id: "session", servers: ["achilles"] });
    expect((await waitBounded(first, cancel, drain)).blocked).toBe(Boolean(refreshError));
    if (expectedSendReady) await waitBounded(send, cancel, drain);
    else await expect(waitBounded(send, cancel, drain)).rejects.toThrow("send is off");
    expect(sendReady).toBe(expectedSendReady);
  });

  test.each([
    { code: -32005, text: "could not refresh page tools" },
    { code: -32602, text: "could not find the achilles" },
    { code: -32003, text: "different chat" },
  ])("blocks send on refresh error $code and retries only the refresh", async ({ code, text }) => {
    let fetches = 0; let requests = 0;
    const client = { features: ["mcp_refresh_tools"], request: async () => { requests += 1; if (requests === 1) throw Object.assign(new Error("failed"), { code }); return { session_id: "session", servers: ["achilles"] }; } };
    const owner = createModeToggleOwner(async () => { fetches += 1; return Response.json({ create_mode: true }); });
    const result = await owner.run({ pageId: "home", sessionId: "session", enabled: true, client });
    expect(result.blocked).toBe(true); expect(result.error).toContain(text);
    await expect(owner.beforeSend()).rejects.toThrow("send is off");
    expect(await owner.run({ pageId: "home", sessionId: "session", enabled: false, client })).toEqual({ createMode: true, error: null, blocked: false, retryable: false });
    await owner.beforeSend();
    expect(fetches).toBe(1); expect(requests).toBe(2);
  });

  test("keeps send blocked and retries the mode update when the endpoint fails", async () => {
    let requests = 0;
    const owner = createModeToggleOwner(async () => {
      requests += 1;
      if (requests === 1) return new Response(null, { status: 503 });
      return Response.json({ create_mode: true });
    });
    const input = { pageId: "home", sessionId: "session", enabled: true, client: { features: ["mcp_refresh_tools"], request: async () => ({}) } };
    expect(await owner.run(input)).toEqual({ createMode: null, error: "could not update create mode (503)", blocked: true, retryable: true });
    await expect(owner.beforeSend()).rejects.toThrow("send is off");
    expect(await owner.run(input)).toEqual({ createMode: true, error: null, blocked: false, retryable: false });
    expect(requests).toBe(2);
  });

  test.each([
    { name: "retry succeeds", failures: 1, expected: { createMode: true, error: null, blocked: false, retryable: false } },
    { name: "retry also fails", failures: 2, expected: { createMode: null, error: "achilles restarted, but zeta kept its expired MCP session. restart zeta serve, then reload this page before using create mode.", blocked: true, retryable: false } },
  ])("retries an expired MCP session once when $name", async ({ failures, expected }) => {
    let requests = 0;
    const client = { features: ["mcp_refresh_tools"], request: async () => {
      requests += 1;
      if (requests <= failures) throw Object.assign(new Error("refresh failed"), { code: -32005, data: { reason: "achilles: MCP HTTP 404: Session not found" } });
      return { session_id: "session", servers: ["achilles"] };
    } };
    const owner = createModeToggleOwner(async () => Response.json({ create_mode: true }));
    const result = await owner.run({ pageId: "home", sessionId: "session", enabled: true, client });
    expect(result).toEqual(expected);
    expect(requests).toBe(2);
    if (result.blocked) await expect(owner.beforeSend()).rejects.toThrow("send is off");
    else await owner.beforeSend();
  });

  test.each([
    { name: "feature was not negotiated", features: [] as string[], code: null, requests: 0 },
    { name: "server returns method not found", features: ["mcp_refresh_tools"], code: -32601, requests: 1 },
  ])("keeps the old toggle behavior when $name", async ({ features, code, requests }) => {
    let requestCount = 0;
    const owner = createModeToggleOwner(async () => Response.json({ create_mode: true }));
    const client = { features, request: async () => { requestCount += 1; throw Object.assign(new Error("unknown method"), { code }); } };
    const result = await owner.run({ pageId: "home", sessionId: "session", enabled: true, client });
    expect(result).toEqual({ createMode: true, error: null, blocked: false, retryable: false });
    await owner.beforeSend();
    expect(requestCount).toBe(requests);
  });
});

async function withFetch<T>(fetcher: typeof fetch, operation: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await operation(); }
  finally { globalThis.fetch = originalFetch; }
}

async function waitBounded<T>(wait: Promise<T>, cancel: () => void, drain: () => Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([wait, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("controlled wait timed out after 10 seconds")), CONTROLLED_TIMEOUT_MS); })]);
  } catch (caught) {
    cancel();
    await drain().catch(() => {});
    throw caught;
  } finally { if (timer) clearTimeout(timer); }
}

function attachmentClient(onRequest?: (method: string, params?: unknown) => void | Promise<void>) {
  return {
    features: ["session_mcp_bindings"],
    request: async (method: string, params?: unknown) => {
      await onRequest?.(method, params);
      if (method === "new_session") return { session: { session_id: "created-on-zeta" } };
      if (method === "resume") return { session: { name: "" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      if (method === "session_history") return { messages: [], next_offset: null };
      if (method === "status") return { session: { session_id: "created-on-zeta" }, state: "idle" };
      throw new Error(`unexpected ${method}`);
    },
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
    replayRevision: () => 1,
    finishReplay: () => true,
  };
}

const page = (sessionId: string | null) => ({ id: "home", route: "/", title: "home", zeta_session_id: sessionId, workspace: "/tmp", create_mode: false, approval_mode: "allow", layout: { blocks: [] } });

describe("steer delivery confirmation", () => {
  test.each([
    { name: "delivered", status: { status: "delivered" } },
    { name: "evicted delivered", status: { status: "evicted", outcome: "delivered" } },
  ])("confirms $name", async ({ status }) => {
    const client = { request: async () => status };
    const result = await confirmSteerDelivery(client as never, "initial");
    expect(result).toBe("initial");
  });

  test.each([
    { name: "dropped", status: { status: "dropped" } },
    { name: "evicted dropped", status: { status: "evicted", outcome: "dropped" } },
  ])("keeps the draft when $name", async ({ status }) => {
    const client = { request: async () => status };
    await expect(confirmSteerDelivery(client as never, "initial")).rejects.toThrow("message was not sent");
  });

  test.each([
    { name: "unknown", statuses: [{ status: "unknown" }], error: "unknown" },
    { name: "evicted without outcome", statuses: [{ status: "evicted" }], error: "evicted" },
  ])("keeps the draft on $name", async ({ statuses, error }) => {
    const client = { request: async () => statuses.shift() };
    await expect(confirmSteerDelivery(client as never, "initial")).rejects.toThrow(error);
  });

  test("keeps the draft when a status request times out", async () => {
    let timeoutMs = 0;
    const client = { request: async (_method: string, _params: unknown, options?: { timeoutMs?: number }) => {
      timeoutMs = options?.timeoutMs ?? 0;
      throw new Error("request timed out");
    }};
    await expect(confirmSteerDelivery(client as never, "initial")).rejects.toThrow("timed out");
    expect(timeoutMs).toBeGreaterThan(0);
  });
});

const refused = (code: number) => Object.assign(new Error(`refused ${code}`), { code });

describe("message delivery tracking", () => {
  test.each([
    { name: "send", steer: false, replies: [{}], log: ["track:d1", "send:d1"] },
    { name: "steer", steer: true, replies: [{}, { status: "delivered" }], log: ["track:d1", "steer:d1", "delivery_status:d1"] },
    { name: "send refused while a turn runs, retried as steer", steer: false, replies: [refused(-32004), {}, { status: "delivered" }], log: ["track:d1", "send:d1", "steer:d1", "delivery_status:d1"] },
    { name: "steer refused with no turn, retried as send", steer: true, replies: [refused(-32005), {}], log: ["track:d1", "steer:d1", "send:d1"] },
    { name: "network error on the first request", steer: false, replies: [new Error("socket closed")], log: ["track:d1", "send:d1"], error: "socket closed" },
    { name: "second refusal", steer: false, replies: [refused(-32004), refused(-32005)], log: ["track:d1", "send:d1", "steer:d1"], error: "refused -32005" },
  ])("tracks the id once, before the first request: $name", async ({ steer, replies, log: expected, error }) => {
    const log: string[] = [];
    const client = { request: async (method: string, params: { delivery_id: string }) => {
      log.push(`${method}:${params.delivery_id}`);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    }};
    const delivery = deliverChatMessage(client as never, "s1", "hi", "d1", steer, (id) => log.push(`track:${id}`));
    if (error) await expect(delivery).rejects.toThrow(error);
    else await delivery;
    expect(log).toEqual(expected);
  });

  test.each([
    { name: "resolves", outcome: async () => "steer" },
    { name: "rejects with a network error", outcome: async () => { throw new Error("socket closed"); } },
    { name: "rejects with a second refusal", outcome: async () => { throw refused(-32005); } },
    { name: "rejects with a dropped steer", outcome: async () => { throw new DroppedSteerDeliveryError("dropped"); } },
  ])("the queued id leaves the set when the send $name", async ({ outcome }) => {
    const queued = new Set<string>();
    let whileSending: string[] = [];
    const result = trackQueuedSteer(async (track) => {
      track("d1");
      whileSending = [...queued];
      return outcome();
    }, (id) => queued.add(id), (id) => queued.delete(id));
    await result.catch(() => {});
    expect(whileSending).toEqual(["d1"]);
    expect([...queued]).toEqual([]);
  });
});

describe("chat state persistence", () => {
  test("a rejected state write does not become an unhandled rejection", async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const write = persistChatState("session", "idle", () => Promise.reject(new Error("achilles stopped")));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBe(0);
      expect(await write).toBe(false);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });
});

describe("untitled chat delivery", () => {
  test.each([
    { name: "title update rejects", fetch: () => Promise.reject(new Error("title failed")) },
    { name: "title update never resolves", fetch: () => new Promise<Response>(() => {}) },
  ])("clears the draft once after confirmed send when $name", async ({ fetch: titleFetch }) => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let draft = "sent text plus new";
    let clears = 0;
    let sends = 0;
    globalThis.fetch = titleFetch as typeof fetch;
    console.error = () => {};
    try {
      sends += 1;
      draft = draft.slice("sent text".length);
      clears += 1;
      persistFirstMessage("session", "sent text", () => {});
      await Promise.resolve();
      expect(draft).toBe(" plus new");
      expect(clears).toBe(1);
      expect(sends).toBe(1);
    } finally { globalThis.fetch = originalFetch; console.error = originalError; }
  });
});

describe("chat title cut", () => {
  test("an emoji across the 200-character edge stays whole or is dropped, never halved", () => {
    const title = cutTitle(`  ${"a".repeat(199)}😀😀 `);
    expect(title).toBe(`${"a".repeat(199)}😀`);
    expect(cutTitle("😀".repeat(300))).toBe("😀".repeat(200));
  });
});

describe("active chat attachment", () => {
  test("opening a page without a chat in the URL lands on its most recent chat, not the first chat it was mapped to", async () => {
    const chats = [
      { session_id: "books-latest", page_id: "books", title: "books chat", message_sent: true },
      { session_id: "home-latest", page_id: "home", title: "newest home chat", message_sent: true },
      { session_id: "home-first", page_id: "home", title: "first home chat", message_sent: true },
    ];
    const fetcher = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page("home-first"));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats, next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const owner = createAttachmentOwner();
    try {
      const ready = await withFetch(fetcher, () => attachPage(attachmentClient() as never, "home", null, owner, createChatCreationOwner(new MemoryStorage()), owner.begin("home", true)));
      expect(ready).toMatchObject({ phase: "ready", sessionId: "home-latest" });
    } finally { owner.clear(); }
  });

  test("a user-set title is not overwritten by a later zeta auto-name", async () => {
    const originalFetch = globalThis.fetch;
    let patched = false;
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page("chat"));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ session_id: "chat", page_id: "home", title: "my custom title", titled_by_user: true }], next: null });
      if (url === "/api/chats/chat" && init?.method === "PATCH") { patched = true; return new Response(null, { status: 200 }); }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = {
      features: ["session_mcp_bindings"],
      request: async (method: string) => {
        if (method === "resume") return { session: { name: "zeta auto name" } };
        if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
        if (method === "session_history") return { messages: [], next_offset: null };
        if (method === "status") return { session: { session_id: "chat" }, state: "idle" };
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
      replayRevision: () => 1,
      finishReplay: () => true,
    };
    const owner = createAttachmentOwner();
    try {
      const ready = await attachPage(client as never, "home", null, owner, createChatCreationOwner(new MemoryStorage()), owner.begin("home", true));
      expect(ready).toMatchObject({ phase: "ready", title: "my custom title" });
      expect(patched).toBe(false);
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });

  test("clearing a user title falls back to the first-message title", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page("chat"));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ session_id: "chat", page_id: "home", title: "bird notes", first_title: "second chat about birds", titled_by_user: true, message_sent: true }], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = {
      features: ["session_mcp_bindings"],
      request: async (method: string) => {
        if (method === "resume") return { session: {} };
        if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
        if (method === "session_history") return { messages: [], next_offset: null };
        if (method === "status") return { session: { session_id: "chat" }, state: "idle" };
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
      replayRevision: () => 1,
      finishReplay: () => true,
    };
    const owner = createAttachmentOwner();
    try {
      const ready = await attachPage(client as never, "home", null, owner, createChatCreationOwner(new MemoryStorage()), owner.begin("home", true));
      // `rename` with an empty value shows autoTitle, so this is the title a clear reverts to
      expect(ready).toMatchObject({ phase: "ready", title: "bird notes", autoTitle: "second chat about birds" });
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });

  test("releases an acquired lease when the attachment becomes stale", async () => {
    const originalFetch = globalThis.fetch;
    let releases = 0; let statusRequests = 0; let reached!: () => void; let release!: () => void;
    const reachedFinalStatus = new Promise<void>((resolve) => { reached = resolve; });
    const statusGate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page("s"));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = {
      ...attachmentClient(),
      request: async (method: string) => {
        if (method === "resume") return { session: { name: "" } };
        if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
        if (method === "session_history") return { messages: [], next_offset: null };
        if (method === "status") { statusRequests += 1; if (statusRequests === 2) { reached(); await statusGate; } return { session: { session_id: "s" }, state: "idle" }; }
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() { releases += 1; } }; },
    };
    const owner = createAttachmentOwner();
    const operation = attachPage(client as never, "home", null, owner, createChatCreationOwner(new MemoryStorage()), owner.begin("home", true));
    try {
      await waitBounded(reachedFinalStatus, () => { owner.begin("other", true); release(); }, () => operation);
      owner.begin("other", true); release();
      await expect(operation).rejects.toThrow();
      expect(releases).toBe(1);
    } finally { release(); owner.clear(); await operation.catch(() => {}); globalThis.fetch = originalFetch; }
  }, CONTROLLED_TIMEOUT_MS + 5_000);

  test("retry after attachment failure creates no second session", async () => {
    const originalFetch = globalThis.fetch;
    const storage = new MemoryStorage();
    let sessions = 0; let resumes = 0;
    globalThis.fetch = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page(null));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats" || url === "/api/pages/home/session") return new Response(null, { status: 200 });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ session_id: "created-on-zeta", page_id: "home", title: "" }], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = attachmentClient((method) => {
      if (method === "new_session") sessions += 1;
      if (method === "resume" && ++resumes === 1) throw new Error("forced attachment failure");
    });
    const owner = createAttachmentOwner();
    const creation = createChatCreationOwner(storage);
    const attempt = async () => {
      const api = creation as unknown as { ensure?: typeof creation.ensure; create?: (value: ChatCreationInput) => Promise<{ sessionId: string }> };
      if (api.ensure) return attachPage(client as never, "home", null, owner, creation, owner.begin("attempt", true), true);
      const created = await api.create!(input(client, true));
      return attachPage(client as never, "home", created.sessionId, owner, creation, owner.begin("attempt", true));
    };
    try {
      await attempt().catch(() => {});
      await attempt();
      expect(sessions).toBe(1);
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });

  test("a later attachment failure replaces the completed creation error", async () => {
    const originalFetch = globalThis.fetch;
    const storage = new MemoryStorage();
    let mappingAttempts = 0;
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page(null));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return new Response(null, { status: 200 });
      if (url === "/api/pages/home/session" && init?.method === "PUT") return new Response(null, { status: ++mappingAttempts === 1 ? 503 : 200 });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const owner = createAttachmentOwner();
    const creation = createChatCreationOwner(storage);
    const client = attachmentClient((method) => { if (method === "resume") throw new Error("forced later attachment failure"); });
    try {
      await creation.ensure(input(client, true), async (sessionId) => ({ sessionId })).catch(() => {});
      expect(creation.status("home").error).toContain("could not save session mapping");

      await attachPage(client as never, "home", null, owner, creation, owner.begin("reconnect", true)).catch(() => {});
      expect(creation.status("home")).toMatchObject({ pending: { sessionId: "created-on-zeta", stage: "mapped" }, error: "forced later attachment failure" });
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });

  test("a selected missing chat is stable and never creates a replacement", async () => {
    const originalFetch = globalThis.fetch;
    let sessions = 0;
    globalThis.fetch = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page("default"));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [{ session_id: "missing", page_id: "home", title: "gone" }], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = attachmentClient((method, params) => {
      if (method === "new_session") sessions += 1;
      if (method === "resume" && (params as { session_id?: string }).session_id === "missing") throw { data: { code: "session_not_found" } };
    });
    const owner = createAttachmentOwner();
    try {
      await attachPage(client as never, "home", "missing", owner, createChatCreationOwner(new MemoryStorage()), owner.begin("missing", true)).catch(() => {});
      expect(sessions).toBe(0);
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });
});

describe("attachment while a turn runs", () => {
  const busyError = () => Object.assign(new Error("a turn is already running"), { code: -32004 });
  const pageFetch = (chats: object[]) => (async (resource: string | URL | Request) => {
    const url = String(resource);
    if (url === "/api/pages/home") return Response.json(page("waiting"));
    if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
    if (url.startsWith("/api/chats?")) return Response.json({ chats, next: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  test("a reload during a pending approval attaches the running chat without resume", async () => {
    const methods: string[] = []; let events: Array<{ type: string; request_id?: string }> = [];
    const running = { session: { session_id: "waiting" }, state: "running", pending_approvals: [{ request_id: "c1", tool_call: { id: "t1", name: "bash", arguments: {} }, delegated: false }] };
    const client = {
      ...attachmentClient(),
      request: async (method: string) => {
        methods.push(method);
        if (method === "resume") throw busyError();
        if (method === "status") return running;
        if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
        if (method === "session_history") return { messages: [], next_offset: null };
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<typeof events>) => { events = await refresh(); return { store: { getState: () => ({ outline: [] }), resync(next: typeof events) { events = next; } }, release() {} }; },
    };
    const owner = createAttachmentOwner();
    try {
      const result = await withFetch(pageFetch([{ session_id: "waiting", page_id: "home", title: "waiting chat" }]), () => attachPage(client as never, "home", "waiting", owner, createChatCreationOwner(new MemoryStorage()), owner.begin("reload", true)))
        .catch((caught: Error) => ({ phase: "error", error: caught.message }));
      expect(result).toMatchObject({ phase: "ready", sessionId: "waiting", rebind: true });
      expect(events.filter((event) => event.type === "approval_request").map((event) => event.request_id)).toEqual(["c1"]);
      expect(methods).not.toContain("resume");
    } finally { owner.clear(); }
  });

  test("an opened chat with a turn but no first-message record repairs it from its history", async () => {
    const user = { type: "user", event: { type: "user_message", text: "  plan the trip  ", mode: "normal" } };
    const client = { ...attachmentClient(), replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [{ id: "u1" }] }), getItem: () => user, resync() {} }, release() {} }; } };
    const patches: unknown[] = [];
    const fetcher = (async (resource: string | URL | Request, init?: RequestInit) => {
      if (String(resource) === "/api/chats/lost" && init?.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return Response.json({}); }
      return pageFetch([{ session_id: "lost", page_id: "home", title: null, message_sent: false }])(resource, init);
    }) as typeof fetch;
    const owner = createAttachmentOwner();
    try {
      const result = await withFetch(fetcher, () => attachPage(client as never, "home", "lost", owner, createChatCreationOwner(new MemoryStorage()), owner.begin("lost", true)));
      expect(result).toMatchObject({ phase: "ready", title: "plan the trip" });
      expect(patches).toEqual([{ first_message: "plan the trip" }]);
    } finally { owner.clear(); }
  });

  test("a new chat while another turn runs names the running chat", async () => {
    const client = attachmentClient((method) => { if (method === "new_session") throw busyError(); });
    client.request = (async (method: string) => {
      if (method === "new_session") throw busyError();
      if (method === "status") return { session: { session_id: "waiting" }, state: "running" };
      throw new Error(`unexpected ${method}`);
    }) as typeof client.request;
    const owner = createAttachmentOwner();
    const creation = createChatCreationOwner(new MemoryStorage());
    try {
      const result = await withFetch(pageFetch([]), () => attachPage(client as never, "home", null, owner, creation, owner.begin("new", true), true, undefined, undefined, true))
        .catch((caught: Error) => ({ phase: "error", error: caught.message }));
      expect(result).toMatchObject({ phase: "busy", busySessionId: "waiting" });
      expect(creation.status("home").pending).toBeFalsy();
    } finally { owner.clear(); }
  });
});

describe("chat creation lifecycle", () => {
  test.each([
    { name: "success" },
    { name: "cancel while creating", cancel: "new_session" },
    { name: "cancel while registering", cancel: "register" },
    { name: "cancel while reading mode", cancel: "session_settings" },
    { name: "cancel while reading status", cancel: "status" },
    { name: "cancel while applying approval", cancel: "set_settings" },
    { name: "cancel while mapping", cancel: "map" },
    { name: "cancel while attaching", cancel: "attach" },
    { name: "cancel while applying create mode", cancel: "mode", pendingMode: true },
    { name: "cancel while handing ready state to the ui", cancel: "publish" },
    { name: "create fails", fail: "new_session" },
    { name: "attach fails", fail: "attach" },
    { name: "create mode apply fails", fail: "mode", pendingMode: true },
    { name: "ready hand-off fails", fail: "publish" },
    { name: "created-state write fails", failWrite: 1 },
    { name: "registered-state write fails", failWrite: 2 },
    { name: "approval-state write fails", failWrite: 3 },
    { name: "mapped-state write fails", failWrite: 4 },
    { name: "attached-state write fails", failWrite: 5 },
    { name: "pending-record clear fails", failWrite: 6 },
    { name: "pending-mode write fails", pendingMode: true, pendingModeWriteFailure: true },
    { name: "pending-mode clear fails", failWrite: 8, pendingMode: true },
    { name: "mode-applied record clear fails", failWrite: 9, pendingMode: true },
    { name: "reload after attach failure", fail: "attach", restart: true },
    { name: "duplicate input joins one operation", duplicate: true },
    { name: "double Enter creates and delivers once", doubleEnter: true },
    { name: "pending create mode is applied before ready", pendingMode: true },
    { name: "pending create mode is visible after reopen", pendingMode: true, reopen: true },
    { name: "pending create mode can be turned off after reopen", pendingMode: true, reopen: true, turnOff: true },
  ])("$name", async ({ cancel, fail, failWrite, restart, duplicate, doubleEnter, pendingMode, pendingModeWriteFailure, reopen, turnOff }) => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let mappings = 0; let attaches = 0; let modes = 0; let publishes = 0; let deliveries = 0; let approval = "ask";
    const appliedModes: boolean[] = [];
    let failed = false;
    const reached = deferred<void>();
    const gate = deferred<void>();
    const step = async (name: string) => {
      if (cancel === name) { reached.resolve(); await gate.promise; }
      if (fail === name && !failed) { failed = true; throw new Error(`forced ${name} failure`); }
    };
    const client = {
      features: ["session_mcp_bindings"],
      request: async (method: string) => {
        await step(method);
        if (method === "new_session") { sessions += 1; return { session: { session_id: "owned-session" } }; }
        if (method === "resume") { await step("attach"); attaches += 1; return { session: { name: "" } }; }
        if (method === "session_settings") return { model: "offline", approval_mode: approval };
        if (method === "session_history") return { messages: [], next_offset: null };
        if (method === "status") return { session: { session_id: "owned-session" }, state: "idle" };
        if (method === "set_settings") { approval = "allow"; return { model: "offline", approval_mode: approval }; }
        if (method === "send") { deliveries += 1; return {}; }
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { getState: () => ({ outline: [] }), resync() {} }, release() {} }; },
      replayRevision: () => 1,
      finishReplay: () => true,
    };
    const fetcher = (async (resource: string | URL | Request) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page(null));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      const name = url.endsWith("/chats") ? "register" : "map";
      await step(name);
      if (name === "register") registrations += 1; else mappings += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    if (pendingMode) {
      const modeOwner = createChatCreationOwner(storage, fetcher);
      if (pendingModeWriteFailure) {
        storage.failWrite = 1;
        expect(() => modeOwner.setCreateMode("home", true)).toThrow("forced durable write 1");
        storage.failWrite = 0;
      }
      modeOwner.setCreateMode("home", true);
    }
    storage.failWrite = failWrite ?? 0;
    let owner = createChatCreationOwner(storage, fetcher);
    const attachmentOwner = createAttachmentOwner();
    const applyMode = async <T,>(attached: T, enabled: boolean) => {
      await step("mode"); modes += 1; appliedModes.push(enabled); return attached;
    };
    const publish = async () => { await step("publish"); publishes += 1; };
    const run = () => reopen
      ? withFetch(fetcher, async () => {
        try { return await attachPage(client as never, "home", null, attachmentOwner, owner, attachmentOwner.begin("home", true), true, applyMode, publish); }
        finally { attachmentOwner.clear(); }
      })
      : owner.ensure(
        input(client, true),
        async (sessionId) => { await step("attach"); attaches += 1; return { sessionId }; },
        applyMode,
        publish,
      )!;
    if (reopen) {
      const reopened = await withFetch(fetcher, () => attachPage(client as never, "home", null, attachmentOwner, owner, attachmentOwner.begin("home", true)));
      attachmentOwner.clear();
      expect(reopened.page.create_mode).toBe(true);
      if (turnOff) owner.setCreateMode("home", false);
    }
    if (doubleEnter) {
      const delivery = createComposerDelivery({
        state: "idle",
        defaultValue: "first draft",
        onDraftChange() {},
        onDeliveryConfirm() {},
        onSubmit: async (text, intent, track) => {
          const attached = await run();
          await deliverChatMessage(client, attached.sessionId, text, "one-delivery-id", pageDeliverySteer("empty", intent), track);
        },
      });
      await Promise.all([delivery.submit(), delivery.submit()]);
    }
    const first = doubleEnter ? Promise.resolve({ sessionId: "owned-session" }) : run();
    if (cancel) {
      try {
        await waitBounded(reached.promise, () => gate.resolve(), () => first);
        const joined = run();
        expect(joined).toBe(first);
        gate.resolve();
        await Promise.all([first, joined]);
      } finally { gate.resolve(); await first.catch(() => {}); }
    } else if (fail || failWrite) {
      await expect(first).rejects.toThrow("forced");
      storage.failWrite = 0;
      if (restart) owner = createChatCreationOwner(storage, fetcher);
      await run();
    } else if (duplicate) {
      const joined = run();
      expect(joined).toBe(first);
      await Promise.all([first, joined]);
    } else await first;

    expect(sessions).toBe(fail === "new_session" ? 1 : 1);
    expect(registrations).toBe(1);
    expect(mappings).toBe(1);
    expect(attaches).toBe(fail === "mode" || fail === "publish" || (failWrite !== undefined && failWrite >= 5) ? 2 : 1);
    expect(publishes).toBe(1);
    expect(modes).toBe(pendingMode ? (failWrite === 8 ? 2 : 1) : 0);
    expect(appliedModes.at(-1)).toBe(pendingMode ? !turnOff : undefined);
    expect(deliveries).toBe(doubleEnter ? 1 : 0);
    expect(owner.status("home")).toMatchObject({ pending: null, error: null, createMode: undefined });
  }, CONTROLLED_TIMEOUT_MS + 5_000);
});
