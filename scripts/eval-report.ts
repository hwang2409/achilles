import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MAX_AGENT_TURNS } from "./eval-grade";
import { PINNED_OUTPUT_UNAVAILABLE, type TranscriptUsage } from "./eval-usage";

export type TaskResult = ReturnType<(typeof import("./eval-grade"))["gradeTask"]> & { status?: "pass" | "agent_fail" | "harness_error" | "unsupported" | "needs_review"; cap_hit?: boolean; gap?: string };
export type UnmappedValue = { task_id: string; check_id: string; field: string; before: unknown; after: unknown };
export type EvalReport = {
  run_id: string;
  // what ran: the SUITE name for a full run, else the sorted TASK ids; BASE=last matches on it
  suite?: string;
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
  const tasks = input.tasks.map((task) => {
    const failedChecks = task.checks.filter(check => !check.pass);
    const onlyUnmapped = task.task_id === "reading-list-one-prompt" && failedChecks.length > 0 && failedChecks.every(check => check.reason?.startsWith("unmapped_after_value:"));
    return { ...task, status: onlyUnmapped ? "needs_review" : task.status, usage: task.usage ?? "unavailable" };
  });
  const unmapped_values = tasks.flatMap(task => task.task_id === "reading-list-one-prompt" ? task.checks.flatMap(check => {
    if (!check.reason?.startsWith("unmapped_after_value:")) return [];
    const transition = (check.evidence as { transition?: Omit<UnmappedValue, "task_id" | "check_id"> }).transition;
    return transition ? [{ task_id: task.task_id, check_id: check.id, ...transition }] : [];
  }) : []);
  return { ...input, totals: input.totals && { ...input.totals, usage: aggregateUsage(tasks) }, tasks, unmapped_values };
}

export function aggregateTaskResults(results: Array<{ task_id: string; pass: boolean; score: number; turns: number; tool_calls: number; wall_ms: number }>) {
  const grouped = new Map<string, typeof results>();
  for (const result of results) if (!["harness_error", "unsupported", "needs_review"].includes((result as { status?: string }).status ?? "")) grouped.set(result.task_id, [...(grouped.get(result.task_id) ?? []), result]);
  return Object.fromEntries([...grouped].map(([task_id, rows]) => [task_id, {
    passes: rows.filter((row) => row.pass).length,
    total: rows.length,
    pass_rate: rows.filter((row) => row.pass).length / rows.length,
    score_min: Math.min(...rows.map((row) => row.score)),
    score_max: Math.max(...rows.map((row) => row.score)),
    mean_score: mean(rows.map((row) => row.score)),
    mean_turns: mean(rows.map((row) => row.turns)),
    median_turns: median(rows.map((row) => row.turns)),
    median_tool_calls: median(rows.map((row) => row.tool_calls)),
    median_wall_ms: median(rows.map((row) => row.wall_ms)),
    cap_hits: rows.filter(row => (row as { cap_hit?: boolean }).cap_hit).length,
    cap_action: rows.filter(row => (row as { cap_hit?: boolean }).cap_hit).length > 1 ? "raise cap" : "",
  }]));
}
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return 0; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };

export function reportJson(report: EvalReport): string { return JSON.stringify(report, null, 2) + "\n"; }
const usageText = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return "unavailable";
  const value = usage as TranscriptUsage;
  return `input ${value.input_tokens}; output ${value.output_tokens}; reasoning ${value.reasoning_output_tokens}; cache read ${value.cache_read_input_tokens}; cache write ${value.cache_creation_input_tokens}`;
};
const runPassed = (task: EvalReport["tasks"][number]) => task.pass && task.status !== "needs_review";
const short = (sha?: string) => sha ? sha.slice(0, 7) : "unavailable";
const clip = (value: unknown, limit = 200) => { const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); return text.length > limit ? `${text.slice(0, limit)}...` : text; };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
// final answers per run, keyed by the run's snapshot path (`task.transcript`); each value maps step id -> answer
export type FinalAnswers = Record<string, Record<string, string> | undefined>;

