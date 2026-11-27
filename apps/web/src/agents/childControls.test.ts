import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { controlFeature, createChildControls, readControlParent, withLiveRow } from "./childControls";
import type { AgentRun } from "./reads";

const row: AgentRun = { sessionId: "root", runId: "fixture-run", parentRunId: null, agentType: "fixture", description: "fixture task", status: "idle" };
const profile = { name: "fixture", description: "fixture profile", tools: ["read"] };
const otherProfile = { ...profile, name: "other-profile" };
const parent = { id: "root", cwd: "/fixture", profiles: [profile, otherProfile], idle: true };
const spawn = { kind: "spawn", parent, profile, task: "fixture task" } as const;
const cancel = { kind: "cancel", row } as const;
const stored = (id: string, status = "idle", description = row.description, root = "root", ancestor: string | null = null) => ({
  session_id: root, run_id: id, parent_run_id: ancestor, agent_type: "fixture", description,
  status, accepts_follow_ups: true, turns_used: 1, tool_count: 0, current_step: status,
  started_at: "2026-01-01", finished_at: null, elapsed_seconds: 1,
});
const accepted = (run_id: string, state?: string) => ({ data: { accepted: true, run_id, state } });
const error = (code: number) => Object.assign(new Error("fixture RPC error"), { code });
function fixture({ reply = accepted("fixture-run", "cancelling") as unknown, refused = false, feature = true, method = true,
  state = "idle", session = "root", cwd = parent.cwd }: {
  reply?: unknown; refused?: boolean; feature?: boolean; method?: boolean; state?: string; session?: string; cwd?: string;
} = {}) {
  const writes: [string, object][] = [];
  const reads: { role: string; params: unknown }[] = [];
  const record = { borrows: 0, refreshes: 0, catalog: [stored(row.runId)], reply, hold: undefined as Promise<unknown> | undefined };
  const make = (role: "observer" | "controller") => ({ features: feature ? [controlFeature] : [], async request(method: string, params: object) {
    if (method === "status") return { state, session: { session_id: session, cwd, agent_catalog: parent.profiles } };
    if (method === "agent_run_catalog") { reads.push({ role, params }); return { revision: "1", data: { items: record.catalog } }; }
    expect(role).toBe("controller");
    writes.push([method, params]);
    if (record.hold) return deadline(`reply to ${method}`, record.hold);
    if (record.reply instanceof Error) throw record.reply;
    return record.reply;
  } }) as unknown as ZetaClient;
  const connection = { client: make("observer") as ZetaClient | null, async withControl<T>(run: (client: ZetaClient) => Promise<T>) {
    record.borrows++;
    return refused ? { refused: "fixture observer refusal" } : { value: await deadline("borrowed controller operation", run(make("controller"))) };
  } };
  const owner = createChildControls(connection, () => method);
  return { connection, owner, writes, reads, record, make, open: (intent: typeof spawn | typeof cancel) => owner.operation(intent, () => { record.refreshes++; }) };
}

async function deadline<T>(name: string, promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), 10_000); })]);
  } finally { clearTimeout(timer); }
}

test.each([
  ["spawn success", spawn, { reply: accepted("new-fixture-run") }, "committed", "spawned fixture", 1, 1, 1],
  ["cancel focuses one child", cancel, {}, "committed", "cancellation requested", 1, 1, 1],
  ["already terminal", cancel, { reply: accepted(row.runId, "completed") }, "committed", "already done", 1, 1, 1],
  ["wrong cancel receipt id", cancel, { reply: accepted("other", "cancelling") }, "unknown", "", 1, 1, 0],
  ["observer refused", cancel, { refused: true }, "failed", "fixture observer refusal", 1, 0, 0],
  ["parent mid-turn", spawn, { state: "running" }, "failed", "zeta is busy", 1, 0, 0],
  ["parent and review differ", spawn, { session: "other" }, "failed", "scope changed", 1, 0, 0],
  ["inherited cwd changed", spawn, { cwd: "/other" }, "failed", "scope changed", 1, 0, 0],
  ["busy is not applied", spawn, { reply: error(-32004) }, "failed", "zeta is busy", 1, 1, 0],
  ["not found requests refresh", cancel, { reply: error(-32012) }, "failed", "no longer has this child", 1, 1, 1],
  ["feature absent on observer", spawn, { feature: false }, "failed", "needs a newer zeta", 0, 0, 0],
  ["method absent on controller", cancel, { method: false }, "failed", "needs a newer zeta", 1, 0, 0],
] as const)("child controls: %s", async (name, intent, options, status, copy, borrows, writes, refreshes) => {
  const f = fixture(options);
  const result = await deadline(name, f.open(intent).execute());
  expect(result.status).toBe(status);
  if (copy) expect(JSON.stringify(result)).toContain(copy);
  expect(f.record.borrows).toBe(borrows);
  expect(f.record.refreshes).toBe(refreshes);
  expect(f.writes).toEqual(!writes ? [] : intent.kind === "spawn" ? [["child_run_spawn", { session_id: "root", agent_type: "fixture", task: "fixture task", background: true }]]
    : [["child_run_cancel", { session_id: "root", run_id: "fixture-run", reason: "user_cancelled" }]]);
});

