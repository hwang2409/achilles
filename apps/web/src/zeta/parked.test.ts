import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Transport } from "@fulcrum/zeta";
import { holdAttached, parkedRows, readHeld, reclaimHeld, refreshParked, stopParked, StopError, subscribeParked, takeParkedEvent } from "./parked";
import { controlledRetry } from "./session";
import { teeRunEnds } from "./turnEnd";

const event = (sessionId: string, data: object) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "parked_session_changed", session_id: sessionId, data } });
let patches: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  patches = [];
  sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { patches.push(`${String(input)} ${String(init?.body)}`); return new Response(null, { status: 204 }); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("transport tee", () => {
  test("a parked_session_changed frame goes to the parked owner and never to fulcrum; other frames pass unchanged", () => {
    let deliver: (text: string) => void = () => {};
    const transport = { send() {}, close() {}, onMessage(callback: (text: string) => void) { deliver = callback; } } as unknown as Transport;
    const client = {};
    const forwarded: string[] = [];
    teeRunEnds(transport, () => client).onMessage((text) => forwarded.push(text));
    const other = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "message_update", session_id: "a", text: "parked_session_changed" } });
    const broken = '{"method":"event","params":{"event":"parked_session_changed"';
    deliver(event("a", { session_id: "a", state: "running", pending_approvals: 0 }));
    deliver(other);
    deliver(broken);
    expect(forwarded).toEqual([other, broken]);
    expect(parkedRows(client)).toEqual([{ session_id: "a", state: "running", pending_approvals: 0 }]);
  });
});

describe("parked owner", () => {
  test("status rows, then events in order: a new chat appends, a change updates, closed removes", async () => {
    const client = { request: async () => ({ parked_sessions: [{ session_id: "a", state: "running", pending_approvals: 0 }, { session_id: "bad" }, { session_id: "b", state: "idle", pending_approvals: 0 }] }) };
    let notified = 0;
    subscribeParked(client, () => { notified += 1; });
    await refreshParked(client as never);
    expect(parkedRows(client).map((row) => row.session_id)).toEqual(["a", "b"]);
    takeParkedEvent(client, event("c", { state: "running", pending_approvals: 0 }));
    takeParkedEvent(client, event("a", { state: "running", pending_approvals: 1 }));
    takeParkedEvent(client, event("b", { state: "closed", pending_approvals: 0 }));
    expect(parkedRows(client)).toEqual([{ session_id: "a", state: "running", pending_approvals: 1 }, { session_id: "c", state: "running", pending_approvals: 0 }]);
    expect(notified).toBe(4);
    // only a change of the shown state writes the chat's last_state, for every tab's sidebar; a chat joining the parked
    // list ran no new turn, so it keeps its place in the list (ux m-6: a stopped chat parked again jumped to the top)
    expect(patches).toEqual(['/api/chats/c {"last_state":"running"}', '/api/chats/a {"last_state":"approval"}', '/api/chats/b {"last_state":"idle"}']);
    // parked and idle: zeta keeps it for its work (a background agent), so the row reads running, never blank
    takeParkedEvent(client, event("a", { state: "idle", pending_approvals: 0 }));
    expect(patches.at(-1)).toBe('/api/chats/a {"last_state":"running"}');
  });

  test("each connection has its own rows", () => {
    const one = {}; const two = {};
    takeParkedEvent(one, event("a", { state: "running", pending_approvals: 0 }));
    expect(parkedRows(two)).toEqual([]);
  });

  test("the tab's held chats are stored as ids only", () => {
    const client = {};
    holdAttached("shown");
    takeParkedEvent(client, event("a", { state: "running", pending_approvals: 2 }));
    expect(readHeld()).toEqual({ attached: "shown", parked: ["a"] });
    expect(JSON.parse(sessionStorage.getItem("achilles:held")!)).toEqual({ attached: "shown", parked: ["a"] });
  });
});

describe("stopParked", () => {
  const binding = { cwd: "/w", mcp_bindings: [{ server: "achilles", headers: { Authorization: "Bearer x" } }] };
  const zeta = (fail: Record<string, object> = {}) => {
    const sent: string[] = [];
    return { sent, client: { request: async (method: string, params: { session_id?: string }) => {
      sent.push(`${method} ${params.session_id ?? ""}`.trim());
      if (fail[method]) throw fail[method];
      return method === "status" ? { parked_sessions: [] } : {};
    } } };
  };

  test("resumes the chat before it aborts it, then reads the parked list again", async () => {
    const { sent, client } = zeta();
    expect(await stopParked(client as never, "a", async () => binding, () => true)).toBe(true);
    expect(sent).toEqual(["resume a", "abort a", "status"]);
    // its row reads idle before it leaves the parked list (no "running" flash); if it still holds work, it parks again
    expect(patches).toEqual(['/api/chats/a {"last_state":"idle"}']);
  });

  test.each([
    ["held by another client", { code: -32014, data: { code: "session_controlled" } }],
    ["gone", { code: -32014, data: { code: "session_not_found" } }],
    ["not this tab's", { code: -32003 }],
  ])("a chat that already left (%s) is not aborted", async (_name, error) => {
    const { sent, client } = zeta({ resume: Object.assign(new Error("refused"), error) });
    expect(await stopParked(client as never, "a", async () => binding, () => true)).toBe(false);
    expect(sent).toEqual(["resume a"]);
  });

  test("an unlisted chat sends nothing", async () => {
    const { sent, client } = zeta();
    expect(await stopParked(client as never, "a", async () => null, () => true)).toBe(false);
    expect(sent).toEqual([]);
  });

  test("another resume error stops the chain with it", async () => {
    const { sent, client } = zeta({ resume: new Error("zeta is restarting") });
    await expect(stopParked(client as never, "a", async () => binding, () => true)).rejects.toThrow("zeta is restarting");
    expect(sent).toEqual(["resume a"]);
  });

  test("an abort error stops the chain with its message", async () => {
    const { sent, client } = zeta({ abort: new Error("abort failed") });
    const caught = await stopParked(client as never, "a", async () => binding, () => true).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(StopError);
    expect((caught as Error).message).toBe("abort failed");
    // zeta now has the chat attached and the shown one parked: the list is read again
    expect(sent).toEqual(["resume a", "abort a", "status"]);
    expect(patches).toEqual([]);
  });

  test("a stale attachment stops before zeta changes", async () => {
    const { sent, client } = zeta();
    await expect(stopParked(client as never, "a", async () => binding, () => false)).rejects.toThrow("request aborted");
    expect(sent).toEqual([]);
  });
});

