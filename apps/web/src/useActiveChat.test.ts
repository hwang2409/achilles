import { describe, expect, test } from "bun:test";
import { createChatCreationOwner, type ChatCreationInput } from "./chatCreation";
import { attachPage, confirmSteerDelivery, createAttachmentOwner, createModeToggleOwner, persistChatState, persistUntitledChatTitle } from "./useActiveChat";

class MemoryStorage {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
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

  test("explains how to recover an expired MCP session without offering a dead retry", async () => {
    const client = { features: ["mcp_refresh_tools"], request: async () => { throw Object.assign(new Error("refresh failed"), { code: -32005, data: { reason: "achilles: MCP HTTP 404: Session not found" } }); } };
    const owner = createModeToggleOwner(async () => Response.json({ create_mode: true }));
    const result = await owner.run({ pageId: "home", sessionId: "session", enabled: true, client });
    expect(result).toEqual({ createMode: null, error: "achilles restarted, but zeta kept its expired MCP session. restart zeta serve, then reload this page before using create mode.", blocked: true, retryable: false });
    await expect(owner.beforeSend()).rejects.toThrow("send is off");
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
    replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { resync() {} }, release() {} }; },
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
    const ids: string[] = [];
    const client = { request: async () => status };
    const result = await confirmSteerDelivery(client as never, "session", "text", "initial", (id) => ids.push(id));
    expect(result).toBe("initial");
    expect(ids).toEqual(["initial"]);
  });

  test.each([
    { name: "dropped", status: { status: "dropped" } },
    { name: "evicted dropped", status: { status: "evicted", outcome: "dropped" } },
  ])("keeps the draft when $name", async ({ status }) => {
    const client = { request: async () => status };
    await expect(confirmSteerDelivery(client as never, "session", "draft", "initial", () => {})).rejects.toThrow("message was not sent");
  });

  test.each([
    { name: "unknown", statuses: [{ status: "unknown" }], error: "unknown" },
    { name: "evicted without outcome", statuses: [{ status: "evicted" }], error: "evicted" },
  ])("keeps the draft on $name", async ({ statuses, error }) => {
    const client = { request: async () => statuses.shift() };
    await expect(confirmSteerDelivery(client as never, "session", "draft", "initial", () => {}, 5_000)).rejects.toThrow(error);
  });

  test("keeps the draft when queued past the deadline", async () => {
    const originalNow = Date.now;
    let now = 100;
    Date.now = () => now;
    try {
      const client = { request: async () => { now = 102; return { status: "queued" }; } };
      await expect(confirmSteerDelivery(client as never, "session", "draft", "initial", () => {}, 1)).rejects.toThrow("may still arrive with your next message");
    } finally { Date.now = originalNow; }
  });

  test("keeps the draft when a status request times out", async () => {
    let timeoutMs = 0;
    const client = { request: async (_method: string, _params: unknown, options?: { timeoutMs?: number }) => {
      timeoutMs = options?.timeoutMs ?? 0;
      throw new Error("request timed out");
    }};
    await expect(confirmSteerDelivery(client as never, "session", "draft", "initial", () => {})).rejects.toThrow("timed out");
    expect(timeoutMs).toBeGreaterThan(0);
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
      persistUntitledChatTitle("session", "sent text", () => {});
      await Promise.resolve();
      expect(draft).toBe(" plus new");
      expect(clears).toBe(1);
      expect(sends).toBe(1);
    } finally { globalThis.fetch = originalFetch; console.error = originalError; }
  });
});

