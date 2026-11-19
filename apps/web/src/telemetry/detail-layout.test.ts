import { expect, test } from "bun:test";
import { agentRows, traceBar, waterfallRows } from "./detail-layout";
import type { TelemetryAgent, TelemetrySpan, TelemetryTrace } from "./telemetry-types";

const agent = (session_id: string, parent_session_id: string | null, first_ns: number): TelemetryAgent => ({ session_id, parent_session_id, first_ns, last_ns: first_ns, depth: 0, status: "unset", agent_name: null, background: null });

test("agents are parent-first even when a child started earlier; orphans and cycles stay visible", () => {
  const items = [agent("leaf", "child", 1), agent("child", "root", 2), agent("sibling", "root", 2), agent("root", null, 3), agent("orphan", "absent", 4), agent("cycle", "cycle", 5)];
  expect(agentRows(items).map(({ item, depth }) => [item.session_id, depth])).toEqual([["root", 0], ["child", 1], ["leaf", 2], ["sibling", 1], ["orphan", 0], ["cycle", 0]]);
});

test("waterfall uses the full trace window, preserves nesting, and keeps instant spans visible", () => {
  const trace = { first_ns: 1000, last_ns: 2000 } as TelemetryTrace;
  const turn = { span_id: "a", parent_span_id: null, operation: "turn", start_ns: 1100, end_ns: 1700 } as TelemetrySpan;
  const chat = { span_id: "b", parent_span_id: "a", operation: "chat", start_ns: 1250, end_ns: 1350, duration_ns: 0 } as TelemetrySpan;
  expect(waterfallRows([chat, turn], trace).map(({ item, depth, left, width }) => [item.span_id, depth, left, width])).toEqual([["a", 0, 10, 60], ["b", 1, 25, 10]]);
  expect(traceBar(1000, 2000, 2000, 2000)).toEqual({ left: 99.6, width: 0.4 });
  expect(traceBar(1000, 1000, 1000, 1000)).toEqual({ left: 0, width: 0.4 });
  expect(traceBar(1000, 2000, 900, 2100)).toEqual({ left: 0, width: 100 });
});
