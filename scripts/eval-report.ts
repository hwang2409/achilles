import { PINNED_OUTPUT_UNAVAILABLE, type TranscriptUsage } from "./eval-usage";

export type TaskResult = ReturnType<(typeof import("./eval-grade"))["gradeTask"]> & { status?: "pass" | "agent_fail" | "harness_error" | "unsupported"; cap_hit?: boolean; gap?: string };
export type UnmappedValue = { task_id: string; check_id: string; field: string; before: unknown; after: unknown };
export type EvalReport = {
  run_id: string;
  agent: { provider: string; model: string; tool_policy: string; observed_catalog: string[]; achilles_sha?: string; zeta_sha?: string };
  repeats: number;
  tasks: Array<TaskResult & { transcript?: string }>;
  unmapped_values: UnmappedValue[];
  totals?: { turns: number; wall_ms: number; usage?: TranscriptUsage | "unavailable" };
};

function aggregateUsage(tasks: EvalReport["tasks"]): TranscriptUsage | "unavailable" {
  const rows = tasks.map(task => task.usage).filter((usage): usage is TranscriptUsage => Boolean(usage && typeof usage === "object"));
  if (rows.length !== tasks.length) return "unavailable";
  const sum = (key: "input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens") => rows.every(row => typeof row[key] === "number") ? rows.reduce((total, row) => total + (row[key] as number), 0) : "unavailable" as const;
  return {
    turns_with_usage: rows.reduce((total, row) => total + row.turns_with_usage, 0),
    input_tokens: sum("input_tokens"),
    output_tokens: rows.every(row => typeof row.output_tokens === "number") ? rows.reduce((total, row) => total + (row.output_tokens as number), 0) : PINNED_OUTPUT_UNAVAILABLE,
    reasoning_output_tokens: rows.every(row => typeof row.reasoning_output_tokens === "number") ? rows.reduce((total, row) => total + (row.reasoning_output_tokens as number), 0) : PINNED_OUTPUT_UNAVAILABLE,
    cache_read_input_tokens: sum("cache_read_input_tokens"),
    cache_creation_input_tokens: sum("cache_creation_input_tokens"),
  };
}

export function makeReport(input: Omit<EvalReport, "tasks" | "unmapped_values"> & { tasks: EvalReport["tasks"] }): EvalReport {
  const tasks = input.tasks.map((task) => ({ ...task, usage: task.usage ?? "unavailable" }));
  const unmapped_values = tasks.flatMap(task => task.task_id === "reading-list-one-prompt" ? task.checks.flatMap(check => {
    if (!check.reason?.startsWith("unmapped_after_value:")) return [];
    const transition = (check.evidence as { transition?: Omit<UnmappedValue, "task_id" | "check_id"> }).transition;
    return transition ? [{ task_id: task.task_id, check_id: check.id, ...transition }] : [];
  }) : []);
  return { ...input, totals: input.totals && { ...input.totals, usage: aggregateUsage(tasks) }, tasks, unmapped_values };
}

