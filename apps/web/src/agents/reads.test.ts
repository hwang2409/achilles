import { expect, jest, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { fromZetaEvent, type ZetaClient } from "@fulcrum/zeta";
import { readSessionTitles } from "../sessions/reads";
import { createAgentRunsReader, sourceNote } from "./reads";

const rich = (id = "a:1") => ({ run_id: id, session_id: "a", parent_run_id: null, status: "completed", agent_type: "worker", description: "check sample", accepts_follow_ups: false, turns_used: 2, tool_count: 0, current_step: "completed", started_at: "2026-01-02T00:00:00Z", finished_at: null, elapsed_seconds: 5 });
const catalog = (items: unknown[], next_cursor?: string) => ({ revision: "sample", data: { items, ...(next_cursor ? { next_cursor } : {}) } });
const error = (code: number) => Object.assign(new Error("test rpc error"), { code });
const stored = { run_id: "a:1", session_id: "a", parent_run_id: null, profile: "worker", status: "finished", background: null, started_ns: null, ended_ns: null };
function setup(features: string[], replies: unknown[], methods = ["agent_run_catalog", "state_agents", "child_run_list"]) {
  const calls: [string, unknown, AbortSignal | undefined][] = [];
  const client = { features, request: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
    calls.push([method, params, options?.signal]);
    if (!replies.length) throw new Error(`unexpected ${method}`);
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return response;
  } } as unknown as ZetaClient;
  return { calls, reader: createAgentRunsReader(client, (method) => methods.includes(method), () => 42) };
}

// Only defer replies that a test needs to reorder; teardown resolves and drains them even on a failed assertion.
async function deadline<T>(promise: Promise<T>, operation: string, cancel: () => void = () => {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel(); reject(new Error(`deadline: ${operation}`)); }, 1000); })]); }
  finally { clearTimeout(timer); }
}

test("catalog needs feature and exact method; reads configured filters, validates rows and keeps an empty continuation", async () => {
  const { reader, calls } = setup(["agent_run_catalog_v1"], [catalog([{ ...rich(), tool_count: "0" }], "after"), catalog([rich(), { ...rich("b:1"), session_id: "b" }])]);
  await reader.refresh({ root: "a", status: "completed" });
  expect(calls[0]?.slice(0, 2)).toEqual(["agent_run_catalog", { limit: 100, root_session_id: "a", state: "completed" }]);
  expect(reader.snapshot().report).toMatchObject({ rows: [], omitted: 1, reportedAt: 42, complete: false });
  await reader.more();
  expect(calls[1]?.[1]).toEqual({ limit: 100, root_session_id: "a", state: "completed", cursor: "after" });
  expect(reader.snapshot().report).toMatchObject({ omitted: 2, complete: true, rows: [{ runId: "a:1", elapsedSeconds: 5 }] });
  const missing = setup(["agent_run_catalog_v1"], [], []);
  await missing.reader.refresh();
  expect(missing.reader.snapshot().unsupported).toBe(true);
  expect(missing.calls).toHaveLength(0);
});

test("method rejection falls back to state then attached; invalid rows are not promoted or invented", async () => {
  const { reader, calls } = setup(["agent_run_catalog_v1", "state_read_v1", "child_runs"], [error(-32601), { as_of_ns: 2, items: [stored, { ...stored, status: "completed" }], next_cursor: null }, error(-32601), { session: { session_id: "a" } }, { runs: [rich(), { ...rich("b:1"), session_id: "b" }], next_offset: 2 }, { runs: [] }]);
  await reader.refresh({ root: "a", status: "completed" });
  expect(calls[1]?.[1]).toEqual({ limit: 100, cursor: null, session_id: "a", status: "finished" });
  expect(reader.snapshot().report).toMatchObject({ source: "state", omitted: 1, rows: [{ status: "completed", agentType: "worker" }] });
  expect(reader.snapshot().report?.rows[0]?.elapsedSeconds).toBeUndefined();
  expect(sourceNote.state).toBe("full agent details need a newer zeta. showing stored agent state.");
  await reader.refresh();
  expect(calls.slice(2).map(([method]) => method)).toEqual(["state_agents", "status", "child_run_list"]);
  expect(reader.snapshot().report).toMatchObject({ source: "attached", omitted: 1, complete: false });
  await reader.more();
  expect(calls[5]?.[1]).toEqual({ session_id: "a", limit: 100, offset: 2 });
  expect(reader.snapshot().report?.complete).toBe(true);
  const unattached = setup(["child_runs"], [{ session: null }]);
  await unattached.reader.refresh();
  expect(unattached.reader.snapshot().unsupported).toBe(true);
  expect(unattached.calls.map(([method]) => method)).toEqual(["status"]);
});

