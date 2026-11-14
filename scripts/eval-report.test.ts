import { expect, test } from "bun:test";
import { aggregateTaskResults, makeReport, reportJson, reportMarkdown } from "./eval-report";

test("report aggregates pass rate per task and states tools", () => {
  const rows = [{ task_id: "a", pass: true, score: 100, turns: 2, tool_calls: 1, wall_ms: 10 }, { task_id: "a", pass: false, score: 50, turns: 3, tool_calls: 2, wall_ms: 20 }];
  expect(aggregateTaskResults(rows).a.pass_rate).toBe(0.5);
  const usage = { turns_with_usage: 1, input_tokens: 10, output_tokens: "unavailable at this zeta pin", reasoning_output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } as const;
  const report = makeReport({ run_id: "run", repeats: 2, agent: { provider: "claude", model: "claude-opus-5-5", tool_policy: "achilles__*,mcp_discover", observed_catalog: ["achilles__list_notes"] }, totals: { turns: 5, wall_ms: 30 }, tasks: rows.map((row) => ({ ...row, approvals: 0, usage, checks: [], host_tools_gap: false })) as never });
  const markdown = reportMarkdown(report);
  expect(markdown).toContain("observed catalog");
  expect(markdown).toContain("50–100");
  expect(markdown).toContain("provider credentials are read from the configured account home");
  expect(markdown).toContain("suite tokens: input 20; output unavailable at this zeta pin; reasoning 8; cache read 6; cache write 4");
  expect(reportJson(report)).toContain('"input_tokens": 20');
  expect(reportJson(report)).toContain("tool_policy");
});

test("goal capability gaps label agent failures without changing status", () => {
  const report = makeReport({ run_id: "run", repeats: 1, agent: { provider: "scripted", model: "offline", tool_policy: "achilles__*", observed_catalog: [] }, tasks: [{ task_id: "reading", pass: false, status: "agent_fail", gap: "capability_missing:create_page_with_tools", score: 0, turns: 1, tool_calls: 0, wall_ms: 1, approvals: 0, checks: [], host_tools_gap: false, usage: "unavailable", diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 0 } }] as never });
  expect(report.tasks[0].status).toBe("agent_fail");
  expect(reportJson(report)).toContain('"gap": "capability_missing:create_page_with_tools"');
  expect(reportMarkdown(report)).toContain("goal not reachable on this revision");
  const withGap = aggregateTaskResults([{ task_id: "reading", pass: false, score: 0, turns: 1, tool_calls: 0, wall_ms: 1, status: "agent_fail", gap: "capability_missing:create_page_with_tools" }]);
  const withoutGap = aggregateTaskResults([{ task_id: "reading", pass: false, score: 0, turns: 1, tool_calls: 0, wall_ms: 1, status: "agent_fail" }]);
  expect(withGap).toEqual(withoutGap);
});

test("unsupported runs are excluded and repeated cap hits request a higher cap", () => {
  const rows = [
    { task_id: "capped", pass: false, score: 0, turns: 4, tool_calls: 1, wall_ms: 1, status: "agent_fail", cap_hit: true },
    { task_id: "capped", pass: false, score: 0, turns: 4, tool_calls: 1, wall_ms: 1, status: "agent_fail", cap_hit: true },
    { task_id: "newer", pass: false, score: 0, turns: 0, tool_calls: 0, wall_ms: 0, status: "unsupported" },
  ];
  expect(aggregateTaskResults(rows).capped.cap_action).toBe("raise cap");
  expect(aggregateTaskResults(rows).newer).toBeUndefined();
});
