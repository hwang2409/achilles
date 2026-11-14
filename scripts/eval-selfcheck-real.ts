import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gradeReference, validateTask, type EvalSnapshot } from "./eval-grade";

const root = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) throw new Error("usage: bun scripts/eval-selfcheck-real.ts DIR");
const tasksDir = new URL("../evals/tasks/", import.meta.url).pathname;
const snapshotsDir = join(root, "snapshots");
const rows = [];
for (const file of (await readdir(snapshotsDir)).filter(name => name.endsWith(".json")).sort()) {
  const match = file.match(/^(.*)-(\d+)\.json$/);
  if (!match) throw new Error(`snapshot name must end in -N.json: ${file}`);
  const task = validateTask(JSON.parse(await readFile(join(tasksDir, `${match[1]}.json`), "utf8")));
  const snapshot = JSON.parse(await readFile(join(snapshotsDir, file), "utf8")) as EvalSnapshot | null;
  if (!snapshot) { rows.push({ snapshot: basename(file), task_id: task.id, status: "harness_error", score: 0, failed_checks: ["snapshot unavailable"] }); continue; }
  const result = gradeReference(task, snapshot);
  rows.push({ snapshot: basename(file), task_id: task.id, status: result.status, score: result.score, failed_checks: result.checks.filter(check => !check.pass).map(check => check.id) });
}
console.log(JSON.stringify(rows, null, 2));