test.each([
  [catalog([], ""), undefined],
  [{ revision: "sample", data: { items: [], next_cursor: null } }, "zeta returned an invalid response"],
  [error(-32005), "zeta could not read agent runs right now"],
  [error(-32007), "zeta could not fit the agent runs in a reply"],
])("refresh maps %p and only replaces the last valid report on success", async (reply, message) => {
  const { reader } = setup(["agent_run_catalog_v1"], [catalog([rich()]), reply]);
  await reader.refresh();
  const report = reader.snapshot().report;
  await reader.refresh();
  expect(reader.snapshot().warning).toBe(message);
  if (message) expect(reader.snapshot().report).toBe(report);
  else expect(reader.snapshot().report?.rows).toEqual([]);
});

test("rejected continuation restarts once at the first page, not a merge of generations", async () => {
  const { reader, calls } = setup(["agent_run_catalog_v1"], [catalog([rich()], "stale"), error(-32602), catalog([rich("a:3")], "loop"), catalog([rich("a:4")], "loop"), error(-32602)]);
  await reader.refresh();
  await reader.more();
  expect(calls.map(([, params]) => params)).toEqual([{ limit: 100 }, { limit: 100, cursor: "stale" }, { limit: 100 }]);
  expect(reader.snapshot().report?.rows.map((row) => row.runId)).toEqual(["a:3"]);
  await reader.more();
  expect(calls).toHaveLength(5);
  expect(reader.snapshot().warning).toContain("rejected");
  expect(reader.snapshot().report?.rows.map((row) => row.runId)).toEqual(["a:3"]);
});

test("a delayed continuation cannot append after refresh replaced its base", async () => {
  const gate = Promise.withResolvers<unknown>();
  const { reader, calls } = setup(["agent_run_catalog_v1"], [catalog([rich()], "older"), gate.promise, catalog([rich("a:3")])]);
  const cancel = () => { reader.stop(); gate.resolve(catalog([])); };
  await deadline(reader.refresh(), "load first report", cancel);
  const more = reader.more();
  try {
    await deadline(reader.refresh(), "replace the report", cancel);
    expect(calls[1]?.[2]?.aborted).toBe(true);
    gate.resolve(catalog([rich("a:2")]));
    await deadline(more, "drain superseded continuation", cancel);
    expect(reader.snapshot().report?.rows.map((row) => row.runId)).toEqual(["a:3"]);
  } finally {
    cancel();
    await deadline(more, "drain continuation on teardown");
  }
});

// zeta's provider-suspended row (child_runs.py: the five retry fields only when suspension_reason is provider_unavailable)
const suspended = (id = "a:1", fields: Record<string, unknown> = {}) => ({ ...rich(id), status: "suspended", current_step: "suspended: provider unavailable, retrying",
  suspension_reason: "provider_unavailable", retry_state: "retrying", retry_started_at: "2026-11-08T00:00:00+00:00", retry_deadline_at: "2026-11-08T01:00:00+00:00",
  next_retry_at: "2026-11-08T00:00:05.004842+00:00", ...fields });

test("a suspended catalog row keeps its status and zeta's retry times; a bad retry field drops the retry, not the row", async () => {
  const { reader } = setup(["agent_run_catalog_v1"], [catalog([suspended(), suspended("a:2", { next_retry_at: "soon" }), suspended("a:3", { retry_state: "stopped", next_retry_at: undefined }),
    { ...rich("a:4"), status: "suspended", current_step: "suspended (parent crashed)" }])]);
  await reader.refresh();
  const rows = reader.snapshot().report!.rows;
  expect(rows.map((row) => row.status)).toEqual(["suspended", "suspended", "suspended", "suspended"]);
  expect(rows[0]!.retry).toEqual({ state: "retrying", startedAt: Date.parse("2026-11-08T00:00:00Z"), deadlineAt: Date.parse("2026-11-08T01:00:00Z"), nextAt: Date.parse("2026-11-08T00:00:05.004Z") });
  expect(rows[1]!.retry).toBeUndefined();
  expect(rows[2]!.retry).toEqual({ state: "stopped", startedAt: Date.parse("2026-11-08T00:00:00Z"), deadlineAt: Date.parse("2026-11-08T01:00:00Z") });
  expect(rows[3]).toMatchObject({ status: "suspended", currentStep: "suspended (parent crashed)" });
  expect(rows[3]!.retry).toBeUndefined();
  reader.stop();
  // an older zeta sends the same child as running with no retry fields: the parsed row has no retry key at all
  const old = setup(["agent_run_catalog_v1"], [catalog([{ ...rich(), status: "running", current_step: "thinking" }])]);
  await old.reader.refresh();
  expect(Object.keys(old.reader.snapshot().report!.rows[0]!)).not.toContain("retry");
});

