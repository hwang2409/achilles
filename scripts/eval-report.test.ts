import { expect, test } from "bun:test";
import { aggregateTaskResults, diffMarkdown, loadBaseReport, makeReport, parseBaseReport, reportJson, reportMarkdown, reportSummary } from "./eval-report";

test("report aggregates pass rate per task and states tools", () => {
  const rows = [{ task_id: "a", pass: true, score: 100, turns: 2, tool_calls: 1, wall_ms: 10 }, { task_id: "a", pass: false, score: 50, turns: 3, tool_calls: 2, wall_ms: 20 }];
  expect(aggregateTaskResults(rows).a.pass_rate).toBe(0.5);
  const usage = { turns_with_usage: 1, input_tokens: 10, output_tokens: "unavailable at this zeta pin", reasoning_output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } as const;
  const failed = { id: "count", pass: false, expected: 3, actual: 2, reason: "wrong_value" };
  const report = makeReport({ run_id: "run", repeats: 2, agent: { provider: "claude", model: "claude-opus-5-5", tool_policy: "achilles__*,mcp_discover", observed_catalog: ["achilles__list_notes"], achilles_sha: "aaaaaaa111", zeta_sha: "bbbbbbb222" }, totals: { turns: 5, wall_ms: 90_000 }, tasks: rows.map((row, index) => ({ ...row, approvals: 0, usage, checks: row.pass ? [] : [failed], host_tools_gap: false, transcript: `snapshots/a-${index + 1}.json` })) as never });
  const markdown = reportMarkdown(report, undefined, { "snapshots/a-2.json": { ask: "first", answer: "x".repeat(400) } });
  const top = markdown.split("\n");
  expect(top[0]).toBe("FAIL 1/2 | achilles aaaaaaa | zeta bbbbbbb | model claude/claude-opus-5-5 | 1.5 min | tokens unavailable");
  expect(top[2]).toBe("eval agent: tools `achilles__*,mcp_discover`, max turns per task from its agent_turns (default 20), no auto memory.");
  expect(top[3]).toStartWith("live `make dev` page chats differ:");
  expect(markdown).toContain("### a run 2: agent_fail, score 50\n\n- check `count`: expected 3, actual 2 (wrong_value)\n- final answer (step `answer`): \"" + "x".repeat(300) + "...\"\n- snapshot: snapshots/a-2.json");
  expect(markdown).not.toContain("### a run 1");
  expect(markdown.startsWith(reportSummary(report, { "snapshots/a-2.json": { ask: "first", answer: "x".repeat(400) } }))).toBe(true);
  expect(markdown).toContain("observed catalog");
  expect(markdown).toContain("| a | 2 | 1/2 | 50% | 75 | 2.5 | 0 | 0 |");
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

test("per-task table counts harness errors and cap hits over every run", () => {
  const run = (pass: boolean, status: string, extra = {}) => ({ task_id: "hard", pass, status, score: pass ? 100 : 40, turns: 6, tool_calls: 1, wall_ms: 1, approvals: 0, checks: [], host_tools_gap: false, usage: "unavailable", ...extra });
  const report = makeReport({ run_id: "run", repeats: 3, agent: { provider: "scripted", model: "offline", tool_policy: "achilles__*", observed_catalog: [] }, tasks: [run(true, "pass"), run(false, "agent_fail", { cap_hit: true }), run(false, "harness_error", { score: 0, turns: 0 }), { ...run(false, "harness_error"), task_id: "broken" }] as never });
  const markdown = reportMarkdown(report);
  expect(markdown).toContain("| hard | 3 | 1/2 | 50% | 70 | 6.0 | 1 | 1 |");
  expect(markdown).toContain("| broken | 1 | 0/0 | n/a | n/a | n/a | 0 | 1 |");
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

test("zero base median prints 'from 0' instead of 'new'", () => {
  const diff = diffMarkdown(base([row("z", false, 0)]), { tasks: [row("z", false, 4)] } as never);
  expect(diff).toContain("- z: median turns 0 -> 4 (from 0)");
});

test("header shows base achilles/zeta revisions when present, and flags a changed revision", () => {
  const baseWithShas = parseBaseReport(JSON.stringify({ run_id: "old", agent: { achilles_sha: "aaa111", zeta_sha: "bbb222" }, tasks: [row("a", true)] }), "old-report");
  const sameShas = diffMarkdown(baseWithShas, { tasks: [row("a", true)], agent: { achilles_sha: "aaa111", zeta_sha: "bbb222" } } as never);
  expect(sameShas).toContain("base revisions: achilles aaa111, zeta bbb222");
  expect(sameShas).not.toContain("this run uses a different");
  const changedShas = diffMarkdown(baseWithShas, { tasks: [row("a", true)], agent: { achilles_sha: "ccc333", zeta_sha: "bbb222" } } as never);
  expect(changedShas).toContain("this run uses a different achilles revision than the base");
  const noShas = diffMarkdown(base([row("a", true)]), { tasks: [row("a", true)] } as never);
  expect(noShas).not.toContain("base revisions:");
});

test("malformed base gives a clear error", async () => {
  expect(() => parseBaseReport("{", "x")).toThrow("BASE x: report.json is not valid json");
  expect(() => parseBaseReport("[]", "x")).toThrow("BASE x: report.json has no tasks list");
  expect(() => parseBaseReport(JSON.stringify({ tasks: [{ task_id: "a", pass: "yes", turns: 1 }] }), "x")).toThrow("BASE x: task 0 needs task_id, pass, and turns");
  await expect(loadBaseReport("/nonexistent/achilles-base")).rejects.toThrow("BASE achilles-base: no readable report.json");
});

test("report starts with the summary, then the base diff, then the results", () => {
  const report = makeReport({ run_id: "run", repeats: 1, agent: { provider: "p", model: "m", tool_policy: "t", observed_catalog: [] }, tasks: [{ ...row("a", true), score: 100, tool_calls: 0, wall_ms: 1, approvals: 0, checks: [] }] as never });
  const plain = reportMarkdown(report);
  const summary = reportSummary(report);
  expect(summary.startsWith("PASS 1/1 |")).toBe(true);
  expect(summary).toContain("## failures\n\nnone");
  expect(plain.startsWith(summary + "\n# results of run run")).toBe(true);
  expect(reportMarkdown(report, base([row("a", false)]))).toBe(summary + "\n" + diffMarkdown(base([row("a", false)]), report) + "\n" + plain.slice(summary.length + 1));
});