export function aggregateTaskResults(results: Array<{ task_id: string; pass: boolean; score: number; turns: number; tool_calls: number; wall_ms: number }>) {
  const grouped = new Map<string, typeof results>();
  for (const result of results) if (!["harness_error", "unsupported"].includes((result as { status?: string }).status ?? "")) grouped.set(result.task_id, [...(grouped.get(result.task_id) ?? []), result]);
  return Object.fromEntries([...grouped].map(([task_id, rows]) => [task_id, {
    passes: rows.filter((row) => row.pass).length,
    total: rows.length,
    pass_rate: rows.filter((row) => row.pass).length / rows.length,
    score_min: Math.min(...rows.map((row) => row.score)),
    score_max: Math.max(...rows.map((row) => row.score)),
    median_turns: median(rows.map((row) => row.turns)),
    median_tool_calls: median(rows.map((row) => row.tool_calls)),
    median_wall_ms: median(rows.map((row) => row.wall_ms)),
    cap_hits: rows.filter(row => (row as { cap_hit?: boolean }).cap_hit).length,
    cap_action: rows.filter(row => (row as { cap_hit?: boolean }).cap_hit).length > 1 ? "raise cap" : "",
  }]));
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return 0; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

export function reportJson(report: EvalReport): string { return JSON.stringify(report, null, 2) + "\n"; }
const usageText = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return "unavailable";
  const value = usage as TranscriptUsage;
  return `input ${value.input_tokens}; output ${value.output_tokens}; reasoning ${value.reasoning_output_tokens}; cache read ${value.cache_read_input_tokens}; cache write ${value.cache_creation_input_tokens}`;
};
export function reportMarkdown(report: EvalReport): string {
  const grouped = aggregateTaskResults(report.tasks);
  const lines = [
    `# achilles eval ${report.run_id}`, "",
    `agent: \`${report.agent.provider}/${report.agent.model}\``,
    `tool policy: \`${report.agent.tool_policy}\``,
    `observed catalog: ${report.agent.observed_catalog.length ? report.agent.observed_catalog.map((name) => `\`${name}\``).join(", ") : "none"}`,
    `achilles: ${report.agent.achilles_sha ?? "unavailable"}`,
    `zeta: ${report.agent.zeta_sha ?? "unavailable"}`,
    `repeats: ${report.repeats}`,
    `totals: ${report.totals?.turns ?? report.tasks.reduce((total, task) => total + task.turns, 0)} turns, ${report.totals?.wall_ms ?? report.tasks.reduce((total, task) => total + task.wall_ms, 0)} ms wall time`,
    `suite tokens: ${usageText(report.totals?.usage)}`,
    `harness errors: ${report.tasks.filter(task => task.status === "harness_error").length}`,
    `unsupported: ${report.tasks.filter(task => task.status === "unsupported").length}`,
    `cap hits: ${report.tasks.filter(task => task.cap_hit).length}`,
    "account home: provider credentials are read from the configured account home; isolation covers Achilles and Zeta run state, not the external provider account.",
    "", "| task | status | score | turns | tool calls | approvals | wall time | usage | host tools gap | create_page first call | create_tool first call | structured errors | unstructured errors | cap hit |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const task of report.tasks) {
    const first = task.diagnostics?.first_call_validity ?? {};
    lines.push(`| ${task.task_id} | ${task.status ?? (task.pass ? "pass" : "agent_fail")}${task.gap ? ` (${task.gap.startsWith("capability_missing:") ? "goal not reachable on this revision" : task.gap})` : ""} | ${task.score} | ${task.turns} | ${task.tool_calls} | ${task.approvals} | ${task.wall_ms} ms | ${usageText(task.usage)} | ${task.host_tools_gap ? "yes" : "no"} | ${first.create_page === undefined ? "n/a" : first.create_page ? "yes" : "no"} | ${first.create_tool === undefined ? "n/a" : first.create_tool ? "yes" : "no"} | ${task.diagnostics?.structured_tool_errors.length ?? 0} | ${task.diagnostics?.unstructured_tool_errors ?? 0} | ${task.cap_hit ? "yes" : "no"} |`);
  }
  lines.push("", "## unmapped values", "");
  if (!report.unmapped_values.length) lines.push("none");
  else {
    lines.push("| task | check | field | before | after |", "| --- | --- | --- | --- | --- |");
    for (const value of report.unmapped_values) lines.push(`| ${value.task_id} | ${value.check_id} | ${value.field} | ${String(value.before)} | ${String(value.after)} |`);
  }
  lines.push("", "## grouped repeat metrics", "", "unsupported and harness-error runs are excluded from comparable task metrics.", "", "| task | passes | repeats | pass rate | score range | median turns | median tool calls | median wall time | cap hits | action |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [task, value] of Object.entries(grouped)) lines.push(`| ${task} | ${value.passes} | ${value.total} | ${(value.pass_rate * 100).toFixed(0)}% | ${value.score_min}–${value.score_max} | ${value.median_turns} | ${value.median_tool_calls} | ${value.median_wall_ms} ms | ${value.cap_hits} | ${value.cap_action} |`);
  return lines.join("\n") + "\n";
}
