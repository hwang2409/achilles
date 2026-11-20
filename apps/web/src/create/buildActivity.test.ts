import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ZetaClient } from "@fulcrum/zeta";
import type { Chat, PageLink } from "../surface/AgentNavAdapter";
import { useBuildActivity } from "./buildActivity";

afterEach(() => { cleanup(); sessionStorage.clear(); });

const chat: Chat = { session_id: "reading-build", purpose: "page_build", page_id: "home", page_route: "/", page_title: "home", title: "a synthetic reading list", last_state: "running", created_at: "2030-01-01", updated_at: "2030-01-01" };
const habit: Chat = { ...chat, session_id: "habit-build", title: "a synthetic habit log" };
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
const running = { ...idle(), state: "running" };
const approval = { ...idle(), state: "tool", pending_approvals: [{ tool_call: { name: "achilles__create_page" } }] };
const offline = Error("socket closed");
const inactive = Object.assign(Error("session is not active"), { code: -32003 });
const done = [call(), result, end];

/** One page load: zeta's status reply, and the history reply when the status names a build. */
type Load = { status: object | Error; history?: unknown[] | Error; superseded?: unknown[] };
type Shown = { state: string | null; reason?: string | null; results?: string[]; tools?: string[] };
type Row = { name: string; loads: Load[]; chats?: Chat[]; pages?: PageLink[]; id?: string; shown: Shown; building?: number; needsYou?: number; receipt?: string | null; dismiss?: boolean };

