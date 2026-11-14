import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";

export const root = resolve(new URL("..", import.meta.url).pathname);
export const port = Number(process.env.PORT ?? 5191);
const home = resolve(process.env.ZETA_HOME ?? `${process.env.HOME}/.zeta`);
const cache = resolve(root, ".cache/dev");

type Discovery = { pid: number; port: number; origins: string[] };
export type ServeDecision = { kind: "reuse"; document: Discovery; origin: string } | { kind: "start" } | { kind: "origin-missing"; command: string };
export type ProcessIdentity = { pid: number; started: string; command: string };
type AchillesState = ProcessIdentity & { stamp: string };
export type AchillesDecision = { kind: "start" } | { kind: "restart"; saved: AchillesState } | { kind: "reuse" } | { kind: "foreign"; pid: number };
type McpConfig = { transport?: string; url?: string };
export type McpDecision = { kind: "add" } | { kind: "unchanged" } | { kind: "different"; command: string };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function serveDecision(document: unknown, requestedOrigin: string, command: string | null): ServeDecision {
  if (!document || typeof document !== "object") return { kind: "start" };
  const value = document as Partial<Discovery>;
  if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || !Array.isArray(value.origins) || !command || !/(^|[\/\s])zeta\s+serve(?:\s|$)/.test(command)) return { kind: "start" };
  const origins = value.origins.filter((item): item is string => typeof item === "string");
  const alternate = requestedOrigin.replace("127.0.0.1", "localhost");
  const allowed = [alternate, requestedOrigin].find((origin) => origins.includes(origin));
  if (allowed) return { kind: "reuse", document: value as Discovery, origin: allowed };
  return { kind: "origin-missing", command: `${command} --ws-origin ${shellQuote(requestedOrigin)} --ws-origin ${shellQuote(alternate)}` };
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp/`;
}

export function mcpDecision(current: McpConfig | null, url: string): McpDecision {
  if (current === null) return { kind: "add" };
  if (current.transport === "streamable-http" && current.url === url) return { kind: "unchanged" };
  return { kind: "different", command: `zeta mcp remove achilles --scope user && zeta mcp add --scope user --url ${shellQuote(url)} achilles` };
}

export function ownedProcessMatches(saved: ProcessIdentity, current: ProcessIdentity | null): boolean {
  return current !== null && saved.pid === current.pid && saved.started === current.started && saved.command === current.command;
}

export function achillesDecision(saved: AchillesState | null, current: ProcessIdentity | null, stamp: string, portPid: number | null): AchillesDecision {
  if (saved && ownedProcessMatches(saved, current)) return saved.stamp === stamp ? { kind: "reuse" } : { kind: "restart", saved };
  if (current) return { kind: "foreign", pid: current.pid };
  if (portPid) return { kind: "foreign", pid: portPid };
  return { kind: "start" };
}

function run(args: string[], cwd = root, capture = false) {
  const result = Bun.spawnSync(args, { cwd, stdout: capture ? "pipe" : "inherit", stderr: capture ? "pipe" : "inherit", env: { ...process.env, PWD: cwd } });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed${capture ? `: ${result.stderr.toString().trim()}` : ""}`);
  return capture ? result.stdout.toString() : "";
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
  const command = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]);
  if (started.exitCode || command.exitCode) return null;
  return { pid, started: started.stdout.toString().trim(), command: command.stdout.toString().trim() };
}
async function readDiscovery(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}
async function digest(paths: string[]) {
  const hash = createHash("sha256");
  for (const path of paths.sort()) { hash.update(path); hash.update(await readFile(path)); }
  return hash.digest("hex");
}
async function filesUnder(dir: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true, dot: true })) {
    if (!entry.includes("node_modules/") && !entry.includes("dist/") && !entry.endsWith(".tsbuildinfo")) results.push(resolve(dir, entry));
  }
  return results;
}
async function ensureFulcrum() {
  const fulcrum = resolve(root, ".cache/fulcrum");
  const pin = (await readFile(resolve(root, "fulcrum.rev"), "utf8")).trim();
  if (!existsSync(resolve(fulcrum, ".git"))) { await mkdir(dirname(fulcrum), { recursive: true }); run(["git", "clone", "https://github.com/hwang2409/fulcrum", fulcrum]); }
  run(["git", "-C", fulcrum, "checkout", "--detach", pin]);
  const stamp = resolve(root, ".cache/fulcrum-build.stamp");
  const tracked = run(["git", "-C", fulcrum, "ls-files", "packages"], root, true).trim().split("\n").filter(Boolean).map((path) => resolve(fulcrum, path));
  const sourceHash = await digest([resolve(root, "fulcrum.rev"), ...tracked]);
  let old = ""; try { old = await readFile(stamp, "utf8"); } catch {}
  if (old !== sourceHash) {
    run(["bun", "install", "--frozen-lockfile"], fulcrum);
    process.env.FULCRUM_DIR = fulcrum;
    run(["bun", "run", "scripts/fulcrum.ts"], root);
    await writeFile(stamp, sourceHash);
  } else console.log("fulcrum build unchanged");
  return stamp;
}
async function freePort() {
  return await new Promise<number>((ok, fail) => { const server = createServer(); server.once("error", fail); server.listen(0, "127.0.0.1", () => { const value = (server.address() as any).port; server.close(() => ok(value)); }); });
}
async function backupOnce(file: string) {
  if (!existsSync(file)) return;
  const backup = `${file}.achilles-backup`;
  let output;
  try { output = await open(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); } catch (error: any) { if (error.code === "EEXIST") return; throw error; }
  try { await output.writeFile(await readFile(file)); await output.sync(); } finally { await output.close(); }
}
async function ensureMcp(url: string) {
  const file = resolve(home, "mcp.json");
  let current: McpConfig | null = null;
  const shown = Bun.spawnSync(["zeta", "mcp", "show", "achilles", "--scope", "user", "--json"], { cwd: home, env: { ...process.env, PWD: home } });
  if (shown.exitCode === 0) {
    try { current = JSON.parse(shown.stdout.toString()).config; } catch { throw new Error("zeta mcp show returned invalid JSON"); }
  } else if (!`${shown.stdout.toString()}${shown.stderr.toString()}`.includes("unknown MCP server: achilles")) {
    throw new Error(`zeta mcp show failed: ${shown.stdout.toString().trim() || shown.stderr.toString().trim()}`);
  }
  const decision = mcpDecision(current, url);
  if (decision.kind === "unchanged") { console.log("mcp.json: unchanged"); return; }
  if (decision.kind === "different") throw new Error(`mcp.json: achilles differs; fix it with: ${decision.command}`);
  await mkdir(dirname(file), { recursive: true }); await backupOnce(file);
  run(["zeta", "mcp", "add", "--scope", "user", "--url", url, "achilles"], home);
  console.log("mcp.json: changed");
}
async function tail(path: string) {
  try { return (await readFile(path, "utf8")).trim().split("\n").slice(-8).join("\n"); } catch { return ""; }
}
async function waitForSpawnedServe(path: string, pid: number, ws: number) {
  for (let i = 0; i < 150; i++) {
    const value = await readDiscovery(path) as Partial<Discovery> | null;
    if (value?.pid === pid && value.port === ws) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for zeta serve discovery");
}
async function chooseServe(requestedOrigin: string): Promise<{ origin: string }> {
  const discovery = resolve(home, "run/serve.ws.json");
  const document = await readDiscovery(discovery) as Partial<Discovery> | null;
  const identity = document?.pid ? await processIdentity(document.pid) : null;
  const decision = serveDecision(document, requestedOrigin, identity?.command ?? null);
  if (decision.kind === "reuse") { console.log(`reusing zeta serve on port ${decision.document.port}`); return { origin: decision.origin }; }
  if (decision.kind === "origin-missing") throw new Error(`zeta serve is running without ${requestedOrigin}; stop it first, then restart it with: ${decision.command}`);
  const ws = await freePort(); let control = await freePort(); while (control === ws) control = await freePort(); await mkdir(cache, { recursive: true });
  const logPath = resolve(cache, "zeta-serve.log"); const log = Bun.file(logPath);
  const alternate = requestedOrigin.replace("127.0.0.1", "localhost");
  const args = ["zeta", "serve", "--port", String(control), "--ws", String(ws), "--ws-origin", requestedOrigin, "--ws-origin", alternate];
  const child = Bun.spawn(args, { cwd: home, stdout: log, stderr: log, env: { ...process.env, PWD: home }, detached: true });
  let outcome: "ready" | "exited";
  try { outcome = await Promise.race([waitForSpawnedServe(discovery, child.pid, ws).then(() => "ready" as const), child.exited.then(() => "exited" as const)]); }
  catch (error) { child.kill(); await child.exited; throw new Error(`${error instanceof Error ? error.message : error}. fix the error and retry:\n${await tail(logPath)}`); }
  if (outcome === "exited") throw new Error(`zeta serve exited during startup. fix the error and retry:\n${await tail(logPath)}`);
  const identityAfter = await processIdentity(child.pid); if (!identityAfter) throw new Error("zeta serve disappeared during startup");
  await writeFile(resolve(cache, "zeta-serve.json"), JSON.stringify(identityAfter)); child.unref();
  console.log(`started zeta serve on port ${ws}`); return { origin: alternate };
}
async function portPid(): Promise<number | null> {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.exitCode !== 0) return null;
  const pid = Number(result.stdout.toString().trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
async function stopAchilles(saved: ProcessIdentity) {
  process.kill(saved.pid, "SIGTERM");
  for (let i = 0; i < 100 && await processIdentity(saved.pid); i++) await Bun.sleep(100);
  if (await processIdentity(saved.pid)) throw new Error(`pid ${saved.pid} did not stop; stop it with: kill ${saved.pid}`);
}
async function startAchilles(appOrigin: string, stamp: string) {
  const stateFile = resolve(cache, "achilles.json");
  let saved: AchillesState | null = null;
  try { saved = JSON.parse(await readFile(stateFile, "utf8")); } catch {}
  const pid = await portPid();
  const current = saved ? await processIdentity(saved.pid) : pid ? await processIdentity(pid) : null;
  const decision = achillesDecision(saved, current, stamp, pid);
  if (decision.kind === "reuse") { console.log(`achilles already running on ${port}; unchanged, open ${appOrigin}`); return; }
  if (decision.kind === "foreign") { console.log(`achilles on ${port} was not started by make dev; to let make dev manage it: kill ${decision.pid} && make dev PORT=${port}`); return; }
  if (decision.kind === "restart") await stopAchilles(decision.saved);
  await mkdir(cache, { recursive: true }); const logPath = resolve(cache, "achilles.log"); const log = Bun.file(logPath);
  const args = ["uv", "run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)];
  const child = Bun.spawn(args, { stdout: log, stderr: log, env: process.env, detached: true });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const outcome = await Promise.race([fetch(`${appOrigin}/`).then(() => "ready" as const).catch(() => "wait" as const), child.exited.then(() => "exited" as const)]);
    if (outcome === "ready") { ready = true; break; }
    if (outcome === "exited") throw new Error(`achilles exited during startup:\n${await tail(logPath)}`);
    await Bun.sleep(100);
  }
  if (!ready) { child.kill(); await child.exited; throw new Error(`timed out waiting for achilles:\n${await tail(logPath)}`); }
  const identity = await processIdentity(child.pid); if (!identity) throw new Error("achilles disappeared during startup");
  await writeFile(resolve(cache, "achilles.json"), JSON.stringify({ ...identity, stamp })); child.unref();
  console.log(`achilles is ready at ${appOrigin}`);
}
async function zetaInstallCommand() {
  const pin = (await readFile(resolve(root, "zeta.rev"), "utf8")).trim();
  return `git clone https://github.com/hwang2409/zeta .cache/zeta && git -C .cache/zeta checkout --detach ${shellQuote(pin)} && uv tool install --editable .cache/zeta`;
}
async function zetaUpgradeCommand() {
  const listed = Bun.spawnSync(["uv", "tool", "list", "--show-paths"]);
  const toolDir = listed.exitCode === 0 ? listed.stdout.toString().match(/^zeta .+ \((.+)\)$/m)?.[1] : undefined;
  if (toolDir) {
    try {
      const receipt = await readFile(resolve(toolDir, "uv-receipt.toml"), "utf8");
      const checkout = receipt.match(/(?:editable|(?<!install-)path) = "([^"]+)"/)?.[1];
      if (checkout) return `git -C ${shellQuote(checkout)} pull`;
    } catch {}
  }
  return "uv tool upgrade zeta";
}
async function prerequisites() {
  const fixes: Record<string, string> = {
    bun: "curl -fsSL https://bun.sh/install | bash",
    uv: "curl -LsSf https://astral.sh/uv/install.sh | sh",
    git: process.platform === "darwin" ? "xcode-select --install" : "sudo apt-get install -y git",
    zeta: await zetaInstallCommand(),
  };
  for (const command of ["bun", "uv", "git", "zeta"]) {
    if (Bun.spawnSync(["sh", "-c", `command -v ${command}`]).exitCode) throw new Error(`missing ${command}: ${fixes[command]}`);
  }
  await mkdir(home, { recursive: true });
  const checks: [string[], string[]][] = [
    [["zeta", "mcp", "--help"], ["add", "show", "remove"]],
    [["zeta", "mcp", "show", "--help"], ["--scope", "--json"]],
    [["zeta", "mcp", "add", "--help"], ["--scope", "--url"]],
    [["zeta", "mcp", "remove", "--help"], ["--scope"]],
  ];
  for (const [args, required] of checks) {
    const result = Bun.spawnSync(args, { cwd: home, env: { ...process.env, PWD: home } });
    const help = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (result.exitCode !== 0 || required.some((value) => !help.includes(value))) throw new Error(`missing zeta mcp: ${await zetaUpgradeCommand()}`);
  }
}
async function dev() {
  await prerequisites();
  const webStamp = resolve(root, ".cache/web-build.stamp");
  // Test hook: skip dependency and web builds while exercising the real dev entry.
  if (process.env.ACHILLES_DEV_SKIP_BUILD !== "1") {
    run(["uv", "sync", "--group", "test"]); const fulcrumStamp = await ensureFulcrum();
    const hash = await digest([...(await filesUnder(resolve(root, "apps/web"))), fulcrumStamp]);
    let old = ""; try { old = await readFile(webStamp, "utf8"); } catch {}
    if (old !== hash) { run(["bun", "run", "build"], resolve(root, "apps/web")); await writeFile(webStamp, hash); } else console.log("web build unchanged");
  }
  const requestedOrigin = `http://127.0.0.1:${port}`; const selected = await chooseServe(requestedOrigin);
  const achillesStamp = await digest([webStamp, ...(await filesUnder(resolve(root, "src/achilles"))), resolve(root, "pyproject.toml"), resolve(root, "uv.lock")]);
  await ensureMcp(mcpUrl(port)); await startAchilles(selected.origin, achillesStamp);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.spawnSync(["sh", "-c", `command -v ${opener}`]).exitCode === 0) Bun.spawn([opener, selected.origin]); else console.log(`open ${selected.origin} in your browser`);
}
if (import.meta.main) { try { await dev(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); } }
