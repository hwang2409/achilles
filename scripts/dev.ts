import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";

export const root = resolve(new URL("..", import.meta.url).pathname);
export const port = Number(process.env.PORT ?? 5191);
export const origin = `http://127.0.0.1:${port}`;
const home = resolve(process.env.ZETA_HOME ?? `${process.env.HOME}/.zeta`);
const cache = resolve(root, ".cache/dev");

export async function mergeMcp(file: string, url: string): Promise<"changed" | "unchanged"> {
  let value: Record<string, any> = {};
  try { value = JSON.parse(await readFile(file, "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const next = { ...value, servers: { ...(value.servers ?? {}) , achilles: { transport: "streamable-http", url } } };
  if (JSON.stringify(value) === JSON.stringify(next)) return "unchanged";
  if (existsSync(file) && !existsSync(`${file}.achilles-backup`)) await writeFile(`${file}.achilles-backup`, await readFile(file));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return "changed";
}

export type ServeDecision = { kind: "reuse"; document: any } | { kind: "start" } | { kind: "origin-missing"; command: string };
export function serveDecision(document: any, allowedOrigin: string): ServeDecision {
  if (!document || !Number.isInteger(document.port)) return { kind: "start" };
  if (document.pid && !existsSync(`/proc/${document.pid}`) && process.platform !== "darwin") return { kind: "start" };
  const origins = Array.isArray(document.origins) ? document.origins : [];
  if (origins.length === 0 || origins.includes(allowedOrigin) || origins.includes(allowedOrigin.replace("127.0.0.1", "localhost"))) return { kind: "reuse", document };
  const all = [...origins, allowedOrigin].map((item) => `--ws-origin ${JSON.stringify(item)}`).join(" ");
  return { kind: "origin-missing", command: `zeta serve --ws ${document.port} ${all}` };
}

async function run(args: string[], cwd = root) {
  const result = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} failed`);
}
async function digest(paths: string[]) {
  const hash = createHash("sha256");
  for (const path of paths.sort()) { hash.update(path); hash.update(await readFile(path)); }
  return hash.digest("hex");
}
async function filesUnder(dir: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true, dot: true })) {
    if (!entry.includes("node_modules/") && !entry.includes("dist/")) results.push(resolve(dir, entry));
  }
  return results;
}
async function ensureFulcrum() {
  const fulcrum = resolve(root, ".cache/fulcrum");
  const pin = (await readFile(resolve(root, "fulcrum.rev"), "utf8")).trim();
  if (!existsSync(resolve(fulcrum, ".git"))) { await mkdir(dirname(fulcrum), { recursive: true }); run(["git", "clone", "https://github.com/hwang2409/fulcrum", fulcrum]); }
  run(["git", "-C", fulcrum, "checkout", "--detach", pin]);
  const stamp = resolve(fulcrum, ".achilles-stamp");
  const sourceHash = await digest([resolve(root, "fulcrum.rev"), ...(await filesUnder(resolve(fulcrum, "packages")))]);
  let old = ""; try { old = await readFile(stamp, "utf8"); } catch {}
  if (old !== sourceHash) {
    run(["bun", "install", "--frozen-lockfile"], fulcrum);
    process.env.FULCRUM_DIR = fulcrum;
    run(["bun", "run", "scripts/fulcrum.ts"], root);
    await writeFile(stamp, sourceHash);
  }
  return stamp;
}
async function freePort() {
  return await new Promise<number>((ok, fail) => { const server = createServer(); server.once("error", fail); server.listen(0, "127.0.0.1", () => { const value = (server.address() as any).port; server.close(() => ok(value)); }); });
}
async function waitFor(path: string, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (existsSync(path)) { try { JSON.parse(await readFile(path, "utf8")); return; } catch {} } await Bun.sleep(100); }
  throw new Error(`timed out waiting for ${basename(path)}`);
}
async function startServe() {
  const discovery = resolve(home, "run/serve.ws.json");
  let document: any = null; try { document = JSON.parse(await readFile(discovery, "utf8")); } catch {}
  const decision = serveDecision(document, origin);
  if (decision.kind === "reuse") { console.log(`reusing zeta serve on port ${document.port}`); return; }
  if (decision.kind === "origin-missing") throw new Error(`zeta serve is running without ${origin}; stop it and run: ${decision.command}`);
  const ws = await freePort(); await mkdir(cache, { recursive: true });
  const log = Bun.file(resolve(cache, "zeta-serve.log"));
  const child = Bun.spawn(["zeta", "serve", "--ws", String(ws), "--ws-origin", origin], { stdout: log, stderr: log, env: process.env, detached: true });
  await writeFile(resolve(cache, "zeta-serve.pid"), String(child.pid)); child.unref();
  await waitFor(discovery); console.log(`started zeta serve on port ${ws}`);
}
async function startAchilles() {
  const pidFile = resolve(cache, "achilles.pid");
  if (existsSync(pidFile)) { const pid = Number(await readFile(pidFile, "utf8")); try { process.kill(pid, 0); throw new Error(`port ${port} is already used by make dev (pid ${pid})`); } catch (error: any) { if (error.message.startsWith("port")) throw error; } }
  const probe = createServer(); try { await new Promise<void>((ok, fail) => { probe.once("error", fail); probe.listen(port, "127.0.0.1", () => probe.close(() => ok())); }); } catch { throw new Error(`port ${port} is busy; stop the process using it before running make dev`); }
  await mkdir(cache, { recursive: true }); const log = Bun.file(resolve(cache, "achilles.log"));
  const child = Bun.spawn(["uv", "run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], { stdout: log, stderr: log, env: process.env, detached: true });
  await writeFile(pidFile, String(child.pid)); child.unref();
  for (let i = 0; i < 150; i++) { try { await fetch(`${origin}/`); console.log(`achilles is ready at ${origin}`); return; } catch { await Bun.sleep(100); } }
  throw new Error("timed out waiting for achilles");
}
async function prerequisites() {
  const missing: string[] = [];
  for (const command of ["uv", "bun", "git", "zeta"]) { const result = Bun.spawnSync(["sh", "-c", `command -v ${command}`]); if (result.exitCode) missing.push(`${command}: install ${command} and put it on PATH`); }
  const accounts = resolve(home, "accounts.json"); if (!existsSync(accounts) || (await stat(accounts)).size < 3) missing.push(`zeta login: run zeta login (no logged-in zeta home found at ${home})`);
  if (missing.length) { for (const item of missing) console.error(`missing prerequisite: ${item}`); process.exit(1); }
}
async function dev() {
  await prerequisites(); await run(["uv", "sync", "--group", "test"]); const fulcrumStamp = await ensureFulcrum();
  const webStamp = resolve(root, ".cache/web-build.stamp"); const hash = await digest([...(await filesUnder(resolve(root, "apps/web"))), fulcrumStamp]);
  let old = ""; try { old = await readFile(webStamp, "utf8"); } catch {}
  if (old !== hash) { run(["bun", "run", "build"], resolve(root, "apps/web")); await writeFile(webStamp, hash); } else console.log("web build unchanged");
  console.log(`mcp.json: ${await mergeMcp(resolve(home, "mcp.json"), `${origin}/mcp/`)}`); await startServe(); await startAchilles();
  const opener = process.platform === "darwin" ? "open" : "xdg-open"; if (Bun.spawnSync(["sh", "-c", `command -v ${opener}`]).exitCode === 0) Bun.spawn([opener, origin]); else console.log(`open ${origin} in your browser`);
}
if (import.meta.main) { if (process.argv[2] === "stop") { console.log("use make stop"); } else await dev(); }
