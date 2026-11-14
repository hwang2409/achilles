import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gradeReference, validateTask, type EvalSnapshot } from "./eval-grade";
import { relatedPages } from "./eval";

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
    if (references.initial) references.good!.related_page_ids = relatedPages(references.initial, references.good!, references.good!.calls ?? []);
    expect(gradeReference(task, references.good!).status, `${task.id} known-good`).toBe("pass");
    if (references.good_old) expect(gradeReference(task, references.good_old).status, `${task.id} known-good old shape`).toBe("pass");
    expect(gradeReference(task, references.bad!).status, `${task.id} known-bad`).toBe("agent_fail");
  }
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
