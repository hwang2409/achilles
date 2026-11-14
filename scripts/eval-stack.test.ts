import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { stopProcessTree } from "./eval-stack";

test("timeout teardown terminates the child process tree", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  await stopProcessTree(child);
  await Bun.sleep(100);
  expect(Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
});
