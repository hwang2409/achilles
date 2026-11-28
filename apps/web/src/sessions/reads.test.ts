import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createSessionsReader, readError } from "./reads";

const signal = () => new AbortController().signal;
const row = (id: string, project_id: string | null = null) => ({ session_id: id, name: `session ${id}`, project_id });
const state = (id: string, status: string) => ({ session_id: id, status, child_count: 0, background_count: 1, attention_count: 5, attention_open: 2, title: "not authoritative" });
function serve(fn: (method: string, params: Record<string, unknown>) => unknown, features = ["list_sessions_paging", "state_read_v1", "session_history_read_v1"]) {
  const calls: [string, Record<string, unknown>][] = [];
  const client = { features, request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return fn(method, params); } } as unknown as ZetaClient;
  return { calls, reader: createSessionsReader(client, () => true) };
}

test("walks short pages and joins by exact id; bad rows are omitted, not idle", async () => {
  const { reader, calls } = serve((method, p) => method === "list_sessions" ? p.offset === 0 ? {
    sessions: [row("a"), { ...row("bad"), project_id: {} }], next_offset: 2,
  } : { sessions: [row("ab"), row("b")], next_offset: null } : p.cursor === null ? {
    items: [state("ab", "running"), state("b", "bogus")], next_cursor: "older",
  } : { items: [state("orphan", "idle")], next_cursor: null });
  const reply = await reader.catalog(signal());
  // attention shows open decisions (attention_open), not every stored record (attention_count)
  expect(reply.items.map(({ id, title, status, state }) => [id, title, status, state?.tasks, state?.attention])).toEqual([
    ["a", "session a", "unknown", undefined, undefined], ["ab", "session ab", "running", 1, 2], ["b", "session b", "unknown", undefined, undefined],
  ]);
  expect([reply.omitted, reply.complete]).toEqual([2, false]);
  expect(calls.map(([method, p]) => [method, p.offset ?? p.cursor])).toEqual([
    ["list_sessions", 0], ["state_sessions", null], ["list_sessions", 2], ["state_sessions", "older"],
  ]);
});

test.each([
  ["bounded prefix on older zeta", { sessions: [row("a")], truncated: true }, false],
  ["empty unpaged success", { sessions: [] }, true],
] as const)("%s", async (_name, reply, complete) => {
  const { reader, calls } = serve(() => reply, []);
  const data = await reader.catalog(signal());
  expect([data.complete, data.warnings, data.items.map(({ id }) => id)]).toEqual(complete
    ? [true, ["session state needs a newer zeta"], []]
    : [false, ["zeta returned only the first sessions; update zeta for paging", "session state needs a newer zeta"], ["a"]]);
  expect(calls).toEqual([["list_sessions", {}]]);
});

test("invalid envelopes fail, and an outdated overlay cannot replace current proof", async () => {
  let overlay = 0;
  let failMetadata = false;
  const { reader } = serve((method) => method === "list_sessions" ? failMetadata ? { sessions: null } : { sessions: [row("a")], next_offset: null }
    : ++overlay === 1 ? { items: [state("a", "idle")], next_cursor: null }
    : overlay === 2 ? { items: [state("a", "running")], next_cursor: null }
    : Promise.reject({ code: -32005 }));
  const [first, second] = await Promise.allSettled([reader.catalog(signal()), reader.catalog(signal())]);
  expect(first).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
  if (second.status === "rejected") throw second.reason;
  const fresh = second.value;
  const stale = await reader.catalog(signal());
  expect([stale.items[0]?.status, stale.staleState, stale.warnings]).toEqual(["running", fresh.reportedAt, ["zeta could not read this data right now"]]);
  failMetadata = true;
  await expect(reader.catalog(signal())).rejects.toThrow("invalid response");
});

