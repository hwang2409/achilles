import { createConnection, createServer } from "node:net";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { connectEvalProtocol } from "./eval-protocol";

export const TOOL_POLICY = "achilles__*,mcp_discover";
// the label shown in the report when a task opts into the live page-chat tool set (zeta settings default: full tool set)
export const LIVE_TOOL_POLICY = "settings-default (full tool set incl. bash, edit, write, fetch)";
export const DEFAULT_MAX_TURNS = 20;
const RESERVED_PORTS = new Set([5190, 5191, 8765]);
const HTTP_TIMEOUT_MS = 10_000;
const DRAIN_MS = 5_000;
// a peer eval on the same checkout holds the web lock through one sync or web repair (two 10 s fetches and five 120 s steps, ~620 s)
const LOCK_TIMEOUT_MS = 900_000;
// each child runs in its own process group, so a SIGKILLed eval cannot clean up: a watchdog in that group kills the
// group once the eval pid is gone, and leaves quietly once its own command ($$ after exec) has exited
// shortcut: polls each second instead of a pipe (bun 1.3.13 closes a later child's extra stdio pipe); upgrade with bun
const WATCHDOG = 'eval_pid=$1; shift; (while kill -0 "$eval_pid" && kill -0 $$; do /bin/sleep 1; done; kill -0 $$ && kill -KILL 0) >/dev/null 2>&1 & exec "$@"';
async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<undefined>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(undefined), timeoutMs); })]); } finally { clearTimeout(timer); }
}
const started = performance.now();
const progress = (stage: string) => console.error(`eval setup: ${stage} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
export type CleanupProof = { pids: number[]; pgids: number[]; process_groups: Array<{ pgid: number; pids: number[] }>; ports: number[]; pids_dead: boolean; pgids_dead: boolean; ports_closed: boolean; discovery_pid_dead: boolean; discovery_cleaned: boolean };
export type EvalStackConfig = { achillesDir?: string; zetaRev?: string; model?: string; accountHome?: string; ollamaBaseUrl?: string; maxTurns?: number; root?: string; signal?: AbortSignal; liveTools?: boolean; beforeDelete?: (root: string) => Promise<void> };
export type EvalStack = { achillesOrigin: string; zetaOrigin: string; achillesDir: string; achillesSha: string; zetaSha: string; provider: string; model: string; root: string; accountHome: string; toolPolicy: string; cleanup?: CleanupProof; run(command: string, args: string[], cwd?: string, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>; restartZeta(): Promise<{ killed_pid: number; started_pid: number }>; close(): Promise<CleanupProof> };

export async function fetchDeadline(input: string | URL, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = HTTP_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeoutMs); const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return fetch(input, { ...init, signal: combined });
}
async function freePort(excluding = new Set<number>()) {
  for (;;) {
    const port = await new Promise<number>((ok, fail) => { const server = createServer(); server.once("error", fail); server.listen(0, "127.0.0.1", () => { const value = (server.address() as { port: number }).port; server.close(() => ok(value)); }); });
    if (!RESERVED_PORTS.has(port) && !excluding.has(port)) return port;
  }
}
const reap = (pgid: number) => { try { process.kill(-pgid, "SIGKILL"); } catch {} };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function processGroups() {
  const output = Bun.spawnSync(["ps", "-axo", "pid=,pgid="], { stdout: "pipe", stderr: "pipe" });
  if (output.exitCode) throw new Error("could not inspect eval process groups");
  const groups = new Map<number, number[]>();
  for (const line of output.stdout.toString().split("\n")) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number); if (!pid || !pgid) continue;
    groups.set(pgid, [...(groups.get(pgid) ?? []), pid]);
  }
  return groups;
}
class ProcessOwner {
  private groups = new Map<number, ChildProcess>();
  private closing?: Promise<{ pids: number[]; pgids: number[]; process_groups: Array<{ pgid: number; pids: number[] }>; pids_dead: boolean; pgids_dead: boolean }>;
  private detachAbort: () => void;
  constructor(signal?: AbortSignal) {
    const cancel = () => { void this.close(); }; this.detachAbort = () => signal?.removeEventListener("abort", cancel);
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  }
  // a done child's group still holds its watchdog (and any leftover descendant): it goes when the child exits, or for
  // run() after its output drains, so a descendant that holds the pipe is reported, not silently killed
  spawn(command: string, args: string[], options: Parameters<typeof spawn>[2], reapOnExit = true) {
    if (this.closing) throw new Error("eval process owner is closing");
    const process = spawn("/bin/sh", ["-c", WATCHDOG, "sh", String(globalThis.process.pid), command, ...args], { ...options, detached: true }); const pgid = process.pid;
    if (pgid) { this.groups.set(pgid, process); process.once("exit", () => { if (this.groups.get(pgid) === process) this.groups.delete(pgid); if (reapOnExit) reap(pgid); }); }
    return process;
  }
  // every wait is bounded and names the child and its last output: a silent wait once held CI for 23 minutes
  async run(command: string, args: string[], cwd?: string, timeoutMs = 15_000) {
    const process = this.spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }, false); const label = [command, ...args.slice(0, 2)].join(" ");
    const out: Buffer[] = []; const err: Buffer[] = []; let spawnError = "";
    const read = (stream: NodeJS.ReadableStream, chunks: Buffer[]) => new Promise<void>((resolveRead, reject) => { stream.on("data", chunk => chunks.push(Buffer.from(chunk))); stream.once("end", () => resolveRead()); stream.once("error", reject); });
    const drained = Promise.all([read(process.stdout!, out), read(process.stderr!, err)]);
    const exited = new Promise<number>(resolveExit => { process.once("exit", code => resolveExit(code ?? -1)); process.once("error", error => { spawnError = error.message; resolveExit(-1); }); });
    const lastOutput = () => Buffer.concat([...out, ...err]).toString().trim().slice(-500) || "(none)";
    const fail = (reason: string) => { process.stdout!.destroy(); process.stderr!.destroy(); return new Error(`${label} ${reason}; last output: ${lastOutput()}`); };
    try {
      const exitCode = await within(exited, timeoutMs);
      if (exitCode === undefined) { await this.stopGroup(process.pid!, process); throw fail(`timed out after ${timeoutMs / 1000}s`); }
      if (spawnError) throw fail(`failed to start: ${spawnError}`);
      // the child exited, so its output closes at once unless a process it started still holds the pipe
      if (await within(drained.then(() => true), DRAIN_MS) === undefined) throw fail(`exited but its output stayed open for ${DRAIN_MS / 1000}s`);
      return { exitCode, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
    } finally { if (process.pid) reap(process.pid); }
  }
  private async stopGroup(pgid: number, owned: ChildProcess) {
    const stillOwned = () => this.groups.get(pgid) === owned && owned.exitCode === null;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!stillOwned()) return;
      try { globalThis.process.kill(-pgid, signal); } catch {}
      for (let i = 0; i < 20 && processGroups().has(pgid); i++) await Bun.sleep(100);
      if (!processGroups().has(pgid) || !stillOwned()) return;
    }
  }
  // a crash, not a shutdown: SIGKILL to the one group this owner started, then wait until the group is gone
  async kill(owned: ChildProcess) {
    const pgid = owned.pid; if (!pgid || this.groups.get(pgid) !== owned) throw new Error("eval process owner does not own that process");
    try { globalThis.process.kill(-pgid, "SIGKILL"); } catch {}
    for (let i = 0; i < 50 && processGroups().has(pgid); i++) await Bun.sleep(100);
    if (processGroups().has(pgid)) throw new Error(`process group ${pgid} survived SIGKILL`);
  }
  close() { return this.closing ??= (async () => {
    this.detachAbort(); const before = processGroups(); const owned = [...this.groups.entries()].filter(([pgid, process]) => this.groups.get(pgid) === process && process.exitCode === null); const pgids = owned.map(([pgid]) => pgid); const process_groups = pgids.map(pgid => ({ pgid, pids: [...new Set([pgid, ...(before.get(pgid) ?? [])])] }));
    for (const [pgid, process] of [...owned].reverse()) await this.stopGroup(pgid, process);
    const after = processGroups(); const pids = [...new Set(process_groups.flatMap(group => group.pids))]; const proof = { pids, pgids, process_groups, pids_dead: pids.every(pid => !pidAlive(pid)), pgids_dead: pgids.every(pgid => !after.has(pgid)) };
    if (!proof.pids_dead || !proof.pgids_dead) throw new Error(`eval process cleanup failed: ${JSON.stringify(proof)}`);
    return proof;
  })(); }
}
async function portClosed(port: number) {
  return new Promise<boolean>(resolveClosed => {
    const socket = createConnection({ host: "127.0.0.1", port }); const timer = setTimeout(() => { socket.destroy(); resolveClosed(false); }, 1_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveClosed(false); });
    socket.once("error", () => { clearTimeout(timer); resolveClosed(true); });
  });
}
async function gitSha(owner: ProcessOwner, dir: string) { const result = await owner.run("git", ["-C", dir, "rev-parse", "HEAD"]); if (result.exitCode) throw new Error(`${dir} is not a git checkout`); return result.stdout.trim(); }
async function selectedModel(owner: ProcessOwner, zeta: string, sourceHome: string, override?: string) {
  let value = override;
  if (!value) { const match = (await readFile(join(sourceHome, "settings.toml"), "utf8")).match(/^\s*model\s*=\s*["']([^"']+)["']/m); if (!match) throw new Error("zeta settings has no model selection; set MODEL"); value = match[1]; }
  const slash = value.indexOf("/"); const namedProvider = slash > 0 ? value.slice(0, slash) : undefined; const model = slash > 0 ? value.slice(slash + 1) : value;
  const result = await owner.run("uv", ["run", "--project", zeta, "python", "-c", "from zeta.models.catalog import provider_for_model; import sys; print(provider_for_model(sys.argv[1]))", model], undefined, 120_000);
  if (result.exitCode) throw new Error(`invalid model selection: ${result.stderr.trim()}`);
  const provider = result.stdout.trim(); if (namedProvider && namedProvider !== provider) throw new Error(`model ${model} belongs to ${provider}, not ${namedProvider}`);
  return { provider, model };
}
function childEnvironment(root: string, accountHome: string, ollamaBaseUrl?: string) {
  const env: NodeJS.ProcessEnv = {};
  // page builds run in docker: achilles serve must use the daemon the fixture setup used
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NO_PROXY", "DOCKER_HOST", "DOCKER_CONTEXT"]) if (Bun.env[key]) env[key] = Bun.env[key];
  return { ...env, ACHILLES_HOME: join(root, "achilles-home"), ACHILLES_ZETA_DISCOVERY: join(root, "zeta-home/run/serve.ws.json"), ZETA_HOME: join(root, "zeta-home"), ZETA_ACCOUNT_HOME: accountHome, ZETA_ANTHROPIC_OAUTH_COMPAT: "1", ...(ollamaBaseUrl ? { ZETA_OLLAMA_BASE_URL: ollamaBaseUrl } : {}) };
}
async function prepareTargetWeb(owner: ProcessOwner, achillesDir: string) {
  const cache = join(achillesDir, ".cache", "fulcrum");
  if (!await readFile(join(cache, ".git/HEAD"), "utf8").then(() => true, () => false)) {
    const clone = await owner.run("git", ["clone", "https://github.com/hwang2409/fulcrum", cache], achillesDir, 120_000);
    if (clone.exitCode) throw new Error(`target web setup failed; run: make eval (${clone.stderr.trim()})`);
    const checkout = await owner.run("git", ["-C", cache, "checkout", "--detach", (await readFile(join(achillesDir, "fulcrum.rev"), "utf8")).trim()], achillesDir, 120_000);
    if (checkout.exitCode) throw new Error(`target web setup failed; run: make eval (${checkout.stderr.trim()})`);
  }
  if (!await Bun.file(join(cache, "node_modules/.bin/tsc")).exists()) {
    const install = await owner.run("bun", ["install", "--frozen-lockfile"], cache, 120_000);
    if (install.exitCode) throw new Error(`target web setup failed; run: cd ${cache} && bun install --frozen-lockfile`);
  }
  const setup = await owner.run("env", [`FULCRUM_DIR=${cache}`, "bun", "scripts/fulcrum.ts", "--prepare-web"], achillesDir, 120_000);
  if (setup.exitCode) throw new Error(`target web setup failed; run: FULCRUM_DIR=${cache} bun scripts/fulcrum.ts --prepare-web`);
  const build = await owner.run("bun", ["run", "build"], join(achillesDir, "apps/web"), 120_000);
  if (build.exitCode) throw new Error(`target web setup failed; run: cd ${join(achillesDir, "apps/web")} && bun run build`);
}

export function targetWebNeedsRepair(ok: boolean, body: string) { return !ok || /static file not found/i.test(body); }
// evals sharing a checkout take turns: vite empties apps/web/dist while it builds, so a peer's repair breaks this check,
// and two `uv run`s building one new venv at once let one import a half-installed package
async function withTargetWebLock(owner: ProcessOwner, achillesDir: string, work: () => Promise<void>) {
  const path = join(achillesDir, ".cache", "eval-web.lock"); await mkdir(join(achillesDir, ".cache"), { recursive: true });
  const holder = owner.spawn("uv", ["run", "--no-project", "python", "-c", "import fcntl, sys\nlock = open(sys.argv[1], 'a')\nfcntl.flock(lock, fcntl.LOCK_EX)\nprint('locked', flush=True)\nsys.stdin.read()", path], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise<void>(resolveExit => { holder.once("exit", () => resolveExit()); holder.once("error", () => resolveExit()); });
  const locked = await within(Promise.race([new Promise<boolean>(resolveLock => holder.stdout!.once("data", () => resolveLock(true))), exited.then(() => false)]), LOCK_TIMEOUT_MS);
  if (locked === undefined) throw new Error(`timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting for ${path}; another eval on this checkout holds it`);
  if (!locked) throw new Error(`could not lock ${path}`);
  const release = async () => { holder.stdin!.end(); if (await within(exited.then(() => true), DRAIN_MS) === undefined) throw new Error(`lock holder for ${path} did not exit after release`); };
  // a failed release must not hide why the work failed; the owner still kills a holder that stays
  try { await work(); } catch (error) { await release().catch(() => {}); throw error; }
  await release();
}
// inexact, so a developer checkout keeps its test group (pytest, ruff) in .venv
async function syncTarget(owner: ProcessOwner, achillesDir: string) {
  await withTargetWebLock(owner, achillesDir, async () => {
    const sync = await owner.run("uv", ["sync", "--inexact", "--project", achillesDir], undefined, 120_000);
    if (sync.exitCode) throw new Error(`could not sync achilles: ${sync.stderr.trim()}`);
  });
}
async function ensureTargetWeb(owner: ProcessOwner, achillesDir: string, origin: string) {
  await withTargetWebLock(owner, achillesDir, async () => {
    const response = await fetchDeadline(`${origin}/`);
    const body = await response.text();
    if (!targetWebNeedsRepair(response.ok, body)) return;
    await prepareTargetWeb(owner, achillesDir);
    const retry = await fetchDeadline(`${origin}/`); const retryBody = await retry.text();
    if (targetWebNeedsRepair(retry.ok, retryBody)) throw new Error(`target web is unavailable; run: cd ${join(achillesDir, "apps/web")} && bun run build`);
  });
}

async function startupFailure(root: string, label: string) {
  const text = (await Promise.all(["achilles-home/serve.log", "zeta-home/serve.log"].map(path => readFile(join(root, path), "utf8").catch(() => "")))).join("\n");
  throw new Error(`${label}${/EADDRINUSE|address already in use/i.test(text) ? ": EADDRINUSE" : ""}`);
}
async function waitForAchilles(origin: string, process: ChildProcess, root: string, signal?: AbortSignal) {
  for (let i = 0; i < 300; i++) {
    signal?.throwIfAborted();
    // another eval's achilles can answer on a port freePort handed out twice; uvicorn logs this line only after its own bind,
    // and startAttempt truncates the log, so a line from a lost earlier attempt cannot count
    const bound = await readFile(join(root, "achilles-home/serve.log"), "utf8").then(log => log.includes("Uvicorn running on"), () => false);
    if (bound && await fetchDeadline(`${origin}/api/pages/home`, {}, signal, 1_000).then(response => response.ok, () => false)) return;
    if (process.exitCode !== null) await startupFailure(root, "achilles exited during startup"); await Bun.sleep(100);
  }
  await startupFailure(root, "timed out waiting for achilles");
}
async function waitForDiscovery(root: string, process: ChildProcess, signal?: AbortSignal) {
  for (let i = 0; i < 300; i++) {
    signal?.throwIfAborted();
    try { const row = JSON.parse(await readFile(join(root, "zeta-home/run/serve.ws.json"), "utf8")); return { url: `ws://127.0.0.1:${row.port}`, controller_token: row.controller_token }; } catch {}
    if (process.exitCode !== null) await startupFailure(root, "zeta exited during startup"); await Bun.sleep(100);
  }
  await startupFailure(root, "timed out waiting for zeta discovery");
}

