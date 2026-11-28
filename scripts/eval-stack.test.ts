import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { retryAddressInUse, startEvalStack } from "./eval-stack";

type ProcessRow = { pid: number; ppid: number; pgid: number; executable: string; command: string };
function processRows() {
  const result = Bun.spawnSync(["ps", "axeww", "-o", "pid=,ppid=,pgid=,comm=,command="], { stdout: "pipe" });
  return result.stdout.toString().split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), executable: match[4], command: match[5] }] : [];
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
  // `serves`: the scenario reaches a serve process, so its walk must record a port. make's EVAL_SETUP_ONLY skips eval.ts entirely, so success runs the full scripted task.
  { name: "success", target: "eval", env: {}, exit: "zero", serves: true },
  { name: "SIGINT", target: "eval-stack", env: {}, signal: "SIGINT", exit: "nonzero", serves: false },
  { name: "SIGTERM", target: "eval-stack", env: {}, signal: "SIGTERM", exit: "nonzero", serves: true },
  { name: "task failure", target: "eval", env: { EVAL_FORCE_ERROR: "1" }, exit: "nonzero", serves: true },
  { name: "startup failure", target: "eval", env: {}, exit: "nonzero", serves: true },
] as const;

test("eval lifecycle owner leaves no process group or port behind", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  for (const scenario of cases) {
    const marker = await mkdtemp(join("/tmp", "achilles-eval-lifecycle-")); const seen = new Map<number, ProcessRow>(); const ports = new Set<number>(); const env = { ...process.env, TMPDIR: marker, EVAL_BACKEND: "scripted", EVAL_SKIP_BROWSER_INSTALL: "1", EVAL_SKIP_EXPLICIT_EXIT: "1", MODEL: "ollama/qwen3:4b", TASK: "harness-smoke", REPORT_DIR: join(marker, "report"), BASE: "none", ...scenario.env };
    if (scenario.signal || scenario.name === "startup failure") { const uv = Bun.which("uv")!; const wrapper = join(marker, "uv"); const fault = scenario.name === "SIGINT" ? `[ "$1" = sync ] && { sleep 60 & wait; exit $?; }` : scenario.name === "startup failure" ? `seen_zeta=\nfor argument in "$@"; do [ "$argument" = zeta ] && seen_zeta=1; [ "$seen_zeta" ] && [ "$argument" = serve ] && exit 1; done` : ""; await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$PPID" > ${JSON.stringify(join(marker, "runner.pid"))}\n${fault}\nexec ${JSON.stringify(uv)} "$@"\n`); await chmod(wrapper, 0o755); env.PATH = `${marker}:${env.PATH}`; }
    const child = spawn("make", [scenario.target], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = []; child.stdout!.on("data", chunk => output.push(Buffer.from(chunk))); child.stderr!.on("data", chunk => output.push(Buffer.from(chunk)));
    const exited = new Promise<number>(resolve => child.once("exit", code => resolve(code ?? -1))); let sent = false; let runnerPid: number | undefined; let timedOut = false; let code: number | undefined;
    try {
      for (let i = 0; i < (scenario.name === "SIGINT" ? 300 : 600) && code === undefined; i++) {
        const rows = processRows(); const active = descendants(child.pid!, rows); for (const row of active) { seen.set(row.pid, row); for (const match of row.command.matchAll(/(?:--port|--ws)\s+(\d+)/g)) ports.add(Number(match[1])); }
        if (scenario.signal && !sent) { const recorded = Number(await Bun.file(join(marker, "runner.pid")).text().catch(() => "")); const ready = scenario.name === "SIGINT" ? recorded > 0 : Buffer.concat(output).includes('"retained_state"'); if (recorded && ready) { runnerPid = recorded; process.kill(recorded, scenario.signal); sent = true; } }
        code = await Promise.race([exited, Bun.sleep(50).then(() => undefined)]);
      }
      if (code === undefined) { timedOut = true; if (runnerPid) process.kill(runnerPid, "SIGKILL"); process.kill(child.pid!, "SIGKILL"); code = await Promise.race([exited, Bun.sleep(2000).then(() => undefined)]); }
      if (code === undefined) throw new Error(`${scenario.name} did not exit: ${Buffer.concat(output).toString()}`);
      if (scenario.signal) expect(sent, `${scenario.name} was not delivered`).toBe(true);
      // an empty walk (for example a `ps` that fails on this platform) would make the survivor and port checks below vacuous
      expect(seen.size, `${scenario.name} walk saw no stack process`).toBeGreaterThan(0);
      if (scenario.serves) expect(ports.size, `${scenario.name} walk saw no serve port`).toBeGreaterThan(0);
      await Bun.sleep(200); const survivors = processRows().filter(row => row.command.includes(marker));
      expect(survivors.map(row => ({ pid: row.pid, pgid: row.pgid })), `${scenario.name} left marked processes alive`).toEqual([]);
      expect(timedOut, `${scenario.name} did not exit before its deadline`).toBe(false);
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

test("a setup child that exits but leaves its output open fails with a named error, not a silent hang", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const marker = await mkdtemp(join("/tmp", "achilles-eval-stall-")); const pidFile = join(marker, "holder.pid"); const path = process.env.PATH; const controller = new AbortController();
  // `uv sync` exits at once but its background child keeps the output pipe open, as a stuck descendant would
  await writeFile(join(marker, "uv"), `#!/bin/sh\n[ "$1" = sync ] && { sleep 600 & echo $! > ${JSON.stringify(pidFile)}; exit 0; }\nexec ${JSON.stringify(Bun.which("uv")!)} "$@"\n`); await chmod(join(marker, "uv"), 0o755);
  process.env.PATH = `${marker}:${path}`;
  try {
    const start = startEvalStack({ model: "ollama/qwen3:4b", signal: controller.signal }).then(() => "started", (error: Error) => error);
    for (let i = 0; i < 1500 && !await Bun.file(pidFile).exists(); i++) await Bun.sleep(100); // a cold cache clones zeta first
    const holder = Number(await Bun.file(pidFile).text());
    const outcome = await Promise.race([start, Bun.sleep(15_000).then(() => "still waiting")]);
    expect(String(outcome), "the stalled stage must fail within its bound").toMatch(/uv sync --project exited but its output stayed open for 5s; last output: \(none\)/);
    expect(() => process.kill(holder, 0), "the stalled child's process group must be killed").toThrow();
  } finally {
    process.env.PATH = path; controller.abort();
    const holder = Number(await Bun.file(pidFile).text().catch(() => "0")); if (holder) { try { process.kill(holder, "SIGKILL"); } catch {} }
    await rm(marker, { recursive: true, force: true });
  }
}, 180_000);

test("a SIGKILLed eval leaves no child of its stack alive", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const marker = await mkdtemp(join("/tmp", "achilles-eval-sigkill-"));
  const env = { ...process.env, TMPDIR: marker, ZETA_HOME: join(marker, "zeta-home"), ACHILLES_HOME: join(marker, "achilles-home"), EVAL_BACKEND: "scripted", EVAL_SKIP_BROWSER_INSTALL: "1", EVAL_STACK_ONLY: "1", MODEL: "ollama/qwen3:4b", REPORT_DIR: join(marker, "report"), BASE: "none" };
  const child = spawn("bun", ["scripts/eval.ts", "--suite", "harness-smoke"], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = []; child.stdout!.on("data", chunk => output.push(Buffer.from(chunk))); child.stderr!.on("data", chunk => output.push(Buffer.from(chunk)));
  let pgids = new Set<number>();
  try {
    // the stack is up (achilles serve and zeta serve), then the eval is SIGKILLed, as a tool timeout does
    for (let i = 0; i < 1800 && !Buffer.concat(output).includes('"retained_state"') && child.exitCode === null; i++) await Bun.sleep(100); // a cold cache clones zeta first
    expect(Buffer.concat(output).toString(), "the eval stack did not start").toContain('"retained_state"');
    // plain pid/ppid/pgid columns: the long `ps eww` rows are only needed for the environment marker
    const groups = () => Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid="], { stdout: "pipe" }).stdout.toString().trim().split("\n").map(line => { const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number); return { pid, ppid, pgid, executable: "", command: line }; });
    pgids = new Set(descendants(child.pid!, groups()).map(row => row.pgid));
    expect(pgids.size, `the stack has no child process groups: ${Buffer.concat(output).toString().slice(-2000)}`).toBeGreaterThan(1);
    process.kill(child.pid!, "SIGKILL");
    // by pgid: macOS ps hides the environment (the marker) of some binaries
    const alive = () => groups().filter(row => pgids.has(row.pgid));
    let survivors = alive();
    for (let i = 0; i < 50 && survivors.length; i++) { await Bun.sleep(100); survivors = alive(); }
    expect(survivors.map(row => `${row.pid} ${row.ppid} ${row.command.slice(0, 80)}`), "children of the SIGKILLed eval must exit within 5s").toEqual([]);
  } finally {
    try { process.kill(child.pid!, "SIGKILL"); } catch {}
    for (const pgid of pgids) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
    await rm(marker, { recursive: true, force: true });
  }
}, 240_000);

test("a setup command that is not installed fails with its own cause", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const marker = await mkdtemp(join("/tmp", "achilles-eval-missing-")); const path = process.env.PATH;
  await symlink(Bun.which("git")!, join(marker, "git")); process.env.PATH = marker; // git only: the zeta sync step finds no uv
  try {
    const outcome = await startEvalStack({ model: "ollama/qwen3:4b" }).then(() => "started", (error: Error) => String(error));
    expect(outcome, "the error must name the missing command").toMatch(/uv: (command )?not found|Executable not found/);
    expect(outcome).not.toContain("stayed open");
  } finally { process.env.PATH = path; await rm(marker, { recursive: true, force: true }); }
}, 180_000);

test("a lock release that fails after the locked work failed keeps the first error", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const marker = await mkdtemp(join("/tmp", "achilles-eval-release-")); const path = process.env.PATH;
  // the lock holder ignores release (stdin EOF), and the achilles sync it guards fails
  await writeFile(join(marker, "uv"), `#!/bin/sh\n[ "$1 $2" = "run --no-project" ] && { echo $$ > ${JSON.stringify(join(marker, "holder.pid"))}; echo locked; exec sleep 600; }\n[ "$1 $2" = "sync --inexact" ] && { echo sync-broke >&2; exit 3; }\nexec ${JSON.stringify(Bun.which("uv")!)} "$@"\n`); await chmod(join(marker, "uv"), 0o755);
  process.env.PATH = `${marker}:${path}`;
  try {
    const outcome = await startEvalStack({ model: "ollama/qwen3:4b" }).then(() => "started", (error: Error) => String(error));
    expect(outcome, "the sync failure must surface, not the release timeout").toContain("could not sync achilles: sync-broke");
  } finally {
    process.env.PATH = path;
    const holder = Number(await Bun.file(join(marker, "holder.pid")).text().catch(() => "0")); if (holder) { try { process.kill(holder, "SIGKILL"); } catch {} }
    await rm(marker, { recursive: true, force: true });
  }
}, 180_000);
