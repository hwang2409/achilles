import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { approvalDecision, classifyTaskSupport, createDecisionQueue, finalAnswer, insertForms, relatedPages, scanArtifactTree, scanSecrets, selectTasks, stopsSuite, validateCatalog, validateReservedBundles, verifySetup } from "./eval";
import { gradeReference, validateTask, type TaskSetup } from "./eval-grade";

const targetRun = (target: string) => async (command: string, args: string[], cwd?: string) => {
  const python = command === "uv" && args[0] === "run" && !Bun.which("uv") ? args.slice(args.indexOf("python")) : [command, ...args];
  const process = Bun.spawn(python, { cwd, env: { ...Bun.env, PYTHONPATH: [join(target, "src"), target].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
};

async function waitForProcess(child: ReturnType<typeof Bun.spawn>, operation: string, timeoutMs: number) {
  const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(timeoutMs).then(() => true)]);
  if (!timedOut) return child.exitCode!;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(-child.pid, signal); } catch {}
    if (!await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])) continue;
    break;
  }
  throw new Error(`${operation} hung after ${timeoutMs / 1000} seconds; its process group was killed`);
}

test("setup verification accepts old and inspect_page layout shapes", () => {
  const setup = { tools: [], records: [], initial_layout: { blocks: [{ type: "text", text: "seeded" }] } };
  const base = { layout: setup.initial_layout, inspect: { tools: [] } };
  expect(() => verifySetup(setup, { ...base, inspect: { tools: [], layout: { ...setup.initial_layout, version: 1, digest: "old" } } })).not.toThrow();
  expect(() => verifySetup(setup, { ...base, inspect: { tools: [], layout: setup.initial_layout, layout_version: 1, layout_digest: "new" } })).not.toThrow();
});

test("every declared seed key is verified before setup and grading", () => {
  const setup: TaskSetup = { tools: [{ name: "add_note", operation: "insert", collection: "notes", input_schema: { type: "object", required: ["text"] } }], records: [{ id: "note-1", collection: "notes", data: { text: "seeded" } }], initial_layout: { blocks: [{ type: "text", text: "seeded" }] } };
  const stored = { tool_versions: [{ page_id: "home", ...setup.tools[0] }], records: [{ page_id: "home", ...setup.records[0] }], layouts: [{ page_id: "home", version: 1, document: setup.initial_layout }] } as Record<string, any>;
  const taskFor = (seed: TaskSetup) => validateTask({ id: "declared-seeds", page_plan: [{ alias: "p", source: "setup", bind_chat: true, create_mode: false }], agent_turns: 1, steps: [{ id: "work", kind: "prompt", page: "p", chat: "c", prompt: "work" }], setup: seed, checks: [{ id: "page", type: "page_exists", page: "p" }] });
  const grade = (seed: TaskSetup, initial: Record<string, any>) => gradeReference(taskFor(seed), { initial, pages: [{ id: "home", alias: "p" }] });
  const mutations: Array<[string, (state: Record<string, any>) => void]> = [
    ["tool name", state => { state.tool_versions[0].name = "wrong"; }],
    ["tool operation", state => { state.tool_versions[0].operation = "list"; }],
    ["tool collection", state => { state.tool_versions[0].collection = "wrong"; }],
    ["tool input_schema", state => { state.tool_versions[0].input_schema = { type: "object", required: ["title"] }; }],
    ["record id", state => { state.records[0].id = "wrong"; }],
    ["record collection", state => { state.records[0].collection = "wrong"; }],
    ["record data", state => { state.records[0].data = { text: "wrong" }; }],
    ["initial_layout", state => { state.layouts[0].document = { blocks: [] }; }],
  ];
  for (const [key, mutate] of mutations) {
    const changed = structuredClone(stored); mutate(changed);
    expect(() => verifySetup(setup, changed), `${key} setup verification`).toThrow("seed mismatch");
    expect(grade(setup, changed).status, `${key} grading precondition`).toBe("harness_error");
  }
  expect(() => verifySetup(setup, stored)).not.toThrow();
  expect(grade(setup, stored).status).toBe("pass");

  const withoutSchema = { ...setup, tools: [{ name: "add_note", operation: "insert" as const, collection: "notes" }] };
  expect(() => verifySetup(withoutSchema, stored), "an undeclared default input_schema is ignored").not.toThrow();
  expect(grade(withoutSchema, stored).status).toBe("pass");
});

