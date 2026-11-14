import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { openSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export const TOOL_POLICY = "achilles__*,mcp_discover";
const RESERVED_PORTS = new Set([5190, 5191, 8765]);
export type EvalStackConfig = { achillesDir?: string; model?: string; accountHome?: string; ollamaBaseUrl?: string; maxTurns?: number; keep?: boolean; root?: string };
export type EvalStack = { achillesOrigin: string; zetaOrigin: string; achillesDir: string; achillesSha: string; provider: string; model: string; root: string; close(): Promise<void> };

async function freePort() { for (;;) { const port = await new Promise<number>((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = (server.address() as { port: number }).port; server.close(() => resolvePort(value)); }); }); if (!RESERVED_PORTS.has(port)) return port; } }
function modelFromSettings(home: string) { const file = Bun.file(join(home, "settings.toml")); return file.exists().then(async exists => { if (!exists) return "claude-opus-5-5"; const match = (await file.text()).match(/^\s*model\s*=\s*["']([^"']+)["']/m); return match?.[1] ?? "claude-opus-5-5"; }); }
function modelParts(value: string) { const model = value.includes("/") ? value.slice(value.indexOf("/") + 1) : value; const provider = value.includes("/") ? value.slice(0, value.indexOf("/")) : model.startsWith("claude-") ? "claude" : model.startsWith("gpt-") ? "codex" : ""; if (!provider || !model) throw new Error(`unsupported model selection: ${value}`); return { provider, model }; }
function child(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string) { const log = openSync(logPath, "a"); return spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", log, log] }); }
async function waitFor(path: string, process: ChildProcess, label: string) { for (let i = 0; i < 300; i++) { if (await Bun.file(path).exists()) return; if (process.exitCode !== null) throw new Error(`${label} exited during startup`); await Bun.sleep(100); } throw new Error(`timed out waiting for ${label}`); }
export async function stopProcessTree(process: ChildProcess | undefined) { if (!process?.pid) return; try { globalThis.process.kill(-process.pid, "SIGTERM"); } catch {} try { globalThis.process.kill(process.pid, "SIGTERM"); } catch {} await Bun.sleep(100); try { globalThis.process.kill(-process.pid, "SIGKILL"); } catch {} try { globalThis.process.kill(process.pid, "SIGKILL"); } catch {} }
async function gitSha(dir: string) { const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode) throw new Error("ACHILLES_DIR is not a git checkout"); return result.stdout.toString().trim(); }

export async function startEvalStack(config: EvalStackConfig = {}): Promise<EvalStack> {
  const root = resolve(config.root ?? await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-")));
  const achillesDir = resolve(config.achillesDir ?? new URL("..", import.meta.url).pathname);
  const zeta = resolve(new URL("../.cache/zeta", import.meta.url).pathname);
  const achillesSha = await gitSha(achillesDir);
  const sourceHome = resolve(Bun.env.ZETA_HOME ?? join(Bun.env.HOME ?? "", ".zeta"));
  const selected = modelParts(config.model ?? await modelFromSettings(sourceHome));
  const accountHome = config.accountHome ?? Bun.env.EVAL_ACCOUNT_HOME ?? sourceHome;
  if (["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZETA_ALLOW_API_KEY"].some(key => Bun.env[key])) throw new Error("api-key environment variables are not allowed for evals");
  await mkdir(join(root, "zeta-home/run"), { recursive: true }); await mkdir(join(root, "achilles-home"), { recursive: true }); await mkdir(join(root, "page-workspaces"), { recursive: true });
  await Bun.write(join(root, "zeta-home/settings.toml"), "[memory]\nauto = false\n[inbox]\nenabled = false\n");
  const achillesPort = await freePort(); const zetaPort = await freePort();
  await Bun.write(join(root, "zeta-home/mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `http://127.0.0.1:${achillesPort}/mcp/` } } }));
  const env = { ...Bun.env, ACHILLES_HOME: join(root, "achilles-home"), ACHILLES_ZETA_DISCOVERY: join(root, "zeta-home/run/serve.ws.json"), ZETA_HOME: join(root, "zeta-home"), ZETA_ACCOUNT_HOME: accountHome, ZETA_ANTHROPIC_OAUTH_COMPAT: "1", ...(config.ollamaBaseUrl ? { ZETA_OLLAMA_BASE_URL: config.ollamaBaseUrl } : {}) };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZETA_ALLOW_API_KEY"]) delete env[key];
  const achillesOrigin = `http://127.0.0.1:${achillesPort}`; const zetaOrigin = `ws://127.0.0.1:${zetaPort}`;
  const achillesProcess = child("uv", ["run", "--project", achillesDir, "achilles", "serve", "--host", "127.0.0.1", "--port", String(achillesPort)], achillesDir, env, join(root, "achilles-home", "serve.log"));
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) { if (await fetch(`${achillesOrigin}/api/pages/home`).then(response => response.ok, () => false)) { ready = true; break; } if (achillesProcess.exitCode !== null) throw new Error("achilles exited during startup"); await Bun.sleep(100); }
    if (!ready) throw new Error("timed out waiting for achilles");
    const zetaProcess = child("uv", ["run", "--project", zeta, "zeta", "--yolo", "--max-turns", String(config.maxTurns ?? 20), "serve", "--ws", String(zetaPort), "--ws-origin", achillesOrigin, "--provider", selected.provider, "--model", selected.model, "--tools", TOOL_POLICY, "--cwd", join(root, "page-workspaces"), "--no-auto-memory"], root, env, join(root, "zeta-home", "serve.log"));
    try { await waitFor(join(root, "zeta-home/run/serve.ws.json"), zetaProcess, "zeta"); return { root, achillesDir, achillesSha, achillesOrigin, zetaOrigin, provider: selected.provider, model: selected.model, close: async () => { await stopProcessTree(zetaProcess); await stopProcessTree(achillesProcess); if (!config.keep) await rm(root, { recursive: true, force: true }); } }; } catch (error) { await stopProcessTree(zetaProcess); throw error; }
  } catch (error) { await stopProcessTree(achillesProcess); if (!config.keep) await rm(root, { recursive: true, force: true }); throw error; }
}
