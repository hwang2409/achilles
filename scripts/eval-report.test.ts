import { expect, test } from "bun:test";
import { aggregateTaskResults, diffMarkdown, loadBaseReport, makeReport, parseBaseReport, reportJson, reportMarkdown } from "./eval-report";

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

test("reports reading-list unmapped after values as needs review", () => {
  const check = { id: "update-and-read", pass: false, expected: "Synthetic Book", actual: false, reason: "unmapped_after_value: progress=bogus", evidence: { type: "updated_record", page: "p1", transition: { field: "progress", before: "unread", after: "bogus" } } };
  const task = { task_id: "reading-list-one-prompt", pass: false, status: "agent_fail", score: 50, turns: 1, tool_calls: 3, wall_ms: 1, approvals: 0, checks: [check], host_tools_gap: false, usage: "unavailable", diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 0 } };
  const report = makeReport({ run_id: "run", repeats: 1, agent: { provider: "scripted", model: "offline", tool_policy: "achilles__*", observed_catalog: [] }, tasks: [task] as never });
  expect(report.tasks[0].status).toBe("needs_review");
  expect(aggregateTaskResults(report.tasks)).toEqual({});
  expect(reportJson(report)).toContain('"after": "bogus"');
  expect(reportMarkdown(report)).toContain("| reading-list-one-prompt | update-and-read | progress | unread | bogus |");
  expect(reportMarkdown(report)).toContain("needs review: extend the value map or confirm agent fail");

  const mixed = makeReport({ run_id: "run", repeats: 1, agent: { provider: "scripted", model: "offline", tool_policy: "achilles__*", observed_catalog: [] }, tasks: [{ ...task, checks: [check, { ...check, id: "other", reason: "wrong_value" }] }] as never });
  expect(mixed.tasks[0].status).toBe("agent_fail");
  expect(aggregateTaskResults(mixed.tasks)["reading-list-one-prompt"].total).toBe(1);
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

const row = (task_id: string, pass: boolean, turns = 4, input_tokens = 100) => ({ task_id, pass, turns, usage: { input_tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
const base = (tasks: unknown[]) => parseBaseReport(JSON.stringify({ run_id: "old", tasks }), "old-report");

test("diff lists pass -> fail before fail -> pass, then large deltas and one-sided tasks", () => {
  const diff = diffMarkdown(base([row("up", false), row("down", true), row("same", true), row("slow", true, 4, 100), row("gone", true)]), { tasks: [row("up", true), row("down", false), row("same", true, 5), row("slow", true, 6, 200), row("new", true)] } as never);
  expect(diff.startsWith("# changes since old-report (run old)")).toBe(true);
  expect(diff.indexOf("- down: 1/1 -> 0/1")).toBeGreaterThan(diff.indexOf("pass -> fail"));
  expect(diff.indexOf("fail -> pass")).toBeGreaterThan(diff.indexOf("- down:"));
  expect(diff.indexOf("- up: 0/1 -> 1/1")).toBeGreaterThan(diff.indexOf("fail -> pass"));
  expect(diff).toContain("- slow: median turns 4 -> 6 (+50%); median tokens 100 -> 200 (+100%)");
  expect(diff).not.toContain("- same:");
  expect(diff).toContain("- gone: only in base");
  expect(diff).toContain("- new: only in this run");
});

test("diff aggregates repeats by pass rate and skips harness errors", () => {
  const diff = diffMarkdown(base([row("a", true), row("a", true), row("a", false), { ...row("b", false), status: "harness_error" }]), { tasks: [row("a", true), row("a", false), row("a", false), row("b", true)] } as never);
  expect(diff).toContain("- a: 2/3 -> 1/3");
  expect(diff).toContain("- b: no comparable runs in one side");
});

test("malformed base gives a clear error", async () => {
  expect(() => parseBaseReport("{", "x")).toThrow("BASE x: report.json is not valid json");
  expect(() => parseBaseReport("[]", "x")).toThrow("BASE x: report.json has no tasks list");
  expect(() => parseBaseReport(JSON.stringify({ tasks: [{ task_id: "a", pass: "yes", turns: 1 }] }), "x")).toThrow("BASE x: task 0 needs task_id, pass, and turns");
  await expect(loadBaseReport("/nonexistent/achilles-base")).rejects.toThrow("BASE achilles-base: no readable report.json");
});

test("report without base is unchanged and with base starts with the diff", () => {
  const report = makeReport({ run_id: "run", repeats: 1, agent: { provider: "p", model: "m", tool_policy: "t", observed_catalog: [] }, tasks: [{ ...row("a", true), score: 100, tool_calls: 0, wall_ms: 1, approvals: 0, checks: [] }] as never });
  const plain = reportMarkdown(report);
  expect(plain.startsWith("# achilles eval run")).toBe(true);
  expect(reportMarkdown(report, base([row("a", false)]))).toBe(diffMarkdown(base([row("a", false)]), report) + "\n" + plain);
});
