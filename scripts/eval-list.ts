// `make eval-list`: every task per suite with its turn cap, read from evals/tasks (the suite field is the one source)
import { selectTasks } from "./eval";

for (const suite of ["core", "hard", "focused"] as const) {
  const tasks = await selectTasks(undefined, Bun.env.EVAL_TASKS_DIR, suite);
  console.log(`${suite}: ${tasks.length} tasks, ${tasks.reduce((total, task) => total + task.agent_turns, 0)} turns at N=1`);
  for (const task of tasks) console.log(`  ${task.id.padEnd(32)} ${String(task.agent_turns).padStart(2)}${task.backend ? `  ${task.backend} only` : ""}`);
}
