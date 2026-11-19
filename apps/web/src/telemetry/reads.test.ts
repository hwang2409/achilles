import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { connect, type ZetaClient } from "@fulcrum/zeta";
import { POLL_MS, useTelemetryReads, type Range, type ReadEnv, type Tab } from "./reads";

afterEach(cleanup);

type Step = "settle" | "fail" | "hide" | "show" | "focus" | "refresh" | "tick" | "unmount" | { range: Range } | { errorsOnly: boolean };
type Shown = { label: string; bucket: "hour" | "day"; stale: boolean; errorsOnly: boolean } | null;
type Row = { name: string; tab?: Tab; steps: Step[]; started: number; phase: string; shown: Shown };

const h24 = { label: "last 24 hours", bucket: "hour" as const, errorsOnly: false };
const d7 = { label: "last 7 days", bucket: "day" as const, errorsOnly: false };

// Each row starts mounted on a visible page with the first read (24 hours) in flight.
const ROWS: Row[] = [
  { name: "polls every 5 s while visible; hidden stops it; showing reads at once", steps: ["settle", "tick", "settle", "hide", "tick", "show", "settle"], started: 3, phase: "idle", shown: { ...h24, stale: false } },
  { name: "a refresh queued behind a read is dropped when the page hides", steps: ["refresh", "hide", "settle"], started: 1, phase: "hidden", shown: { ...h24, stale: false } },
  { name: "the dropped follow-up reads once when the page shows again", steps: ["refresh", "hide", "settle", "show", "settle"], started: 2, phase: "idle", shown: { ...h24, stale: false } },
  { name: "focus during a read waits for it, then reads once", steps: ["focus", "settle"], started: 2, phase: "refreshing", shown: { ...h24, stale: false } },
  { name: "manual refresh during a read waits for it, then reads once", steps: ["refresh", "settle", "settle"], started: 2, phase: "idle", shown: { ...h24, stale: false } },
  { name: "duplicate refresh and focus input during a read become one follow-up", steps: ["focus", "refresh", "refresh", "focus", "settle", "settle"], started: 2, phase: "idle", shown: { ...h24, stale: false } },
  { name: "retained data keeps its own range label and bucket, dimmed, while a new range loads", steps: ["settle", { range: "7d" }], started: 2, phase: "refreshing", shown: { ...h24, stale: true } },
  { name: "a range change during a read waits for it; the old reply shows dimmed under its own label", steps: ["settle", "refresh", { range: "7d" }, "settle"], started: 3, phase: "refreshing", shown: { ...h24, stale: true } },
  { name: "the new range's reply replaces the retained data and is not dimmed", steps: ["settle", "refresh", { range: "7d" }, "settle", "settle"], started: 3, phase: "idle", shown: { ...d7, stale: false } },
  { name: "a filter change during a read waits for it; the unfiltered reply shows dimmed", tab: "sessions", steps: ["settle", "refresh", { errorsOnly: true }, "settle"], started: 3, phase: "refreshing", shown: { ...h24, stale: true } },
  { name: "the filtered reply then shows, not dimmed", tab: "sessions", steps: ["settle", "refresh", { errorsOnly: true }, "settle", "settle"], started: 3, phase: "idle", shown: { ...h24, errorsOnly: true, stale: false } },
  { name: "unmount during a read drops its reply and schedules nothing", steps: ["unmount", "settle", "tick", "focus"], started: 1, phase: "loading", shown: null },
  { name: "a failed first read shows nothing and polls again", steps: ["fail"], started: 1, phase: "idle", shown: null },
  { name: "a failed refresh keeps the last data, dimmed", steps: ["settle", "refresh", "fail"], started: 2, phase: "idle", shown: { ...h24, stale: true } },
];

const status = { enabled: true, receiver: "ready", endpoint: "builtin", last_export: "ok", last_export_ns: null, raw_days: 14, rollup_days: 90, max_bytes: 1, used_bytes: 0, oldest_raw_ns: null, oldest_rollup_ns: null };
const totals = { start_ns: 0, end_ns: 1, sessions: 0, traces: 0, spans: 0, errors: 0, model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, duration_ns: 0 };