async function startAttempt(config: EvalStackConfig, owner: ProcessOwner, root: string, achillesDir: string, zeta: string, selected: { provider: string; model: string }, shas: { achilles: string; zeta: string }, accountHome: string): Promise<EvalStack> {
  await mkdir(join(root, "zeta-home/run"), { recursive: true }); await mkdir(join(root, "achilles-home"), { recursive: true }); await mkdir(join(root, "page-workspaces"), { recursive: true });
  await Bun.write(join(root, "zeta-home/settings.toml"), "[memory]\nauto = false\n[inbox]\nenabled = false\n");
  const achillesPort = await freePort(); const zetaPort = await freePort(new Set([achillesPort]));
  await Bun.write(join(root, "zeta-home/mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `http://127.0.0.1:${achillesPort}/mcp/` } } }));
  const env = childEnvironment(root, accountHome, config.ollamaBaseUrl);
  const achillesOrigin = `http://127.0.0.1:${achillesPort}`; const zetaOrigin = `ws://127.0.0.1:${zetaPort}`; let closing: Promise<CleanupProof> | undefined; let stack: EvalStack | undefined; let lostPort: number | undefined;
  const close = () => closing ??= (async () => {
    const discoveryPath = join(root, "zeta-home/run/serve.ws.json"); let discoveryPid = 0;
    try { discoveryPid = Number(JSON.parse(await readFile(discoveryPath, "utf8")).pid ?? 0); } catch {}
    const processProof = await owner.close();
    const proof: CleanupProof = { ...processProof, ports: [achillesPort, zetaPort], ports_closed: (await Promise.all([achillesPort, zetaPort].filter(port => port !== lostPort).map(portClosed))).every(Boolean), discovery_pid_dead: !discoveryPid || !pidAlive(discoveryPid), discovery_cleaned: false };
    await rm(join(root, "zeta-home/run"), { recursive: true, force: true }); proof.discovery_cleaned = true; if (stack) stack.cleanup = proof;
    if (!proof.pids_dead || !proof.pgids_dead || !proof.ports_closed || !proof.discovery_pid_dead) throw new Error(`stack cleanup verification failed: ${JSON.stringify(proof)}`);
    return proof;
  })();
  try {
    config.signal?.throwIfAborted();
    progress("achilles sync"); await syncTarget(owner, achillesDir);
    const achillesLog = openSync(join(root, "achilles-home/serve.log"), "w"); const achillesProcess = owner.spawn("uv", ["run", "--no-sync", "--project", achillesDir, "achilles", "serve", "--host", "127.0.0.1", "--port", String(achillesPort)], { cwd: achillesDir, env, stdio: ["ignore", achillesLog, achillesLog] }); closeSync(achillesLog);
    progress("achilles serve"); await waitForAchilles(achillesOrigin, achillesProcess, root, config.signal); progress("target web"); await ensureTargetWeb(owner, achillesDir, achillesOrigin); if (Bun.env.EVAL_FORCE_STARTUP_FAILURE === "1") throw new Error("forced eval startup failure");
    // a live-tools task drops the narrow eval tool policy so the session carries zeta's full default tool set, exactly
    // like a `make dev` / achilles serve page chat; the achilles__* MCP tools stay available either way
    const toolArgs = config.liveTools ? [] : ["--tools", TOOL_POLICY];
    const spawnZeta = () => { const zetaLog = openSync(join(root, "zeta-home/serve.log"), "a"); const child = owner.spawn("uv", ["run", "--project", zeta, "zeta", "--yolo", "--max-turns", String(config.maxTurns ?? DEFAULT_MAX_TURNS), "serve", "--ws", String(zetaPort), "--ws-origin", achillesOrigin, "--provider", selected.provider, "--model", selected.model, ...toolArgs, "--cwd", join(root, "page-workspaces"), "--no-auto-memory"], { cwd: root, env, stdio: ["ignore", zetaLog, zetaLog] }); closeSync(zetaLog); return child; };
    progress("zeta serve"); let zetaProcess = spawnZeta();
    const discovery = await waitForDiscovery(root, zetaProcess, config.signal);
    // the same serve again on the same port and home; the stale discovery file goes first so the wait sees the new process
    const restartZeta = async () => {
      const killed_pid = zetaProcess.pid!; await owner.kill(zetaProcess); await rm(join(root, "zeta-home/run/serve.ws.json"), { force: true });
      zetaProcess = spawnZeta(); await waitForDiscovery(root, zetaProcess, config.signal); return { killed_pid, started_pid: zetaProcess.pid! };
    }; progress("zeta protocol"); const preflight = await connectEvalProtocol(discovery); await preflight.close(); progress("stack ready");
    stack = { root, achillesDir, achillesSha: shas.achilles, zetaSha: shas.zeta, achillesOrigin, zetaOrigin, provider: selected.provider, model: selected.model, accountHome, toolPolicy: config.liveTools ? LIVE_TOOL_POLICY : TOOL_POLICY, run: (command, args, cwd, timeoutMs) => owner.run(command, args, cwd, timeoutMs), restartZeta, close };
    return stack;
  } catch (error) {
    const detail = error as Error & { cleanup?: CleanupProof };
    // a lost port race leaves that port open in the process that won it, so it is not ours to prove closed
    if (/EADDRINUSE|address already in use/i.test(String(error))) lostPort = String(error).includes("achilles") ? achillesPort : zetaPort;
    detail.cleanup = await close(); throw detail;
  }
}

export async function retryAddressInUse<T>(start: (attempt: number) => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown; for (let attempt = 1; attempt <= attempts; attempt++) { try { return await start(attempt); } catch (error) { last = error; if (attempt === attempts || !/EADDRINUSE|address already in use/i.test(String(error))) throw error; } } throw last;
}
async function zetaCheckout(owner: ProcessOwner, achillesDir: string, requested?: string) {
  const harnessRoot = resolve(new URL("..", import.meta.url).pathname); const pin = (await readFile(join(achillesDir, "zeta.rev"), "utf8")).trim(); const revision = requested ?? pin;
  const zeta = join(harnessRoot, ".cache", `zeta-${revision}`);
  if (!await readFile(join(zeta, ".git/HEAD"), "utf8").then(() => true, () => false)) {
    const clone = await owner.run("git", ["clone", "https://github.com/hwang2409/zeta", zeta], undefined, 120_000); if (clone.exitCode) throw new Error(`could not clone zeta override: ${clone.stderr.trim()}`);
    const checkout = await owner.run("git", ["-C", zeta, "checkout", "--detach", revision], undefined, 120_000); if (checkout.exitCode) throw new Error(`could not checkout zeta override: ${checkout.stderr.trim()}`);
  }
  { const sync = await owner.run("uv", ["sync", "--project", zeta, "--frozen"], undefined, 120_000); if (sync.exitCode) throw new Error(`could not sync zeta override: ${sync.stderr.trim()}`); }
  const expected = (await owner.run("git", ["-C", zeta, "rev-parse", revision])).stdout.trim(); const actual = await gitSha(owner, zeta);
  if (!expected || actual !== expected) throw new Error(`zeta checkout mismatch: requested ${revision}, got ${actual}`); return { zeta, sha: actual };
}
export async function startEvalStack(config: EvalStackConfig = {}): Promise<EvalStack> {
  return retryAddressInUse(async () => {
    const owner = new ProcessOwner(config.signal); const achillesDir = resolve(config.achillesDir ?? new URL("..", import.meta.url).pathname); const root = resolve(config.root ?? await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-")));
    try {
      progress("zeta checkout"); const selectedZeta = await zetaCheckout(owner, achillesDir, config.zetaRev); const zeta = selectedZeta.zeta; const shas = { achilles: await gitSha(owner, achillesDir), zeta: selectedZeta.sha };
      const sourceHome = resolve(Bun.env.ZETA_HOME ?? join(Bun.env.HOME ?? "", ".zeta")); progress("model selection"); const selected = await selectedModel(owner, zeta, sourceHome, config.model); const accountHome = config.accountHome ?? Bun.env.EVAL_ACCOUNT_HOME ?? sourceHome;
      return await startAttempt(config, owner, root, achillesDir, zeta, selected, shas, accountHome);
    } catch (error) { await owner.close(); if (config.beforeDelete) await config.beforeDelete(root); await rm(root, { recursive: true, force: true }); throw error; }
  });
}
