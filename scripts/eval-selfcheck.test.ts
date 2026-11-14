import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gradeReference, validateTask, type EvalSnapshot } from "./eval-grade";
import { relatedPages, validateToolVersionSchemas } from "./eval";

const tasksDir = new URL("../evals/tasks/", import.meta.url).pathname;
const referencesDir = new URL("../evals/references/", import.meta.url).pathname;

test("every task passes the expectation lint and its known-good and known-bad references", async () => {
  const taskFiles = (await readdir(tasksDir)).filter(name => name.endsWith(".json")).sort();
  const referenceFiles = (await readdir(referencesDir)).filter(name => name.endsWith(".json")).sort();
  expect(referenceFiles).toEqual(taskFiles);
  for (const file of taskFiles) {
    const task = validateTask(JSON.parse(await readFile(join(tasksDir, file), "utf8")));
    const references = JSON.parse(await readFile(join(referencesDir, file), "utf8")) as { initial?: EvalSnapshot; good?: EvalSnapshot; good_old?: EvalSnapshot; bad?: EvalSnapshot };
    expect(references.good, `${basename(file)} needs a known-good snapshot`).toBeDefined();
    expect(references.bad, `${basename(file)} needs a known-bad snapshot`).toBeDefined();
    if (references.initial) {
      references.good!.related_page_ids = relatedPages(references.initial, references.good!, references.good!.calls ?? []);
      references.bad!.related_page_ids = relatedPages(references.initial, references.bad!, references.bad!.calls ?? []);
    }
    expect(gradeReference(task, references.good!).status, `${task.id} known-good`).toBe("pass");
    if (references.good_old) expect(gradeReference(task, references.good_old).status, `${task.id} known-good old shape`).toBe("pass");
    expect(gradeReference(task, references.bad!).status, `${task.id} known-bad`).toBe("agent_fail");
  }
});

test("tool-version schema evidence uses the product validator", async () => {
  const schemas = [
    ["empty", {}],
    ["mixed", { anyOf: [{ type: "number" }, { type: "string" }] }],
    ["number", { type: "number" }],
    ["nullable", { anyOf: [{ type: "number" }, { type: "null" }] }],
    ["integer", { type: "integer" }],
  ] as const;
  const cwd = new URL("..", import.meta.url).pathname;
  const stack = {
    achillesDir: cwd,
    run: async (command: string, args: string[], runCwd?: string) => {
      const process = Bun.spawn([command, ...args], { cwd: runCwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { stdout, stderr, exitCode };
    },
  };
  const snapshot = { tool_versions: schemas.map(([name, schema], index) => ({ name, version: 2, input_schema: { type: "object", properties: { title: { type: "string" }, rating: schema }, required: ["title"], additionalProperties: false }, tool_id: `tool-${index}` })) };
  const calls = schemas.map(([name]) => ({ tool: `achilles__${name}`, arguments: { title: "Dune", rating: 5 } }));
  const result = await validateToolVersionSchemas(stack as never, snapshot, calls);
  if (!Bun.which("uv")) {
    expect(result.tool_schema_validation_error).toContain("product schema validation failed");
    return;
  }
  expect(result.tool_schema_validation_error).toBeUndefined();
  expect(result.tool_schema_validations?.map(row => [row.tool, row.number_valid, row.string_valid])).toEqual([
    ["empty", true, true],
    ["mixed", true, true],
    ["number", true, false],
    ["nullable", true, false],
    ["integer", true, false],
  ]);
});

test("tool-version references use product-valid bundles and version evidence", async () => {
  const references = JSON.parse(await readFile(join(referencesDir, "tool-version-fresh-chat.json"), "utf8")) as { good: EvalSnapshot; bad: EvalSnapshot };
  const uv = Bun.which("uv");
  if (uv) for (const [name, snapshot] of Object.entries(references)) {
    const bundles = (snapshot.calls ?? []).filter(call => call.tool === "achilles__create_tool" && call.success === true).map(call => (call.arguments as { bundle?: unknown } | undefined)?.bundle).filter(Boolean);
    const validation = Bun.spawn([uv, "run", "python", "-c", "import json,sys; from achilles.tools import validate_bundle; [validate_bundle(bundle, reject_conflicting_output=True) for bundle in json.loads(sys.argv[1])]", JSON.stringify(bundles)], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(validation.stderr).text();
    expect(await validation.exited, `${name}: ${stderr}`).toBe(0);
  }
  expect(references.good.records).toContainEqual(expect.objectContaining({ id: "new-book", version: 2 }));
});

test("wrong-page judge reference recomputes related pages through production", async () => {
  const task = validateTask(JSON.parse(await readFile(join(tasksDir, "judge-page-and-annotate.json"), "utf8")));
  const references = JSON.parse(await readFile(join(referencesDir, "judge-page-and-annotate.json"), "utf8")) as { initial: EvalSnapshot; bad: EvalSnapshot };
  references.bad.related_page_ids = relatedPages(references.initial, references.bad, references.bad.calls ?? []);
  expect(gradeReference(task, references.bad).checks.find(check => check.id === "same-page")?.pass).toBe(false);
});

test("synthetic real-behavior references keep their hand-graded status", async () => {
  const source = await Bun.file(new URL("../evals/real-behavior-references.json", import.meta.url)).json() as { synthetic: boolean; cases: Array<{ id: string; task_id: string; expected_status: "pass" | "agent_fail"; snapshot: EvalSnapshot }> };
  expect(source.synthetic).toBe(true);
  for (const reference of source.cases) {
    const task = validateTask(JSON.parse(await readFile(join(tasksDir, `${reference.task_id}.json`), "utf8")));
    expect(gradeReference(task, reference.snapshot).status, reference.id).toBe(reference.expected_status);
  }
});

test("text does not accept a near-miss title field", async () => {
  const task = validateTask(JSON.parse(await readFile(join(tasksDir, "harness-smoke.json"), "utf8")));
  const references = JSON.parse(await readFile(join(referencesDir, "harness-smoke.json"), "utf8")) as { good: EvalSnapshot; bad: EvalSnapshot };
  expect(gradeReference(task, references.good).status).toBe("pass");
  const bad = gradeReference(task, references.bad);
  expect(bad.status).toBe("agent_fail");
  expect(bad.checks.find(check => check.id === "layout")?.pass).toBe(false);
  expect(bad.checks.filter(check => check.id !== "layout").every(check => check.pass)).toBe(true);
});