const passCount = (tasks: BaseReport["tasks"]) => { const graded = tasks.filter(task => task.status !== "unsupported"); return { passed: graded.filter(task => task.pass && task.status !== "needs_review").length, graded: graded.length, unsupported: tasks.length - graded.length }; };

// the top of report.md and the terminal summary: one result line, the eval tool set, then every failed run
export function reportSummary(report: EvalReport, answers: FinalAnswers = {}): string {
  const { passed, graded, unsupported } = passCount(report.tasks);
  const wallMs = report.totals?.wall_ms ?? report.tasks.reduce((total, task) => total + task.wall_ms, 0);
  const tokens = totalTokens(report.totals?.usage);
  const lines = [
    [`${passed === graded ? "PASS" : "FAIL"} ${passed}/${graded}${unsupported ? ` (${unsupported} unsupported)` : ""}`, `achilles ${short(report.agent.achilles_sha)}`, `zeta ${short(report.agent.zeta_sha)}`, `model ${report.agent.provider}/${report.agent.model}`, `${(wallMs / 60_000).toFixed(1)} min`, tokens === undefined ? "tokens unavailable" : `${tokens} tokens`].join(" | "),
    "",
    `eval agent: tools \`${report.agent.tool_policy}\`, max turns per task from its agent_turns (at most ${MAX_AGENT_TURNS}), no auto memory.`,
    "live `make dev` page chats differ: zeta's default tool set plus all MCP servers, zeta's default limit of 150 turns, auto memory on, no `--yolo`.",
    "", "## failures", "",
  ];
  const failed = report.tasks.filter(task => task.status !== "unsupported" && !runPassed(task));
  if (!failed.length) lines.push("none");
  for (const task of failed) lines.push(...failureBlock(task, answers));
  return lines.join("\n").trimEnd() + "\n";
}

function failureBlock(task: EvalReport["tasks"][number], answers: FinalAnswers): string[] {
  const run = task.transcript?.match(/-(\d+)\.json$/)?.[1];
  const lines = [`### ${task.task_id}${run ? ` run ${run}` : ""}: ${task.status ?? "agent_fail"}, score ${task.score}${task.cap_hit ? ", turn cap hit" : ""}`, ""];
  for (const check of task.checks.filter(check => !check.pass)) {
    const why = check.reason ?? (check.evidence as { message?: unknown } | undefined)?.message;
    lines.push(`- check \`${check.id}\`: expected ${clip(check.expected)}, actual ${clip(check.actual)}${why ? ` (${clip(why)})` : ""}`);
  }
  const final = Object.entries((task.transcript && answers[task.transcript]) || {}).at(-1);
  lines.push(final ? `- final answer (step \`${final[0]}\`): ${JSON.stringify(final[1].length > 300 ? `${final[1].slice(0, 300)}...` : final[1])}` : "- final answer: none captured");
  lines.push(`- snapshot: ${task.transcript ?? "unavailable"}`, "");
  return lines;
}

