import { describe, expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError, watchTurnEnd } from "./session";

describe("applyApprovalMode", () => {
  test("defers a mode change while the session is running", async () => {
    const methods: string[] = [];
    const client = { features: [], request: async (method: string) => {
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
    const client = { features: [], request: async (method: string) => {
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
    const client = { features: [], request: async (method: string) => {
      methods.push(method);
      if (method === "status") return { state: "idle" };
      throw { data: { code: "session_not_found" } };
    } };

    await expect(openHomeSession(client as never, "missing", "credential", "/tmp", "allow")).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(methods).toEqual(["status", "resume"]);
  });

  test("preserves a resumed chat mode when the server does not force ask", async () => {
    const methods: string[] = [];
    const client = { features: [], request: async (method: string) => {
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
    const client = { features: [], request: async (method: string) => {
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
    store.dispatch({ type: "turn_end" });
    await settle();
    expect(ended).toBe(0); // the run_start mark keeps a store that missed agent_start running until agent_end
    store.dispatch({ type: "run_end" }); store.dispatch({ type: "run_end" });
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

  test("keeps the last outcome when it undoes its mark", async () => {
    const { store, client } = watched({ state: "idle" });
    store.dispatch({ type: "run_start" }); store.dispatch({ type: "run_end", outcome: "failed" });
    watchTurnEnd(client as never, "other", () => {});
    await settle();
    expect(store.getState().endOutcome).toBe("failed");
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
  const replayClient = (request: (method: string, params: Record<string, unknown>) => unknown, revision: () => number = () => 0) => {
    const snapshots: unknown[][] = [];
    const client = {
      request: async (method: string, params: Record<string, unknown>) => request(method, params),
      replay: async (_id: string, load: () => Promise<unknown[]>) => { snapshots.push(await load()); return { store: {}, release() {} }; },
      replayRevision: revision,
    };
    return { client: client as never, snapshots };
  };
  const joined = (state: string, messages: unknown[] = [], next_before: number | null = null) => ({ messages, next_before, history_validator: { end: 1, entry_id: "e", repair_generation: null }, status: { state, pending_approvals: [] }, replay: { stream_id: "r", history_seq: 0 } });

  test("reads older rows, then installs the join that finds them read, so no event of that join is dropped", async () => {
    const text = (id: string) => ({ id, role: "assistant", content: [{ type: "text", text: id }] });
    const requests: string[] = [];
    const { client, snapshots } = replayClient((method, params) => {
      requests.push(`${method}:${params.before ?? ""}`);
      if (method === "session_history_and_subscribe") return joined("running", [text(requests.length === 1 ? "new" : "newer")], 3);
      if (method === "session_history") return params.before === 3 ? { messages: [text("mid")], next_before: 1 } : { messages: [text("old")], next_before: null };
      throw new Error(`unexpected ${method}`);
    });
    await loadSession(client, "s");
    expect(requests).toEqual(["session_history_and_subscribe:", "session_history:3", "session_history:1", "session_history_and_subscribe:"]);
    const shown = JSON.stringify(snapshots.at(-1));
    const at = ["old", "mid", "newer"].map((id) => shown.indexOf(`"${id}"`));
    expect(at[0]).toBeGreaterThan(-1);
    expect(at[0] < at[1] && at[1] < at[2]).toBe(true);
    expect(shown).not.toContain('"new"');
  });

  test("joins again after a stale join", async () => {
    let joins = 0;
    const { client } = replayClient((method) => {
      joins += 1;
      if (joins === 1) throw Object.assign(new Error("stale"), { code: -32009 });
      return method === "session_history_and_subscribe" ? joined("running") : null;
    });
    await loadSession(client, "s");
    expect(joins).toBe(2);
  });

  test("ends the snapshot with the kept turn or with how zeta stopped the last one", async () => {
    const tail = async (status: { state: string }) => {
      const { client, snapshots } = replayClient((method) => method === "status" ? status : joined(status.state));
      await loadSession(client, "s");
      return snapshots.at(-1);
    };
    const ended = (reason: string, session = "s") => ({ session: { session_id: session }, state: "idle", last_turn_outcome: { turn_id: "t", reason } });
    expect(await tail({ session: { session_id: "s" }, state: "running" } as never)).toEqual([{ type: "run_start" }, { type: "turn_start" }]);
    expect(await tail(ended("disconnect"))).toEqual([{ type: "run_end", outcome: "disconnected" }]);
    expect(await tail(ended("user_stop"))).toEqual([{ type: "run_end", outcome: "cancelled" }]);
    expect(await tail(ended("completed"))).toEqual([{ type: "run_end" }]);
    expect(await tail(ended("disconnect", "other"))).toEqual([{ type: "run_end" }]);
  });
});
