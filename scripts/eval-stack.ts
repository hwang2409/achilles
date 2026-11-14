import { createConnection, createServer } from "node:net";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { connectEvalProtocol } from "./eval-protocol";

export const TOOL_POLICY = "achilles__*,mcp_discover";
const RESERVED_PORTS = new Set([5190, 5191, 8765]);
const HTTP_TIMEOUT_MS = 10_000;
export type CleanupProof = { pids: number[]; ports: number[]; pids_dead: boolean; ports_closed: boolean; discovery_pid_dead: boolean; discovery_cleaned: boolean };
export type EvalStackConfig = { achillesDir?: string; zetaRev?: string; model?: string; accountHome?: string; ollamaBaseUrl?: string; maxTurns?: number; root?: string; signal?: AbortSignal; beforeDelete?: (root: string) => Promise<void> };
export type EvalStack = { achillesOrigin: string; zetaOrigin: string; achillesDir: string; achillesSha: string; zetaSha: string; provider: string; model: string; root: string; accountHome: string; cleanup?: CleanupProof; close(): Promise<CleanupProof> };

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
function child(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string) {
  const log = openSync(logPath, "a");
  try { return spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", log, log] }); } finally { closeSync(log); }
}
async function waitForExit(process: ChildProcess, timeoutMs: number) {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return Promise.race([new Promise<boolean>(ok => process.once("exit", () => ok(true))), Bun.sleep(timeoutMs).then(() => false)]);
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function stopProcessTree(process: ChildProcess | undefined) {
  if (!process?.pid || !pidAlive(process.pid)) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { globalThis.process.kill(-process.pid, signal); } catch {} try { globalThis.process.kill(process.pid, signal); } catch {}
    if (await waitForExit(process, 2_000)) return;
  }
}
async function portClosed(port: number) {
  return new Promise<boolean>(resolveClosed => {
    const socket = createConnection({ host: "127.0.0.1", port }); const timer = setTimeout(() => { socket.destroy(); resolveClosed(false); }, 1_000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveClosed(false); });
    socket.once("error", () => { clearTimeout(timer); resolveClosed(true); });
  });
}
async function gitSha(dir: string) { const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode) throw new Error(`${dir} is not a git checkout`); return result.stdout.toString().trim(); }
async function selectedModel(zeta: string, sourceHome: string, override?: string) {
  let value = override;
  if (!value) { const match = (await readFile(join(sourceHome, "settings.toml"), "utf8")).match(/^\s*model\s*=\s*["']([^"']+)["']/m); if (!match) throw new Error("zeta settings has no model selection; set MODEL"); value = match[1]; }
  const slash = value.indexOf("/"); const namedProvider = slash > 0 ? value.slice(0, slash) : undefined; const model = slash > 0 ? value.slice(slash + 1) : value;
  const result = Bun.spawnSync(["uv", "run", "--project", zeta, "python", "-c", "from zeta.models.catalog import provider_for_model; import sys; print(provider_for_model(sys.argv[1]))", model], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`invalid model selection: ${result.stderr.toString().trim()}`);
  const provider = result.stdout.toString().trim(); if (namedProvider && namedProvider !== provider) throw new Error(`model ${model} belongs to ${provider}, not ${namedProvider}`);
  return { provider, model };
}
function childEnvironment(root: string, accountHome: string, ollamaBaseUrl?: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NO_PROXY"]) if (Bun.env[key]) env[key] = Bun.env[key];
  return { ...env, ACHILLES_HOME: join(root, "achilles-home"), ACHILLES_ZETA_DISCOVERY: join(root, "zeta-home/run/serve.ws.json"), ZETA_HOME: join(root, "zeta-home"), ZETA_ACCOUNT_HOME: accountHome, ZETA_ANTHROPIC_OAUTH_COMPAT: "1", ...(ollamaBaseUrl ? { ZETA_OLLAMA_BASE_URL: ollamaBaseUrl } : {}) };
}
async function startupFailure(root: string, label: string) {
  const text = (await Promise.all(["achilles-home/serve.log", "zeta-home/serve.log"].map(path => readFile(join(root, path), "utf8").catch(() => "")))).join("\n");
  throw new Error(`${label}${/EADDRINUSE|address already in use/i.test(text) ? ": EADDRINUSE" : ""}`);
}
async function waitForAchilles(origin: string, process: ChildProcess, root: string, signal?: AbortSignal) {
  for (let i = 0; i < 300; i++) {
    signal?.throwIfAborted();
    if (await fetchDeadline(`${origin}/api/pages/home`, {}, signal, 1_000).then(response => response.ok, () => false)) return;
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

export function stopOnAbort(signal: AbortSignal | undefined, processes: ChildProcess[]) {
  const cancel = () => { for (const process of [...processes].reverse()) void stopProcessTree(process); };
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  return () => signal?.removeEventListener("abort", cancel);
}

async function startAttempt(config: EvalStackConfig, root: string, achillesDir: string, zeta: string, selected: { provider: string; model: string }, shas: { achilles: string; zeta: string }, accountHome: string): Promise<EvalStack> {
  await mkdir(join(root, "zeta-home/run"), { recursive: true }); await mkdir(join(root, "achilles-home"), { recursive: true }); await mkdir(join(root, "page-workspaces"), { recursive: true });
  await Bun.write(join(root, "zeta-home/settings.toml"), "[memory]\nauto = false\n[inbox]\nenabled = false\n");
  const achillesPort = await freePort(); const zetaPort = await freePort(new Set([achillesPort]));
  await Bun.write(join(root, "zeta-home/mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `http://127.0.0.1:${achillesPort}/mcp/` } } }));
  const env = childEnvironment(root, accountHome, config.ollamaBaseUrl); const processes: ChildProcess[] = [];
  const achillesOrigin = `http://127.0.0.1:${achillesPort}`; const zetaOrigin = `ws://127.0.0.1:${zetaPort}`; const detachAbort = stopOnAbort(config.signal, processes);
  try {
    config.signal?.throwIfAborted();
    const achillesProcess = child("uv", ["run", "--project", achillesDir, "achilles", "serve", "--host", "127.0.0.1", "--port", String(achillesPort)], achillesDir, env, join(root, "achilles-home/serve.log")); processes.push(achillesProcess);
    await waitForAchilles(achillesOrigin, achillesProcess, root, config.signal);
    const zetaProcess = child("uv", ["run", "--project", zeta, "zeta", "--yolo", "--max-turns", String(config.maxTurns ?? 20), "serve", "--ws", String(zetaPort), "--ws-origin", achillesOrigin, "--provider", selected.provider, "--model", selected.model, "--tools", TOOL_POLICY, "--cwd", join(root, "page-workspaces"), "--no-auto-memory"], root, env, join(root, "zeta-home/serve.log")); processes.push(zetaProcess);
    const discovery = await waitForDiscovery(root, zetaProcess, config.signal); const preflight = await connectEvalProtocol(discovery); preflight.close();
    let closing: Promise<CleanupProof> | undefined;
    const stack: EvalStack = { root, achillesDir, achillesSha: shas.achilles, zetaSha: shas.zeta, achillesOrigin, zetaOrigin, provider: selected.provider, model: selected.model, accountHome, close: async () => { throw new Error("close not initialized"); } };
    stack.close = () => closing ??= (async () => {
      for (const process of [...processes].reverse()) await stopProcessTree(process);
      const discoveryPath = join(root, "zeta-home/run/serve.ws.json"); let discoveryPid = 0;
      try { discoveryPid = Number(JSON.parse(await readFile(discoveryPath, "utf8")).pid ?? 0); } catch {}
      const proof: CleanupProof = { pids: processes.map(process => process.pid!).filter(Boolean), ports: [achillesPort, zetaPort], pids_dead: processes.every(process => !process.pid || !pidAlive(process.pid)), ports_closed: (await Promise.all([portClosed(achillesPort), portClosed(zetaPort)])).every(Boolean), discovery_pid_dead: !discoveryPid || !pidAlive(discoveryPid), discovery_cleaned: false };
      await rm(join(root, "zeta-home/run"), { recursive: true, force: true }); proof.discovery_cleaned = true; stack.cleanup = proof;
      if (!proof.pids_dead || !proof.ports_closed || !proof.discovery_pid_dead) throw new Error(`stack cleanup verification failed: ${JSON.stringify(proof)}`);
      return proof;
    })();
    return stack;
  } catch (error) { for (const process of [...processes].reverse()) await stopProcessTree(process); throw error; }
  finally { detachAbort(); }
}

export async function retryAddressInUse<T>(start: (attempt: number) => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown; for (let attempt = 1; attempt <= attempts; attempt++) { try { return await start(attempt); } catch (error) { last = error; if (attempt === attempts || !/EADDRINUSE|address already in use/i.test(String(error))) throw error; } } throw last;
}
async function zetaCheckout(achillesDir: string, requested?: string) {
  const harnessRoot = resolve(new URL("..", import.meta.url).pathname); const pin = (await readFile(join(achillesDir, "zeta.rev"), "utf8")).trim(); const revision = requested ?? pin;
  const zeta = join(harnessRoot, ".cache", `zeta-${revision}`);
  if (!await readFile(join(zeta, ".git/HEAD"), "utf8").then(() => true, () => false)) {
    const clone = Bun.spawnSync(["git", "clone", "https://github.com/hwang2409/zeta", zeta], { stdout: "pipe", stderr: "pipe" }); if (clone.exitCode) throw new Error(`could not clone zeta override: ${clone.stderr.toString().trim()}`);
    const checkout = Bun.spawnSync(["git", "-C", zeta, "checkout", "--detach", revision], { stdout: "pipe", stderr: "pipe" }); if (checkout.exitCode) throw new Error(`could not checkout zeta override: ${checkout.stderr.toString().trim()}`);
  }
  { const sync = Bun.spawnSync(["uv", "sync", "--project", zeta, "--frozen"], { stdout: "pipe", stderr: "pipe" }); if (sync.exitCode) throw new Error(`could not sync zeta override: ${sync.stderr.toString().trim()}`); }
  const expected = Bun.spawnSync(["git", "-C", zeta, "rev-parse", revision], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(); const actual = await gitSha(zeta);
  if (!expected || actual !== expected) throw new Error(`zeta checkout mismatch: requested ${revision}, got ${actual}`); return { zeta, sha: actual };
}
export async function startEvalStack(config: EvalStackConfig = {}): Promise<EvalStack> {
  const achillesDir = resolve(config.achillesDir ?? new URL("..", import.meta.url).pathname); const selectedZeta = await zetaCheckout(achillesDir, config.zetaRev); const zeta = selectedZeta.zeta;
  const shas = { achilles: await gitSha(achillesDir), zeta: selectedZeta.sha };
  const sourceHome = resolve(Bun.env.ZETA_HOME ?? join(Bun.env.HOME ?? "", ".zeta")); const selected = await selectedModel(zeta, sourceHome, config.model); const accountHome = config.accountHome ?? Bun.env.EVAL_ACCOUNT_HOME ?? sourceHome;
  return retryAddressInUse(async () => {
    const root = resolve(config.root ?? await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-")));
    try { return await startAttempt(config, root, achillesDir, zeta, selected, shas, accountHome); }
    catch (error) { if (config.beforeDelete) await config.beforeDelete(root); await rm(root, { recursive: true, force: true }); throw error; }
  });
}
