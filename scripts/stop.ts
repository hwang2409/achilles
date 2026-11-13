import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedProcessMatches, type ProcessIdentity } from "./dev";

const root = resolve(new URL("..", import.meta.url).pathname);
const dir = resolve(root, ".cache/dev");

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  const started = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
  if (started.exitCode || command.exitCode) return null;
  return { pid, started: started.stdout.toString().trim(), command: command.stdout.toString().trim() };
}

async function stop() {
  for (const name of ["achilles", "zeta-serve"]) {
    const file = resolve(dir, `${name}.json`);
    if (!existsSync(file)) continue;
    let saved: ProcessIdentity;
    try { saved = JSON.parse(await readFile(file, "utf8")); } catch { console.log(`left ${name} state in place; it is malformed`); continue; }
    const current = await processIdentity(saved.pid);
    if (current === null) { await rm(file); continue; }
    if (!ownedProcessMatches(saved, current)) { console.log(`left pid ${saved.pid} running; ${name} process identity does not match`); continue; }
    process.kill(saved.pid, "SIGTERM");
    for (let i = 0; i < 100 && await processIdentity(saved.pid); i++) await Bun.sleep(100);
    if (await processIdentity(saved.pid)) { console.log(`pid ${saved.pid} did not stop; ${name} state was kept`); continue; }
    await rm(file); console.log(`stopped ${name} (pid ${saved.pid})`);
  }
}

try { await stop(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