export function reportMarkdown(report: EvalReport, base?: BaseReport, answers: FinalAnswers = {}): string {
  const grouped = aggregateTaskResults(report.tasks);
  const lines = [
    `# results of run ${report.run_id}`, "",
    `observed catalog: ${report.agent.observed_catalog.length ? report.agent.observed_catalog.map((name) => `\`${name}\``).join(", ") : "none"}`,
    `achilles: ${report.agent.achilles_sha ?? "unavailable"}`,
    `zeta: ${report.agent.zeta_sha ?? "unavailable"}`,
    `repeats: ${report.repeats}`,
    `totals: ${report.totals?.turns ?? report.tasks.reduce((total, task) => total + task.turns, 0)} turns, ${seconds(report.totals?.wall_ms ?? report.tasks.reduce((total, task) => total + task.wall_ms, 0))} wall time`,
    `suite tokens: ${usageText(report.totals?.usage)}`,
    `harness errors: ${report.tasks.filter(task => task.status === "harness_error").length}`,
    `unsupported: ${report.tasks.filter(task => task.status === "unsupported").length}`,
    `needs review: ${report.tasks.filter(task => task.status === "needs_review").length}`,
    `cap hits: ${report.tasks.filter(task => task.cap_hit).length}`,
    `conflict seen (report only, not graded): ${report.tasks.filter(task => task.diagnostics?.conflict_seen !== undefined).map(task => `${task.task_id} ${task.diagnostics.conflict_seen ? "yes" : "no"}`).join(", ") || "n/a"}`,
    "account home: provider credentials are read from the configured account home; isolation covers Achilles and Zeta run state, not the external provider account.",
    "", "| task | status | score | turns | tool calls | approvals | wall time | tokens |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const task of report.tasks) {
    lines.push(`| ${task.task_id} | ${task.status ?? (task.pass ? "pass" : "agent_fail")}${task.gap ? ` (${task.gap.startsWith("capability_missing:") ? "goal not reachable on this revision" : task.gap})` : ""} | ${task.score} | ${task.turns} | ${task.tool_calls} | ${task.approvals} | ${seconds(task.wall_ms)} | ${totalTokens(task.usage) ?? "unavailable"} |`);
  }
  lines.push("", "## diagnostics", "", "| task | usage | host tools gap | create_page first call | create_tool first call | structured errors | unstructured errors | cap hit |", "| --- | --- | --- | --- | --- | ---: | ---: | --- |");
  for (const task of report.tasks) {
    const first = task.diagnostics?.first_call_validity ?? {};
    lines.push(`| ${task.task_id} | ${usageText(task.usage)} | ${task.host_tools_gap ? "yes" : "no"} | ${first.create_page === undefined ? "n/a" : first.create_page ? "yes" : "no"} | ${first.create_tool === undefined ? "n/a" : first.create_tool ? "yes" : "no"} | ${task.diagnostics?.structured_tool_errors.length ?? 0} | ${task.diagnostics?.unstructured_tool_errors ?? 0} | ${task.cap_hit ? "yes" : "no"} |`);
  }
  lines.push("", "## unmapped values", "");
  if (!report.unmapped_values.length) lines.push("none");
  else {
    lines.push("| task | check | field | before | after |", "| --- | --- | --- | --- | --- |");
    for (const value of report.unmapped_values) lines.push(`| ${value.task_id} | ${value.check_id} | ${value.field} | ${String(value.before)} | ${String(value.after)} |`);
  }
  // one row per task over every run; pass rate, mean score, and mean turns use graded runs only
  lines.push("", "## per task", "", "runs counts every run. pass rate, mean score, and mean turns count graded runs only: unsupported, needs-review, and harness-error runs are left out.", "needs review: extend the value map or confirm agent fail", "", "| task | runs | passes | pass rate | mean score | mean turns | cap hits | harness errors |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const id of [...new Set(report.tasks.map(task => task.task_id))]) {
    const runs = report.tasks.filter(task => task.task_id === id); const value = grouped[id];
    const graded = value ? `${value.passes}/${value.total} | ${(value.pass_rate * 100).toFixed(0)}% | ${value.mean_score.toFixed(0)} | ${value.mean_turns.toFixed(1)}` : "0/0 | n/a | n/a | n/a";
    lines.push(`| ${id} | ${runs.length} | ${graded} | ${runs.filter(task => task.cap_hit).length}${value?.cap_action ? ` (${value.cap_action})` : ""} | ${runs.filter(task => task.status === "harness_error").length} |`);
  }
  return reportSummary(report, answers) + "\n" + (base ? diffMarkdown(base, report) + "\n" : "") + lines.join("\n") + "\n";
}

// BASE: a saved report folder from an earlier run; its report.json is outside input, so check the fields the diff reads.
export type BaseReport = { name: string; run_id: string; tasks: Array<{ task_id: string; pass: boolean; turns: number; status?: string; usage?: unknown }>; achilles_sha?: string; zeta_sha?: string; suite?: string; repeats?: number; totals?: { turns?: number; wall_ms?: number; usage?: unknown } };
export function parseBaseReport(text: string, name: string): BaseReport {
  const fail = (why: string): never => { throw new Error(`BASE ${name}: ${why}`); };
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { fail(`report.json is not valid json (${(error as Error).message})`); }
  const report = data as { run_id?: unknown; tasks?: unknown; agent?: unknown; suite?: unknown; repeats?: unknown; totals?: unknown };
  if (!report || typeof report !== "object" || !Array.isArray(report.tasks)) fail("report.json has no tasks list");
  const tasks = (report.tasks as unknown[]).map((task, index) => {
    const row = task as { task_id?: unknown; pass?: unknown; turns?: unknown; status?: unknown };
    if (!row || typeof row !== "object" || typeof row.task_id !== "string" || typeof row.pass !== "boolean" || typeof row.turns !== "number") fail(`task ${index} needs task_id, pass, and turns`);
    return task as BaseReport["tasks"][number];
  });
  const agent = report.agent as { achilles_sha?: unknown; zeta_sha?: unknown } | undefined;
  return {
    name, run_id: typeof report.run_id === "string" ? report.run_id : "unknown", tasks,
    achilles_sha: typeof agent?.achilles_sha === "string" ? agent.achilles_sha : undefined,
    zeta_sha: typeof agent?.zeta_sha === "string" ? agent.zeta_sha : undefined,
    suite: typeof report.suite === "string" ? report.suite : undefined,
    repeats: typeof report.repeats === "number" ? report.repeats : undefined,
    totals: report.totals && typeof report.totals === "object" ? report.totals as BaseReport["totals"] : undefined,
  };
}
export async function loadBaseReport(dir: string): Promise<BaseReport> {
  const name = basename(dir);
  let text: string;
  try { text = await readFile(join(dir, "report.json"), "utf8"); } catch { throw new Error(`BASE ${name}: no readable report.json in that folder`); }
  return parseBaseReport(text, name);
}

// eval results stay on this machine, outside any checkout: the repo is public
export const historyDir = () => join(Bun.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "achilles", "evals");
const startedMs = (run: BaseReport) => Number.parseInt(run.run_id, 10) || 0;
// every readable run in the history dir, newest first; a folder without a valid report.json is skipped
export async function readHistory(dir = historyDir()): Promise<BaseReport[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const runs = await Promise.all(names.map(name => loadBaseReport(join(dir, name)).catch(() => undefined)));
  return runs.filter((run): run is BaseReport => Boolean(run)).sort((a, b) => startedMs(b) - startedMs(a));
}
// BASE=last: the newest run of the same suite, or undefined (no diff) when there is none
export async function lastRun(suite: string, dir = historyDir()): Promise<BaseReport | undefined> { return (await readHistory(dir)).find(run => run.suite === suite); }
export function historyLine(run: BaseReport): string {
  const { passed, graded } = passCount(run.tasks); const ms = startedMs(run); const tokens = totalTokens(run.totals?.usage);
  return [ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : run.name, `achilles ${short(run.achilles_sha)}`, `zeta ${short(run.zeta_sha)}`, run.suite ?? "suite unknown", `N=${run.repeats ?? "?"}`, `pass ${passed}/${graded}`, `${typeof run.totals?.turns === "number" ? run.totals.turns : run.tasks.reduce((total, task) => total + task.turns, 0)} turns`, tokens === undefined ? "tokens unavailable" : `${tokens} tokens`, typeof run.totals?.wall_ms === "number" ? `${(run.totals.wall_ms / 60_000).toFixed(1)} min` : "min unavailable"].join(" | ");
}

const totalTokens = (usage: unknown) => {
  if (!usage || typeof usage !== "object") return undefined;
  const values = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map(key => (usage as Record<string, unknown>)[key]);
  return values.every(value => typeof value === "number") ? (values as number[]).reduce((a, b) => a + b, 0) : undefined;
};
const percent = (from: number, to: number) => from === 0 ? (to === 0 ? 0 : Infinity) : (to - from) / from;
// per task: pass rate, median turns, median total tokens over comparable runs (same exclusions as the per-task table).
function summarize(tasks: BaseReport["tasks"]) {
  const grouped = aggregateTaskResults(tasks.map(task => ({ ...task, score: 0, tool_calls: 0, wall_ms: 0 })));
  return new Map(Object.entries(grouped).map(([id, value]) => {
    const tokens = tasks.filter(task => task.task_id === id && !["harness_error", "unsupported", "needs_review"].includes(task.status ?? "")).map(task => totalTokens(task.usage));
    return [id, { passes: value.passes, total: value.total, rate: value.pass_rate, turns: value.median_turns, tokens: tokens.every(token => token !== undefined) ? median(tokens as number[]) : undefined }];
  }));
}
export function diffMarkdown(base: BaseReport, report: Pick<EvalReport, "tasks"> & { agent?: Partial<EvalReport["agent"]> }): string {
  const before = summarize(base.tasks); const after = summarize(report.tasks);
  const ids = (tasks: BaseReport["tasks"]) => new Set(tasks.map(task => task.task_id));
  const baseIds = ids(base.tasks); const runIds = ids(report.tasks);
  const shared = [...after.keys()].filter(id => before.has(id)).sort();
  const rate = (value: { passes: number; total: number }) => `${value.passes}/${value.total}`;
  const lines = [`# changes since ${base.name} (run ${base.run_id})`];
  if (base.achilles_sha !== undefined || base.zeta_sha !== undefined) {
    lines.push(`base revisions: achilles ${base.achilles_sha ?? "unknown"}, zeta ${base.zeta_sha ?? "unknown"}`);
    const changed = ["achilles", "zeta"].filter(name => {
      const baseSha = name === "achilles" ? base.achilles_sha : base.zeta_sha;
      const runSha = name === "achilles" ? report.agent?.achilles_sha : report.agent?.zeta_sha;
      return baseSha !== undefined && runSha !== undefined && baseSha !== runSha;
    });
    if (changed.length) lines.push(`this run uses a different ${changed.join(" and ")} revision than the base`);
  }
  lines.push("");
  const section = (title: string, rows: string[]) => lines.push(`## ${title}`, "", ...(rows.length ? rows : ["none"]), "");
  section("pass -> fail (pass rate fell)", shared.filter(id => after.get(id)!.rate < before.get(id)!.rate).map(id => `- ${id}: ${rate(before.get(id)!)} -> ${rate(after.get(id)!)}`));
  section("fail -> pass (pass rate rose)", shared.filter(id => after.get(id)!.rate > before.get(id)!.rate).map(id => `- ${id}: ${rate(before.get(id)!)} -> ${rate(after.get(id)!)}`));
  const deltas = shared.flatMap(id => {
    const a = before.get(id)!; const b = after.get(id)!; const parts: string[] = [];
    const change = (label: string, from: number, to: number) => { const delta = percent(from, to); if (Math.abs(delta) > 0.25) parts.push(`${label} ${from} -> ${to} (${delta === Infinity ? "from 0" : `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}%`})`); };
    change("median turns", a.turns, b.turns);
    if (a.tokens !== undefined && b.tokens !== undefined) change("median tokens", a.tokens, b.tokens);
    return parts.length ? [`- ${id}: ${parts.join("; ")}`] : [];
  });
  section("turn or token change over 25%", deltas);
  const notComparable = [...baseIds].filter(id => runIds.has(id) && !(before.has(id) && after.has(id))).sort();
  section("tasks not compared", [
    ...[...baseIds].filter(id => !runIds.has(id)).sort().map(id => `- ${id}: only in base`),
    ...[...runIds].filter(id => !baseIds.has(id)).sort().map(id => `- ${id}: only in this run`),
    ...notComparable.map(id => `- ${id}: no comparable runs in one side (harness error, unsupported, or needs review)`),
  ]);
  return lines.join("\n");
}
