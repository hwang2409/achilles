import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { openSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { connectEvalProtocol } from "./eval-protocol";

export const TOOL_POLICY = "achilles__*,mcp_discover";
const RESERVED_PORTS = new Set([5190, 5191, 8765]);
export type EvalStackConfig = { achillesDir?: string; model?: string; accountHome?: string; ollamaBaseUrl?: string; maxTurns?: number; keep?: boolean; root?: string };
export type EvalStack = { achillesOrigin: string; zetaOrigin: string; achillesDir: string; achillesSha: string; zetaSha: string; provider: string; model: string; root: string; close(): Promise<void> };

type Started = { stack: EvalStack; processes: ChildProcess[] };
async function freePort(excluding = new Set<number>()) {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const value = (server.address() as { port: number }).port; server.close(() => resolvePort(value)); });
    });
    if (!RESERVED_PORTS.has(port) && !excluding.has(port)) return port;
  }
}
function child(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string) {
  const log = openSync(logPath, "a");
  return spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", log, log] });
}
async function waitForExit(process: ChildProcess, timeoutMs: number) {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return await Promise.race([new Promise<boolean>(resolveExit => process.once("exit", () => resolveExit(true))), Bun.sleep(timeoutMs).then(() => false)]);
}
export async function stopProcessTree(process: ChildProcess | undefined) {
  if (!process?.pid || process.exitCode !== null || process.signalCode !== null) return;
  try { globalThis.process.kill(-process.pid, "SIGTERM"); } catch {}
  try { globalThis.process.kill(process.pid, "SIGTERM"); } catch {}
  if (await waitForExit(process, 2_000)) return;
  try { globalThis.process.kill(-process.pid, "SIGKILL"); } catch {}
  try { globalThis.process.kill(process.pid, "SIGKILL"); } catch {}
  await waitForExit(process, 2_000);
}
async function gitSha(dir: string) { const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode) throw new Error(`${dir} is not a git checkout`); return result.stdout.toString().trim(); }
async function selectedModel(zeta: string, sourceHome: string, override?: string) {
  let value = override;
  if (!value) {
    const settings = join(sourceHome, "settings.toml");
    const match = (await readFile(settings, "utf8")).match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (!match) throw new Error("zeta settings has no model selection; set MODEL");
    value = match[1];
  }
  const slash = value.indexOf("/"); const namedProvider = slash > 0 ? value.slice(0, slash) : undefined; const model = slash > 0 ? value.slice(slash + 1) : value;
  const code = "from zeta.models.catalog import provider_for_model; import sys; print(provider_for_model(sys.argv[1]))";
  const result = Bun.spawnSync(["uv", "run", "--project", zeta, "python", "-c", code, model], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`invalid model selection: ${result.stderr.toString().trim()}`);
  const provider = result.stdout.toString().trim();
  if (namedProvider && namedProvider !== provider) throw new Error(`model ${model} belongs to ${provider}, not ${namedProvider}`);
  return { provider, model };
}
async function startupFailure(root: string, label: string) {
  const paths = [join(root, "achilles-home/serve.log"), join(root, "zeta-home/serve.log")];
  const text = (await Promise.all(paths.map(path => readFile(path, "utf8").catch(() => "")))).join("\n");
  throw new Error(`${label}${/EADDRINUSE|address already in use/i.test(text) ? ": EADDRINUSE" : ""}`);
}

