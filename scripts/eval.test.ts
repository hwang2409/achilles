import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { classifyTaskSupport, scanArtifactTree, scanSecrets, selectTasks, stopsSuite, validateCatalog, validateReservedBundles, verifySetup } from "./eval";

const targetRun = (target: string) => async (command: string, args: string[], cwd?: string) => {
  const python = command === "uv" && args[0] === "run" && !Bun.which("uv") ? args.slice(args.indexOf("python")) : [command, ...args];
  const process = Bun.spawn(python, { cwd, env: { ...Bun.env, PYTHONPATH: [join(target, "src"), target].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
};

test("setup verification accepts old and inspect_page layout shapes", () => {
  const setup = { tools: [], records: [], initial_layout: { blocks: [{ type: "text", text: "seeded" }] } };
  const base = { layout: setup.initial_layout, inspect: { tools: [] } };
  expect(() => verifySetup(setup, { ...base, inspect: { tools: [], layout: { ...setup.initial_layout, version: 1, digest: "old" } } })).not.toThrow();
  expect(() => verifySetup(setup, { ...base, inspect: { tools: [], layout: setup.initial_layout, layout_version: 1, layout_digest: "new" } })).not.toThrow();
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
    const inspected = await targetRun(target)("uv", ["run", "--project", target, "python", "-c", "import json,sys; from pathlib import Path; from achilles.pages import PageStore; store=PageStore(Path(sys.argv[1])); print(json.dumps({'layout':store.layout('home'),'version':store.inspect_page('home')['layout']['version']}))", root], target);
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual({ layout, version: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("turn cap report preserves the seeded initial snapshot", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const target = resolve(new URL("..", import.meta.url).pathname); const root = await mkdtemp(join(tmpdir(), "achilles-turn-cap-"));
  const taskId = "turn-cap-seeded-snapshot"; const taskPath = join(target, "evals/tasks", `${taskId}.json`); let child: ReturnType<typeof Bun.spawn> | undefined;
  const layout = { blocks: [{ type: "text", text: "Seeded dashboard" }] }; const record = { id: "seed-1", collection: "notes", data: { text: "Seeded note" } };
  try {
    await Bun.write(taskPath, JSON.stringify({ id: taskId, page_plan: [{ alias: "seeded", source: "setup", bind_chat: true, create_mode: true }], agent_turns: 1, steps: [{ id: "use-turn", kind: "prompt", page: "seeded", chat: "seeded-chat", prompt: "keep using tools" }, { id: "exhaust", kind: "prompt", page: "seeded", chat: "seeded-chat", prompt: "continue" }], setup: { tools: [], records: [record], initial_layout: layout }, checks: [{ id: "seeded-record", type: "record", page: "seeded", value: record.data }] }));
    const revision = (await readFile(join(target, "zeta.rev"), "utf8")).trim(); const warmZeta = join(target, ".cache/zeta"); const runnerZeta = join(target, ".cache", `zeta-${revision}`);
    if (await Bun.file(join(warmZeta, ".git/HEAD")).exists() && !await Bun.file(join(runnerZeta, ".git/HEAD")).exists()) await symlink(warmZeta, runnerZeta, "dir").catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    if (!await Bun.file(join(target, ".venv/bin/achilles")).exists()) { const synced = await targetRun(target)("uv", ["sync", "--project", target, "--frozen"], target); expect(synced.exitCode, synced.stderr).toBe(0); }
    child = Bun.spawn(["bun", "scripts/eval.ts", "--suite", taskId], { cwd: target, env: { ...Bun.env, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", REPORT_DIR: root }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    const exitCode = await Promise.race([child.exited, Bun.sleep(28_500).then(() => { throw new Error("scripted eval exceeded 28.5 seconds"); })]);
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
    await rm(taskPath, { force: true }); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("suite selection validates every task and sums one command budget", async () => {
  const tasks = await selectTasks();
  expect(tasks.map(task => task.id)).toEqual([...tasks].map(task => task.id).sort());
  expect(reserveTurns(tasks, 1)).toBe(tasks.reduce((total, task) => total + task.agent_turns, 0));
  expect(() => assertTurnBudget(reserveTurns(tasks, 50))).toThrow("command budget");
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
