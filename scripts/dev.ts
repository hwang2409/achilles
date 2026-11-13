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

export function serveDecision(document: unknown, requestedOrigin: string, command: string | null): ServeDecision {
  if (!document || typeof document !== "object") return { kind: "start" };
  const value = document as Partial<Discovery>;
  if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || !Array.isArray(value.origins) || !command || !/(^|[\/\s])zeta\s+serve(?:\s|$)/.test(command)) return { kind: "start" };
  const origins = value.origins.filter((item): item is string => typeof item === "string");
  const alternate = requestedOrigin.replace("127.0.0.1", "localhost");
  const allowed = origins.includes(requestedOrigin) ? requestedOrigin : origins.includes(alternate) ? alternate : null;
  if (allowed) return { kind: "reuse", document: value as Discovery, origin: allowed };
  const all = [...origins, requestedOrigin].map((item) => `--ws-origin ${JSON.stringify(item)}`).join(" ");
  return { kind: "origin-missing", command: `zeta serve --ws ${value.port} ${all}` };
}

export function ownedProcessMatches(saved: ProcessIdentity, current: ProcessIdentity | null): boolean {
  return current !== null && saved.pid === current.pid && saved.started === current.started && saved.command === current.command;
}

function run(args: string[], cwd = root, capture = false) {
  const result = Bun.spawnSync(args, { cwd, stdout: capture ? "pipe" : "inherit", stderr: capture ? "pipe" : "inherit", env: process.env });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed${capture ? `: ${result.stderr.toString().trim()}` : ""}`);
  return capture ? result.stdout.toString() : "";
}
async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
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
  let current: any = null;
  const shown = Bun.spawnSync(["zeta", "mcp", "show", "achilles", "--scope", "user", "--json"], { cwd: home, env: process.env });
  if (shown.exitCode === 0) { try { current = JSON.parse(shown.stdout.toString()); } catch {} }
  if (current?.config?.transport === "streamable-http" && current?.config?.url === url) { console.log("mcp.json: unchanged"); return; }
  await mkdir(dirname(file), { recursive: true }); await backupOnce(file);
  if (current) run(["zeta", "mcp", "remove", "achilles", "--scope", "user"], home);
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
  if (decision.kind === "origin-missing") throw new Error(`zeta serve is running without ${requestedOrigin}; leave it running and restart it with: ${decision.command}`);
  const ws = await freePort(); let control = await freePort(); while (control === ws) control = await freePort(); await mkdir(cache, { recursive: true });
  const logPath = resolve(cache, "zeta-serve.log"); const log = Bun.file(logPath);
  const args = ["zeta", "serve", "--port", String(control), "--ws", String(ws), "--ws-origin", requestedOrigin];
  const child = Bun.spawn(args, { stdout: log, stderr: log, env: process.env, detached: true });
  let outcome: "ready" | "exited";
  try { outcome = await Promise.race([waitForSpawnedServe(discovery, child.pid, ws).then(() => "ready" as const), child.exited.then(() => "exited" as const)]); }
  catch (error) { child.kill(); await child.exited; throw new Error(`${error instanceof Error ? error.message : error}. fix the error and retry:\n${await tail(logPath)}`); }
  if (outcome === "exited") throw new Error(`zeta serve exited during startup. fix the error and retry:\n${await tail(logPath)}`);
  const identityAfter = await processIdentity(child.pid); if (!identityAfter) throw new Error("zeta serve disappeared during startup");
  await writeFile(resolve(cache, "zeta-serve.json"), JSON.stringify(identityAfter)); child.unref();
  console.log(`started zeta serve on port ${ws}`); return { origin: requestedOrigin };
}
async function portIsFree() {
  const probe = createServer();
  try { await new Promise<void>((ok, fail) => { probe.once("error", fail); probe.listen(port, "127.0.0.1", () => probe.close(() => ok())); }); return true; } catch { return false; }
}
async function startAchilles(appOrigin: string) {
  if (!(await portIsFree())) {
    try {
      const response = await fetch(`${appOrigin}/api/zeta/discovery`, { headers: { Origin: appOrigin } });
      const value = await response.json();
      if (response.ok && typeof value?.url === "string") { console.log(`achilles already running on ${port}; open ${appOrigin}`); return; }
    } catch {}
    throw new Error(`port ${port} is busy; leave that process running and use PORT=<free-port>`);
  }
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
  await writeFile(resolve(cache, "achilles.json"), JSON.stringify(identity)); child.unref();
  console.log(`achilles is ready at ${appOrigin}`);
}
async function prerequisites() {
  const missing: string[] = [];
  for (const command of ["uv", "bun", "git", "zeta"]) { const result = Bun.spawnSync(["sh", "-c", `command -v ${command}`]); if (result.exitCode) missing.push(`${command}: install ${command} and put it on PATH`); }
  if (missing.length) { for (const item of missing) console.error(`missing prerequisite: ${item}`); process.exit(1); }
}
async function dev() {
  await prerequisites(); run(["uv", "sync", "--group", "test"]); const fulcrumStamp = await ensureFulcrum();
  const webStamp = resolve(root, ".cache/web-build.stamp"); const hash = await digest([...(await filesUnder(resolve(root, "apps/web"))), fulcrumStamp]);
  let old = ""; try { old = await readFile(webStamp, "utf8"); } catch {}
  if (old !== hash) { run(["bun", "run", "build"], resolve(root, "apps/web")); await writeFile(webStamp, hash); } else console.log("web build unchanged");
  const requestedOrigin = `http://127.0.0.1:${port}`; const selected = await chooseServe(requestedOrigin);
  await ensureMcp(`${selected.origin}/mcp/`); await startAchilles(selected.origin);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.spawnSync(["sh", "-c", `command -v ${opener}`]).exitCode === 0) Bun.spawn([opener, selected.origin]); else console.log(`open ${selected.origin} in your browser`);
}
if (import.meta.main) { try { await dev(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); } }
