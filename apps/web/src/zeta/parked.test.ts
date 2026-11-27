import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Transport } from "@fulcrum/zeta";
import { holdAttached, parkedRows, readHeld, refreshParked, stopParked, StopError, subscribeParked, takeParkedEvent } from "./parked";
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
    // only a change of the shown state writes the chat's last_state, for every tab's sidebar
    expect(patches).toEqual(['/api/chats/c {"last_state":"running"}', '/api/chats/a {"last_state":"approval"}']);
    takeParkedEvent(client, event("a", { state: "idle", pending_approvals: 0 }));
    expect(patches.at(-1)).toBe('/api/chats/a {"last_state":"idle"}');
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
    expect(sent).toEqual(["resume a", "abort a"]);
    expect(patches).toEqual([]);
  });

  test("a stale attachment stops before zeta changes", async () => {
    const { sent, client } = zeta();
    await expect(stopParked(client as never, "a", async () => binding, () => false)).rejects.toThrow("request aborted");
    expect(sent).toEqual([]);
  });
});