// Each load is a fresh page load in the same tab (same sessionStorage); the last one is asserted.
const ROWS: Row[] = [
  { name: "active running", loads: [{ status: running, history: [call()] }], shown: { state: "building", reason: null, tools: ["achilles__create_page"] }, building: 1, receipt: null },
  { name: "active needs you", loads: [{ status: approval, history: [call()] }], shown: { state: "needs you", reason: null, tools: ["achilles__create_page"] }, needsYou: 1 },
  { name: "active idle with a confirmed route", loads: [{ status: idle(), history: done }], shown: { state: "done", reason: null, results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "active idle, result route not yet in the catalog", pages: [], loads: [{ status: idle(), history: done }], shown: { state: "unfinished", results: [] }, receipt: null },
  { name: "active idle with no result", loads: [{ status: idle(), history: [call(), end] }], shown: { state: "unfinished", reason: null, results: [] } },
  { name: "unknown result shapes are not pages", loads: [{ status: idle(), history: [call(undefined, "another__create_page"), result, resultOf("orphan", '{"route":"/expenses"}'), call("bad"), resultOf("bad", "not JSON"), call("bare"), resultOf("bare", '{"existing":true}'), end] }], shown: { state: "unfinished", results: [] } },
  { name: "is_error result", loads: [{ status: idle(), history: [call("error"), resultOf("error", "boom", true), end] }], shown: { state: "failed", reason: null, results: [] } },
  { name: "two results, a failure between them (Q3)", pages: [reading, expenses], loads: [{ status: idle(), history: [call(), result, call("error"), resultOf("error", "boom", true), call("existing"), resultOf("existing", '{"route":"/expenses","existing":true}'), end] }], shown: { state: "done", results: ["/reading-list", "/expenses"] }, receipt: "/reading-list" },
  { name: "duplicate history rows", loads: [{ status: idle(), history: [call(), call(), result, result, end, end] }], shown: { state: "done", results: ["/reading-list"] } },
  { name: "b1: remembered done, then another session is current", loads: [{ status: idle(), history: done }, { status: idle("newer") }], shown: { state: "done", reason: null, results: ["/reading-list"] }, receipt: "/reading-list" },
  { name: "remembered done, then zeta offline", loads: [{ status: idle(), history: done }, { status: offline }], shown: { state: "done", reason: null, results: ["/reading-list"] }, building: 0 },
  { name: "acknowledged receipt stays gone after reload", dismiss: true, loads: [{ status: idle(), history: done }, { status: idle("newer") }], shown: { state: "done" }, receipt: null },
  { name: "m1: remembered building, then zeta offline", loads: [{ status: running, history: [call()] }, { status: offline }], shown: { state: "building", reason: "zeta offline", tools: [] }, building: 0 },
  { name: "remembered building, then -32003 between status and history", loads: [{ status: running, history: [call()] }, { status: running, history: inactive }], shown: { state: "building", reason: "not the current session" }, building: 0 },
  { name: "b1: nothing remembered and not current", loads: [{ status: idle("newer") }], shown: { state: null, results: [] }, building: 0 },
  { name: "m1: nothing remembered and zeta offline", loads: [{ status: offline }], shown: { state: null, results: [] }, building: 0, needsYou: 0 },
  { name: "m2: a sixth page build with persisted running", chats: [chat, habit, ...[1, 2, 3, 4].map((n) => ({ ...chat, session_id: `build-${n}` }))].reverse(), loads: [{ status: idle("newer") }], shown: { state: null }, building: 0 },
  { name: "an ordinary running chat never appears", chats: [ordinary], id: ordinary.session_id, loads: [{ status: running }], shown: { state: "absent" }, building: 0 },
  { name: "a stale response arriving after a newer one", loads: [{ status: idle(), history: done, superseded: [call()] }], shown: { state: "done", tools: [] }, building: 0 },
];

function fakeZeta(load: Load, hold = false) {
  const calls: string[] = [];
  const held = Promise.withResolvers<unknown>();
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push(method);
      if (method === "status") { if (load.status instanceof Error) throw load.status; return load.status; }
      expect(method).toBe("session_history");
      expect(params).toEqual({ session_id: chat.session_id, before: null });
      if (hold) return held.promise;
      if (load.history instanceof Error) throw load.history;
      return { messages: load.history };
    },
  } as unknown as ZetaClient;
  return { client, calls, release: (messages: unknown[]) => held.resolve({ messages }) };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
  const chats = row.chats ?? [chat];
  const pages = row.pages ?? [reading];
  const id = row.id ?? chat.session_id;
  let hook: ReturnType<typeof renderHook<ReturnType<typeof useBuildActivity>, { client: ZetaClient }>> | undefined;
  const late: ReturnType<typeof fakeZeta>[] = [];
  try {
    for (const load of row.loads) {
      hook?.unmount();
      const zeta = fakeZeta(load);
      const first = load.superseded ? fakeZeta({ status: load.status }, true) : zeta;
      hook = renderHook(({ client }) => useBuildActivity({ client, chats, pages, reloadPages: () => {} }), { initialProps: { client: first.client } });
      if (load.superseded) {
        late.push(first);
        while (first.calls.length < 2) await flush();
        hook.rerender({ client: zeta.client });
      }
      const expected = load.history === undefined || load.status instanceof Error ? 1 : 2;
      for (let i = 0; i < 50 && zeta.calls.length < expected; i++) await flush();
      await flush();
      if (load.superseded) { first.release(load.superseded); await flush(); }
      if (row.dismiss && load === row.loads[0]) act(() => hook!.result.current.dismissReceipt());
    }
    const activity = hook!.result.current;
    const found = activity.rows.find((build) => build.chat.session_id === id) as Record<string, unknown> | undefined;
    const shown = found ? Object.fromEntries(Object.keys(row.shown).map((key) => [key, key === "results" ? (found.results as PageLink[]).map((page) => page.route) : found[key]])) : { state: "absent" };
    expect({ row: row.name, state: shown.state }).toEqual({ row: row.name, state: row.shown.state });
    expect({ row: row.name, ...shown }).toEqual({ row: row.name, ...row.shown });
    expect({ building: activity.building, needsYou: activity.needsYou, receipt: activity.latestReceipt?.page.route ?? null })
      .toMatchObject({ ...(row.building === undefined ? {} : { building: row.building }), ...(row.needsYou === undefined ? {} : { needsYou: row.needsYou }), ...(row.receipt === undefined ? {} : { receipt: row.receipt }) });
  } finally {
    hook?.unmount();
    late.forEach((zeta) => zeta.release([]));
  }
});
