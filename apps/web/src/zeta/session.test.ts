import { describe, expect, test } from "bun:test";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError } from "./session";

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
      throw { data: { code: "session_not_found" } };
    } };

    await expect(openHomeSession(client as never, "missing", "credential", "/tmp", "allow")).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(methods).toEqual(["resume"]);
  });

  test("preserves a resumed chat mode when the server does not force ask", async () => {
    const methods: string[] = [];
    const client = { request: async (method: string) => {
      methods.push(method);
      if (method === "resume") return { session: { name: "existing" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "ask" };
      throw new Error(`unexpected ${method}`);
    } };

    const result = await openHomeSession(client as never, "existing", "credential", "/tmp", "allow");
    expect(result.approvalMode).toBe("ask");
    expect(methods).toEqual(["resume", "session_settings"]);
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
