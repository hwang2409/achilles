import { describe, expect, test } from "bun:test";
import type { SessionLease } from "@fulcrum/zeta";
import { createAttachmentOwner, createRegisteredSession } from "./useActiveChat";

const lease = (name: string) => ({ name }) as unknown as SessionLease;

describe("attachment ownership", () => {
  test.each([
    { name: "success", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.accept(token, lease("a")); owner.clear(); }, releases: 1 },
    { name: "switch during load", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const old = owner.begin("chat-a"); const next = owner.begin("chat-b"); owner.accept(old, lease("a")); owner.accept(next, lease("b")); owner.clear(); }, releases: 2 },
    { name: "reconnect during load", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const old = owner.begin("chat-a"); const next = owner.begin("chat-a", true); owner.accept(old, lease("old")); owner.accept(next, lease("new")); owner.clear(); }, releases: 2 },
    { name: "failure after session settings before acquire", run: (owner: ReturnType<typeof createAttachmentOwner>) => { owner.begin("chat-a"); owner.clear(); }, releases: 0 },
    { name: "stale after session settings before acquire", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.begin("chat-b"); owner.release(token); }, releases: 0 },
    { name: "failure after acquire during mapping or title", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.accept(token, lease("a")); owner.release(token); owner.clear(); }, releases: 1 },
    { name: "stale after acquire during mapping or title", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.accept(token, lease("a")); owner.begin("chat-b"); owner.release(token); }, releases: 1 },
    { name: "mapping conflict replaces acquire", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.accept(token, lease("old")); owner.accept(token, lease("actual")); owner.clear(); }, releases: 2 },
    { name: "duplicate select", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const first = owner.begin("chat-a"); owner.accept(first, lease("a")); expect(owner.begin("chat-a")).toBe(first); owner.clear(); }, releases: 1 },
  ])("releases the owned lease exactly once after $name", ({ run, releases }) => {
    const released: SessionLease[] = [];
    const owner = createAttachmentOwner((value) => released.push(value));
    run(owner);
    expect(released).toHaveLength(releases);
    expect(new Set(released).size).toBe(releases);
  });
});

describe("new chat registration", () => {
  test("registers a committed session even when its caller becomes stale", async () => {
    const originalFetch = globalThis.fetch;
    const registered: string[] = [];
    let current = true;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      registered.push(JSON.parse(String(init?.body)).session_id);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = { request: async (method: string) => {
      if (method === "new_session") { current = false; return { session: { session_id: "created-on-zeta" } }; }
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };
    try {
      const retained: Array<string | null> = [];
      const result = await createRegisteredSession(client as never, {
        credential: "synthetic",
        page: { id: "home", route: "/", workspace: "/tmp" } as never,
        serverApprovalMode: "allow",
      }, (orphan) => retained.push(orphan?.sessionId ?? null));
      expect(current).toBeFalse();
      expect(result.created.id).toBe("created-on-zeta");
      expect(registered).toEqual(["created-on-zeta"]);
      expect(retained).toEqual(["created-on-zeta", null]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("finishes registration when the caller becomes stale during register", async () => {
    const originalFetch = globalThis.fetch;
    let current = true;
    globalThis.fetch = (async () => { current = false; return new Response(null, { status: 200 }); }) as typeof fetch;
    const client = { request: async (method: string) => {
      if (method === "new_session") return { session: { session_id: "stale-during-register" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };
    try {
      const retained: Array<string | null> = [];
      const result = await createRegisteredSession(client as never, {
        credential: "synthetic",
        page: { id: "home", route: "/", workspace: "/tmp" } as never,
        serverApprovalMode: "allow",
      }, (orphan) => retained.push(orphan?.sessionId ?? null));
      expect(current).toBeFalse();
      expect(result.created.id).toBe("stale-during-register");
      expect(retained).toEqual(["stale-during-register", null]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("keeps the session registered when settings fail after creation", async () => {
    const originalFetch = globalThis.fetch;
    const registered: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      registered.push(JSON.parse(String(init?.body)).session_id);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = { request: async (method: string) => {
      if (method === "new_session") return { session: { session_id: "registered-before-settings" } };
      throw new Error("settings failed");
    } };
    try {
      const retained: Array<string | null> = [];
      await expect(createRegisteredSession(client as never, {
        credential: "synthetic",
        page: { id: "home", route: "/", workspace: "/tmp" } as never,
        serverApprovalMode: "allow",
      }, (orphan) => retained.push(orphan?.sessionId ?? null))).rejects.toThrow("settings failed");
      expect(registered).toEqual(["registered-before-settings"]);
      expect(retained).toEqual(["registered-before-settings", null]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("retains the exact session after both registration attempts fail", async () => {
    const originalFetch = globalThis.fetch;
    let registrations = 0;
    globalThis.fetch = (async () => { registrations += 1; return new Response(null, { status: 503 }); }) as typeof fetch;
    const client = { request: async (method: string) => {
      if (method === "new_session") return { session: { session_id: "kept-on-zeta" } };
      throw new Error(`unexpected ${method}`);
    } };
    try {
      const retained: Array<string | null> = [];
      await expect(createRegisteredSession(client as never, {
        credential: "synthetic",
        page: { id: "home", route: "/", workspace: "/tmp" } as never,
        serverApprovalMode: "allow",
      }, (orphan) => retained.push(orphan?.sessionId ?? null))).rejects.toThrow("could not save chat (503)");
      expect(registrations).toBe(2);
      expect(retained).toEqual(["kept-on-zeta"]);
    } finally { globalThis.fetch = originalFetch; }
  });
});