test("the attached child list keeps zeta's retry times that fulcrum's row parser drops", async () => {
  const { reader } = setup(["child_runs", "child_recovery"], [{ session: { session_id: "a" } }, { runs: [suspended(), suspended("a:2", { retry_state: "stopped", next_retry_at: undefined })] }], ["child_run_list"]);
  await reader.refresh({ root: "a" });
  const rows = reader.snapshot().report!.rows;
  expect(rows.map((row) => row.status)).toEqual(["suspended", "suspended"]);
  expect(rows[0]!.retry).toEqual({ state: "retrying", startedAt: Date.parse("2026-11-08T00:00:00Z"), deadlineAt: Date.parse("2026-11-08T01:00:00Z"), nextAt: Date.parse("2026-11-08T00:00:05.004Z") });
  expect(rows[1]!.retry?.state).toBe("stopped");
  reader.stop();
});

test("rows sharing a retry time reread once after it passes, never while a read is in flight, and not again for the same time", async () => {
  jest.useFakeTimers();
  try {
    const next = Date.parse("2026-11-08T00:00:05Z");
    jest.setSystemTime(next - 5000);
    const page = catalog(Array.from({ length: 50 }, (_, index) => suspended(`a:${index}`, { next_retry_at: "2026-11-08T00:00:05+00:00" })));
    const parked = Promise.withResolvers<unknown>();
    const replies = [page, page, parked.promise, page];
    const calls: unknown[] = [];
    const client = { features: ["agent_run_catalog_v1"], request: async (_method: string, params: unknown) => { calls.push(params); return replies.shift(); } } as unknown as ZetaClient;
    const reader = createAgentRunsReader(client, () => true);
    await reader.refresh({ root: "a" });
    jest.advanceTimersByTime(7900);
    expect(calls).toHaveLength(1);
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(calls).toEqual([{ limit: 100, root_session_id: "a" }, { limit: 100, root_session_id: "a" }]);
    // zeta returned the same planned time again: no reread loop
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(2);
    // a new planned time while another read runs: the due time passes during that read and is skipped
    replies.unshift(catalog([suspended("a:1", { next_retry_at: "2026-11-08T00:01:30+00:00" })]));
    await reader.refresh({ root: "a" });
    const busy = reader.refresh({ root: "a" });
    jest.setSystemTime(Date.parse("2026-11-08T00:02:00Z"));
    jest.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(4);
    reader.stop();
    parked.resolve(catalog([]));
    await busy;
  } finally { jest.useRealTimers(); }
});

test("session titles for the agents view keep only real names and first messages", async () => {
  const sessions = [{ session_id: "named", name: "synthetic name" }, { session_id: "typed", first_message_preview: "synthetic typed" }, { session_id: "0123456789abcdef" }];
  const client = { features: [], request: async () => ({ sessions }) } as unknown as ZetaClient;
  expect([...await readSessionTitles(client, new AbortController().signal)]).toEqual([["named", "synthetic name"], ["typed", "synthetic typed"]]);
});

test("a live row older than the report does not replace the report's step", async () => {
  let clock = 0;
  const live = (step: string, toolCount: number) => ({ ...rich(), status: "running", current_step: step, tool_count: toolCount });
  const replies = [catalog([live("turn 1: thinking", 0)]), catalog([live("turn 2: reading", 3)])];
  const store = createRunStore((flush) => flush());
  const client = { features: ["agent_run_catalog_v1", "child_run_events"], stores: new Map([["a", store]]), request: async () => replies.shift() } as unknown as ZetaClient;
  const reader = createAgentRunsReader(client, () => true, () => clock);
  try {
    await reader.refresh();
    clock = 1000;
    for (const event of fromZetaEvent({ event: "child_progress", session_id: "a", run_id: "a:1", sequence: 2, child: live("turn 1: editing", 1) })) store.dispatch(event);
    expect(reader.snapshot().report?.rows[0]).toMatchObject({ currentStep: "turn 1: editing", toolCount: 1 });
    clock = 2000;
    await reader.refresh();
    expect(reader.snapshot().report?.rows[0]).toMatchObject({ currentStep: "turn 2: reading", toolCount: 3, elapsedSeconds: 5 });
  } finally { reader.stop(); store.dispose(); }
});
