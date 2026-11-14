import { expect, test } from "bun:test";
import { aggregateTaskResults, makeReport, reportJson, reportMarkdown } from "./eval-report";

test("report aggregates pass rate per task and states tools", () => {
  const rows = [{ task_id: "a", pass: true, score: 100, turns: 2, tool_calls: 1, wall_ms: 10 }, { task_id: "a", pass: false, score: 50, turns: 3, tool_calls: 2, wall_ms: 20 }];
  expect(aggregateTaskResults(rows).a.pass_rate).toBe(0.5);
  const report = makeReport({ run_id: "run", repeats: 2, agent: { provider: "claude", model: "claude-opus-5-5", tool_policy: "achilles__*,mcp_discover", observed_catalog: ["achilles__list_notes"] }, tasks: rows.map((row) => ({ ...row, approvals: 0, usage: "unavailable", checks: [], host_tools_gap: false })) as never });
  const markdown = reportMarkdown(report);
  expect(markdown).toContain("observed catalog");
  expect(markdown).toContain("50–100");
  expect(markdown).toContain("provider credentials are read from the configured account home");
  expect(reportJson(report)).toContain("tool_policy");
});