test("detail collection restarts once and does not accept a different session's rows", async () => {
  let heads = 0;
  const { reader, calls } = serve((method, p) => {
    expect(method).toBe("state_session");
    if (p.cursor) throw { code: -32009 };
    const attempt = ++heads;
    return { collection: "agents", session: state("a", "idle"), next_cursor: attempt === 1 ? "stale" : null,
      items: [{ session_id: "a", run_id: `run${attempt}`, status: "finished" }, { session_id: "ab", run_id: "wrong", status: "running" }] };
  });
  const detail = await reader.collection("a", "agents", signal());
  expect([detail.items.map((item) => item.id), detail.omitted, calls.map(([, p]) => p.cursor)]).toEqual([["run2"], 1, [null, "stale", null]]);
});

test.each([
  { name: "attached", attached: row("a"), method: "session_history" },
  { name: "other in the same project (both null)", attached: row("b"), method: "session_history_read" },
  { name: "idle scope allows the read", attached: null, method: "session_history_read" },
  { name: "session outside the read scope", attached: null, method: "session_history_read", failure: { code: -32602, data: { code: "session_not_found" } }, error: "the transcript is not available" },
  { name: "invalid parameters are not session_not_found", attached: null, method: "session_history_read", failure: { code: -32602, data: { code: "invalid_params" } }, error: "could not read from zeta" },
  { name: "serve cannot read while idle", attached: null, method: "session_history_read", failure: { code: -32005, data: { code: "state_unavailable" } }, error: "zeta could not read this data right now" },
  { name: "method not implemented", attached: row("b"), method: "session_history_read", failure: { code: -32601 }, error: "needs a newer zeta to read this transcript without opening the session" },
])("transcript access: $name", async ({ attached, method, error, failure }) => {
  const { reader, calls } = serve((name) => {
    if (name === "list_sessions") return { sessions: [row("a")], next_offset: null };
    if (name === "state_sessions") return { items: [], next_cursor: null };
    if (name === "status") return { session: attached };
    if (failure) throw failure;
    return { messages: [{ id: "message", role: "user", content: [] }, { id: "broken", role: "assistant", content: [{ type: "tool_use" }] }], next_cursor: null, next_offset: null };
  });
  const [session] = (await reader.catalog(signal())).items;
  calls.length = 0;
  const read = reader.transcript(session!, undefined, signal());
  if (error) expect(await read.then(() => "read succeeded", readError)).toBe(error);
  else expect((await read).rows).toEqual([{ id: "message", role: "user", content: [] }]);
  expect(calls.map(([name]) => name)).toEqual(["status", ...(method ? [method] : [])]);
});

test("a stale history cursor discards the partial walk and retries the head only once", async () => {
  let heads = 0;
  const { reader, calls } = serve((name, p) => {
    if (name === "list_sessions") return { sessions: [row("a")], next_offset: null };
    if (name === "state_sessions") return { items: [], next_cursor: null };
    if (name === "status") return { session: row("b") };
    if (p.cursor || ++heads > 2) throw { code: -32009 };
    return { messages: [{ role: "user", id: `message-${heads}`, content: [{ type: "text", text: `snapshot ${heads}` }] }], next_cursor: "cursor" };
  });
  const [session] = (await reader.catalog(signal())).items;
  const first = await reader.transcript(session!, undefined, signal());
  const second = await reader.transcript(session!, first, signal());
  expect([second.rows, second.restarted]).toEqual([[{ role: "user", id: "message-2", content: [{ type: "text", text: "snapshot 2" }] }], true]);
  await expect(reader.transcript(session!, second, signal())).rejects.toEqual({ code: -32009 });
  expect(calls.filter(([name]) => name === "session_history_read").map(([, p]) => p.cursor)).toEqual([undefined, "cursor", undefined, "cursor", undefined]);
  expect(calls.some(([name]) => name === "resume")).toBe(false);
});

