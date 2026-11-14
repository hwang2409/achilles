import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { scanArtifactTree, scanSecrets, selectTasks, validateCatalog } from "./eval";

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

test("secret-shaped values fail closed", () => {
  expect(() => scanSecrets("Bearer abcdefghijklmnop", [])).toThrow();
});
