import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const zeta = process.env.ZETA_CHECKOUT ?? join(root, ".cache/zeta");
const zetaRef = (await readFile(join(root, "zeta.rev"), "utf8")).trim();
if (!/^[0-9a-f]{40}$/.test(zetaRef)) throw new Error("zeta.rev must contain one sha");
const temp = await mkdtemp(join(tmpdir(), "achilles-v3-"));
const zetaHome = join(temp, "zeta-home"); const achillesHome = join(temp, "achilles-home");
const cwd = join(temp, "cwd"); const control = join(temp, "control.json");
const port = 5191; const origin = `http://127.0.0.1:${port}`;
const children: ChildProcess[] = []; const logs = new Map<ChildProcess, string>();
const redact = (text: string) => text.replace(/(bearer\.|controller_token|observer_token)[^\s,}\"]*/gi, "$1[redacted]");
const start = (command: string, args: string[], env: NodeJS.ProcessEnv, cwdArg = root) => {
  const child = spawn(command, args, { cwd: cwdArg, env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  logs.set(child, ""); child.stdout?.on("data", (data) => logs.set(child, logs.get(child)! + data)); child.stderr?.on("data", (data) => logs.set(child, logs.get(child)! + data)); return child;
};
const waitFor = async (check: () => Promise<boolean>, label: string) => { for (let i = 0; i < 300; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error(`timed out waiting for ${label}`); };
let browser;
try {
  await Bun.spawn(["git", "init", cwd]).exited; await Bun.write(join(cwd, "fixture.txt"), "synthetic fixture\n");
  const env = { ...process.env, PYTHONPATH: zeta, ZETA_HOME: zetaHome, ACHILLES_HOME: achillesHome, ZETA_PROOF_WORKTREE: root, ZETA_PROOF_CWD: cwd, ZETA_PROOF_CONTROL: control, ZETA_PROOF_ORIGIN: origin };
  const zetaProcess = start("uv", ["run", "--project", zeta, "python", join(root, "scripts/real-zeta-server.py")], env);
  await waitFor(async () => (await Bun.file(join(zetaHome, "run/serve.ws.json")).exists()), "zeta discovery");
  const pending = JSON.parse(await Bun.file(join(zetaHome, "run/serve.ws.json")).text());
  const discovery = join(temp, "discovery.json"); await Bun.write(discovery, JSON.stringify({ ...pending, url: `ws://127.0.0.1:${pending.port}` }));
  const appEnv = { ...env, ACHILLES_ZETA_DISCOVERY: discovery };
  const seed = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.execute(\"UPDATE page SET zeta_session_id='stale-session-id' WHERE id='home'\"); db.commit(); db.close()"], env);
  await new Promise<void>((resolve, reject) => { seed.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))); });
  const app = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], appEnv);
  await waitFor(async () => (await fetch(origin).then((r) => r.ok, () => false)), "achilles");
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); const errors: string[] = []; const frames: string[] = [];
  page.on("websocket", (socket) => { socket.on("framesent", (event) => frames.push(String(event.payload))); socket.on("framereceived", (event) => frames.push(String(event.payload))); });
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(origin); const field = page.getByRole("textbox", { name: "message" }); await field.waitFor({ timeout: 20000 }).catch(async () => { throw new Error(`composer missing: ${await page.locator("body").innerText()} errors=${redact(errors.join(" | "))} logs=${redact(logs.get(zetaProcess) ?? "")} discovery fields unavailable`); });
  const homeSessionId = async () => page.locator("[data-session-id]").getAttribute("data-session-id");
  const first = await homeSessionId(); if (!first) throw new Error("home session id missing");
  const requests = () => frames.map((frame) => { try { return JSON.parse(frame); } catch { return null; } }).filter(Boolean);
  if (requests().filter((frame) => frame.method === "resume" && frame.params?.session_id === "stale-session-id").length !== 1) throw new Error("stale session was not resumed exactly once");
  if (requests().filter((frame) => frame.method === "new_session").length !== 1) throw new Error("stale session did not create exactly one replacement");
  const mapped = await page.request.get(`${origin}/api/pages/home`).then((response) => response.json());
  if (mapped.zeta_session_id !== first) throw new Error("home mapping did not persist the winning session");
  await field.fill("prove chat"); await field.press("Enter");
  await page.getByText("assistant ready", { exact: true }).waitFor({ timeout: 20000 });
  const approval = page.locator('[data-part="approval"]'); await approval.waitFor({ timeout: 20000 });
  await approval.getByRole("button", { name: /approve/i }).click(); await page.getByText("approval complete", { exact: true }).waitFor({ timeout: 20000 });
  const transcript = await page.locator("body").innerText();
  const beforeReloadCreates = requests().filter((frame) => frame.method === "new_session").length;
  await page.reload(); await page.getByText("approval complete", { exact: true }).waitFor({ timeout: 20000 });
  if (requests().filter((frame) => frame.method === "new_session").length !== beforeReloadCreates) throw new Error("reload created a second session");
  if (await homeSessionId() !== first) throw new Error("reload changed home session id");
  if ((await page.locator("body").innerText()).includes("prove chat") === false || transcript.includes("approval complete") === false) throw new Error("reload lost transcript");
  if (errors.length) throw new Error(`browser errors: ${redact(errors.join(" | "))}`);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  console.log(`real-zeta gate passed: session ${first}`);
} finally {
  await browser?.close().catch(() => {}); for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("child did not exit after SIGTERM")), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  })));

  await rm(temp, { recursive: true, force: true });
}
