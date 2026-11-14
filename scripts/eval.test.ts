import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { classifyTaskSupport, relatedPages, scanArtifactTree, scanSecrets, selectTasks, stopsSuite, validateCatalog, validateReservedBundles } from "./eval";

const targetRun = (target: string) => async (command: string, args: string[], cwd?: string) => {
  const python = command === "uv" && args[0] === "run" && !Bun.which("uv") ? args.slice(args.indexOf("python")) : [command, ...args];
  const process = Bun.spawn(python, { cwd, env: { ...Bun.env, PYTHONPATH: [join(target, "src"), target].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
};

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