test("setup seeds an initial layout on a fresh page at version 1", async () => {
  const target = resolve(new URL("..", import.meta.url).pathname); const root = await mkdtemp(join(tmpdir(), "achilles-layout-setup-"));
  try {
    const source = await readFile(join(target, "scripts/eval.ts"), "utf8"); const script = source.match(/(?:export )?const SETUP_SCRIPT = `([\s\S]*?)`;/)?.[1];
    expect(script).toBeDefined();
    const layout = { blocks: [{ type: "text", text: "seeded dashboard" }] }; const setup = { tools: [], records: [], initial_layout: layout };
    const seeded = await targetRun(target)("uv", ["run", "--project", target, "python", "-c", script!, root, "home", JSON.stringify(setup)], target);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    expect(() => verifySetup(setup, JSON.parse(seeded.stdout))).not.toThrow();
    const inspected = await targetRun(target)("uv", ["run", "--project", target, "python", "-c", "import json,sys; from pathlib import Path; from achilles.pages import PageStore; store=PageStore(Path(sys.argv[1])); summary=store.inspect_page('home'); print(json.dumps({'layout':store.layout('home'),'version':summary.get('layout_version',summary['layout'].get('version'))}))", root], target);
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual({ layout, version: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("turn cap report preserves the seeded initial snapshot", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const target = resolve(new URL("..", import.meta.url).pathname); const root = await mkdtemp(join(tmpdir(), "achilles-turn-cap-"));
  const taskId = "turn-cap-seeded-snapshot"; const tasks = join(root, "tasks"); const taskPath = join(tasks, `${taskId}.json`); let child: ReturnType<typeof Bun.spawn> | undefined;
  const layout = { blocks: [{ type: "text", text: "Seeded dashboard" }] }; const record = { id: "seed-1", collection: "notes", data: { text: "Seeded note" } };
  try {
    await mkdir(tasks);
    await Bun.write(taskPath, JSON.stringify({ id: taskId, page_plan: [{ alias: "seeded", source: "setup", bind_chat: true, create_mode: true }], agent_turns: 1, steps: [{ id: "use-turn", kind: "prompt", page: "seeded", chat: "seeded-chat", prompt: "keep using tools" }, { id: "exhaust", kind: "prompt", page: "seeded", chat: "seeded-chat", prompt: "continue" }], setup: { tools: [], records: [record], initial_layout: layout }, checks: [{ id: "seeded-record", type: "record", page: "seeded", value: record.data }] }));
    const revision = (await readFile(join(target, "zeta.rev"), "utf8")).trim(); const warmZeta = join(target, ".cache/zeta"); const runnerZeta = join(target, ".cache", `zeta-${revision}`);
    if (await Bun.file(join(warmZeta, ".git/HEAD")).exists() && !await Bun.file(join(runnerZeta, ".git/HEAD")).exists()) await symlink(warmZeta, runnerZeta, "dir").catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    if (!await Bun.file(join(target, ".venv/bin/achilles")).exists()) { const synced = await targetRun(target)("uv", ["sync", "--project", target, "--frozen"], target); expect(synced.exitCode, synced.stderr).toBe(0); }
    child = Bun.spawn(["bun", "scripts/eval.ts", "--suite", taskId], { cwd: target, detached: true, env: { ...Bun.env, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", EVAL_TASKS_DIR: tasks, REPORT_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    const exitCode = await waitForProcess(child, "scripted turn-cap eval", 90_000);
    expect(exitCode, `${await stdout}\n${await stderr}`).toBe(1);
    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8")); const result = report.tasks[0];
    const snapshot = JSON.parse(await readFile(join(root, result.transcript), "utf8"));
    expect(snapshot.initial, "turn-cap snapshot must retain initial setup").toBeDefined();
    expect(snapshot.initial.layouts).toContainEqual(expect.objectContaining({ page_id: "home", version: 1, document: layout }));
    expect(snapshot.initial?.records).toContainEqual(expect.objectContaining({ page_id: "home", ...record }));
    expect(result).toEqual(expect.objectContaining({ status: "agent_fail", cap_hit: true }));
    expect(JSON.stringify(result.checks)).not.toContain("setup precondition unverifiable");
  } finally {
    if (child?.exitCode === null) { child.kill(); await Promise.race([child.exited, Bun.sleep(500)]); }
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);

test("scripted faults: a zeta restart mid-approval resumes the same chat, and a 529 run keeps its write and retries once", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const target = resolve(new URL("..", import.meta.url).pathname); const root = await mkdtemp(join(tmpdir(), "achilles-faults-")); const tasks = join(root, "tasks"); let child: ReturnType<typeof Bun.spawn> | undefined;
  const restart = { id: "restart-scripted", page_plan: [{ alias: "tasks", source: "setup", bind_chat: true, create_mode: false }], agent_turns: 8, approval_mode: "ask", steps: [{ id: "add", kind: "prompt", page: "tasks", chat: "tasks-chat", prompt: "add_task each of these with the field title: Alpha, Beta, Gamma", during: { tool: "achilles__add_task", nth: 2, restart_zeta: true } }, { id: "resume", kind: "prompt", page: "tasks", chat: "tasks-chat", prompt: "continue" }], setup: { tools: [{ name: "add_task", operation: "insert", collection: "tasks" }], records: [] }, checks: [{ id: "records", type: "records_exact", page: "tasks", value: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }] }, { id: "recovery", type: "restart_recovery", page: "tasks", step: "resume", collection: "tasks", fields: ["title"] }] };
  try {
    await mkdir(tasks); await Bun.write(join(tasks, "restart-scripted.json"), JSON.stringify(restart));
    await Bun.write(join(tasks, "provider-error-try-again.json"), await readFile(join(target, "evals/tasks/provider-error-try-again.json"), "utf8"));
    const revision = (await readFile(join(target, "zeta.rev"), "utf8")).trim(); const warmZeta = join(target, ".cache/zeta"); const runnerZeta = join(target, ".cache", `zeta-${revision}`);
    if (await Bun.file(join(warmZeta, ".git/HEAD")).exists() && !await Bun.file(join(runnerZeta, ".git/HEAD")).exists()) await symlink(warmZeta, runnerZeta, "dir").catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    child = Bun.spawn(["bun", "scripts/eval.ts", "--suite", "restart-scripted,provider-error-try-again"], { cwd: target, detached: true, env: { ...Bun.env, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", EVAL_SKIP_BROWSER_INSTALL: "1", EVAL_TASKS_DIR: tasks, REPORT_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    const exitCode = await waitForProcess(child, "scripted fault eval", 150_000);
    expect(exitCode, `${await stdout}\n${await stderr}`).toBe(0);
    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8")); const [restarted, faulted] = report.tasks;
    expect(restarted.status, JSON.stringify(restarted.checks)).toBe("pass");
    const row = JSON.parse(await readFile(join(root, restarted.transcript), "utf8")).interjections[0];
    expect(row).toEqual(expect.objectContaining({ action: "restart_zeta", ok: true, history_continuity: true, resumed_session_id: row.original_session_id }));
    expect(row.started_pid).not.toBe(row.killed_pid);
    expect(faulted.status, JSON.stringify(faulted.checks)).toBe("pass");
  } finally {
    if (child?.exitCode === null) { child.kill(); await Promise.race([child.exited, Bun.sleep(500)]); }
    await rm(root, { recursive: true, force: true });
  }
}, 160_000);

test("suite selection validates every task and sums one command budget", async () => {
  const tasks = await selectTasks();
  expect(tasks.map(task => task.id)).toEqual([...tasks].map(task => task.id).sort());
  expect(reserveTurns(tasks, 1)).toBe(tasks.reduce((total, task) => total + task.agent_turns, 0));
  expect(() => assertTurnBudget(reserveTurns(tasks, 50))).toThrow("command budget");
  expect(tasks.every(task => task.suite === "core")).toBe(true);
  const hard = await selectTasks(undefined, undefined, "hard");
  expect(hard.length).toBeGreaterThan(0);
  expect(hard.every(task => task.suite === "hard")).toBe(true);
  // the hard suite fits one command at N=1; N=3 runs take a TASK= subset
  expect(() => assertTurnBudget(reserveTurns(hard, 1))).not.toThrow();
  // LOOP budget: a full run of core or hard is at most 12 tasks; the loader refuses a 13th
  expect(tasks.length).toBeLessThanOrEqual(12); expect(hard.length).toBeLessThanOrEqual(12);
  const root = await mkdtemp(join(tmpdir(), "achilles-suite-budget-"));
  try {
    const task = JSON.parse(await readFile(new URL("../evals/tasks/harness-smoke.json", import.meta.url), "utf8"));
    for (let index = 0; index < 13; index++) await Bun.write(join(root, `budget-${index}.json`), JSON.stringify({ ...task, id: `budget-${index}`, suite: "hard" }));
    await expect(selectTasks(undefined, root, "hard")).rejects.toThrow("the hard suite has 13 tasks; a full run allows at most 12");
    expect((await selectTasks("budget-0,budget-1", root, "hard")).length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
  // a fault the real provider cannot take needs the scripted marker, so a real run reports it unsupported instead of spending turns
  const faulted = JSON.parse(await readFile(new URL("../evals/tasks/provider-error-retried.json", import.meta.url), "utf8"));
  expect(validateTask(faulted).backend).toBe("scripted");
  expect(() => validateTask({ ...faulted, backend: undefined })).toThrow('set backend: "scripted"');
});

test("turn reservation is command-wide", () => {
  expect(reserveTurns([{ agent_turns: 20 }, { agent_turns: 20 }], 2)).toBe(80);
  expect(() => assertTurnBudget(241)).toThrow("command budget");
});

test("live turn budget allows the cap and aborts only excess work", async () => {
  let aborts = 0;
  const enforce = enforceTurnBudget(2, async () => { aborts += 1; });
  await enforce({ event: "turn_start" });
  await enforce({ event: "turn_start" });
  expect(aborts).toBe(0);
  await expect(enforce({ event: "turn_start" })).rejects.toThrow("limit exceeded");
  expect(aborts).toBe(1);
});

test("capability probe keeps an unrelated internal ImportError as a harness_error", async () => {
  const task = { id: "capability", requires: ["update_layout"] } as never;
  const root = await mkdtemp(join(tmpdir(), "achilles-broken-target-"));
  try {
    await mkdir(join(root, "achilles"));
    await Bun.write(join(root, "pyproject.toml"), '[project]\nname="broken-target"\nversion="0.0.0"\nrequires-python=">=3.11"\n');
    await Bun.write(join(root, "achilles", "__init__.py"), "");
    await Bun.write(join(root, "achilles", "tools.py"), "from achilles import unrelated\n");
    await Bun.write(join(root, "achilles", "unrelated.py"), 'raise ImportError("unrelated dependency broke")\n');
    const result = await classifyTaskSupport({ run: targetRun(root), achillesDir: root } as never, task, []);
    expect(result?.status).toBe("harness_error");
    expect(result?.checks[0].evidence).toEqual(expect.objectContaining({ message: expect.stringContaining("unrelated dependency broke") }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reading metric baseline without update_layout is unsupported, not agent_fail", async () => {
  const task = { id: "reading-metric-count", requires: ["update_layout"] } as never;
  const root = await mkdtemp(join(tmpdir(), "achilles-old-metric-target-"));
  try {
    await mkdir(join(root, "achilles"));
    await Bun.write(join(root, "pyproject.toml"), '[project]\nname="old-metric-target"\nversion="0.0.0"\nrequires-python=">=3.11"\n');
    await Bun.write(join(root, "achilles", "__init__.py"), "");
    await Bun.write(join(root, "achilles", "tools.py"), 'BUILTIN_TOOL_NAMES = ("create_page", "create_tool")\n');
    await Bun.write(join(root, "achilles", "pages.py"), "class PageStore:\n    def create_page(self, page_id): pass\n");
    const result = await classifyTaskSupport({ run: targetRun(root), achillesDir: root } as never, task, []);
    expect(result?.status).toBe("unsupported");
    expect(result?.checks[0].evidence).toEqual({ missing: ["update_layout"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reserved bundle validation uses the target revision's validator after changing only the name", async () => {
  const valid = { format_version: 1, kind: "data_operation", name: "create_tool", description: "synthetic tool", input_schema: { type: "object", additionalProperties: true }, output_schema: { type: "object", additionalProperties: true, properties: { record_id: { type: "string" }, revision: { type: "integer" } }, required: ["record_id", "revision"] }, implementation: { operation: "insert", collection: "records", data_schema: { type: "object", additionalProperties: true } } };
  const invalid = [
    { ...valid, implementation: { ...valid.implementation, collection: "" } },
    { ...valid, input_schema: { type: "not-a-json-schema-type" } },
    { ...valid, extra: true },
    { ...valid, description: "x".repeat(10_000) },
  ];
  const bundles = [valid, ...invalid]; const calls = bundles.map((bundle, index) => ({ id: `call-${index}`, tool: "achilles__create_tool", arguments: { bundle } }));
  const results = calls.map(call => ({ call_id: call.id, success: false }));
  const target = Bun.env.ACHILLES_DIR ?? resolve(new URL("..", import.meta.url).pathname);
  const validations = await validateReservedBundles({ run: targetRun(target), achillesDir: target } as never, calls, results);
  expect(validations.map(row => row.valid)).toEqual([true, false, false, false, false]);
});

test("related pages include both ends of successful page-tool calls only", () => {
  const before = { pages: [{ id: "home" }], tools: [], records: [], layouts: [], assignments: [] };
  const after = { pages: [{ id: "home" }, { id: "review" }], tools: [{ id: "tool-1", page_id: "review", name: "add_annotation" }], records: [], layouts: [], assignments: [] };
  const calls = [
    { page_id: "home", tool: "achilles__inspect_page", success: true },
    { page_id: "home", tool: "achilles__create_page", success: true },
    { page_id: "review", tool: "achilles__create_tool", success: true },
    { page_id: "review", tool: "mcp_discover", success: true },
    { page_id: "home", tool: "achilles__add_annotation", success: false },
    { page_id: "home", tool: "achilles__add_annotation", success: true },
  ];
  expect(relatedPages(before, after, calls)).toEqual(["home", "review", "review", "review"]);
});

test("provider catalog is allow-only", () => {
  expect(() => validateCatalog(["mcp_discover", "achilles__create_tool"], "achilles__create_tool")).not.toThrow();
  expect(() => validateCatalog(["achilles__create_tool", "bash"])).toThrow("bash");
});

test("artifact scan fails closed on nested known secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "achilles-artifacts-"));
  try {
    await Bun.write(join(root, "safe.txt"), "safe");
    await scanArtifactTree(root, ["private"]);
    await Bun.write(join(root, "unsafe.txt"), "private");
    await expect(scanArtifactTree(root, ["private"])).rejects.toThrow("known secret");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("account and secret failures stop the suite", () => {
  expect(stopsSuite(new Error("OAuth credentials are invalid; login required"))).toBe(true);
  expect(stopsSuite(new Error('{"type":"usage_limit_reached"}'))).toBe(true);
  try { scanSecrets("Bearer abcdefghijklmnop", []); } catch (error) { expect(stopsSuite(error)).toBe(true); }
  expect(stopsSuite(new Error("task setup failed"))).toBe(false);
});

test("each step's answer is the last assistant text of its own turn", () => {
  const text = (value: string) => ({ role: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: value }] });
  const end = { role: "system", event: "served_turn_end" };
  const history = [
    { role: "user", content: [{ type: "text", text: "first" }] }, text("first answer"), end,
    { role: "user", content: [{ type: "text", text: "second" }] }, text("let me check"),
    { role: "assistant", content: [{ type: "tool_use", tool_call: { id: "t1", name: "achilles__list_books" } }] },
    { role: "tool_result", content: [{ type: "text", text: "[]" }], tool_result: { tool_call_id: "t1", content: "[]" } },
    // an assistant-role row carrying an event (defensive: no observed row shape does this today)
    // must still be excluded, or its text would wrongly win over "3 are done".
    text("3 are done"), { role: "assistant", event: "approval_end", content: [{ type: "text", text: "not an answer" }] }, end,
  ];
  expect(finalAnswer(history, 0)).toBe("first answer");
  expect(finalAnswer(history, 1)).toBe("3 are done");
  expect(finalAnswer([{ role: "user", content: [] }, { role: "assistant", content: [{ type: "tool_use" }] }, end], 0)).toBeUndefined();
});

test("insertForms finds the active insert tool behind each form block, in render order", () => {
  const schema = (field: string) => ({ type: "object", properties: { [field]: { type: "string" } }, required: [field] });
  const snapshot = {
    layouts: [
      { page_id: "p", version: 1, document: { blocks: [] } },
      { page_id: "p", version: 2, document: { blocks: [{ type: "list", collection: "books" }, { type: "form", tool: "edit_book" }, { type: "form", tool: "add_book", fields: ["title"] }] } },
    ],
    tools: [{ id: "t-add", page_id: "p", name: "add_book" }, { id: "t-edit", page_id: "p", name: "edit_book" }],
    assignments: [{ page_id: "p", tool_id: "t-add", active_version: 2 }, { page_id: "p", tool_id: "t-edit", active_version: 1 }],
    tool_versions: [
      { page_id: "p", tool_id: "t-add", version: 1, operation: "insert", collection: "books", input_schema: schema("old") },
      { page_id: "p", tool_id: "t-add", version: 2, operation: "insert", collection: "books", input_schema: schema("title") },
      { page_id: "p", tool_id: "t-edit", version: 1, operation: "update", collection: "books", input_schema: schema("title") },
    ],
  };
  expect(insertForms(snapshot, "p")).toEqual([{ index: 1, tool: "add_book", collection: "books", input_schema: schema("title"), fields: ["title"] }]);
});

test("a decision list answers the n-th request of its tool and approves the rest", () => {
  let n = 0; const next = () => n++; const rule = { tool: "achilles__update_ticket", decisions: ["approve", "deny"] as Array<"approve" | "deny"> };
  expect(["achilles__list_tickets", "achilles__update_ticket", "achilles__update_ticket", "achilles__update_ticket"].map(tool => approvalDecision(rule, tool, next))).toEqual(["approve", "approve", "deny", "approve"]);
  expect(approvalDecision("deny", "achilles__anything", next)).toBe("deny");
  expect(approvalDecision(undefined, "achilles__anything", next)).toBe("approve");
});

test("a during action finishes before its approval is answered, and later answers wait for it", async () => {
  const order: string[] = []; let release!: () => void; const errors: unknown[] = [];
  const enqueue = createDecisionQueue(error => errors.push(error));
  const first = enqueue(async () => { order.push("answer 1"); }, () => new Promise<void>(resolve => { release = () => { order.push("user write"); resolve(); }; }));
  const second = enqueue(async () => { order.push("answer 2"); });
  await Bun.sleep(10); expect(order).toEqual([]);
  release(); await Promise.all([first, second]);
  expect(order).toEqual(["user write", "answer 1", "answer 2"]);
  // a failed action reports once and does not answer its request; later requests still get answers
  await enqueue(async () => { order.push("answer 3"); }, async () => { throw new Error("write failed"); });
  await enqueue(async () => { order.push("answer 4"); });
  expect(order.slice(3)).toEqual(["answer 4"]); expect(errors.map(error => (error as Error).message)).toEqual(["write failed"]);
});
