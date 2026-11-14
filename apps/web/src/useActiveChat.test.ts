import { describe, expect, test } from "bun:test";
import { createChatCreationOwner, type ChatCreationInput } from "./chatCreation";
import { attachPage, createAttachmentOwner } from "./useActiveChat";

class MemoryStorage {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
}

const input = (client: object, map = false): ChatCreationInput => ({ client: client as never, pageId: "home", credential: "synthetic", cwd: "/tmp", mode: "allow", ...(map ? { mapExpectedSessionId: null } : {}) });
const record = (storage: MemoryStorage) => storage.value && JSON.parse(storage.value)[0] as { sessionId: string; stage: string };

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
    { name: "registration fails", fail: "register", retained: "created" },
    { name: "session settings fail after registration", fail: "session_settings", retained: "registered" },
    { name: "status fails after registration", fail: "status", retained: "registered" },
    { name: "settings publish fails after registration", fail: "set_settings", retained: "registered" },
    { name: "mapping fails after approval", fail: "map", retained: "approvalApplied" },
  ])("retains and resumes the exact session when $name", async ({ fail, retained }) => {
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

    await expect(createChatCreationOwner(storage, fetcher).create(input(client, true))).rejects.toThrow();
    expect(record(storage)).toEqual({ sessionId: "created-on-zeta", pageId: "home", mode: "allow", stage: retained, expectedSessionId: null });

    const restarted = createChatCreationOwner(storage, fetcher);
    const resumed = await restarted.resume(input(client, true));
    expect(resumed?.mappedSessionId).toBe("created-on-zeta");
    expect(sessions).toBe(1);
    expect(registrations).toBe(fail === "register" ? 2 : 1);
    expect(mappings).toBe(fail === "map" ? 2 : 1);
    expect(mode).toBe("allow");
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
    expect(createChatCreationOwner(storage).pending("home")).toBeNull();
  });
});
