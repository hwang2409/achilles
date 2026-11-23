import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createSessionsReader } from "./reads";

const signal = () => new AbortController().signal;
const row = (id: string, project_id: string | null = null) => ({ session_id: id, name: `session ${id}`, project_id });
const state = (id: string, status: string) => ({ session_id: id, status, child_count: 0, background_count: 1, title: "not authoritative" });
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
  expect(reply.items.map(({ id, title, status, state }) => [id, title, status, state?.tasks])).toEqual([
    ["a", "session a", "unknown", undefined], ["ab", "session ab", "running", 1], ["b", "session b", "unknown", undefined],
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
  let release!: (reply: unknown) => void;
  let overlay = 0;
  let failMetadata = false;
  const { reader } = serve((method) => method === "list_sessions" ? failMetadata ? { sessions: null } : { sessions: [row("a")], next_offset: null }
    : ++overlay === 1 ? new Promise((answer) => { release = answer; })
    : overlay === 2 ? { items: [state("a", "running")], next_cursor: null }
    : Promise.reject({ code: -32005 }));
  const first = reader.catalog(signal());
  const fresh = await reader.catalog(signal());
  release({ items: [state("a", "idle")], next_cursor: null });
  await expect(first).rejects.toHaveProperty("name", "AbortError");
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
  { name: "other project", attached: row("b", "elsewhere"), error: "attached session’s project" },
  { name: "project unknown", attached: { session_id: "b" }, error: "attached session’s project" },
  { name: "no attached session", attached: null, error: "no attached session" },
  { name: "method not implemented", attached: row("b"), method: "session_history_read", missing: true, error: "needs a newer zeta" },
])("transcript access: $name", async ({ attached, method, error, missing }) => {
  const { reader, calls } = serve((name) => {
    if (name === "list_sessions") return { sessions: [row("a")], next_offset: null };
    if (name === "state_sessions") return { items: [], next_cursor: null };
    if (name === "status") return { session: attached };
    if (missing) throw { code: -32601 };
    return { messages: [{ id: "message", role: "user", content: [] }, { id: "broken", role: "assistant", content: [{ type: "tool_use" }] }], next_cursor: null, next_offset: null };
  });
  const [session] = (await reader.catalog(signal())).items;
  calls.length = 0;
  const read = reader.transcript(session!, undefined, signal());
  if (error) await expect(read).rejects.toThrow(error);
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
