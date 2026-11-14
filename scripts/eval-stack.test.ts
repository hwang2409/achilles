import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { retryAddressInUse, stopOnAbort, stopProcessTree } from "./eval-stack";

test("timeout teardown terminates the child process tree", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  await stopProcessTree(child);
  await Bun.sleep(100);
  expect(Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
});

test("address collision retries the complete start attempt", async () => {
  let calls = 0;
  const result = await retryAddressInUse(async () => { calls += 1; if (calls === 1) throw new Error("EADDRINUSE"); return "started"; });
  expect(result).toBe("started");
  expect(calls).toBe(2);
});

test("startup abort stops every process already owned", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); child.unref();
  const controller = new AbortController(); const detach = stopOnAbort(controller.signal, [child]); controller.abort();
  try {
    for (let i = 0; i < 30 && Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim(); i++) await Bun.sleep(100);
    expect(Bun.spawnSync(["ps", "-p", String(child.pid), "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
  } finally { detach(); await stopProcessTree(child); }
});
