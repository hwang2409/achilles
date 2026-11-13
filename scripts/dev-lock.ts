import { constants } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const lockPath = resolve(root, ".cache/dev/lock");
type LockOwner = { pid: number; started: string };

function startedAt(pid: number): string | null {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

async function readOwner(): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8"));
    return Number.isInteger(value.pid) && typeof value.started === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function withDevLock(run: () => Promise<void>): Promise<void> {
  await mkdir(resolve(root, ".cache/dev"), { recursive: true });
  const owner = { pid: process.pid, started: startedAt(process.pid) };
  if (!owner.started) throw new Error("could not identify make dev process");

  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile(JSON.stringify(owner)); } finally { await file.close(); }
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      let current = await readOwner();
      if (!current) { await Bun.sleep(50); current = await readOwner(); }
      if (current && startedAt(current.pid) === current.started) throw new Error(`make dev is already running (pid ${current.pid})`);
      if (attempt > 0) throw new Error("could not take over stale make dev lock");
      await rm(lockPath, { force: true });
    }
  }

  try {
    await run();
  } finally {
    const current = await readOwner();
    if (current?.pid === owner.pid && current.started === owner.started) await rm(lockPath, { force: true });
  }
}
