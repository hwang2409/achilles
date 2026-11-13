import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dir = resolve(root, ".cache/dev");
for (const name of ["achilles", "zeta-serve"]) {
  const file = resolve(dir, `${name}.pid`);
  if (!existsSync(file)) continue;
  const pid = Number(await readFile(file, "utf8"));
  try {
    const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString();
    const expected = name === "achilles" ? "achilles serve" : "zeta serve";
    if (command.includes(expected)) { process.kill(pid); console.log(`stopped ${name} (pid ${pid})`); }
    else console.log(`left pid ${pid} running; it is not ${expected}`);
  } catch { /* already stopped */ }
  await rm(file, { force: true });
}