async function startAttempt(config: EvalStackConfig, root: string, achillesDir: string, zeta: string, selected: { provider: string; model: string }, shas: { achilles: string; zeta: string }, accountHome: string): Promise<Started> {
  await mkdir(join(root, "zeta-home/run"), { recursive: true }); await mkdir(join(root, "achilles-home"), { recursive: true }); await mkdir(join(root, "page-workspaces"), { recursive: true });
  await Bun.write(join(root, "zeta-home/settings.toml"), "[memory]\nauto = false\n[inbox]\nenabled = false\n");
  const achillesPort = await freePort(); const zetaPort = await freePort(new Set([achillesPort]));
  await Bun.write(join(root, "zeta-home/mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `http://127.0.0.1:${achillesPort}/mcp/` } } }));
  const env = { ...Bun.env, ACHILLES_HOME: join(root, "achilles-home"), ACHILLES_ZETA_DISCOVERY: join(root, "zeta-home/run/serve.ws.json"), ZETA_HOME: join(root, "zeta-home"), ZETA_ACCOUNT_HOME: accountHome, ZETA_ANTHROPIC_OAUTH_COMPAT: "1", ...(config.ollamaBaseUrl ? { ZETA_OLLAMA_BASE_URL: config.ollamaBaseUrl } : {}) };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZETA_ALLOW_API_KEY"]) delete env[key];
  const processes: ChildProcess[] = [];
  const achillesOrigin = `http://127.0.0.1:${achillesPort}`; const zetaOrigin = `ws://127.0.0.1:${zetaPort}`;
  try {
    const achillesProcess = child("uv", ["run", "--project", achillesDir, "achilles", "serve", "--host", "127.0.0.1", "--port", String(achillesPort)], achillesDir, env, join(root, "achilles-home/serve.log")); processes.push(achillesProcess);
    let ready = false;
    for (let i = 0; i < 300; i++) { if (await fetch(`${achillesOrigin}/api/pages/home`).then(response => response.ok, () => false)) { ready = true; break; } if (achillesProcess.exitCode !== null) await startupFailure(root, "achilles exited during startup"); await Bun.sleep(100); }
    if (!ready) await startupFailure(root, "timed out waiting for achilles");
    const zetaProcess = child("uv", ["run", "--project", zeta, "zeta", "--yolo", "--max-turns", String(config.maxTurns ?? 20), "serve", "--ws", String(zetaPort), "--ws-origin", achillesOrigin, "--provider", selected.provider, "--model", selected.model, "--tools", TOOL_POLICY, "--cwd", join(root, "page-workspaces"), "--no-auto-memory"], root, env, join(root, "zeta-home/serve.log")); processes.push(zetaProcess);
    let discovery: { url: string; controller_token: string } | undefined;
    for (let i = 0; i < 300; i++) {
      try { const row = JSON.parse(await readFile(join(root, "zeta-home/run/serve.ws.json"), "utf8")); discovery = { url: `ws://127.0.0.1:${row.port}`, controller_token: row.controller_token }; break; } catch {}
      if (zetaProcess.exitCode !== null) await startupFailure(root, "zeta exited during startup"); await Bun.sleep(100);
    }
    if (!discovery) await startupFailure(root, "timed out waiting for zeta discovery");
    const preflight = await connectEvalProtocol(discovery); preflight.close();
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => { for (const process of [...processes].reverse()) await stopProcessTree(process); if (!config.keep) await rm(root, { recursive: true, force: true }); })();
    return { processes, stack: { root, achillesDir, achillesSha: shas.achilles, zetaSha: shas.zeta, achillesOrigin, zetaOrigin, provider: selected.provider, model: selected.model, close } };
  } catch (error) { for (const process of [...processes].reverse()) await stopProcessTree(process); throw error; }
}

export async function retryAddressInUse<T>(start: (attempt: number) => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await start(attempt); }
    catch (error) { last = error; if (attempt === attempts || !/EADDRINUSE|address already in use/i.test(String(error))) throw error; }
  }
  throw last;
}

export async function startEvalStack(config: EvalStackConfig = {}): Promise<EvalStack> {
  if (["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZETA_ALLOW_API_KEY"].some(key => Bun.env[key])) throw new Error("api-key environment variables are not allowed for evals");
  const achillesDir = resolve(config.achillesDir ?? new URL("..", import.meta.url).pathname);
  const zeta = resolve(new URL("../.cache/zeta", import.meta.url).pathname);
  const expectedZeta = (await readFile(new URL("../zeta.rev", import.meta.url), "utf8")).trim();
  const shas = { achilles: await gitSha(achillesDir), zeta: await gitSha(zeta) };
  if (shas.zeta !== expectedZeta) throw new Error(`pinned zeta checkout mismatch: expected ${expectedZeta}, got ${shas.zeta}`);
  const sourceHome = resolve(Bun.env.ZETA_HOME ?? join(Bun.env.HOME ?? "", ".zeta"));
  const selected = await selectedModel(zeta, sourceHome, config.model);
  const accountHome = config.accountHome ?? Bun.env.EVAL_ACCOUNT_HOME ?? sourceHome;
  const retainedRoot = resolve(new URL(`../.cache/evals/${Date.now()}-${process.pid}`, import.meta.url).pathname);
  return retryAddressInUse(async () => {
    const root = resolve(config.root ?? (config.keep ? retainedRoot : await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-"))));
    try { return (await startAttempt(config, root, achillesDir, zeta, selected, shas, accountHome)).stack; }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  });
}
