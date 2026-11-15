import { describe, expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError, watchTurnEnd } from "./session";

describe("applyApprovalMode", () => {
  test("defers a mode change while the session is running", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string) => {
      methods.push(method);
      if (method === "session_settings") return { model: "offline", approval_mode: "ask" };
      if (method === "status") return { state: "running" };
      throw new Error(`unexpected ${method}`);
    } };

    expect(await applyApprovalMode(client as never, "s", "allow")).toEqual({ approvalMode: "ask", pending: true });
    expect(methods).toEqual(["session_settings", "status"]);
  });

  test("does not inspect or write a mode that already matches", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string) => {
      methods.push(method);
      return { model: "offline", approval_mode: "allow" };
    } };

    expect(await applyApprovalMode(client as never, "s", "allow")).toEqual({ approvalMode: "allow", pending: false });
    expect(methods).toEqual(["session_settings"]);
  });
});

describe("openHomeSession", () => {
  test("chooses the creation mode from the server and default", () => {
    expect(creationApprovalMode("allow")).toBe("allow");
    expect(creationApprovalMode("allow", false)).toBe("ask");
    expect(creationApprovalMode("ask")).toBe("ask");
  });

  test("reports a missing resumed chat without creating a replacement", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string) => {
      methods.push(method);
      if (method === "status") return { state: "idle" };
      throw { data: { code: "session_not_found" } };
    } };

    await expect(openHomeSession(client as never, "missing", "credential", "/tmp", "allow")).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(methods).toEqual(["status", "resume"]);
  });

  test("preserves a resumed chat mode when the server does not force ask", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string) => {
      methods.push(method);
      if (method === "status") return { state: "idle" };
      if (method === "resume") return { session: { name: "existing" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "ask" };
      throw new Error(`unexpected ${method}`);
    } };

    const result = await openHomeSession(client as never, "existing", "credential", "/tmp", "allow");
    expect(result.approvalMode).toBe("ask");
    expect(methods).toEqual(["status", "resume", "session_settings"]);
  });

  test("resumes once more when the other turn ended between resume and status", async () => {
    const methods: string[] = []; let resumes = 0;
    const client = { request: async (method: string) => {
      methods.push(method);
      if (method === "status") return methods.length === 1 ? { session: { session_id: "other" }, state: "running" } : { state: "idle" };
      if (method === "resume" && ++resumes === 1) throw Object.assign(new Error("a turn is already running"), { code: -32004 });
      if (method === "resume") return { session: { name: "existing" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };

    const result = await openHomeSession(client as never, "existing", "credential", "/tmp", "allow").catch((caught: Error) => ({ error: caught.message }));
    expect(result).toMatchObject({ id: "existing", name: "existing", rebind: false });
    expect(methods).toEqual(["status", "resume", "status", "resume", "session_settings"]);
  });
});

describe("watchTurnEnd", () => {
  const watched = (status: { state: string; session?: { session_id: string } }) => {
    const store = createRunStore((callback) => queueMicrotask(callback)); let released = 0;
    const client = { forSession: () => ({ store, release: () => { released += 1; } }), request: async () => status };
    return { store, client, released: () => released };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("fires on agent_end of a turn the store joined mid-way, once", async () => {
    const { store, client, released } = watched({ session: { session_id: "other" }, state: "running" });
    let ended = 0;
    watchTurnEnd(client as never, "other", () => { ended += 1; });
    await settle();
    expect(ended).toBe(0);
    store.dispatch({ type: "turn_end" }); store.dispatch({ type: "run_end" }); store.dispatch({ type: "run_end" });
    await settle();
    expect(ended).toBe(1);
    expect(released()).toBe(1);
  });

  test("fires when the turn already ended before the watch, and leaves the store idle", async () => {
    const { store, client } = watched({ state: "idle" });
    let ended = 0;
    watchTurnEnd(client as never, "other", () => { ended += 1; });
    await settle();
    expect(ended).toBe(1);
    expect(store.getState().agent).toBe("idle");
  });

  test("cancel stops it", async () => {
    const { store, client, released } = watched({ session: { session_id: "other" }, state: "running" });
    let ended = 0;
    watchTurnEnd(client as never, "other", () => { ended += 1; })();
    store.dispatch({ type: "run_end" });
    await settle();
    expect(ended).toBe(0);
    expect(released()).toBe(1);
  });
});

describe("loadSession", () => {
  test("releases an acquired lease when replay finalization fails", async () => {
    let statusRequests = 0;
    let releases = 0;
    const client = {
      request: async (method: string) => {
        if (method === "session_history") return { messages: [], next_offset: null };
        statusRequests += 1;
        if (statusRequests > 1) throw new Error("status failed after acquire");
        return { session: { session_id: "s" }, state: "idle" };
      },
      replay: async (_id: string, refresh: () => Promise<unknown[]>) => {
        await refresh();
        return { store: { resync() {} }, release() { releases += 1; } };
      },
      replayRevision: () => 1,
      finishReplay: () => true,
    };
    await expect(loadSession(client as never, "s")).rejects.toThrow("status failed after acquire");
    expect(releases).toBe(1);
  });

  test("reconciles a tail event that arrives during refresh", async () => {
    let revision = 0;
    let historyRequests = 0;
    const snapshots: unknown[][] = [];
    const client = {
      request: async (method: string) => {
        if (method === "status") return { session: { session_id: "s" }, state: "idle" };
        historyRequests += 1;
        if (historyRequests === 2) revision += 1;
        return { messages: historyRequests > 2 ? [{ role: "assistant", content: "later" }] : [], next_offset: null };
      },
      replay: async (_id: string, refresh: (signal: AbortSignal) => Promise<unknown[]>) => {
        revision = 1;
        await refresh(new AbortController().signal);
        return { store: { resync: (events: unknown[]) => snapshots.push(events) }, release() {} };
      },
      replayRevision: () => revision,
      finishReplay: (_id: string, expected: number) => expected === revision,
    };
    const lease = await loadSession(client as never, "s");
    expect(historyRequests).toBe(3);
    expect(snapshots.at(-1)).toBeDefined();
    expect(lease.store).toBeDefined();
  });
});
