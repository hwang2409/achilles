import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { retryAddressInUse } from "./eval-stack";

type ProcessRow = { pid: number; ppid: number; pgid: number; command: string };
function processRows() {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,command="], { stdout: "pipe" });
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
  { name: "task failure", target: "eval", env: { EVAL_FORCE_ERROR: "1" }, exit: "nonzero" },
  { name: "startup failure", target: "eval", env: { EVAL_SETUP_ONLY: "1", EVAL_FORCE_STARTUP_FAILURE: "1" }, exit: "nonzero" },
  { name: "SIGINT", target: "eval-stack", env: {}, signal: "SIGINT", exit: "nonzero" },
  { name: "SIGTERM", target: "eval-stack", env: {}, signal: "SIGTERM", exit: "nonzero" },
] as const;

test("eval lifecycle owner leaves no process group or port behind", async () => {
  for (const scenario of cases) {
    const report = await mkdtemp(join(tmpdir(), "achilles-eval-lifecycle-")); const seen = new Map<number, ProcessRow>(); const ports = new Set<number>();
    const child = spawn("make", [scenario.target], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", MODEL: "ollama/qwen3:4b", TASK: "harness-smoke", REPORT_DIR: report, ...scenario.env }, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = []; child.stdout!.on("data", chunk => output.push(Buffer.from(chunk))); child.stderr!.on("data", chunk => output.push(Buffer.from(chunk)));
    const exited = new Promise<number>(resolve => child.once("exit", code => resolve(code ?? -1))); let sent = false; let code: number | undefined;
    try {
      for (let i = 0; i < 1_200 && code === undefined; i++) {
        const rows = processRows(); for (const row of descendants(child.pid!, rows)) { seen.set(row.pid, row); if (/(?:achilles|zeta).*serve/.test(row.command) && row.pid !== row.pgid) seen.set(row.pgid, { pid: row.pgid, ppid: 1, pgid: row.pgid, command: "uv wrapper/group leader" }); for (const match of row.command.matchAll(/(?:--port|--ws)\s+(\d+)/g)) ports.add(Number(match[1])); }
        if (scenario.signal && !sent) { const bun = [...seen.values()].find(row => row.command.includes("bun scripts/eval.ts")); const servers = [...seen.values()].filter(row => /(?:achilles|zeta).*serve/.test(row.command)); if (bun && servers.length >= 2) { process.kill(bun.pid, scenario.signal); sent = true; } }
        code = await Promise.race([exited, Bun.sleep(50).then(() => undefined)]);
      }
      if (code === undefined) throw new Error(`${scenario.name} did not exit: ${Buffer.concat(output).toString()}`);
      expect(seen.size, `${scenario.name} recorded no child processes`).toBeGreaterThan(0); if (scenario.signal) expect(sent, `${scenario.name} was not delivered`).toBe(true);
      expect(scenario.exit === "zero" ? code : code === 0, `${scenario.name} exit ${code}: ${Buffer.concat(output).toString()}`).toBe(scenario.exit === "zero" ? 0 : false);
      await Bun.sleep(200); const remaining = processRows(); const livePids = [...seen.keys()].filter(pid => remaining.some(row => row.pid === pid)); const ownedPgids = new Set([...seen.values()].filter(row => /(?:achilles|zeta).*serve/.test(row.command)).map(row => row.pgid)); const livePgids = [...ownedPgids].filter(pgid => remaining.some(row => row.pgid === pgid));
      expect(livePids, `${scenario.name} left pids alive`).toEqual([]); expect(livePgids, `${scenario.name} left process groups alive`).toEqual([]); expect(await Promise.all([...ports].map(portClosed)), `${scenario.name} left ports open`).not.toContain(false);
      const serverRows = [...seen.values()].filter(row => ownedPgids.has(row.pgid)); expect(serverRows.some(row => row.pid === row.pgid), `${scenario.name} missed uv wrapper/group leader pids`).toBe(true); expect(serverRows.every(row => seen.has(row.pid)), `${scenario.name} missed a process-group member`).toBe(true);
    } finally { if (code === undefined) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} } for (const pgid of new Set([...seen.values()].filter(row => /(?:achilles|zeta).*serve|uv wrapper\/group leader/.test(row.command)).map(row => row.pgid))) { try { process.kill(-pgid, "SIGKILL"); } catch {} } await rm(report, { recursive: true, force: true }); }
  }
}, 180_000);

test("address collision retries the complete start attempt", async () => {
  let calls = 0; const result = await retryAddressInUse(async () => { calls += 1; if (calls === 1) throw new Error("EADDRINUSE"); return "started"; });
  expect(result).toBe("started"); expect(calls).toBe(2);
});