/** A zeta whose replies wait for the test. One read is one `telemetry_overview` call (sessions adds its page call). */
function fakeZeta() {
  const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void; method: string }[] = [];
  const counts = { started: 0, inFlight: 0, maxInFlight: 0 };
  const client = {
    features: ["telemetry_read_v1"],
    request: (method: string) => new Promise((resolve, reject) => {
      if (method === "telemetry_overview") { counts.started++; counts.maxInFlight = Math.max(counts.maxInFlight, ++counts.inFlight); }
      pending.push({ resolve, reject, method });
    }),
  } as unknown as ZetaClient;
  const finish = (ok: boolean) => {
    for (const request of pending.splice(0)) {
      if (request.method === "telemetry_overview") counts.inFlight--;
      if (!ok) request.reject({ code: -32005, message: "down", data: { code: "state_unavailable", retryable: true } });
      else request.resolve(request.method === "telemetry_overview" ? { status, totals, series: [], active_models: 0, active_tools: 0, next_cursor: null } : { items: [], next_cursor: null, as_of_ns: 1 });
    }
  };
  return { client, counts, finish };
}

function fakeEnv() {
  let visible = true;
  let listener: ((event: "visible" | "hidden" | "focus") => void) | null = null;
  const timers = new Map<number, () => void>();
  let next = 0;
  const env: ReadEnv = {
    visible: () => visible,
    watch: (callback) => { listener = callback; return () => { listener = null; }; },
    setTimer: (callback, ms) => { expect(ms).toBe(POLL_MS); timers.set(++next, callback); return next; },
    clearTimer: (timer) => { timers.delete(timer as number); },
  };
  const tick = () => { const due = [...timers.values()]; timers.clear(); due.forEach((callback) => callback()); };
  const emit = (event: "visible" | "hidden" | "focus") => { if (event !== "focus") visible = event === "visible"; listener?.(event); };
  return { env, tick, emit, timers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test.each(ROWS.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
  const zeta = fakeZeta();
  const page = fakeEnv();
  const hook = renderHook(() => useTelemetryReads(zeta.client, row.tab ?? "overview", page.env));
  let mounted = true;
  try {
    expect(zeta.counts.started).toBe(1);
    for (const step of row.steps) {
      await act(async () => {
        if (step === "settle" || step === "fail") zeta.finish(step === "settle");
        else if (step === "hide") page.emit("hidden");
        else if (step === "show") page.emit("visible");
        else if (step === "focus") page.emit("focus");
        else if (step === "refresh") hook.result.current.refresh();
        else if (step === "tick") page.tick();
        else if (step === "unmount") { hook.unmount(); mounted = false; }
        else if ("range" in step) hook.result.current.chooseRange(step.range);
        else hook.result.current.setFilters({ errorsOnly: step.errorsOnly });
        await flush();
      });
    }
    const reads = hook.result.current;
    const shown = reads.shown ? { label: reads.shown.label, bucket: reads.shown.bucket, stale: reads.shown.stale, errorsOnly: reads.shown.data.ask.query.errorsOnly } : null;
    expect({ maxInFlight: zeta.counts.maxInFlight, started: zeta.counts.started, phase: reads.phase, shown }).toEqual({ maxInFlight: 1, started: row.started, phase: row.phase, shown: row.shown });
    expect(page.timers.size).toBe(mounted && reads.phase === "idle" ? 1 : 0); // only an idle, visible page waits to poll
  } finally {
    if (mounted) hook.unmount();
    zeta.finish(true);
  }
});

type Reply = { result: unknown } | { error: { code: number; message: string; data?: object } };
async function wireZeta(reply: (method: string, params: Record<string, unknown>) => Reply) {
  let receive: (text: string) => void;
  const client = connect({
    onMessage: (callback) => { receive = callback; },
    send(text) {
      const { id, method, params } = JSON.parse(text);
      const body = method === "hello"
        ? { result: { protocol_version: "1.2", capabilities: { features: ["telemetry_read_v1"] } } }
        : reply(method, params);
      queueMicrotask(() => receive(JSON.stringify({ jsonrpc: "2.0", id, ...body })));
    },
    close() {},
  });
  await client.hello(["telemetry_read_v1"]);
  return client;
}

test("invalid params on the wire disables only the summary lookup", async () => {
  const page = fakeEnv();
  const detail = { sessionId: "session", traceId: null };
  const trace = { trace_id: "trace" };
  const agents = [{ session_id: "session" }];
  let lookups = 0;
  let traceReads = 0;
  const client = await wireZeta((method, params) => {
    if (method === "telemetry_status") return { result: status };
    if (method === "telemetry_sessions" && params.session_id === detail.sessionId) {
      lookups++;
      if (lookups === 1) return { error: { code: -32602, message: "invalid params", data: { code: "invalid_params" } } };
      throw new Error("unexpected second summary lookup");
    }
    if (method === "telemetry_agent_tree") return { result: { items: params.collection === "traces" ? [trace.trace_id] : agents, next_cursor: null } };
    if (method === "telemetry_trace") {
      traceReads++;
      return { result: { trace, spans: [], next_cursor: null } };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const hook = renderHook(() => useTelemetryReads(client, "sessions", page.env, detail));
  try {
    await act(flush);
    await act(async () => { page.tick(); await flush(); });
    expect(lookups).toBe(1);
    expect(traceReads).toBe(2);
    expect(hook.result.current.error).toBeUndefined();
    expect(hook.result.current.shown?.data).toMatchObject({ tab: "detail", session: undefined, trace, agents });
  } finally {
    hook.unmount();
    client.close();
  }
});

const rpcError = (code: number, data?: object) => ({ code, message: "read failed", data });
const RETRIES = [
  ["socket closed", new Error("transport closed"), true],
  ["request timed out", new Error("request timed out"), true],
  ["operation busy", rpcError(-32004), true],
  ["output overflow closes the socket", rpcError(-32011), true],
  ["read state unavailable", rpcError(-32005, { code: "state_unavailable", retryable: true }), true],
  ["account lock timeout", rpcError(-32008, { code: "account_lock_timeout", retryable: true }), true],
  ["stale snapshot", rpcError(-32009, { code: "stale_state_snapshot", retryable: true }), true],
  ["invalid request", rpcError(-32600), false],
  ["method not found", rpcError(-32601), false],
  ["invalid params outside summary lookup", rpcError(-32602, { retryable: true }), false],
  ["summary schema mismatch", rpcError(-32000, { code: "telemetry_schema_mismatch" }), false],
  ["parked limit requires intervention", rpcError(-32004, { reason: "parked_limit" }), false],
  ["active session blocks operation", rpcError(-32005, { code: "active_session" }), false],
  ["observer read only", rpcError(-32008, { code: "observer_read_only" }), false],
  ["stale revision needs a new request", rpcError(-32009, { code: "stale_revision" }), false],
  ["unknown app code", rpcError(-32099), false],
  ["unexpected local failure", new Error("bad result"), false],
] as const;

test.each(RETRIES)("%s: retry only when the same read can heal", async (name, error, retry) => {
  const page = fakeEnv();
  const detail = { sessionId: "session", traceId: null };
  let reads = 0;
  const client = await wireZeta((method) => {
    const failingMethod = name === "invalid params outside summary lookup" ? "telemetry_status" : "telemetry_sessions";
    if (method === "telemetry_status" && method !== failingMethod) return { result: status };
    if (method === "telemetry_agent_tree") return { result: { items: [], next_cursor: null } };
    expect(method).toBe(failingMethod);
    reads++;
    if (error instanceof Error) throw error;
    return { error };
  });
  const hook = renderHook(() => useTelemetryReads(client, "sessions", page.env, detail));
  try {
    await act(flush);
    await act(async () => { page.tick(); await flush(); });
    expect(reads).toBe(retry ? 2 : 1);
    expect(hook.result.current.error).toMatchObject({ message: error.message });
    expect(hook.result.current.retrying).toBe(retry);
    if (!retry) {
      await act(async () => { page.emit("focus"); page.emit("hidden"); page.emit("visible"); await flush(); });
      expect(reads).toBe(1);
      expect(hook.result.current.phase).toBe("idle");
      await act(async () => { hook.result.current.refresh(); await flush(); });
      expect(reads).toBe(2);
      expect(page.timers.size).toBe(0);
    }
  } finally {
    hook.unmount();
    client.close();
  }
});