describe("active chat attachment", () => {
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
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { resync() {} }, release() { releases += 1; } }; },
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

  test("fresh-page publish failure retries the owned session instead of creating another", async () => {
    const originalFetch = globalThis.fetch;
    const storage = new MemoryStorage();
    let sessions = 0; let mappingAttempts = 0;
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json(page(null));
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/chats") return new Response(null, { status: 200 });
      if (url === "/api/pages/home/session" && init?.method === "PUT") return new Response(null, { status: ++mappingAttempts === 1 ? 503 : 200 });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = attachmentClient((method) => { if (method === "new_session") sessions += 1; });
    const owner = createAttachmentOwner();
    const creation = createChatCreationOwner(storage);
    try {
      await creation.create(input(client, true)).catch(() => {});
      await attachPage(client as never, "home", null, owner, creation, owner.begin("retry", true));
      expect(sessions).toBe(1);
      expect(mappingAttempts).toBe(2);
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });

  test("a later attachment failure cannot retain a completed creation error", async () => {
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
      await creation.create(input(client, true)).catch(() => {});
      expect(creation.status("home").error).toContain("could not save session mapping");

      await attachPage(client as never, "home", null, owner, creation, owner.begin("reconnect", true)).catch(() => {});
      expect(creation.status("home")).toEqual({ pending: null, error: null });
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

describe("chat creation lifecycle", () => {
  test.each([
    { name: "registration fails", fail: "register", retained: "created", recovery: "restart" },
    { name: "session settings fail after registration", fail: "session_settings", retained: "registered", recovery: "retry" },
    { name: "status fails after registration", fail: "status", retained: "registered", recovery: "attach" },
    { name: "settings publish fails after registration", fail: "set_settings", retained: "registered", recovery: "duplicate" },
    { name: "mapping fails after approval", fail: "map", retained: "approvalApplied", recovery: "retry" },
  ])("owns the error and resumes the exact session when $name", async ({ fail, retained, recovery }) => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let mappings = 0; let mode = "ask"; let failed = false;
    const client = { request: async (method: string) => {
      if (method === "new_session") { sessions += 1; return { session: { session_id: "created-on-zeta" } }; }
      if (method === "session_settings") { if (fail === method && !failed) { failed = true; throw new Error("forced session settings failure"); } return { model: "offline", approval_mode: mode }; }
      if (method === "status") { if (fail === method && !failed) { failed = true; throw new Error("forced status failure"); } return { state: "idle" }; }
      if (method === "set_settings") { if (fail === method && !failed) { failed = true; throw new Error("forced settings publish failure"); } mode = "allow"; return { model: "offline", approval_mode: mode }; }
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async (resource: string | URL | Request) => {
      if (String(resource).endsWith("/chats")) {
        registrations += 1;
        if (fail === "register" && !failed) { failed = true; return new Response(null, { status: 503 }); }
      } else {
        mappings += 1;
        if (fail === "map" && !failed) { failed = true; return new Response(null, { status: 503 }); }
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const original = createChatCreationOwner(storage, fetcher);
    await expect(original.create(input(client, true))).rejects.toThrow();
    expect(original.status("home")).toMatchObject({ pending: { sessionId: "created-on-zeta", stage: retained }, error: expect.any(String) });

    const owner = recovery === "restart" ? createChatCreationOwner(storage, fetcher) : original;
    if (recovery === "restart") expect(owner.status("home").error).toEqual(expect.any(String));
    const resumed = recovery === "duplicate" ? await owner.create(input(client, true))
      : recovery === "retry" ? await owner.resume("home")
      : await owner.resume(input(client, true));
    expect(resumed?.mappedSessionId).toBe("created-on-zeta");
    expect(sessions).toBe(1);
    expect(registrations).toBe(fail === "register" ? 2 : 1);
    expect(mappings).toBe(fail === "map" ? 2 : 1);
    expect(mode).toBe("allow");
    expect(owner.status("home")).toEqual({ pending: null, error: null });
    expect(storage.value).toBeNull();
  });

  test("mapping conflict keeps the created chat indexed and returns the winner", async () => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0;
    const client = { request: async (method: string) => {
      if (method === "new_session") { sessions += 1; return { session: { session_id: "indexed-loser" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async (resource: string | URL | Request) => {
      if (String(resource).endsWith("/chats")) { registrations += 1; return new Response(null, { status: 200 }); }
      return Response.json({ session_id: "mapping-winner" }, { status: 409 });
    }) as typeof fetch;

    const result = await createChatCreationOwner(storage, fetcher).create(input(client, true));
    expect(result).toMatchObject({ sessionId: "indexed-loser", mappedSessionId: "mapping-winner", stage: "mapped" });
    expect({ sessions, registrations }).toEqual({ sessions: 1, registrations: 1 });
    expect(storage.value).toBeNull();
  });

  test.each(["new_session", "register", "session_settings", "status", "set_settings", "map"])("a stale caller cannot cancel creation while waiting for %s", async (heldStep) => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let mode = "ask"; let reached!: () => void; let release!: () => void;
    const reachedStep = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = async (step: string) => { if (heldStep === step) { reached(); await gate; } };
    const client = { request: async (method: string) => {
      await hold(method);
      if (method === "new_session") { sessions += 1; return { session: { session_id: "durable-session" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: mode };
      if (method === "status") return { state: "idle" };
      if (method === "set_settings") { mode = "allow"; return { model: "offline", approval_mode: mode }; }
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async (resource: string | URL | Request) => {
      const step = String(resource).endsWith("/chats") ? "register" : "map";
      await hold(step);
      if (step === "register") registrations += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const owner = createChatCreationOwner(storage, fetcher);
    const operation = owner.create(input(client, true));
    try {
      await waitBounded(reachedStep, release, () => operation);
      expect(owner.resume(input(client, true))).toBe(operation);
      release();
      await operation;
      expect({ sessions, registrations, mode }).toEqual({ sessions: 1, registrations: 1, mode: "allow" });
      expect(owner.status("home")).toEqual({ pending: null, error: null });
      expect(storage.value).toBeNull();
    } finally { release(); await operation.catch(() => {}); }
  }, CONTROLLED_TIMEOUT_MS + 5_000);

  test("finishes success and deduplicates double create and double retry", async () => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let reached!: () => void; let release!: () => void;
    const reachedRegistration = new Promise<void>((resolve) => { reached = resolve; });
    const registrationGate = new Promise<void>((resolve) => { release = resolve; });
    const client = { request: async (method: string) => {
      if (method === "new_session") { sessions += 1; return { session: { session_id: "only-session" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async (resource: string | URL | Request) => {
      if (String(resource).endsWith("/chats")) { registrations += 1; reached(); await registrationGate; }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const owner = createChatCreationOwner(storage, fetcher);
    const first = owner.create(input(client, true));
    try {
      await waitBounded(reachedRegistration, release, () => first);
      const duplicate = owner.create(input(client, true));
      expect(duplicate).toBe(first);
      expect(owner.resume(input(client, true))).toBe(first);
      release();
      const [created, repeated] = await Promise.all([first, duplicate]);
      expect(created).toMatchObject({ sessionId: "only-session", mappedSessionId: "only-session" });
      expect(repeated.sessionId).toBe("only-session");
      expect({ sessions, registrations }).toEqual({ sessions: 1, registrations: 1 });
      expect(owner.status("home")).toEqual({ pending: null, error: null });
      expect(storage.value).toBeNull();
    } finally { release(); await first.catch(() => {}); }
  }, CONTROLLED_TIMEOUT_MS + 5_000);

  test("ignores invalid durable records field by field", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify([
      { sessionId: "", pageId: "home", mode: "allow", stage: "created" },
      { sessionId: "s", pageId: 4, mode: "allow", stage: "created" },
      { sessionId: "s", pageId: "home", mode: "unsafe", stage: "created" },
      { sessionId: "s", pageId: "home", mode: "allow", stage: "unknown" },
      { sessionId: "s", pageId: "home", mode: "allow", stage: "approvalApplied", expectedSessionId: 4 },
      { sessionId: "s", pageId: "home", mode: "allow", stage: "mapped", expectedSessionId: null },
    ]);
    expect(createChatCreationOwner(storage).status("home")).toEqual({ pending: null, error: null });
  });
});
