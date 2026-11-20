import { expect, test } from "bun:test";
import type { Chat } from "../surface/AgentNavAdapter";
import { buildAcknowledgements, createBuildReader, projectBuilds } from "./buildActivity";

const chat: Chat = { session_id: "reading-build", purpose: "page_build", page_id: "home", page_route: "/", page_title: "home", title: "a synthetic reading list", last_state: "running", created_at: "2030-01-01", updated_at: "2030-01-01" };
// Observed from a scripted create_page call on the pinned real Zeta server.
const result = {
  id: "eb27aa42805b407ab62a75ed25e8a338",
  role: "tool_result",
  content: [{ type: "text", text: '{"detail_filter_matches": [], "digest": "feada5cd77e082c59d63adb88e51218f0c87d61ea66f1b5b28fc3d31d5e01982", "existing": false, "page_id": "06b6531f0662009cf9c8e086", "route": "/reading-list"}' }],
  tool_result: { tool_call_id: "create-reading-list", content: '{"detail_filter_matches": [], "digest": "feada5cd77e082c59d63adb88e51218f0c87d61ea66f1b5b28fc3d31d5e01982", "existing": false, "page_id": "06b6531f0662009cf9c8e086", "route": "/reading-list"}', is_error: false, content_blocks: [], structured_content: null },
};
const call = (id = "create-reading-list", name = "achilles__create_page") => ({ role: "assistant", content: [{ type: "tool_use", tool_call: { id, name, arguments: { route: "/reading-list" }, arguments_truncated: false } }] });
const end = { role: "system", event: "served_turn_end", data: { turn_id: "reading-turn", reason: "completed" } };
const reading = { id: "06b6531f0662009cf9c8e086", route: "/reading-list", title: "reading list" };
const expenses = { id: "expenses", route: "/expenses", title: "expenses" };
const status = { session: { session_id: chat.session_id }, state: "idle", pending_approvals: [], last_turn_outcome: end.data };
const storage = () => {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
};
const fixture = (seen = buildAcknowledgements(storage)) => {
  let values: Parameters<typeof projectBuilds>[2] = new Map();
  const reader = createBuildReader((next) => { values = next; }, () => {});
  const project = (pages = [reading], chats = [chat]) => projectBuilds(chats, pages, values, seen);
  const read = (messages: unknown[], presence: unknown = status) => reader.refresh([chat], async (method, params) => {
    if (method === "status") return presence;
    expect(method).toBe("session_history");
    expect(params).toEqual({ session_id: chat.session_id, before: null });
    return { messages };
  });
  return { ...reader, project, read };
};

test("only page-build purposes appear; result links require the page catalog", async () => {
  const f = fixture();
  await f.read([call(), result, end]);
  const rows = f.project([reading], [{ ...chat, purpose: "chat", session_id: "ordinary" }, chat]).rows;
  expect(rows.map(({ chat }) => chat.session_id)).toEqual([chat.session_id]);
  expect(f.project([]).rows[0]).toMatchObject({ state: "unfinished", results: [] });
  expect(f.project([]).latestReceipt).toBeNull();
  expect(f.project().latestReceipt?.page).toEqual(reading);
});

test("only observed successful create_page results count, in result order; a later success clears tool failure", async () => {
  const f = fixture();
  const malformed = { ...result, tool_result: { ...result.tool_result, content: "not JSON" } };
  const missingRoute = { ...result, tool_result: { ...result.tool_result, content: '{"existing":true}' } };
  for (const messages of [[call(undefined, "another__create_page"), result], [result], [call(), malformed], [call(), missingRoute]]) {
    await f.read([...messages, end]);
    expect(f.project().rows[0]).toMatchObject({ state: "unfinished", results: [] });
  }
  const error = { ...result, tool_result: { ...result.tool_result, tool_call_id: "error", is_error: true } };
  await f.read([call("error"), error, end]);
  expect(f.project().rows[0]?.state).toBe("failed");
  const existing = { ...result, tool_result: { ...result.tool_result, tool_call_id: "existing", content: '{"route":"/expenses","existing":true}' } };
  await f.read([call(), result, call("error"), error, call("existing"), existing, end]);
  expect(f.project([reading, expenses]).rows[0]).toMatchObject({ state: "done", results: [reading, expenses] });
  expect(f.project([reading, expenses]).latestReceipt?.page).toEqual(reading);
  expect(f.project([expenses]).latestReceipt).toBeNull();
});