describe("reclaimHeld", () => {
  const binding = { cwd: "/w", mcp_bindings: [{ server: "achilles", headers: { Authorization: "Bearer x" } }] };
  const hold = (attached: string, parked: string[]) => sessionStorage.setItem("achilles:held", JSON.stringify({ attached, parked }));
  const refusal = (data: object, code = -32014) => Object.assign(new Error("refused"), { code, data });
  // answers each resume from `answers[id]` in turn (an error to throw, or "ok"), and records every request
  const zeta = (answers: Record<string, Array<Error | "ok">> = {}) => {
    const sent: string[] = [];
    return { sent, client: { request: async (method: string, params: { session_id?: string; mcp_bindings?: unknown }) => {
      if (method === "status") { sent.push("status"); return { parked_sessions: [] }; }
      sent.push(`${method} ${params.session_id}${params.mcp_bindings ? "" : " (no binding)"}`);
      const answer = answers[params.session_id!]?.shift() ?? "ok";
      if (answer !== "ok") throw answer;
      return {};
    } } };
  };
  const realWait = controlledRetry.wait;
  let waits = 0;
  beforeEach(() => { waits = 0; controlledRetry.wait = async () => { waits += 1; }; });
  afterEach(() => { controlledRetry.wait = realWait; });

  test("parked chats oldest first, the shown chat last, the target left out; then the parked list is read", async () => {
    hold("shown", ["p1", "p2", "target"]);
    const { sent, client } = zeta();
    await reclaimHeld(client as never, "target", async () => binding);
    expect(sent).toEqual(["resume p1", "resume p2", "resume shown", "status"]);
  });

  test("once per connection: every attach on it waits for the same reclaim", async () => {
    hold("shown", ["p1"]);
    const { sent, client } = zeta();
    await Promise.all([reclaimHeld(client as never, null, async () => binding), reclaimHeld(client as never, null, async () => binding)]);
    await reclaimHeld(client as never, null, async () => binding);
    expect(sent).toEqual(["resume p1", "resume shown", "status"]);
  });

  test("nothing held sends nothing", async () => {
    const { sent, client } = zeta();
    await reclaimHeld(client as never, null, async () => binding);
    expect(sent).toEqual([]);
  });

  test("a chat held elsewhere is retried from one budget shared by all chats, then dropped", async () => {
    hold("shown", ["p1", "p2"]);
    const controlled = () => refusal({ code: "session_controlled" });
    // p1 is free after 2 retries (the old socket closed); p2 stays held and spends the last retry; shown is not retried
    const { sent, client } = zeta({ p1: [controlled(), controlled()], p2: [controlled(), controlled(), controlled()], shown: [controlled()] });
    await reclaimHeld(client as never, null, async () => binding);
    expect(sent).toEqual(["resume p1", "resume p1", "resume p1", "resume p2", "resume p2", "resume shown", "status"]);
    expect(waits).toBe(3);
  });

  test("a missing chat, one that is not ours, or one achilles no longer lists is dropped", async () => {
    hold("shown", ["gone", "theirs", "unlisted"]);
    const { sent, client } = zeta({ gone: [refusal({ code: "session_not_found" })], theirs: [refusal({}, -32003)] });
    await reclaimHeld(client as never, null, async (id) => id === "unlisted" ? null : binding);
    expect(sent).toEqual(["resume gone", "resume theirs", "resume shown", "status"]);
  });

  test("resident_limit stops the reclaim", async () => {
    hold("shown", ["p1", "p2"]);
    const { sent, client } = zeta({ p1: [refusal({ reason: "resident_limit" }, -32004)] });
    await reclaimHeld(client as never, null, async () => binding);
    expect(sent).toEqual(["resume p1", "status"]);
  });

  // the url is the tab's chat, read at each attach: the first attach's target (left to it) is taken back when a later
  // attach on the connection opens another chat before the first one resumed it
  test("a later attach with another target takes back the first target too", async () => {
    hold("shown", ["p1"]);
    const { sent, client } = zeta();
    const first = reclaimHeld(client as never, "shown", async () => binding);
    const later = reclaimHeld(client as never, "other", async () => binding);
    await Promise.all([first, later]);
    await reclaimHeld(client as never, "other", async () => binding);
    expect(sent).toEqual(["resume p1", "status", "resume shown", "status"]);
  });
});