test("double submit joins across remount and drains the pending write", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<unknown>();
  f.record.hold = gate.promise;
  const first = f.open(cancel).execute();
  try {
    expect(f.open(cancel).execute()).toBe(first);
    expect(f.writes).toHaveLength(1);
  } finally {
    gate.resolve(accepted(row.runId, "cancelling"));
    expect(await deadline("drain joined cancel", first)).toMatchObject({ status: "committed" });
  }
});

test.each([
  ["one exact new direct run", spawn, [stored(row.runId), stored("new-run"), stored("nested", "idle", row.description, "root", "a"), stored("different", "idle", "another task")], "committed", undefined],
  ["different review after remount cannot settle the earlier spawn", spawn, [stored(row.runId), stored("new-run")], "unknown", { ...spawn, profile: otherProfile, task: "another task" }],
  ["multiple exact new runs", spawn, [stored("second"), stored("third")], "unknown", undefined],
  ["only the original matching run", spawn, [stored(row.runId)], "unknown", undefined],
  ["only a nested matching run", spawn, [stored("nested", "idle", row.description, "root", "a")], "unknown", undefined],
  ["other root is not authoritative", cancel, [stored(row.runId, "canceled", row.description, "other")], "unknown", undefined],
  ["the exact child ended", cancel, [stored(row.runId, "canceled")], "committed", undefined],
  ["the exact child completed instead", cancel, [stored(row.runId, "completed")], "committed", undefined],
  ["the exact child still runs", cancel, [stored(row.runId, "running"), stored("other", "canceled")], "unknown", undefined],
] as const)("lost reply: %s", async (name, intent, catalog, status, otherReview) => {
  const f = fixture({ reply: new Error("socket lost") });
  const original = f.open(intent);
  expect(await deadline(`${name}: original attempt`, original.execute())).toEqual({ status: "unknown" });
  f.connection.client = null;
  expect(await deadline(`${name}: offline check`, original.checkResult())).toEqual({ status: "unknown" });
  f.connection.client = f.make("observer");
  f.record.catalog = [...catalog];
  const reopened = f.open(otherReview ?? intent);
  const result = await deadline(`${name}: execute reopened review`, reopened.execute());
  expect(await deadline(`${name}: check`, reopened.checkResult())).toMatchObject({ status });
  if (otherReview) {
    expect(result).toMatchObject({ status: "failed", reason: "not-applied", message: expect.stringContaining("earlier spawn") });
    expect(await deadline(`${name}: check the original review`, f.open(intent).checkResult())).toMatchObject({ status: "committed" });
  } else {
    expect(result).toEqual({ status: "unknown" });
  }
  expect(f.writes).toHaveLength(1);
  expect(f.record.borrows).toBe(1);
  expect(f.reads.at(-1)).toEqual({ role: "observer", params: { root_session_id: "root", limit: 100 } });
});

test("active status projects the picker, not stored catalog rows", async () => {
  const f = fixture();
  expect(await deadline("active status", readControlParent(f.connection.client!, AbortSignal.timeout(500)))).toEqual(parent);
  expect(f.reads).toEqual([]);
});

test("the catalog's step, turns, and tool calls are shown as reported; the live row adds waiting state (and the wait as the step) and the reply", () => {
  const running: AgentRun = { ...row, status: "running", currentStep: "turn 2: reading", toolCount: 4, turnsUsed: 2 };
  const live = { status: "running", latestActivity: "turn 1: thinking", toolCount: 1 };
  expect(withLiveRow(running, live)).toBe(running);
  expect(withLiveRow(running, { ...live, status: "waiting_approval", latestActivity: "approve bash: rm notes.txt" })).toEqual({ ...running, waiting: "needs approval", currentStep: "approve bash: rm notes.txt" });
  expect(withLiveRow(running, { status: "waiting_input" })).toEqual({ ...running, waiting: "needs input", currentStep: "needs input" });
  expect(withLiveRow(running, { status: "done", summary: "counted 3 lines" })).toEqual({ ...running, reply: "counted 3 lines" });
  expect(withLiveRow(running, { status: "done" })).toBe(running);
  expect(withLiveRow({ ...running, status: "completed" }, { status: "waiting_input" }).waiting).toBeUndefined();
  expect(withLiveRow(running, undefined)).toBe(running);
});
