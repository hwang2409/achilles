import "../test-dom";
import { afterEach, expect, jest, test } from "bun:test";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { AppShell } from "../AppShell";
import { useAgentNavAdapter } from "../surface/AgentNavAdapter";
import { ShellDockSlot } from "../surface/ModuleState";
import { chatsRoute } from "../surface/routes";
import type { Transport, ZetaClient } from "@fulcrum/zeta";
import { teeRunEnds } from "../zeta/turnEnd";
import type { Chat, PageLink } from "../surface/AgentNavAdapter";
import { buildLabel, useBuildActivity } from "./buildActivity";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const chat: Chat = { session_id: "reading-build", purpose: "page_build", page_id: "home", page_route: "/", page_title: "home", title: "a synthetic reading list", last_state: "running", created_at: "2030-01-01", updated_at: "2030-01-01" };
const habit: Chat = { ...chat, session_id: "habit-build", title: "a synthetic habit log" };
const third: Chat = { ...chat, session_id: "third-build", title: "a synthetic expense log" };
const ordinary: Chat = { ...chat, session_id: "ordinary", purpose: "chat", title: "an ordinary chat" };
// Observed from a scripted create_page call on the pinned real Zeta server.
const resultContent = '{"detail_filter_matches": [], "digest": "feada5cd77e082c59d63adb88e51218f0c87d61ea66f1b5b28fc3d31d5e01982", "existing": false, "page_id": "06b6531f0662009cf9c8e086", "route": "/reading-list"}';
const result = {
  id: "eb27aa42805b407ab62a75ed25e8a338",
  role: "tool_result",
  content: [{ type: "text", text: resultContent }],
  tool_result: { tool_call_id: "create-reading-list", content: resultContent, is_error: false, content_blocks: [], structured_content: null },
};
const resultOf = (id: string, content: string, is_error = false) => ({ ...result, tool_result: { ...result.tool_result, tool_call_id: id, content, is_error } });
const call = (id = "create-reading-list", name = "achilles__create_page") => ({ role: "assistant", content: [{ type: "tool_use", tool_call: { id, name, arguments: { route: "/reading-list" }, arguments_truncated: false } }] });
const end = { role: "system", event: "served_turn_end", data: { turn_id: "reading-turn", reason: "completed" } };
const page = (id: string, route: string, title: string): PageLink => ({ id, route, title, created_at: "2030-01-01", updated_at: "2030-01-01", create_mode: false, chat_count: 0, created_by_route: "/" });
const reading = page("06b6531f0662009cf9c8e086", "/reading-list", "reading list");
const expenses = page("expenses", "/expenses", "expenses");
const idle = (id = chat.session_id) => ({ session: { session_id: id }, state: "idle", pending_approvals: [], last_turn_outcome: end.data });
const runningOf = (id = chat.session_id) => ({ ...idle(id), state: "running" });
const running = runningOf();
const approval = { ...idle(), state: "tool", pending_approvals: [{ tool_call: { name: "achilles__create_page" } }] };
const offline = Error("socket closed");
const inactive = Object.assign(Error("session is not active"), { code: -32003 });
const done = [call(), result, end];
const madeExpenses = [call("expenses-call"), resultOf("expenses-call", '{"route":"/expenses"}'), end];
// This tab watched the build run: a live pass saw it running before it finished.
const ran = (id = chat.session_id): Load => ({ status: runningOf(id), history: [call(id === chat.session_id ? undefined : "expenses-call")] });

/** One page load: zeta's status reply, and the history reply when the status names a build. */
type Load = { status: object | Error; history?: unknown[] | Error; superseded?: unknown[]; older?: boolean };
type Shown = { state: string | null; reason?: string | null; results?: string[]; tools?: string[] };
type Row = { name: string; loads: Load[]; recover?: Load; chats?: Chat[]; pages?: PageLink[]; id?: string; shown: Shown; building?: number; needsYou?: number; receipt?: string | null; dismiss?: number; cold?: boolean; at?: string };

