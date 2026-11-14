import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { failureResult, productCapabilities, scanArtifactTree, scanSecrets, selectTasks, stopsSuite, unsupportedResult, validateCatalog } from "./eval";

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

test("capability probe classifies an absent capability as unsupported and a broken target as harness_error", async () => {
  const task = { id: "capability", requires: ["update_layout"] } as never;
  const target = (result: { exitCode: number; stdout: string; stderr: string }) => ({ run: async () => result, achillesDir: "/synthetic" });
  const baseline = await productCapabilities(target({ exitCode: 0, stdout: '["create_page","create_tool"]', stderr: "" }) as never);
  const missing = ["update_layout"].filter(name => !baseline.has(name));
  expect(unsupportedResult(task, missing).status).toBe("unsupported");
  try {
    await productCapabilities(target({ exitCode: 1, stdout: "", stderr: "SyntaxError: broken target" }) as never);
    throw new Error("broken target unexpectedly passed");
  } catch (error) {
    expect(failureResult(task, error, []).status).toBe("harness_error");
    expect(failureResult(task, error, []).checks[0].evidence).toEqual(expect.objectContaining({ message: "capability preflight failed: SyntaxError: broken target" }));
  }
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
