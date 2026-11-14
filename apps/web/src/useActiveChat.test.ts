import { describe, expect, test } from "bun:test";
import { createChatCreationOwner, type ChatCreationInput } from "./chatCreation";
import { attachPage, createAttachmentOwner } from "./useActiveChat";

class MemoryStorage {
  value: string | null = null;
  getItem() { return this.value; }
  setItem(_key: string, value: string) { this.value = value; }
  removeItem() { this.value = null; }
}

const input = (client: object): ChatCreationInput => ({ client: client as never, pageId: "home", credential: "synthetic", cwd: "/tmp", mode: "allow" });
const record = (storage: MemoryStorage) => storage.value && JSON.parse(storage.value)[0] as { sessionId: string; stage: string };

describe("active chat attachment", () => {
  test.each(["stale after load", "mapping failure after acquire"])("releases its acquired lease exactly once on %s", async (scenario) => {
    const originalFetch = globalThis.fetch;
    let releases = 0; let statusRequests = 0; let releaseStatus!: () => void; let finalStatusReached!: () => void;
    const finalStatus = new Promise<void>((resolve) => { finalStatusReached = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource);
      if (url === "/api/pages/home") return Response.json({ id: "home", route: "/", title: "home", zeta_session_id: "s", workspace: "/tmp", create_mode: false, approval_mode: "allow", layout: { blocks: [] } });
      if (url === "/api/pages/home/credential") return Response.json({ credential: "synthetic" });
      if (url === "/api/pages/home/session" && init?.method === "PUT") return new Response(null, { status: scenario === "mapping failure after acquire" ? 503 : 200 });
      if (url.startsWith("/api/chats?")) return Response.json({ chats: [], next: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const client = {
      features: ["session_mcp_bindings"],
      request: async (method: string) => {
        if (method === "resume") return { session: { name: "" } };
        if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
        if (method === "session_history") return { messages: [], next_offset: null };
        if (method === "status") {
          statusRequests += 1;
          if (scenario === "stale after load" && statusRequests === 2) { finalStatusReached(); await statusGate; }
          return { session: { session_id: "s" }, state: "idle" };
        }
        throw new Error(`unexpected ${method}`);
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => { await refresh(); return { store: { resync() {} }, release() { releases += 1; } }; },
      replayRevision: () => 1,
      finishReplay: () => true,
    };
    const owner = createAttachmentOwner();
    const token = owner.begin("home");
    const creation = createChatCreationOwner(new MemoryStorage());
    try {
      const attachment = attachPage(client as never, "home", null, owner, creation, token);
      if (scenario === "stale after load") { await finalStatus; owner.begin("other"); releaseStatus(); }
      await expect(attachment).rejects.toThrow();
      expect(releases).toBe(1);
    } finally { owner.clear(); globalThis.fetch = originalFetch; }
  });
});

describe("chat creation lifecycle", () => {
  test.each([
    { name: "registration fails", fail: "register", retained: "created" },
    { name: "session settings fail after registration", fail: "session_settings", retained: "registered" },
    { name: "status fails after registration", fail: "status", retained: "registered" },
    { name: "settings publish fails after registration", fail: "set_settings", retained: "registered" },
  ])("retains and resumes the exact session when $name", async ({ fail, retained }) => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let mode = "ask"; let failed = false;
    const client = { request: async (method: string) => {
      if (method === "new_session") { sessions += 1; return { session: { session_id: "created-on-zeta" } }; }
      if (method === "session_settings") { if (fail === method && !failed) { failed = true; throw new Error("forced session settings failure"); } return { model: "offline", approval_mode: mode }; }
      if (method === "status") { if (fail === method && !failed) { failed = true; throw new Error("forced status failure"); } return { state: "idle" }; }
      if (method === "set_settings") { if (fail === method && !failed) { failed = true; throw new Error("forced settings publish failure"); } mode = "allow"; return { model: "offline", approval_mode: mode }; }
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async () => {
      registrations += 1;
      if (fail === "register" && !failed) { failed = true; return new Response(null, { status: 503 }); }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await expect(createChatCreationOwner(storage, fetcher).create(input(client))).rejects.toThrow();
    expect(record(storage)).toEqual({ sessionId: "created-on-zeta", pageId: "home", mode: "allow", stage: retained });

    const restarted = createChatCreationOwner(storage, fetcher);
    await restarted.resume(input(client));
    expect(sessions).toBe(1);
    expect(registrations).toBe(fail === "register" ? 2 : 1);
    expect(mode).toBe("allow");
    expect(storage.value).toBeNull();
  });

  test.each(["new_session", "register", "session_settings", "status", "set_settings"])("a stale caller cannot cancel creation while waiting for %s", async (heldStep) => {
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
    const fetcher = (async () => { await hold("register"); registrations += 1; return new Response(null, { status: 200 }); }) as typeof fetch;
    const owner = createChatCreationOwner(storage, fetcher);

    const operation = owner.create(input(client));
    await reachedStep;
    const staleRetry = owner.resume(input(client));
    expect(staleRetry).toBe(operation);
    release();
    await operation;
    expect(sessions).toBe(1);
    expect(registrations).toBe(1);
    expect(mode).toBe("allow");
    expect(storage.value).toBeNull();
  });

  test("finishes success and deduplicates double create and double retry", async () => {
    const storage = new MemoryStorage();
    let sessions = 0; let registrations = 0; let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const client = { request: async (method: string) => {
      if (method === "new_session") { sessions += 1; return { session: { session_id: "only-session" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };
    const fetcher = (async () => { registrations += 1; await registrationGate; return new Response(null, { status: 200 }); }) as typeof fetch;
    const owner = createChatCreationOwner(storage, fetcher);

    const first = owner.create(input(client));
    const duplicate = owner.create(input(client));
    await Promise.resolve(); await Promise.resolve();
    expect(sessions).toBe(1);
    expect(record(storage)?.stage).toBe("created");
    expect(owner.resume(input(client))).toBe(first);
    releaseRegistration();
    const [created, repeated] = await Promise.all([first, duplicate]);
    expect(created.sessionId).toBe("only-session");
    expect(repeated.sessionId).toBe("only-session");
    expect(registrations).toBe(1);
    expect(storage.value).toBeNull();
  });

  test("ignores invalid durable records field by field", () => {
    const storage = new MemoryStorage();
    storage.value = JSON.stringify([
      { sessionId: "", pageId: "home", mode: "allow", stage: "created" },
      { sessionId: "s", pageId: 4, mode: "allow", stage: "created" },
      { sessionId: "s", pageId: "home", mode: "unsafe", stage: "created" },
      { sessionId: "s", pageId: "home", mode: "allow", stage: "unknown" },
    ]);
    expect(createChatCreationOwner(storage).pending("home")).toBeNull();
  });
});