// Each load is a fresh page load in the same tab (same sessionStorage); the last one is asserted.
const ROWS: Row[] = [
  { name: "active running", loads: [{ status: running, history: [call()] }], shown: { state: "building", reason: null, tools: ["achilles__create_page"] }, building: 1, receipt: null },
  { name: "active needs you", loads: [{ status: approval, history: [call()] }], shown: { state: "needs you", reason: null, tools: ["achilles__create_page"] }, needsYou: 1 },
  { name: "seen running, then idle with a confirmed route", loads: [ran(), { status: idle(), history: done }], shown: { state: "done", reason: null, results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "first seen already done on the current session: done, with no receipt", loads: [{ status: idle(), history: done }], shown: { state: "done", reason: null, results: ["/reading-list"] }, receipt: null },
  { name: "L1: a confirmed route outside the loaded catalog is done", pages: [], loads: [ran(), { status: idle(), history: done }], shown: { state: "done", results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "active idle with no result", loads: [{ status: idle(), history: [call(), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "unknown result shapes are not pages", loads: [{ status: idle(), history: [call(undefined, "another__create_page"), result, resultOf("orphan", '{"route":"/expenses"}'), call("bad"), resultOf("bad", "not JSON"), call("bare"), resultOf("bare", '{"existing":true}'), end] }], shown: { state: "unfinished", results: [] } },
  { name: "is_error result", loads: [{ status: idle(), history: [call("error"), resultOf("error", "boom", true), end] }], shown: { state: "failed", reason: null, results: [] } },
  { name: "two results, a failure between them (Q3)", pages: [reading, expenses], loads: [ran(), { status: idle(), history: [call(), result, call("error"), resultOf("error", "boom", true), call("existing"), resultOf("existing", '{"route":"/expenses","existing":true}'), end] }], shown: { state: "done", results: ["/reading-list", "/expenses"] }, receipt: "/reading-list" },
  { name: "duplicate history rows", loads: [{ status: idle(), history: [call(), call(), result, result, end, end] }], shown: { state: "done", results: ["/reading-list"] } },
  { name: "b1: remembered done, then another session is current", loads: [ran(), { status: idle(), history: done }, { status: idle("newer") }], shown: { state: "done", reason: null, results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "remembered done, then zeta offline", loads: [{ status: idle(), history: done }, { status: offline }], shown: { state: "done", reason: null, results: ["/reading-list"] }, building: 0 },
  { name: "acknowledged receipt stays gone after reload", dismiss: 1, loads: [ran(), { status: idle(), history: done }, { status: idle("newer") }], shown: { state: "done" }, receipt: null },
  { name: "m1: remembered building, then zeta offline", loads: [{ status: running, history: [call()] }, { status: offline }], shown: { state: "building", reason: "zeta offline", tools: [] }, building: 0 },
  { name: "remembered building, then -32003 between status and history", loads: [{ status: running, history: [call()] }, { status: running, history: inactive }], shown: { state: "building", reason: "not the current session" }, building: 0 },
  { name: "b1: nothing remembered and not current", loads: [{ status: idle("newer") }], shown: { state: null, results: [] }, building: 0 },
  { name: "m1: nothing remembered and zeta offline", loads: [{ status: offline }], shown: { state: null, results: [] }, building: 0, needsYou: 0 },
  { name: "m2: a sixth page build with persisted running", chats: [chat, habit, ...[1, 2, 3, 4].map((n) => ({ ...chat, session_id: `build-${n}` }))].reverse(), loads: [{ status: idle("newer") }], shown: { state: null }, building: 0 },
  { name: "an ordinary running chat never appears", chats: [ordinary], id: ordinary.session_id, loads: [{ status: running }], shown: { state: "absent" }, building: 0 },
  { name: "an outage during a build, then recovery, is live again", loads: [{ status: running, history: [call()] }, { status: offline }], recover: { status: running, history: [call()] }, shown: { state: "building", reason: null }, building: 1 },
  { name: "a reload shows the kept receipt on the first render, before any catalog or zeta read", cold: true, loads: [ran(), { status: idle(), history: done }, { status: offline }], shown: { state: "absent" }, receipt: "/reading-list" },
  { name: "acknowledging the newest receipt acknowledges older completions (Q1)", chats: [habit, chat], pages: [reading, expenses], dismiss: 3, loads: [ran(), { status: idle(), history: done }, ran(habit.session_id), { status: idle(habit.session_id), history: madeExpenses }, { status: idle("newer") }], shown: { state: "done", results: ["/reading-list"] }, receipt: null },
  { name: "a build that finishes after an acknowledgement shows a new receipt", chats: [third, chat], pages: [reading, expenses], dismiss: 1, loads: [ran(), { status: idle(), history: done }, ran(third.session_id), { status: idle(third.session_id), history: madeExpenses }], shown: { state: "done", results: ["/reading-list"] }, receipt: "/expenses" },
  { name: "a remembered confirmed route survives a later tail without the result", loads: [{ status: idle(), history: done }, { status: idle(), history: [call("later", "achilles__update_page"), end] }], shown: { state: "done", reason: null, results: ["/reading-list"] } },
  { name: "a create_page approval zeta asks again for after a restart is unfinished", loads: [{ status: idle(), history: [call("again"), resultOf("again", "tool changed after approval: achilles__create_page; request a new approval", true), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "a canceled create_page call is unfinished, not failed", loads: [{ status: idle(), history: [call("cancel"), resultOf("cancel", "tool execution canceled", true), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "L7: a tail without the create_page call and nothing remembered is no claim", loads: [{ status: idle(), history: [end], older: true }], shown: { state: null } },
  { name: "L6: a follow-up turn that ends on a build is a new completion", dismiss: 1, loads: [ran(), { status: idle(), history: done }, ran(), { status: { ...idle(), last_turn_outcome: { turn_id: "follow-turn" } }, history: [{ role: "user", content: [] }, { ...end, data: { turn_id: "follow-turn", reason: "completed" } }], older: true }], shown: { state: "done", results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "L6: a build that finished later is the receipt, whatever the chat list order", chats: [chat, habit], pages: [reading, expenses], loads: [ran(), { status: idle(), history: done }, ran(habit.session_id), { status: idle(habit.session_id), history: madeExpenses }], shown: { state: "done" }, receipt: "/expenses" },
  { name: "a denied create_page approval is unfinished, not failed", loads: [{ status: idle(), history: [call("deny"), resultOf("deny", "tool execution denied", true), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "a denial with a reason is unfinished, not failed", loads: [{ status: idle(), history: [call("deny"), resultOf("deny", "tool execution denied: not now", true), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "the tab saw the build idle with no turn end: no last known building later", loads: [{ status: running, history: [call()] }, { status: idle(), history: [call()] }, { status: idle("newer") }], shown: { state: null }, building: 0 },
  { name: "a receipt for the page this tab is on is acknowledged", at: "/reading-list", loads: [ran(), { status: idle(), history: done }, { status: idle("newer") }], shown: { state: "done" }, receipt: null },
  { name: "a stale response arriving after a newer one", loads: [{ status: idle(), history: done, superseded: [call()] }], shown: { state: "done", tools: [] }, building: 0 },
];

function fakeZeta(first: Load, hold = false) {
  const calls: string[] = [];
  let load = first;
  const held = Promise.withResolvers<unknown>();
  const client = {
    features: [],
    request: async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "status") { if (load.status instanceof Error) throw load.status; return load.status; }
      expect(method).toBe("session_history");
      expect(params).toEqual({ session_id: (load.status as { session: { session_id: string } }).session.session_id, before: null });
      if (hold) return held.promise;
      if (load.history instanceof Error) throw load.history;
      return { messages: load.history, next_before: load.older ? 5 : null };
    },
  } as unknown as ZetaClient;
  return { client, calls, release: (messages: unknown[]) => held.resolve({ messages }), become: (next: Load) => { load = next; } };
}

let fakeClock = false;
const noChats: Chat[] = [];
const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); if (fakeClock) jest.advanceTimersByTime(0); }); });

test.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
  const chats = row.chats ?? [chat];
  const pages = row.pages ?? [reading];
  const id = row.id ?? chat.session_id;
  let hook: ReturnType<typeof renderHook<ReturnType<typeof useBuildActivity>, { client: ZetaClient }>> | undefined;
  const late: ReturnType<typeof fakeZeta>[] = [];
  if (row.at) history.replaceState(null, "", row.at);
  try {
    for (const load of row.loads) {
      hook?.unmount();
      if (row.recover && load === row.loads.at(-1)) { jest.useFakeTimers(); fakeClock = true; }
      const zeta = fakeZeta(load);
      const first = load.superseded ? fakeZeta({ status: load.status }, true) : zeta;
      // a cold load starts with neither catalog loaded
      const cold = row.cold && load === row.loads.at(-1);
      hook = renderHook(({ client }) => useBuildActivity({ client, chats: cold ? noChats : chats, pages: cold ? null : pages, reloadPages: () => {} }), { initialProps: { client: first.client } });
      if (cold) expect(hook.result.current.latestReceipt?.route).toBe(row.receipt!);
      if (load.superseded) {
        late.push(first);
        for (let i = 0; i < 50 && first.calls.length < 2; i++) await flush();
        hook.rerender({ client: zeta.client });
      }
      const expected = cold ? 0 : load.history === undefined || load.status instanceof Error ? 1 : 2;
      for (let i = 0; i < 50 && zeta.calls.length < expected; i++) await flush();
      await flush();
      if (load.superseded) { first.release(load.superseded); await flush(); }
      if (row.dismiss !== undefined && load === row.loads[row.dismiss]) act(() => hook!.result.current.dismissReceipt());
      if (row.recover && load === row.loads.at(-1)) {
        // the retry timer was set by the outage read; the fake clock fires it without waiting
        expect(hook.result.current.rows[0]).toMatchObject({ state: "building", reason: "zeta offline" });
        zeta.become(row.recover);
        jest.advanceTimersByTime(2000);
        await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
      }
    }
    const activity = hook!.result.current;
    const found = activity.rows.find((build) => build.chat.session_id === id) as Record<string, unknown> | undefined;
    const shown = found ? Object.fromEntries(Object.keys(row.shown).map((key) => [key, found[key]])) : { state: "absent" };
    expect({ row: row.name, state: shown.state }).toEqual({ row: row.name, state: row.shown.state });
    expect({ row: row.name, ...shown }).toEqual({ row: row.name, ...row.shown });
    expect({ building: activity.building, needsYou: activity.needsYou, receipt: activity.latestReceipt?.route ?? null })
      .toMatchObject({ ...(row.building === undefined ? {} : { building: row.building }), ...(row.needsYou === undefined ? {} : { needsYou: row.needsYou }), ...(row.receipt === undefined ? {} : { receipt: row.receipt }) });
  } finally {
    hook?.unmount();
    jest.useRealTimers();
    fakeClock = false;
    late.forEach((zeta) => zeta.release([]));
    history.replaceState(null, "", "/");
  }
});

// The real shell with a stand-in activity. The interceptor answers the chat list and any page the test window navigates to.
function mountShell({ needsYou = 0, sessionId = null as string | null, waiting = 0, chats = [] as Chat[] } = {}) {
  const receipts = [{ chat: habit, route: "/expenses", turn: "t2", done: 2 }, { chat, route: "/reading-list", turn: "t1", done: 1 }];
  const dismissed: string[] = [];
  function Shell() {
    const nav = useAgentNavAdapter({ sessionId, waiting, canWrite: false, refreshKey: 0, pageRefreshKey: 0 });
    const [shown, setShown] = useState(0);
    // flushSync: a browser re-renders before it follows the link, as React flushes a discrete event's update first
    const dismissReceipt = () => { dismissed.push(receipts[shown]!.route); flushSync(() => setShown((value) => value + 1)); };
    const activity = { rows: [], latestReceipt: receipts[shown] ?? null, building: 0, needsYou, announcement: null, markAnnounced: () => {}, refresh: () => {}, dismissReceipt };
    return createElement(AppShell, { activity, current: chatsRoute, nav, newChat: { available: false, run: () => {} }, connectionStatus: { label: "zeta connected", connected: true } }, createElement(ShellDockSlot));
  }
  const settings = (window as unknown as { happyDOM: { settings: { fetch: { interceptor: unknown } } } }).happyDOM.settings.fetch;
  settings.interceptor = { beforeAsyncRequest: async ({ request }: { request: Request }) => new URL(request.url).pathname === "/api/chats"
    ? Response.json({ chats, next: null, approval_count: 0 }) : new Response("") };
  const view = render(createElement(Shell));
  return { view, dismissed, close: () => { settings.interceptor = null; history.replaceState(null, "", "/"); } };
}

test("open page goes to the shown receipt's page, not the next unseen one", () => {
  const shell = mountShell();
  try {
    act(() => { shell.view.getByText("open page").click(); });
    expect(location.pathname).toBe("/expenses");
  } finally { shell.close(); }
});

test("open page: a new-tab click is the browser's, Space opens like a button", () => {
  const shell = mountShell();
  try {
    const open = shell.view.getByText("open page");
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      act(() => { open.dispatchEvent(click); });
      expect({ modifier, prevented: click.defaultPrevented, dismissed: shell.dismissed }).toEqual({ modifier, prevented: false, dismissed: [] });
      history.replaceState(null, "", "/");
    }
    act(() => { open.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    expect({ path: location.pathname, dismissed: shell.dismissed }).toEqual({ path: "/expenses", dismissed: ["/expenses"] });
  } finally { shell.close(); }
});

test("a build that needs you is counted once in the chats badge", async () => {
  const build = { ...chat, last_state: "approval" as const };
  const shell = mountShell({ needsYou: 1, sessionId: build.session_id, waiting: 1, chats: [build] });
  try {
    const badge = () => shell.view.container.querySelector('a[aria-label="chats"] .waiting-count')?.textContent;
    for (let i = 0; i < 50 && !shell.view.container.querySelector(".chat-row"); i++) await flush();
    expect(badge()).toBe("1");
  } finally { shell.close(); }
});

test("a build's run end is read at once, not at the next poll", async () => {
  // a chat waiting for zeta attaches on the same agent_end, and the pinned server then cannot read the build any more
  const zeta = fakeZeta({ status: running, history: [call()] });
  let deliver: (text: string) => void = () => {};
  teeRunEnds({ send: () => {}, close: () => {}, onMessage: (callback: (text: string) => void) => { deliver = callback; } } as unknown as Transport, () => zeta.client).onMessage(() => {});
  const chats = [chat], pages = [reading], reloadPages = () => {};
  const hook = renderHook(() => useBuildActivity({ client: zeta.client, chats, pages, reloadPages }));
  try {
    for (let i = 0; i < 50 && zeta.calls.length < 2; i++) await flush();
    expect(hook.result.current.rows[0]?.state).toBe("building");
    zeta.become({ status: idle(), history: done });
    act(() => deliver(JSON.stringify({ method: "event", params: { event: "agent_end", session_id: chat.session_id } })));
    for (let i = 0; i < 50 && zeta.calls.length < 4; i++) await flush();
    await flush();
    expect({ state: hook.result.current.rows[0]?.state, receipt: hook.result.current.latestReceipt?.route ?? null }).toEqual({ state: "done", receipt: "/reading-list" });
  } finally {
    hook.unmount();
  }
});

// session_history_read_v1: builds that are not zeta's attached session, read on demand through the one build owner.
const READ = "session_history_read_v1";
type Call = { method: string; params: { session_id?: string } };
type Handler = (params: { session_id: string }) => unknown;
const busy = Object.assign(Error("a session read is in flight"), { code: -32004, data: { retry_after_ms: 2000 } });
const rows = (messages: unknown[]) => ({ messages, next_cursor: null });
const builds = (...ids: string[]) => ids.map((session_id) => ({ ...chat, session_id }));

/** A zeta whose replies are functions of the request, so a row can hold, fail, or change any of them. */
function serveZeta({ features = [READ], status, history = () => ({ messages: [call()], next_before: null }), read = () => rows([]) }: { features?: string[]; status: () => unknown; history?: Handler; read?: Handler }) {
  const calls: Call[] = [];
  let reading = 0;
  let mostReading = 0;
  const client = {
    features,
    request: async (method: string, params: { session_id: string }) => {
      calls.push({ method, params });
      if (method === "status") return status();
      if (method === "session_history") return history(params);
      expect(method).toBe("session_history_read");
      mostReading = Math.max(mostReading, ++reading);
      try { return await read(params); } finally { reading--; }
    },
  } as unknown as ZetaClient;
  const count = (method: string) => calls.filter((one) => one.method === method).length;
  return { client, calls, count, reads: () => calls.filter((one) => one.method === "session_history_read").map((one) => one.params.session_id), mostReading: () => mostReading };
}

const settle = async () => { for (let i = 0; i < 20; i++) await flush(); };
type Mounted = ReturnType<typeof renderHook<ReturnType<typeof useBuildActivity>, { client: ZetaClient; chats: Chat[] }>>;
const mounted: Mounted[] = [];
async function mount(zeta: ReturnType<typeof serveZeta>, chats: Chat[] = [chat]) {
  const hook: Mounted = renderHook(({ client, chats }) => useBuildActivity({ client, chats, pages: [reading], reloadPages: () => {} }), { initialProps: { client: zeta.client, chats } });
  mounted.push(hook);
  await settle();
  return hook;
}
const rowOf = (hook: Mounted, id = chat.session_id) => {
  const row = hook.result.current.rows.find((build) => build.chat.session_id === id);
  return { label: row ? buildLabel(row) : "absent", receipt: hook.result.current.latestReceipt?.route ?? null };
};
/** This tab watched the build run: a live pass saw it running. */
async function rememberBuilding() {
  (await mount(serveZeta({ status: () => running }))).unmount();
}
afterEach(() => { mounted.splice(0).forEach((hook) => hook.unmount()); jest.useRealTimers(); fakeClock = false; });

test("flag absent: a remembered build keeps today's fallback and is never read", async () => {
  await rememberBuilding();
  const zeta = serveZeta({ features: [], status: () => idle("newer"), read: () => rows(done) });
  const hook = await mount(zeta);
  expect({ ...rowOf(hook), reads: zeta.reads() }).toEqual({ label: "last known building · not the current session", receipt: null, reads: [] });
});

test("flag present: a remembered build that finished elsewhere is done, with its receipt", async () => {
  await rememberBuilding();
  const zeta = serveZeta({ status: () => idle("newer"), read: () => rows(done) });
  const hook = await mount(zeta);
  expect({ ...rowOf(hook), reads: zeta.reads() }).toEqual({ label: "done", receipt: "/reading-list", reads: [chat.session_id] });
});

test("flag present: a build this tab never saw run is done with no receipt (quiet)", async () => {
  const zeta = serveZeta({ status: () => idle("newer"), read: () => rows(done) });
  const hook = await mount(zeta);
  expect(rowOf(hook)).toEqual({ label: "done", receipt: null });
});

test("rows with no turn end are no claim: the fallback label stays", async () => {
  await rememberBuilding();
  const zeta = serveZeta({ status: () => idle("newer"), read: () => rows([call()]) });
  const hook = await mount(zeta);
  expect({ ...rowOf(hook), reads: zeta.reads().length }).toEqual({ label: "last known building · not the current session", receipt: null, reads: 1 });
});

test("-32004: the read waits at least retry_after_ms before it asks again", async () => {
  jest.useFakeTimers(); fakeClock = true;
  const at: number[] = [];
  const zeta = serveZeta({ status: () => idle("newer"), read: () => { at.push(Date.now()); if (at.length === 1) throw busy; return rows(done); } });
  const hook = await mount(zeta);
  // bun's fake clock follows real time across event-loop ticks, so compare the times the fake read saw, on the timer's clock
  act(() => { jest.advanceTimersByTime(2600); });
  await settle();
  expect({ reads: zeta.reads().length, ...rowOf(hook) }).toEqual({ reads: 2, label: "done", receipt: null });
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(2000);
});

test("-32004 three times: three reads, then no claim until a new demand", async () => {
  await rememberBuilding();
  jest.useFakeTimers(); fakeClock = true;
  const zeta = serveZeta({ status: () => idle("newer"), read: () => { throw busy; } });
  const hook = await mount(zeta);
  for (let i = 0; i < 4; i++) { act(() => { jest.advanceTimersByTime(3000); }); await settle(); }
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  expect({ reads: zeta.reads().length, ...rowOf(hook) }).toEqual({ reads: 3, label: "last known building · not the current session", receipt: null });
});

test("-32004 three times: the wait after the third holds the queue, and a new demand gets three tries again", async () => {
  jest.useFakeTimers(); fakeClock = true;
  const at: [string, number][] = [];
  const zeta = serveZeta({ status: () => idle("newer"), read: ({ session_id }) => { at.push([session_id, Date.now()]); if (session_id === "b1") throw busy; return rows(done); } });
  const hook = await mount(zeta, builds("b1", "b2"));
  for (let i = 0; i < 4; i++) { act(() => { jest.advanceTimersByTime(3000); }); await settle(); }
  expect(at.map(([id]) => id)).toEqual(["b1", "b1", "b1", "b2"]);
  // bun's fake clock follows real time across ticks: compare the times the fake read saw
  expect(at[3]![1] - at[2]![1]).toBeGreaterThanOrEqual(2000);
  hook.rerender({ client: zeta.client, chats: [{ ...builds("b1")[0]!, updated_at: "2030-01-02" }, builds("b2")[0]!] });
  for (let i = 0; i < 4; i++) { act(() => { jest.advanceTimersByTime(3000); }); await settle(); }
  expect(at.map(([id]) => id)).toEqual(["b1", "b1", "b1", "b2", "b1", "b1", "b1"]);
});

test("a page load does not read builds this tab already proved settled; a new turn or a manual refresh reads", async () => {
  (await mount(serveZeta({ status: () => idle("newer"), read: () => rows(done) }), builds("b1", "b2"))).unmount();
  const zeta = serveZeta({ status: () => idle("newer"), read: () => rows(done) });
  const hook = await mount(zeta, builds("b1", "b2"));
  expect(zeta.reads()).toEqual([]);
  hook.rerender({ client: zeta.client, chats: [{ ...builds("b1")[0]!, updated_at: "2030-01-02" }, builds("b2")[0]!] });
  await settle();
  expect(zeta.reads()).toEqual(["b1"]);
  act(() => hook.result.current.refresh());
  await settle();
  expect(zeta.reads().sort()).toEqual(["b1", "b1", "b2"]);
});

test("a read sent before the live pass saw the build current is dropped", async () => {
  let current: unknown = idle("newer");
  const held = Promise.withResolvers<unknown>();
  const zeta = serveZeta({ status: () => current, read: () => held.promise });
  const hook = await mount(zeta);
  expect(zeta.reads()).toEqual([chat.session_id]);
  // the build attaches and runs, then another session attaches; the old read answers last
  current = running;
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  current = idle("newer");
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  held.resolve(rows(done));
  await settle();
  expect(rowOf(hook)).toEqual({ label: "last known building · not the current session", receipt: null });
});

test("one read in flight, and only the builds of one chat-list page", async () => {
  const waiting: ((value: unknown) => void)[] = [];
  const ids = Array.from({ length: 52 }, (_, n) => `b${n + 1}`);
  const zeta = serveZeta({ status: () => idle("newer"), read: () => new Promise((resolve) => waiting.push(resolve)) });
  await mount(zeta, builds(...ids));
  for (let i = 0; i < 60 && waiting.length; i++) { waiting.shift()!(rows([])); await settle(); }
  expect({ most: zeta.mostReading(), reads: zeta.reads() }).toEqual({ most: 1, reads: ids.slice(0, 50) });
});

test("a new turn during an in-flight read: the next page load reads again", async () => {
  const held = Promise.withResolvers<unknown>();
  let replies = [() => held.promise, () => new Promise(() => {})];
  const first = serveZeta({ status: () => idle("newer"), read: () => replies.shift()!() });
  const hook = await mount(first, builds("b1"));
  // the chat list moves updated_at while the first read is in flight; the reply proves the older turn
  hook.rerender({ client: first.client, chats: [{ ...builds("b1")[0]!, updated_at: "2030-01-02" }] });
  await settle();
  held.resolve(rows(done));
  await settle();
  hook.unmount();
  replies = [];
  const zeta = serveZeta({ status: () => idle("newer"), read: () => rows(done) });
  await mount(zeta, [{ ...builds("b1")[0]!, updated_at: "2030-01-02" }]);
  expect(zeta.reads()).toEqual(["b1"]);
});

test("a chat-list reload with the same updated_at reads nothing; a new turn reads once", async () => {
  const zeta = serveZeta({ status: () => idle("newer") });
  const hook = await mount(zeta);
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  expect(zeta.reads().length).toBe(1);
  hook.rerender({ client: zeta.client, chats: [{ ...chat, updated_at: "2030-01-02" }] });
  await settle();
  expect(zeta.reads().length).toBe(2);
});

// zeta gives the same session_not_found for an absent id, another project, project versus no project, and a child id.
const notFound = (data?: object) => Object.assign(Error("the requested session does not exist"), { code: -32602, data });
test.each([
  ["session_not_found", notFound({ code: "session_not_found", reason: "session_not_found" })],
  ["session_not_found with only data.code", notFound({ code: "session_not_found" })],
  ["-32602 with no data", notFound()],
  ["-32007", Object.assign(Error("refused"), { code: -32007 })],
  ["-32005", Object.assign(Error("state unavailable"), { code: -32005 })],
])("%s: no claim and no retry", async (_name, error) => {
  const zeta = serveZeta({ status: () => idle("newer"), read: () => { throw error; } });
  const hook = await mount(zeta);
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  expect({ reads: zeta.reads().length, status: zeta.count("status"), ...rowOf(hook) }).toEqual({ reads: 1, status: 2, label: null, receipt: null });
});

test("-32602 for the attached session asks for one more live pass", async () => {
  const zeta = serveZeta({ status: () => idle("newer"), read: () => { throw Object.assign(Error("invalid params"), { code: -32602, data: { code: "invalid_params" } }); } });
  await mount(zeta);
  expect({ reads: zeta.reads().length, status: zeta.count("status") }).toEqual({ reads: 1, status: 2 });
});

/** A run end for `id`, delivered off the socket as the app's transport does. */
function runEnds(client: ZetaClient) {
  let deliver: (text: string) => void = () => {};
  teeRunEnds({ send: () => {}, close: () => {}, onMessage: (callback: (text: string) => void) => { deliver = callback; } } as unknown as Transport, () => client).onMessage(() => {});
  return (id = chat.session_id) => act(() => deliver(JSON.stringify({ method: "event", params: { event: "agent_end", session_id: id } })));
}

test("run end: the build's history goes out with status, not after it", async () => {
  let status: () => unknown = () => running;
  let history: Handler = () => ({ messages: [call()], next_before: null });
  const zeta = serveZeta({ features: [], status: () => status(), history: (params) => history(params) });
  const end = runEnds(zeta.client);
  const hook = await mount(zeta);
  const held = Promise.withResolvers<unknown>();
  status = () => held.promise;
  history = () => ({ messages: done, next_before: null });
  const before = zeta.calls.length;
  end();
  await settle();
  // status is still unanswered here
  expect(zeta.calls.slice(before).map((one) => `${one.method} ${one.params.session_id ?? ""}`.trim()).sort()).toEqual([`session_history ${chat.session_id}`, "status"]);
  held.resolve(idle());
  await settle();
  expect(rowOf(hook)).toEqual({ label: "done", receipt: "/reading-list" });
});

test("run end: a build this tab never polled running gets its receipt from the run end it saw", async () => {
  let status: unknown = idle("newer");
  const zeta = serveZeta({ features: [], status: () => status, history: () => ({ messages: done, next_before: null }) });
  const end = runEnds(zeta.client);
  const hook = await mount(zeta);
  status = idle();
  end();
  await settle();
  expect(rowOf(hook)).toEqual({ label: "done", receipt: "/reading-list" });
});

test("run end: another session attached first, the build's history still proves done", async () => {
  let status: unknown = running;
  let history: unknown = { messages: [call()], next_before: null };
  const zeta = serveZeta({ features: [], status: () => status, history: () => history });
  const end = runEnds(zeta.client);
  const hook = await mount(zeta);
  status = idle("newer");
  history = { messages: done, next_before: null };
  end();
  await settle();
  expect(rowOf(hook)).toEqual({ label: "done", receipt: "/reading-list" });
});

test("run end: a chat-list change while the build's history is in flight does not drop it", async () => {
  const held = Promise.withResolvers<unknown>();
  let history: Handler = () => ({ messages: [call()], next_before: null });
  let status: unknown = running;
  const zeta = serveZeta({ features: [], status: () => status, history: (params) => history(params) });
  const end = runEnds(zeta.client);
  const hook = await mount(zeta);
  status = idle();
  history = () => { history = () => { throw inactive; }; return held.promise; };
  end();
  await settle();
  hook.rerender({ client: zeta.client, chats: [{ ...chat }] });
  await settle();
  held.resolve({ messages: done, next_before: null });
  await settle();
  expect(rowOf(hook)).toEqual({ label: "done", receipt: "/reading-list" });
});

test("one read in flight: new chats and a run end during a busy wait or a held read send no second read", async () => {
  jest.useFakeTimers(); fakeClock = true;
  const held: ((value: unknown) => void)[] = [];
  let first = true;
  const zeta = serveZeta({ status: () => idle("newer"), read: () => { if (first) { first = false; throw busy; } return new Promise((resolve) => held.push(resolve)); } });
  const end = runEnds(zeta.client);
  const hook = await mount(zeta, builds("b1", "b2"));
  // b1 is busy and waits; b2 is queued. A new turn on b2 and its run end must not read during the wait.
  hook.rerender({ client: zeta.client, chats: [builds("b1")[0]!, { ...builds("b2")[0]!, updated_at: "2030-01-02" }] });
  end("b2");
  await settle();
  expect(zeta.reads()).toEqual(["b1"]);
  act(() => { jest.advanceTimersByTime(2600); });
  await settle();
  expect(zeta.reads()).toEqual(["b1", "b1"]);
  // b1's second read is held. Another new turn on b2 and a run end must not send b2 beside it.
  hook.rerender({ client: zeta.client, chats: [builds("b1")[0]!, { ...builds("b2")[0]!, updated_at: "2030-01-03" }] });
  end("b2");
  await settle();
  expect({ most: zeta.mostReading(), reads: zeta.reads() }).toEqual({ most: 1, reads: ["b1", "b1"] });
  held.shift()!(rows([]));
  await settle();
  expect({ most: zeta.mostReading(), reads: zeta.reads() }).toEqual({ most: 1, reads: ["b1", "b1", "b2"] });
});

test("a second tab on a workspace route sees another tab's build when it comes back", async () => {
  let listed: Chat[] = [];
  const settings = (window as unknown as { happyDOM: { settings: { fetch: { interceptor: unknown } } } }).happyDOM.settings.fetch;
  settings.interceptor = { beforeAsyncRequest: async ({ request }: { request: Request }) => new URL(request.url).pathname === "/api/chats"
    ? Response.json({ chats: listed, next: null, approval_count: 0 }) : Response.json({ pages: [], next: null }) };
  const zeta = serveZeta({ status: () => idle(), history: () => ({ messages: done, next_before: null }) });
  // the same nav a chat, /create, or page route uses (AgentSurface passes its own refresh key, not a focus key)
  const view = renderHook(() => {
    const nav = useAgentNavAdapter({ sessionId: null, waiting: 0, canWrite: true, refreshKey: 0, pageRefreshKey: 0 });
    return useBuildActivity({ client: zeta.client, chats: nav.recentChats, pages: [reading], reloadPages: () => {} });
  });
  try {
    await settle();
    expect(view.result.current.rows).toEqual([]);
    listed = [chat];
    act(() => { dispatchEvent(new Event("focus")); });
    for (let i = 0; i < 5; i++) await settle();
    expect(view.result.current.rows.map((row) => [row.chat.session_id, buildLabel(row)])).toEqual([[chat.session_id, "done"]]);
    // it never saw that build run, so no receipt
    expect(view.result.current.latestReceipt).toBeNull();
  } finally { view.unmount(); settings.interceptor = null; }
});
