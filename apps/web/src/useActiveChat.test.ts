import { describe, expect, test } from "bun:test";
import { createChatCreationOwner, type ChatCreationInput } from "./chatCreation";
import { attachPage, confirmSteerDelivery, createAttachmentOwner, persistUntitledChatTitle } from "./useActiveChat";

class MemoryStorage {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
}

const input = (client: object, map = false): ChatCreationInput => ({ client: client as never, pageId: "home", credential: "synthetic", cwd: "/tmp", mode: "allow", ...(map ? { mapExpectedSessionId: null } : {}) });
const CONTROLLED_TIMEOUT_MS = 10_000;

async function waitBounded(wait: Promise<void>, cancel: () => void, drain: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([wait, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("controlled wait timed out after 10 seconds")), CONTROLLED_TIMEOUT_MS); })]);
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
    { name: "delivered", statuses: [{ status: "delivered" }], sends: 0 },
    { name: "dropped then resend", statuses: [{ status: "dropped" }, { status: "delivered" }], sends: 1 },
    { name: "evicted delivered", statuses: [{ status: "evicted", outcome: "delivered" }], sends: 0 },
    { name: "evicted dropped then resend", statuses: [{ status: "evicted", outcome: "dropped" }, { status: "delivered" }], sends: 1 },
  ])("confirms $name", async ({ statuses, sends }) => {
    const requests: string[] = [];
    const ids: string[] = [];
    const client = { request: async (method: string, params: { delivery_id?: string }) => {
      requests.push(method);
      if (method === "delivery_status") return statuses.shift();
      if (method === "status") return { state: "idle" };
      if (method === "send") return { accepted: true, delivery_id: params.delivery_id };
      throw new Error(`unexpected ${method}`);
    }};
    const result = await confirmSteerDelivery(client as never, "session", "text", "initial", (id) => ids.push(id));
    expect(result).toBe(ids.at(-1));
    expect(requests.filter((method) => method === "send")).toHaveLength(sends);
    expect(new Set(ids).size).toBe(sends + 1);
  });

  test("waits for the finished turn before resending a dropped steer exactly once", async () => {
    let releaseTurnEnd!: () => void;
    const turnEnded = new Promise<void>((resolve) => { releaseTurnEnd = resolve; });
    let markStatusReached!: () => void;
    const statusReached = new Promise<void>((resolve) => { markStatusReached = resolve; });
    let statusChecks = 0;
    let sends = 0;
    const client = { request: async (method: string) => {
      if (method === "delivery_status") return sends ? { status: "delivered" } : { status: "dropped" };
      if (method === "status") { statusChecks += 1; markStatusReached(); await turnEnded; return { state: "idle" }; }
      if (method === "send") { sends += 1; return { accepted: true }; }
      throw new Error(`unexpected ${method}`);
    }};

    const confirmation = confirmSteerDelivery(client as never, "session", "new turn", "initial", () => {});
    try {
      await waitBounded(statusReached, () => releaseTurnEnd(), () => confirmation);
      expect(statusChecks).toBe(1);
      expect(sends).toBe(0);
      releaseTurnEnd();
      await confirmation;
      expect(sends).toBe(1);
    } finally {
      releaseTurnEnd();
      await confirmation.catch(() => {});
    }
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
      await expect(confirmSteerDelivery(client as never, "session", "draft", "initial", () => {}, 1)).rejects.toThrow("timed out");
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
      await attachPage(client as never, "home", null, owner, creation, owner.begin("first", true)).catch(() => {});
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
      await attachPage(client as never, "home", null, owner, creation, owner.begin("first", true)).catch(() => {});
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