test("live activity, stale history and inactive history never invent completion", async () => {
  const f = fixture();
  try {
    await f.read([call()], { ...status, state: "tool", pending_approvals: [{ tool_call: { name: "achilles__create_page" } }] });
    expect(f.project().rows[0]).toMatchObject({ state: "needs you", stale: false, tools: ["achilles__create_page"] });
    await f.refresh([chat], async (method) => {
      if (method === "status") return status;
      throw Error("offline");
    });
    expect(f.project().rows[0]).toMatchObject({ state: "needs you", stale: true });
    expect(f.project().latestReceipt).toBeNull();
    await f.read([call(), result, end]);
    expect(f.project().rows[0]).toMatchObject({ state: "done", stale: false });
    await f.read([], { ...status, session: { session_id: "other" } });
    expect(f.project().rows[0]).toMatchObject({ state: "done", stale: true });
    const fresh = fixture();
    await fresh.refresh([chat]);
    await fresh.read([], { ...status, session: { session_id: "other" } });
    expect(fresh.project().rows[0]).toMatchObject({ state: "unfinished", stale: true, results: [] });
  } finally { f.stop(); }
});

test("a late response cannot replace a newer projection or publish after stop", async () => {
  const f = fixture();
  const controlled = () => {
    const waiting = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const done = f.refresh([chat], async (method, _, options) => {
      if (method === "status") return status;
      entered.resolve(options?.signal);
      return waiting.promise;
    });
    return { done, waiting, entered };
  };
  const old = controlled();
  let unmounted: ReturnType<typeof controlled> | undefined;
  try {
    const signal = await old.entered.promise;
    await f.read([call(), result, end]);
    expect(signal?.aborted).toBe(true);
    old.waiting.resolve({ messages: [] });
    await old.done;
    expect(f.project().latestReceipt?.page).toEqual(reading);
    unmounted = controlled();
    const unmountedSignal = await unmounted.entered.promise;
    f.stop();
    unmounted.waiting.resolve({ messages: [] });
    await unmounted.done;
    expect(unmountedSignal?.aborted).toBe(true);
    expect(f.project().latestReceipt?.page).toEqual(reading);
  } finally { f.stop(); old.waiting.resolve({ messages: [] }); unmounted?.waiting.resolve({ messages: [] }); }
}, 2000);

test("a receipt acknowledgement survives reload in one tab only", async () => {
  const tab = storage();
  const seen = buildAcknowledgements(() => tab);
  const f = fixture(seen);
  await f.read([call(), result, end]);
  expect(f.project().latestReceipt?.page).toEqual(reading);
  seen.add(chat.session_id, reading.route);
  expect(f.project().latestReceipt).toBeNull();
  const reload = fixture(buildAcknowledgements(() => tab));
  const otherTab = fixture(buildAcknowledgements(storage));
  await reload.read([call(), result, end]);
  await otherTab.read([call(), result, end]);
  expect(reload.project().latestReceipt).toBeNull();
  expect(otherTab.project().latestReceipt?.page).toEqual(reading);
});

test("a runtime switch between status and history is inactive, not a generic outage", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const history = Promise.withResolvers<never>();
  const pending = f.refresh([chat], async (method) => {
    if (method === "status") return { ...status, state: "running" };
    entered.resolve();
    return history.promise;
  });
  try {
    await entered.promise;
    history.reject(Object.assign(new Error("session is not active"), { code: -32003 }));
    await pending;
    expect(f.project().rows[0]).toMatchObject({ state: "unfinished", stale: true, results: [] });
  } finally {
    f.stop();
    history.reject(new Error("test cleanup"));
    await pending;
  }
}, 2000);
