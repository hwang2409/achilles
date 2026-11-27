import { afterEach, beforeEach, expect, test } from "bun:test";
import { parkedRows, refreshParked, takeParkedEvent } from "./parked";
import { forgetRowWrites, rowState, subscribeRowWrites, verifyChatStates, writeShownState, type RowState } from "./rowState";

// achilles' chat rows as the server keeps them: each state write adds 1 to state_version, and a write with an expected
// row is a compare-and-set (the row unchanged when it changed since the read), as in PageStore.update_chat
type Row = { last_state: RowState | null; state_version: number };
let server = new Map<string, Row>();
let stored = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  server = new Map(); stored = 0;
  forgetRowWrites();
  sessionStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = decodeURIComponent(String(input).split("/").at(-1)!);
    const body = JSON.parse(String(init?.body)) as { last_state: RowState; expected_last_state?: RowState | null; expected_state_version?: number };
    const row = server.get(id);
    if (!row) return new Response(null, { status: 404 });
    if (body.expected_state_version !== undefined && (row.last_state !== body.expected_last_state || row.state_version !== body.expected_state_version)) { stored += 1; return Response.json(row); }
    server.set(id, { last_state: body.last_state, state_version: row.state_version + 1 });
    stored += 1;
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const event = (data: object) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "parked_session_changed", session_id: "c", data } });
type Step =
  // this tab shows the chat, and its header state changes
  | { attached: RowState }
  // this tab keeps the chat parked: zeta reports a change, or closed
  | { parked: { state: string; pending_approvals?: number } }
  // another tab's chat list load checks the row with zeta (null: session_not_found); `meanwhile` runs while zeta answers
  | { verify: string | null; meanwhile?: Step[] };
type RowCase = { name: string; stored: RowState | null; parkedAtStart?: boolean; steps: Step[]; shown: (RowState | null)[]; reads?: number; writes?: number };
const rows: RowCase[] = [
  { name: "the shown chat runs, then goes idle", stored: null, steps: [{ attached: "running" }, { attached: "idle" }], shown: ["running", "idle"] },
  { name: "the holder writes a state it already wrote once", stored: null, steps: [{ attached: "running" }, { attached: "running" }, { attached: "idle" }, { attached: "idle" }], shown: ["running", "running", "idle", "idle"], writes: 2 },
  { name: "a parked chat goes idle (only a background agent works), then closes", stored: "running", parkedAtStart: true, steps: [{ parked: { state: "idle" } }, { parked: { state: "closed" } }], shown: ["running", "idle"] },
  { name: "a parked chat that closes while it runs", stored: "running", parkedAtStart: true, steps: [{ parked: { state: "closed" } }], shown: ["idle"] },
  { name: "a parked chat needs you, then runs on", stored: "running", parkedAtStart: true, steps: [{ parked: { state: "running", pending_approvals: 1 } }, { parked: { state: "running" } }], shown: ["approval", "running"] },
  { name: "the stale row of a closed tab", stored: "running", steps: [{ verify: "idle" }], shown: ["idle"] },
  { name: "a stale row whose zeta session is gone settles, and is not read again", stored: "approval", steps: [{ verify: null }, { verify: null }], shown: ["idle", "idle"], reads: 1 },
  { name: "a stale row whose last turn failed keeps failed", stored: "running", steps: [{ verify: "failed" }], shown: ["failed"] },
  { name: "an unknown zeta status changes nothing", stored: "running", steps: [{ verify: "mystery" }], shown: ["running"] },
  { name: "another tab's late idle never overwrites the holder's newer turn", stored: "running", steps: [{ verify: "idle", meanwhile: [{ attached: "idle" }, { attached: "running" }] }], shown: ["running"] },
];

test.each(rows)("a chat row's state: $name", async (row) => {
  server.set("c", { last_state: row.stored, state_version: 0 });
  const reads: string[] = [];
  let meanwhile: Step[] = [];
  const client = { request: async (method: string, params: { session_id?: string }) => {
    if (method === "status") return { parked_sessions: row.parkedAtStart ? [{ session_id: "c", state: "running", pending_approvals: 0 }] : [] };
    reads.push(params.session_id!);
    const status = (row.steps.find((step) => "verify" in step) as { verify: string | null }).verify;
    for (const step of meanwhile.splice(0)) await run(step);
    if (status === null) throw Object.assign(new Error("resource not found"), { code: -32602, data: { code: "session_not_found" } });
    return { session: { session_id: "c", status }, items: [] };
  } };
  async function run(step: Step) {
    if ("attached" in step) await writeShownState("c", step.attached);
    else if ("parked" in step) { takeParkedEvent(client, event({ pending_approvals: 0, ...step.parked })); await new Promise((resolve) => setTimeout(resolve, 0)); }
    else { meanwhile = step.meanwhile ?? []; await verifyChatStates(client as never, [{ session_id: "c", ...server.get("c")! }], new Set()); }
  }
  let reloads = 0;
  const unsubscribe = subscribeRowWrites(() => { reloads += 1; });
  await refreshParked(client as never);
  const shown: (RowState | null)[] = [];
  for (const step of row.steps) {
    await run(step);
    const parked = parkedRows(client).find((entry) => entry.session_id === "c");
    shown.push(rowState(server.get("c")!.last_state, parked && { from: "parked", row: parked }).shown);
  }
  expect(shown, "the row's state after each step").toEqual(row.shown);
  expect(server.get("c")!.last_state, "the stored state every tab reads").toBe(row.shown.at(-1)!);
  if (row.reads !== undefined) expect(reads).toHaveLength(row.reads);
  if (row.writes !== undefined) expect(stored, "chat writes").toBe(row.writes);
  // each answered write (stored, or a lost compare-and-set) loads every sidebar's list again, so no row waits for a reload
  expect(reloads, "a stored state did not reload the chat list").toBe(stored);
  unsubscribe();
});

test("this tab's chat write posts to the other tabs; another tab's post reloads this list as remote", async () => {
  server.set("c", { last_state: "idle", state_version: 0 });
  const causes: boolean[] = [];
  const posts: unknown[] = [];
  const unsubscribe = subscribeRowWrites((remote) => { causes.push(remote); });
  const otherTab = new BroadcastChannel("achilles:chats");
  otherTab.addEventListener("message", (event) => { posts.push(event.data); });
  try {
    await writeShownState("c", "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts, "the other tab did not hear this tab's write").toEqual(["c"]);
    expect(causes, "this tab's own write: a local reload, and its post does not come back to it").toEqual([false]);
    otherTab.postMessage("c");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(causes, "another tab's post reloads the list as remote").toEqual([false, true]);
    // the other tab wrote the chat, so this tab's same state is no longer known stored: it writes it again
    await writeShownState("c", "running");
    expect(stored, "the write after another tab's write was skipped").toBe(2);
  } finally { otherTab.close(); unsubscribe(); }
});
