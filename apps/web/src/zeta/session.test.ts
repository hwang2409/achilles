import { describe, expect, test } from "bun:test";
import { applyApprovalMode, creationApprovalMode, loadSession, openHomeSession, SessionNotFoundError } from "./session";

describe("applyApprovalMode", () => {
  test("defers a mode change while the session is running", async () => {
    const methods: string[] = [];
    const client = { features: [], request: async (method: string) => {
      methods.push(method);
      if (method === "session_settings") return { model: "offline", approval_mode: "ask" };
      if (method === "status") return { state: "running" };
      throw new Error(`unexpected ${method}`);
    } };

    expect(await applyApprovalMode(client as never, "s", "allow")).toEqual({ approvalMode: "ask", model: "offline", pending: true });
    expect(methods).toEqual(["session_settings", "status"]);
  });

  test("does not inspect or write a mode that already matches", async () => {
    const methods: string[] = [];
    const client = { features: [], request: async (method: string) => {
      methods.push(method);
      return { model: "offline", approval_mode: "allow" };
    } };

    expect(await applyApprovalMode(client as never, "s", "allow")).toEqual({ approvalMode: "allow", model: "offline", pending: false });
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
    expect(result.model).toBe("offline");
    expect(methods).toEqual(["status", "resume", "session_settings"]);
  });

  test("resumes once more when the other turn ended between resume and status", async () => {
    const methods: string[] = []; let resumes = 0;
    const client = { features: [], request: async (method: string) => {
      methods.push(method);
      if (method === "status") return methods.length === 1 ? { session: { session_id: "other" }, state: "running" } : { state: "idle" };
      if (method === "resume" && ++resumes === 1) throw Object.assign(new Error("a turn is already running"), { code: -32004 });
      if (method === "resume") return { session: { name: "existing", cwd: "/stored/dir" } };
      if (method === "session_settings") return { model: "offline", approval_mode: "allow" };
      throw new Error(`unexpected ${method}`);
    } };

    const result = await openHomeSession(client as never, "existing", "credential", "/tmp", "allow").catch((caught: Error) => ({ error: caught.message }));
    // the stored session cwd wins over the requested one: a resumed session keeps its own directory
    expect(result).toMatchObject({ id: "existing", name: "existing", cwd: "/stored/dir", rebind: false });
    expect(methods).toEqual(["status", "resume", "status", "resume", "session_settings"]);
  });
});