// zeta's state_attention lists hold the project's whole queue; "a" owns 2 decisions and 1 deferred item, "b" one decision
const item = (id: string, session_id: string, kind: string) => ({ attention_id: id, project_id: null, session_id, kind,
  requires_action: kind === "decision" || kind === "deferred", status: "open", title: `synthetic ${kind} ${id}`, created_ns: 1_800_000_000_000_000_000, updated_ns: 1 });
const queue = { action: [item("d1", "a", "decision"), item("o1", "b", "decision"), item("d2", "a", "deferred")], fyi: [item("n1", "a", "answer"), item("n2", "a", "decided")] };
function attentionZeta(open: number, lists: Record<string, unknown[]> = queue) {
  return serve((method, p) => method === "list_sessions" ? { sessions: [row("a"), row("b")], next_offset: null }
    : method === "state_sessions" ? { items: [{ ...state("a", "idle"), attention_open: open }], next_cursor: null }
    : method === "state_attention" ? lists[String(p.list)] && !p.cursor ? { items: lists[String(p.list)], next_cursor: null, as_of_ns: 1 } : Promise.reject({ code: -32602 })
    : Promise.reject({ code: -32601 }));
}

test("the attention badge counts exactly the listed open decisions and deferred items", async () => {
  const { reader, calls } = attentionZeta(2);
  const [a] = (await reader.catalog(signal())).items;
  const listed = await reader.attention?.(a!, signal());
  expect([a!.state?.attention, listed?.decisions.length]).toEqual([2, 2]);
  expect(calls.filter(([method]) => method === "state_attention").map(([, p]) => p)).toEqual([
    { list: "action", cursor: null, limit: 200 }, { list: "fyi", cursor: null, limit: 200 },
  ]);
});

test("decisions and FYI notes come from zeta's split lists and stay apart", async () => {
  const { reader } = attentionZeta(2);
  const [a] = (await reader.catalog(signal())).items;
  const listed = await reader.attention?.(a!, signal());
  expect([listed?.decisions.map(({ id, kind }) => [id, kind]), listed?.notes.map(({ id, kind }) => [id, kind])]).toEqual([
    [["d1", "decision"], ["d2", "deferred"]], [["n1", "answer"], ["n2", "decided"]],
  ]);
  // a note in the action list (or the reverse) is malformed, not a decision
  const swapped = attentionZeta(0, { action: [item("n1", "a", "answer")], fyi: [item("d1", "a", "decision")] });
  const [b] = (await swapped.reader.catalog(signal())).items;
  expect(await swapped.reader.attention?.(b!, signal())).toMatchObject({ decisions: [], notes: [], omitted: 2 });
});

test("an older zeta has no attention place", async () => {
  const offered = serve(() => null, ["state_read_v1"]).reader.attention;
  const older = createSessionsReader({ features: ["state_read_v1"], request: async () => null } as unknown as ZetaClient, (method) => method !== "state_attention").attention;
  expect([typeof offered, typeof older]).toEqual(["function", "undefined"]);
  // a zeta before the split refuses the list param
  const { reader } = attentionZeta(0, {});
  const [a] = (await reader.catalog(signal())).items;
  expect(await reader.attention?.(a!, signal()).then(() => "listed", readError)).toBe("the attention list needs a newer zeta");
});

test("a resident in-use row is not owned elsewhere", async () => {
  const { reader } = serve((method) => method === "list_sessions" ? { sessions: [
    { ...row("grace"), in_use: true, resident: true }, { ...row("other"), in_use: true, resident: false },
    { ...row("old"), in_use: true }, { ...row("bad"), in_use: true, resident: "yes" },
  ], next_offset: null } : method === "status" ? { session: null } : { items: [], next_cursor: null });
  const reply = await reader.catalog(signal());
  expect(reply.items.map(({ id, inUse, resident }) => [id, inUse, resident])).toEqual([
    ["grace", true, true], ["other", true, false], ["old", true, false],
  ]);
  expect(reply.omitted).toBe(1);
});
