import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { retryAddressInUse } from "./eval-stack";

type ProcessRow = { pid: number; ppid: number; pgid: number; command: string };
function processRows() {
  const result = Bun.spawnSync(["ps", "eww", "-axo", "pid=,ppid=,pgid=,command="], { stdout: "pipe" });
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
  });
}
function descendants(root: number, rows: ProcessRow[]) {
  const ids = new Set([root]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  return rows.filter(row => ids.has(row.pid) && row.pid !== root);
}
function portClosed(port: number) {
  return new Promise<boolean>(resolve => { const socket = createConnection({ host: "127.0.0.1", port }); socket.setTimeout(500); socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(true)); socket.once("timeout", () => { socket.destroy(); resolve(true); }); });
}

const cases = [
  { name: "success", target: "eval", env: { EVAL_SETUP_ONLY: "1" }, exit: "zero" },
  { name: "SIGINT", target: "eval-stack", env: {}, signal: "SIGINT", exit: "nonzero" },
  { name: "SIGTERM", target: "eval-stack", env: {}, signal: "SIGTERM", exit: "nonzero" },
  { name: "task failure", target: "eval", env: { EVAL_FORCE_ERROR: "1" }, exit: "nonzero" },
  { name: "startup failure", target: "eval", env: { EVAL_SETUP_ONLY: "1" }, exit: "nonzero" },
] as const;

test("eval lifecycle owner leaves no process group or port behind", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  for (const scenario of cases) {
    const marker = await mkdtemp(join("/tmp", "achilles-eval-lifecycle-")); const seen = new Map<number, ProcessRow>(); const ports = new Set<number>(); const env = { ...process.env, TMPDIR: marker, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", MODEL: "ollama/qwen3:4b", TASK: "harness-smoke", REPORT_DIR: join(marker, "report"), ...scenario.env };
    if (scenario.name === "SIGINT" || scenario.name === "startup failure") { const uv = Bun.which("uv")!; const wrapper = join(marker, "uv"); const fault = scenario.name === "SIGINT" ? `[ "$1" = sync ] && { sleep 60 & wait; exit $?; }` : `seen_zeta=\nfor argument in "$@"; do [ "$argument" = zeta ] && seen_zeta=1; [ "$seen_zeta" ] && [ "$argument" = serve ] && exit 1; done`; await writeFile(wrapper, `#!/bin/sh\n${fault}\nexec ${JSON.stringify(uv)} "$@"\n`); await chmod(wrapper, 0o755); env.PATH = `${marker}:${env.PATH}`; }
    const child = spawn("make", [scenario.target], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = []; child.stdout!.on("data", chunk => output.push(Buffer.from(chunk))); child.stderr!.on("data", chunk => output.push(Buffer.from(chunk)));
    const exited = new Promise<number>(resolve => child.once("exit", code => resolve(code ?? -1))); let sent = false; let code: number | undefined;
    try {
      for (let i = 0; i < (scenario.name === "SIGINT" ? 100 : 600) && code === undefined; i++) {
        const rows = processRows(); for (const row of descendants(child.pid!, rows)) { seen.set(row.pid, row); for (const match of row.command.matchAll(/(?:--port|--ws)\s+(\d+)/g)) ports.add(Number(match[1])); }
        if (scenario.signal && !sent) { const bun = [...seen.values()].find(row => /(?:^|\/)bun scripts\/eval\.ts/.test(row.command) && !row.command.includes("/bin/sh -c")); const servers = [...seen.values()].filter(row => /(?:achilles|zeta).*serve/.test(row.command)); const ready = scenario.name === "SIGINT" ? [...seen.values()].some(row => row.command.includes(`${marker}/uv sync`) || row.command.includes("sleep 60")) : servers.length >= 2; if (bun && ready) { process.kill(bun.pid, scenario.signal); sent = true; } }
        code = await Promise.race([exited, Bun.sleep(50).then(() => undefined)]);
      }
      if (code === undefined) { const runner = [...seen.values()].find(row => /(?:^|\/)bun scripts\/eval\.ts/.test(row.command) && !row.command.includes("/bin/sh -c")); if (runner) process.kill(runner.pid, "SIGKILL"); code = await Promise.race([exited, Bun.sleep(2000).then(() => undefined)]); }
      if (code === undefined) throw new Error(`${scenario.name} did not exit: ${Buffer.concat(output).toString()}`);
      expect(seen.size, `${scenario.name} recorded no child processes`).toBeGreaterThan(0); if (scenario.signal) expect(sent, `${scenario.name} was not delivered`).toBe(true);
      await Bun.sleep(200); const survivors = processRows().filter(row => row.command.includes(marker));
      expect(survivors.map(row => ({ pid: row.pid, pgid: row.pgid })), `${scenario.name} left marked processes alive`).toEqual([]);
      const report = await Bun.file(join(marker, "report", "report.json")).text().catch(() => "");
      expect(scenario.exit === "zero" ? code : code === 0, `${scenario.name} exit ${code}: ${Buffer.concat(output).toString()}${report}`).toBe(scenario.exit === "zero" ? 0 : false);
      expect(await Promise.all([...ports].map(portClosed)), `${scenario.name} left ports open`).not.toContain(false);
    } finally { const survivors = processRows().filter(row => row.command.includes(marker)); for (const row of survivors.reverse()) { try { process.kill(row.pid, "SIGKILL"); } catch {} } if (code === undefined) { try { process.kill(child.pid!, "SIGKILL"); } catch {} } await rm(marker, { recursive: true, force: true }); }
  }
}, 180_000);

test("address collision retries the complete start attempt", async () => {
  let calls = 0; const result = await retryAddressInUse(async () => { calls += 1; if (calls === 1) throw new Error("EADDRINUSE"); return "started"; });
  expect(result).toBe("started"); expect(calls).toBe(2);
});