describe("loadSession", () => {
  const replayClient = (request: (method: string, params: Record<string, unknown>) => unknown, revision: () => number = () => 0) => {
    const snapshots: unknown[][] = [];
    const controller = new AbortController();
    const client = {
      features: ["session_replay_seq"],
      request: async (method: string, params: Record<string, unknown>) => request(method, params),
      replay: async (_id: string, load: (signal: AbortSignal) => Promise<unknown[]>) => { snapshots.push(await load(controller.signal)); return { store: {}, release() {} }; },
      replayRevision: revision,
    };
    return { client: client as never, snapshots, abort: () => controller.abort() };
  };
  const joined = (state: string, messages: unknown[] = [], next_before: number | null = null, repair_generation: string | null = null) => ({ messages, next_before, history_validator: { end: 1, entry_id: "e", repair_generation }, status: { state, pending_approvals: [] }, replay: { stream_id: "r", history_seq: 0 } });
  const stopped = (reason: string) => ({ session: { session_id: "s" }, state: "idle", last_turn_outcome: { turn_id: "t", reason } });

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

  test("installs the join whose status read saw no event, with its outcome", async () => {
    // a background child sends an event during the first status read: that join's events were dropped
    let revision = 0; let joins = 0; let reads = 0;
    const { client, snapshots } = replayClient((method) => {
      if (method === "session_history_and_subscribe") { joins += 1; return joined("idle", [{ id: `join-${joins}`, role: "assistant", content: [{ type: "text", text: `join-${joins}` }] }]); }
      if (method === "status") { reads += 1; if (reads === 1) revision += 1; return stopped("user_stop"); }
      throw new Error(`unexpected ${method}`);
    }, () => revision);
    await loadSession(client, "s");
    expect(joins).toBe(2);
    const shown = JSON.stringify(snapshots.at(-1));
    expect(shown).toContain("join-2");
    expect(shown).not.toContain("join-1");
    expect(snapshots.at(-1)?.at(-1)).toEqual({ type: "run_end", outcome: "cancelled" });
  });

  test("an event during every status read stops after 3 reads and installs with no outcome", async () => {
    let revision = 0; let joins = 0; let reads = 0;
    const { client, snapshots } = replayClient((method) => {
      if (method === "session_history_and_subscribe") { joins += 1; return joined("idle"); }
      if (method === "status") { if (++reads > 10) throw new Error("status reads have no limit"); revision += 1; return stopped("user_stop"); }
      throw new Error(`unexpected ${method}`);
    }, () => revision);
    await loadSession(client, "s");
    expect({ joins, reads }).toEqual({ joins: 4, reads: 3 });
    expect(snapshots.at(-1)).toEqual([{ type: "run_end" }]);
  });

  test("a chat that keeps going stale fails with a clear error after 5 restarts", async () => {
    let joins = 0;
    const { client } = replayClient(() => { if (++joins > 10) throw new Error("stale joins have no limit"); throw Object.assign(new Error("stale"), { code: -32009 }); });
    await expect(loadSession(client, "s")).rejects.toThrow("this chat kept changing while it loaded");
    expect(joins).toBe(6);
  });

  test("a cursor that changes on every join fails with a clear error after 5 older reads", async () => {
    let joins = 0; let older = 0;
    const { client } = replayClient((method) => {
      if (method === "session_history_and_subscribe") return joined("running", [], ++joins);
      if (++older > 10) throw new Error("older reads have no limit");
      return { messages: [], next_before: null };
    });
    await expect(loadSession(client, "s")).rejects.toThrow("this chat kept changing while it loaded");
    expect({ joins, older }).toEqual({ joins: 6, older: 5 });
  });

  test("reads older rows again when a repair lands between the two joins", async () => {
    const requests: string[] = [];
    const { client, snapshots } = replayClient((method) => {
      requests.push(method);
      const joins = requests.filter((name) => name === "session_history_and_subscribe").length;
      if (method === "session_history_and_subscribe") return joined("running", [], 3, joins === 1 ? null : "repair-1");
      return { messages: [{ id: `older-${joins}`, role: "assistant", content: [{ type: "text", text: `older-${joins}` }] }], next_before: null };
    });
    await loadSession(client, "s");
    expect(requests).toEqual(["session_history_and_subscribe", "session_history", "session_history_and_subscribe", "session_history", "session_history_and_subscribe"]);
    const shown = JSON.stringify(snapshots.at(-1));
    expect(shown).toContain("older-2");
    expect(shown).not.toContain("older-1");
  });

  test("stops at the next request once fulcrum aborts the load or the page moves on", async () => {
    const aborted = replayClient((method) => { if (method === "session_history_and_subscribe") { abortLoad(); return joined("running", [], 3); } throw new Error(`unexpected ${method}`); });
    const abortLoad = aborted.abort;
    await expect(loadSession(aborted.client, "s")).rejects.toMatchObject({ name: "AbortError" });

    let wanted = true; const methods: string[] = [];
    const moved = replayClient((method) => { methods.push(method); wanted = false; return joined("running", [], 3); });
    await expect(loadSession(moved.client, "s", () => wanted)).rejects.toMatchObject({ name: "AbortError" });
    expect(methods).toEqual(["session_history_and_subscribe"]);
  });

  test("a zeta without session_replay_seq gets a clear error", async () => {
    const client = { features: [], request: async () => { throw new Error("unexpected request"); } };
    await expect(loadSession(client as never, "s")).rejects.toThrow("this zeta is too old to open chats");
  });
});
