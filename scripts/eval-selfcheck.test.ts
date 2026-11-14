import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gradeReference, validateTask, type EvalSnapshot } from "./eval-grade";

const tasksDir = new URL("../evals/tasks/", import.meta.url).pathname;
const referencesDir = new URL("../evals/references/", import.meta.url).pathname;

test("every task's known-good passes and plausible known-bad agent fails", async () => {
  const taskFiles = (await readdir(tasksDir)).filter(name => name.endsWith(".json")).sort();
  const referenceFiles = (await readdir(referencesDir)).filter(name => name.endsWith(".json")).sort();
  expect(referenceFiles).toEqual(taskFiles);
  for (const file of taskFiles) {
    const task = validateTask(JSON.parse(await readFile(join(tasksDir, file), "utf8")));
    const references = JSON.parse(await readFile(join(referencesDir, file), "utf8")) as { good?: EvalSnapshot; bad?: EvalSnapshot };
    expect(references.good, `${basename(file)} needs a known-good snapshot`).toBeDefined();
    expect(references.bad, `${basename(file)} needs a known-bad snapshot`).toBeDefined();
    expect(gradeReference(task, references.good!).status, `${task.id} known-good`).toBe("pass");
    expect(gradeReference(task, references.bad!).status, `${task.id} known-bad`).toBe("agent_fail");
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
