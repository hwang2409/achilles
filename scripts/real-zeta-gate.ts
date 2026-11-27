import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CDPSession, Locator, Page, Request, Route } from "../apps/web/node_modules/playwright";
import { appShortcut, controlSnapshot, desktopPageChatProof, writeControl, createFrameRing, createGateWait, diagnostic, redactArtifact } from "./gate-diagnostics";
import { gateAccountsPlace, gateCreatePlace, gateShell, gateStablePlace } from "./gate-shell";
import { gateReloadMidTurn, gateTranscript, waitForIdleTurn } from "./gate-transcript";
import { approvalModeWaiter, assertServerAskWins, gateCreationApprovalDefaults, gateSettings } from "./gate-settings";
import { gatePalette } from "./gate-palette";
import { gateVim } from "./gate-vim";
import { gateHomeSettings } from "./gate-home-settings";
import { gateAgentControls, agentControlArtifacts } from "./gate-agent-controls";
import { gateMcpAdd, mcpAddArtifacts } from "./gate-mcp-add";
import { gateMcpWrites, mcpWriteArtifacts } from "./gate-mcp-writes";
import { gateMcpTest, mcpTestArtifacts } from "./gate-mcp-test";
import { gateMcpOAuth, mcpOAuthArtifacts, oauthFixture, refuseMcpOAuth } from "./gate-mcp-oauth";

import { writeSurfaceIds as registryWriteSurfaceIds } from "../apps/web/src/writeSurfaces";
import { TELEMETRY_FEATURE } from "../apps/web/src/zeta/connection";
import { surfaceRoutes } from "../apps/web/src/surface/routes";
import { focusable } from "../apps/web/src/focusable";
import { expectBrowserErrors } from "./browser-errors";
import { freeGatePort } from "./gate-port";

const root = new URL("..", import.meta.url).pathname;

// the compiled home page the gate seeds: plain ESM is valid TSX, so it stands in for a write_page build without docker.
// it lists two collections through the frame bridge every 500 ms and writes one record from a button.
const gateHomePage = `const root = document.getElementById("root");
const list = async (collection) => (await window.achilles.records.list(collection)).map((row) => row.text).join(" | ") || "none";
const button = document.createElement("button");
button.textContent = "add frame note";
button.onclick = () => window.achilles.records.insert("frame_notes", { text: "from the frame" });
const annotations = document.createElement("p");
const notes = document.createElement("p");
const heading = document.createElement("h1");
heading.textContent = "gate home";
root.append(heading, annotations, notes, button);
const render = async () => {
  annotations.textContent = "trace annotations: " + await list("trace_annotations");
  notes.textContent = "frame notes: " + await list("frame_notes");
};
render();
setInterval(render, 500);
`;

const { chromium } = await import(pathToFileURL(join(root, "apps/web/node_modules/playwright/index.mjs")).href);
const zeta = process.env.ZETA_CHECKOUT ?? join(root, ".cache/zeta");
const zetaRef = (await readFile(join(root, "zeta.rev"), "utf8")).trim();
if (!/^[0-9a-f]{40}$/.test(zetaRef))
  throw new Error("zeta.rev must contain one sha");
const pinnedProtocol = await readFile(join(zeta, "src/zeta/server/protocol.py"), "utf8");
const protocolMutationMethods = new Set<string>();
for (const declaration of pinnedProtocol.matchAll(/\b[A-Z_]+\s*=\s*\(([^)]*)\)/g)) {
  const body = declaration[1]!;
  const wire = body.match(/^\s*"([^"]+)"/s)?.[1];
  if (wire && /Access\.(?:SESSION_MUTATION|DELIVERY|CONTROLLER_WRITE)/.test(body)) protocolMutationMethods.add(wire);
}
const resourceDir = join(zeta, "src/zeta/server/handlers/resources");
for await (const file of new Bun.Glob("*.py").scan(resourceDir)) {
  const source = await readFile(join(resourceDir, file), "utf8");
  for (const [, wire] of source.matchAll(/ResourceMethod\(\s*"([^"]+)",\s*Access\.CONTROLLER_WRITE\b/g)) protocolMutationMethods.add(wire!);
}
if (!protocolMutationMethods.size) throw new Error(`pinned zeta ${zetaRef} has no mutation declarations`);
const temp = await mkdtemp(join(tmpdir(), "achilles-v3-"));
const zetaHome = join(temp, "zeta-home");
const achillesHome = join(temp, "achilles-home");
const ownDiscovery = join(achillesHome, "run/serve.json");
const sharedDiscovery = join(zetaHome, "run/serve.ws.json");
const cwd = join(temp, "cwd");
const control = join(temp, "control.json");
const configuredPort = process.env.GATE_PORT;
let port!: number;
let origin!: string;
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const children: ChildProcess[] = [];
const logs = new Map<ChildProcess, string>();
const secrets: string[] = [];
// Failure logs must not overwrite a concurrent run's diagnostics.
const artifactDir = process.env.GATE_ARTIFACT_DIR ?? join(root, ".cache/gate-artifacts", basename(temp));
const artifactSecrets: string[] = [];
const artifactLogs: { name: string; lines: [string, string][]; partial: { stdout: string; stderr: string } }[] = [];
const frameLog: [string, number, string, string][] = [];
const artifactNotes: [string, string][] = [];
let passed = false;
const writeArtifacts = async () => {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const now = new Date().toISOString();
  const all = [...secrets, ...artifactSecrets];
  const safe = ([time, line]: [string, string]) => `${time} ${redactArtifact(line, all)}`;
  for (const log of artifactLogs)
    await writeFile(join(artifactDir, `${log.name}.log`), [...log.lines, ...Object.values(log.partial).filter(Boolean).map((line) => [now, line] as [string, string])].map(safe).join("\n") + "\n");
  if (artifactNotes.length) await writeFile(join(artifactDir, "notes.log"), artifactNotes.map(safe).join("\n") + "\n");
  await writeFile(join(artifactDir, "frames.log"), frameLog.map(([time, socket, direction, payload]) => `${time} socket=${socket} ${direction} ${redactArtifact(payload, all)}`).join("\n") + "\n");
  console.error(`gate artifacts written to ${artifactDir}`);
};
// every token field of a discovery file the gate reads goes into the artifact redaction list at once.
// the gate reads the scripted server's file before each SIGTERM, so every restarted server's tokens are listed.
const readDiscovery = async (path: string) => {
  const document = JSON.parse(await Bun.file(path).text());
  for (const [key, value] of Object.entries(document)) if (/token/i.test(key) && typeof value === "string") artifactSecrets.push(value);
  return document;
};
// a pre-kill read is diagnostics only: a missing or partial file adds a note and never fails or masks the gate.
const listTokens = (path: string) => readDiscovery(path).catch((error) => { artifactNotes.push([new Date().toISOString(), `discovery read failed before SIGTERM: ${error}`]); });
const redact = (text: string) => diagnostic(text, secrets);
const safeControl = async () => {
  try { return controlSnapshot(await Bun.file(control).text(), secrets); }
  catch (error) { return `<control missing: ${redactArtifact(String(error), secrets)}>`; }
};
const frameRing = createFrameRing();
const gateWait = createGateWait(
  frameRing.snapshot,
  async () => await safeControl(),
);
const start = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwdArg = root,
) => {
  const child = spawn(command, args, {
    cwd: cwdArg,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  logs.set(child, "");
  const kinds: [string, (arg: string) => boolean][] = [["achilles", (arg) => arg === "achilles"], ["zeta-serve", (arg) => arg === "serve"], ["real-zeta-server", (arg) => arg.endsWith("real-zeta-server.py")]];
  const kind = kinds.find(([, match]) => args.some(match))?.[0] ?? "helper";
  const log = { name: `${kind}-${artifactLogs.filter((entry) => entry.name.startsWith(`${kind}-`)).length + 1}`, lines: [] as [string, string][], partial: { stdout: "", stderr: "" } };
  artifactLogs.push(log);
  // one partial line per stream, so interleaved output never joins two half-lines.
  const stamp = (stream: keyof typeof log.partial) => (data: Buffer) => {
    const lines = (log.partial[stream] + data).split("\n");
    log.partial[stream] = lines.pop()!;
    const time = new Date().toISOString();
    for (const line of lines) log.lines.push([time, line]);
  };
  child.stdout?.on("data", stamp("stdout"));
  child.stderr?.on("data", stamp("stderr"));
  child.stdout?.on("data", (data) => logs.set(child, logs.get(child)! + data));
  child.stderr?.on("data", (data) => logs.set(child, logs.get(child)! + data));
  return child;
};
const waitFor = (check: () => Promise<boolean>, label: string) => gateWait(async () => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
});
const waitForExit = (child: ChildProcess, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let timer: ReturnType<typeof setTimeout>;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
const startAchilles = async (env: NodeJS.ProcessEnv, label: string, initial = false) => {
  for (let attempt = 0; ; attempt++) {
    if (initial) {
      port = configuredPort === undefined ? await freeGatePort() : Number(configuredPort);
      origin = `http://127.0.0.1:${port}`;
    }
    const child = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], {
      ...env, ZETA_PROOF_ORIGIN: origin,
    });
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // A different listener can answer HTTP if it takes the port after the probe.
    await waitFor(async () => exited() || (logs.get(child)!.includes("Uvicorn running on") &&
      await fetch(origin).then((r) => r.ok, () => false)), label);
    if (!exited()) return child;
    const collision = /EADDRINUSE|address already in use/i.test(logs.get(child)!);
    if (configuredPort !== undefined || !collision || attempt >= 4)
      throw new Error(`${label} exited during startup: ${redact(logs.get(child)!)}`);
    // Restarts must retain the origin used by the browser and Zeta.
    if (!initial) await Bun.sleep(100);
  }
};
let browser;
try {
  await Bun.spawn(["git", "init", cwd]).exited;
  await mkdir(join(achillesHome, "run"), { recursive: true, mode: 0o700 });
  await Bun.write(join(cwd, "fixture.txt"), "synthetic fixture\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZETA_TOOL_SUBPROCESS: undefined,
    PYTHONPATH: zeta,
    ZETA_HOME: zetaHome,
    ZETA_ACCOUNT_HOME: zetaHome,
    ACHILLES_HOME: achillesHome,
    ZETA_PROOF_WORKTREE: root,
    ZETA_PROOF_CWD: cwd,
    ZETA_PROOF_CONTROL: control,
    ZETA_PROOF_DISCOVERY: ownDiscovery,
    ACHILLES_ZETA_DISCOVERY: ownDiscovery,
    ACHILLES_APPROVAL: "ask",
  };
  browser = await chromium.launch({ headless: true });
  const authHome = join(temp, "auth-zeta");
  const authDiscovery = join(authHome, "run/serve.ws.json");
  const authAccounts = join(temp, "auth-accounts");
  const oauthPath = (name: string) => join(authAccounts, "accounts/anthropic", name, "oauth.json");
  const authEnv: NodeJS.ProcessEnv = {
    ...env,
    ZETA_HOME: authHome,
    ZETA_ACCOUNT_HOME: authAccounts,
    ACHILLES_HOME: join(temp, "auth-achilles"),
    ACHILLES_ZETA_DISCOVERY: authDiscovery,
    ZETA_ALLOW_API_KEY: "0",
  };
  const serveAuth = async (scripted: boolean) => {
    const child = start("uv", ["run", "--project", zeta, "zeta", "serve", "--port", "0", "--ws", "0", "--ws-origin", origin, "--provider", "claude"], {
      ...authEnv, ZETA_TEST_SCRIPTED_PROVIDER: scripted ? "1" : "0",
    }, cwd);
    await waitFor(async () => await Bun.file(authDiscovery).exists(), "switch-then-reply zeta discovery");
    const discovery = await readDiscovery(authDiscovery);
    const ps = await Bun.$`ps eww -p ${discovery.pid ?? child.pid!}`.quiet().nothrow();
    if (ps.exitCode !== 0 || /\bZETA_TOOL_SUBPROCESS=/.test(ps.text())) throw new Error("could not verify the serve environment");
    return child;
  };
  const stop = async (child: ChildProcess) => {
    child.kill("SIGTERM");
    if (!await waitForExit(child, 15_000)) throw new Error("switch-then-reply process did not exit");
  };
  await mkdir(authAccounts, { recursive: true, mode: 0o700 });
  const authApp = await startAchilles(authEnv, "idle accounts achilles", true);
  env.ZETA_PROOF_ORIGIN = origin;
  authEnv.ZETA_PROOF_ORIGIN = origin;
  let authZeta = await serveAuth(false);
  const mcpAddSurfaceId = await gateMcpAdd(browser, origin, authHome, cwd, screenshotDir, () => `${logs.get(authApp)}\n${logs.get(authZeta)}`);
  const mcpOAuthSurfaceIds = await gateMcpOAuth(browser, origin, authHome, screenshotDir);
  const accountsPage = await browser.newPage();
  try { await gateAccountsPlace(accountsPage, origin); }
  finally { await accountsPage.close(); }
  await writeFile(join(authAccounts, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: {
      "anthropic:failed": { provider: "anthropic", name: "failed" },
      "anthropic:working": { provider: "anthropic", name: "working" },
    },
    defaults: { anthropic: "anthropic:failed" },
  }), { mode: 0o600 });
  const seedOAuth = async (name: string) => {
    await mkdir(join(oauthPath(name), ".."), { recursive: true, mode: 0o700 });
    await writeFile(oauthPath(name), JSON.stringify({
      version: 1, access_token: "fake-access", refresh_token: "fake-refresh", expires_at: 4102444800,
    }), { mode: 0o600 });
  };
  await seedOAuth("failed");
  await seedOAuth("working");
  await waitFor(async () => await fetch(origin).then(r => r.ok, () => false), "switch-then-reply achilles");
  await Bun.write(join(authHome, "mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `${origin}/mcp/` } } }));
  const restartAuth = async (scripted: boolean) => {
    await stop(authZeta);
    await rm(authDiscovery, { force: true });
    authZeta = await serveAuth(scripted);
  };
  await restartAuth(false);
  const authPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const sentinel = "https://provider.invalid/fixture-browser-sign-in";
    await authPage.context().route(sentinel, route => route.fulfill({ body: "synthetic provider sign-in" }));
    const log: string[] = [];
    authPage.on("console", message => log.push(message.text()));
    const loginRequests: unknown[] = [];
    const switches: { id: number; account: string }[] = [];
    let settledByRead = false;
    let drop = false;
    await authPage.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer();
      let droppedReply: number | undefined;
      socket.onMessage(async raw => {
        const { id, method, params } = JSON.parse(String(raw));
        if (method === "login_start") {
          loginRequests.push(params);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: { state: "pending", authorization_url: sentinel } }));
          return;
        }
        if (method === "login_status") {
          await seedOAuth("failed");
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: { state: "succeeded" } }));
          return;
        }
        if (method === "account_switch") {
          switches.push({ id, account: params.account });
          if (drop) { drop = false; droppedReply = id; }
        }
        if (method === "account_list" && switches.length === 2 && droppedReply === undefined) settledByRead = true;
        server.send(raw);
      });
      server.onMessage(raw => {
        if (droppedReply !== undefined && JSON.parse(String(raw)).id === droppedReply) {
          void socket.close();
          return;
        }
        socket.send(raw);
      });
    });
    const review = authPage.getByRole("dialog", { name: "review chat account switch" });
    const capture = async (name: string, locator: Locator, device?: CDPSession) => {
      if (!screenshotDir) return;
      await locator.evaluate(async element => {
        const start = performance.now();
        let prior = "";
        for (;;) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const box = JSON.stringify(element.getBoundingClientRect());
          if (box === prior && performance.now() - start >= 300) break;
          if (performance.now() - start > 3_000) throw new Error("account proof layout did not settle");
          prior = box;
        }
      }, undefined, { timeout: 5_000 });
      const path = join(screenshotDir, `accounts-${name}.png`);
      if (device) await Bun.write(path, Buffer.from((await device.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      else await authPage.screenshot({ path, animations: "disabled" });
    };
    const confirm = async (account: string, chat: string) => {
      await review.waitFor({ timeout: 10_000 });
      if (!(await review.textContent())?.includes(chat)) throw new Error("account switch did not name the active chat");
      const action = review.getByRole("button", { name: "switch chat account", exact: true });
      if (await action.isEnabled()) throw new Error("switch review did not require the typed account id");
      await review.getByRole("textbox").fill(account);
      await action.click();
    };
    authPage.setDefaultTimeout(10_000);
    await authPage.goto(`${origin}/not-a-real-page`);
    await authPage.getByRole("button", { name: "new chat", exact: true }).click({ timeout: 20_000 });
    const composer = authPage.getByRole("textbox", { name: "message", exact: true });
    const title = "fixture account recovery";
    await composer.fill(title, { timeout: 20_000 });
    // A missing credential triggers real auth failure without sending a provider request.
    await rm(oauthPath("failed"));
    await composer.press("Enter");
    const card = authPage.locator(".chat-auth-error");
    await card.waitFor({ timeout: 20_000 });
    const id = await authPage.locator("[data-session-id]").getAttribute("data-session-id");
    if (!id) throw new Error("switch-then-reply chat has no session id");
    const chatUrl = authPage.url();
    const pin = async () => JSON.parse(await Bun.file(join(authHome, "sessions", id, "meta.json")).text()).selected_accounts.anthropic;
    if (await pin() !== "anthropic:failed") throw new Error("switch-then-reply chat did not start pinned to anthropic:failed");
    await capture("auth-card-1440", card);
    await card.getByRole("link", { name: "/accounts", exact: true }).click();
    const occupied = authPage.getByText(/another tab had control/, { selector: "#account-switch-reason" });
    if (await authPage.getByRole("button", { name: "try again", exact: true }).isVisible()) await authPage.getByRole("button", { name: "try again", exact: true }).click();
    await authPage.getByRole("button", { name: "sign in again to anthropic:failed", exact: true }).click();
    const login = authPage.getByRole("dialog", { name: "review browser sign-in" });
    await login.getByRole("checkbox").check();
    const popupEvent = authPage.waitForEvent("popup", { timeout: 10_000 });
    const [popup, confirmed] = await Promise.allSettled([popupEvent, login.getByRole("button", { name: "sign in again", exact: true }).click()]);
    if (popup.status === "rejected") throw new Error("named sign-in popup did not open", { cause: popup.reason });
    try {
      if (confirmed.status === "rejected") throw confirmed.reason;
      await popup.value.waitForURL(sentinel, { timeout: 10_000 });
    } finally { await popup.value.close(); }
    await authPage.getByText(/^signed in at/).waitFor();
    const pageData = await authPage.evaluate(() => JSON.stringify([document.documentElement.outerHTML, location.href, history.state,
      ...[localStorage, sessionStorage].map(store => Object.entries(store))]));
    if (pageData.includes(sentinel) || log.some(line => line.includes(sentinel))) throw new Error("authorization URL escaped the popup");
    if (JSON.stringify(loginRequests) !== '[{"provider":"claude","account":"anthropic:failed"}]') throw new Error("browser sign-in did not name the failed account");
    await capture("named-sign-in-1440", authPage.getByText(/^signed in at/));
    const toWorking = authPage.getByRole("button", { name: "switch active chat to anthropic:working" });
    await toWorking.click();
    await review.waitFor();
    await capture("page-review-1440", review);
    await authPage.setViewportSize({ width: 390, height: 844 });
    await capture("page-review-390", review);
    await authPage.setViewportSize({ width: 1440, height: 900 });
    // At 200% a 1440×900 surface has a 720×450 CSS-pixel layout viewport.
    const cdp = await authPage.context().newCDPSession(authPage);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
    if (!await review.evaluate(dialog => [...dialog.querySelectorAll(".confirmation-name input, .confirmation-actions button")].every(node => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
    }))) throw new Error("typed proof and actions are not visible at 200% zoom");
    await capture("page-review-1440-200pct", review, cdp);
    await confirm("anthropic:working", title);
    await authPage.getByText(/switched to anthropic:working/).waitFor();
    await capture("page-receipt-1440-200pct", authPage.getByText(/switched to anthropic:working/), cdp);
    if (await pin() !== "anthropic:working") throw new Error("/accounts did not switch the active session");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
    const other = await browser.newPage();
    try {
      await other.goto(chatUrl);
      await other.getByRole("textbox", { name: "message", exact: true }).waitFor({ timeout: 10_000 });
      await authPage.getByRole("button", { name: "switch active chat to anthropic:failed" }).click();
      await confirm("anthropic:failed", title);
      await review.getByText(/another tab had control/).waitFor();
      await review.getByRole("button", { name: "keep current account" }).click();
      await occupied.waitFor();
      if (await authPage.getByRole("button", { name: "switch active chat to anthropic:failed" }).isEnabled() || switches.length !== 1)
        throw new Error("/accounts did not disable switching after control refusal");
      await capture("controller-refusal-1440", occupied);
    } finally { await other.close(); }
    await authPage.goto(chatUrl);
    await composer.fill("/accounts anthropic:failed");
    await composer.press("Enter");
    await review.waitFor();
    await capture("composer-review-1440", review);
    drop = true;
    await confirm("anthropic:failed", title);
    await authPage.getByText(/current account confirmed as anthropic:failed/).waitFor({ timeout: 20_000 });
    await capture("composer-read-receipt-1440", authPage.getByText(/current account confirmed as anthropic:failed/));
    if (await pin() !== "anthropic:failed" || !settledByRead || Number(switches.length) !== 2) throw new Error("lost switch reply was not settled by read alone");
    await restartAuth(true);
    await authPage.reload();
    await card.waitFor({ timeout: 20_000 });
    await card.getByRole("button", { name: "switch this chat to anthropic:working", exact: true }).click({ timeout: 20_000 });
    await confirm("anthropic:working", title);
    await authPage.getByText(/switched to anthropic:working/).waitFor();
    await waitFor(async () => await pin() === "anthropic:working", "switch-then-reply working pin");
    // Old zeta uses the real backend after switching. Keep that path offline too.
    await rm(oauthPath("working"));
    await composer.fill("reply after switch");
    await composer.press("Enter");
    await waitFor(async () => await authPage.getByText("you said: reply after switch", { exact: true }).isVisible(), "switch-then-reply scripted reply");
    await card.waitFor({ state: "hidden", timeout: 20_000 });
    console.log("switch-then-reply passed: pin changed to anthropic:working, scripted reply visible, auth card gone");
  } finally {
    await authPage.close();
  }
  await stop(authZeta);
  await stop(authApp);
  if (process.env.ACCOUNTS_PROOF_ONLY === "1") {
    passed = true;
  } else {
  const sharedProcess = start(
    "uv",
    ["run", "--project", zeta, "zeta", "serve", "--port", "0", "--ws", "0", "--ws-origin", origin, "--provider", "codex"],
    env,
  );
  await waitFor(async () => await Bun.file(sharedDiscovery).exists(), "shared zeta discovery");
  const shared = await readDiscovery(sharedDiscovery);
  let zetaProcess = start(
    "uv",
    [
      "run",
      "--project",
      zeta,
      "python",
      join(root, "scripts/real-zeta-server.py"),
    ],
    env,
  );
  // the control file pid is the python server's os.getpid(), not the uv pid, and the server writes it after its discovery file.
  // so a new control pid and an existing discovery file mean the new server listens.
  const controlPid = async () => { try { return JSON.parse(await Bun.file(control).text()).pid; } catch { return undefined; } };
  const restartZeta = async (label: string) => {
    const previousPid = await controlPid();
    zetaProcess = start("uv", ["run", "--project", zeta, "python", join(root, "scripts/real-zeta-server.py")], env);
    await waitFor(async () => (await controlPid()) !== previousPid && await Bun.file(ownDiscovery).exists(), label);
  };
  await waitFor(async () => await Bun.file(ownDiscovery).exists(), "achilles zeta discovery");
  const pending = await readDiscovery(ownDiscovery);
  for (const key of ["controller_token", "observer_token"])
    if (typeof pending[key] === "string") secrets.push(pending[key]);
  const appEnv = env;
  const seed = start(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import hashlib, sys
from achilles.web import _database, _home
with _database() as db:
    db.execute("UPDATE page SET zeta_session_id='stale-session-id' WHERE id='home'")
    artifact = sys.argv[1].encode()
    digest = hashlib.sha256(artifact).hexdigest()
    (_home() / "bundles" / f"{digest}.js").write_bytes(artifact)
    db.execute("INSERT INTO code_revision(page_id,version,source,dependencies,digest,artifact_size,created_at) VALUES('home',1,?,'{}',?,?,datetime('now'))", (sys.argv[1], digest, len(artifact)))
    db.execute("UPDATE page SET active_code_revision=1 WHERE id='home'")
    db.executemany("INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)", [(f'gate-page-{i}', f'/gate-page-{i}', f'gate page {i}', f'2025-01-{i:02d}', f'2025-01-{i:02d}') for i in range(1,46)])
`,
      gateHomePage,
    ],
    env,
  );
  if (!await waitForExit(seed, 15_000) || seed.exitCode !== 0) throw new Error("could not seed gate fixtures");
  let app = await startAchilles(appEnv, "achilles");
  if (process.env.GATE_VERIFY_LISTENER === "1") {
    const info = (await Bun.$`lsof -nP -iTCP:${port} -sTCP:LISTEN`.text()).trim();
    const pids = [...new Set(info.split("\n").slice(1).map((line) => Number(line.trim().split(/\s+/)[1])))];
    if (pids.length !== 1) throw new Error("gate listener must belong to one process");
    const pid = pids[0];
    const parent = pid === app.pid ? pid : Number((await Bun.$`ps -o ppid= -p ${pid}`.text()).trim());
    const cwd = await Bun.$`lsof -a -p ${pid} -d cwd -Fn`.text();
    if (parent !== app.pid || !cwd.split("\n").includes(`n${root.replace(/\/$/, "")}`)) throw new Error("gate did not start the listener in this worktree");
    console.log(`verified worktree listener pid=${pid} port=${port}`);
  }
  // before any chat tab opens: a chat tab keeps control, and the settings change borrows it
  await gateHomeSettings(browser, origin, zetaHome, waitFor, screenshotDir);
  const mcpWriteSurfaceIds = await gateMcpWrites(browser, origin, zetaHome, cwd, screenshotDir);
  const mcpTestSurfaceId = await gateMcpTest(browser, origin, zetaHome, cwd, screenshotDir);
  const agentsHome = join(temp, "agents-zeta");
  const agentsDiscovery = join(agentsHome, "agents-ws.json");
  await mkdir(agentsHome, { mode: 0o700 });
  const agentsServer = start("uv", ["run", "--project", zeta, "python", join(root, "scripts/agent-controls-server.py")], {
    ...env, ZETA_HOME: agentsHome, ZETA_ACCOUNT_HOME: agentsHome, ZETA_PROOF_DISCOVERY: agentsDiscovery,
  });
  await waitFor(async () => await Bun.file(agentsDiscovery).exists(), "agent controls zeta discovery");
  const agentDiscovery = await readDiscovery(agentsDiscovery);
  const agentWriteSurfaceIds = await gateAgentControls(browser, origin, { ...agentDiscovery, url: `ws://127.0.0.1:${agentDiscovery.port}` }, waitFor, screenshotDir);
  await stop(agentsServer);
  const telemetryPage = await browser.newPage();
  const telemetryChatPage = await browser.newPage();
  const telemetryFailures: string[] = [];
  const telemetryArtifacts: string[] = [];
  const telemetryHttp: string[] = [];
  const recordTelemetryRequest = (request: Request) => telemetryHttp.push(`${request.method()} ${new URL(request.url()).pathname}`);
  const telemetryMethods: string[] = [];
  let telemetryConnections = 0;
  const forbiddenHttp = () => telemetryHttp.find((value) => value.startsWith("GET /api/pages/telemetry"));
  const forbiddenMethods = new Set(["resume", "status", "session_settings", "set_settings", "session_history_and_subscribe", "session_history", "mcp_refresh_tools", "new_session", "abort", "delivery_status", "send", "steer", "approve", "deny"]);
  let telemetryHello = false;
  const decodeFrame = (payload: string | Buffer): { id?: string | number; method?: string; result?: unknown } | null => {
    try { return JSON.parse(String(payload)); } catch { return null; }
  };
  // New zeta negotiates telemetry_read_v1. Keep exercising the legacy recovery UI
  // by omitting only that optional feature from these tabs' hello requests.
  const legacyTelemetry = (tab: Page) => tab.routeWebSocket(url => url.hostname === "127.0.0.1", socket => {
    const server = socket.connectToServer();
    socket.onMessage(payload => {
      const frame = JSON.parse(String(payload));
      if (frame.method === "hello" && Array.isArray(frame.params?.features)) {
        frame.params.features = frame.params.features.filter((feature: string) => feature !== TELEMETRY_FEATURE);
        server.send(JSON.stringify(frame));
      } else server.send(payload);
    });
  });
  await legacyTelemetry(telemetryPage);
  telemetryPage.on("request", recordTelemetryRequest);
  telemetryPage.on("websocket", (socket) => {
    telemetryConnections += 1;
    let helloId: string | number | undefined;
    socket.on("framesent", ({ payload }) => {
      const frame = decodeFrame(payload);
      if (typeof frame?.method !== "string") return;
      telemetryMethods.push(frame.method);
      if (frame.method === "hello") helloId = frame.id;
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = decodeFrame(payload);
      if (helloId !== undefined && frame?.id === helloId && Object.hasOwn(frame, "result")) telemetryHello = true;
    });
  });
  try {
    await telemetryPage.goto(`${origin}/telemetry/sessions/x`);
    await waitFor(async () => telemetryHello, "telemetry hello");
    const newerZeta = telemetryPage.getByText("telemetry · needs a newer zeta", { exact: true });
    // Let attachment win the race on old builds so the assertion names the side effect, not missing copy.
    await waitFor(async () => Boolean(forbiddenHttp()) || await newerZeta.isVisible(), "telemetry route milestone");
    await telemetryPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (await telemetryPage.locator('.place-nav [aria-current="page"]').innerText() !== "Telemetry") throw new Error("telemetry child URL did not select telemetry");
    if (telemetryConnections !== 1) throw new Error(`telemetry child opened ${telemetryConnections} connections`);
    const attachment = forbiddenHttp();
    if (attachment) throw new Error(`telemetry route started page attachment: ${attachment}`);
    const agentMethods = telemetryMethods.filter((method) => forbiddenMethods.has(method));
    if (agentMethods.length) throw new Error(`telemetry route used agent RPCs: ${agentMethods.join(", ")}`);
    if (!await newerZeta.isVisible()) throw new Error("telemetry route did not show the newer-zeta state");
    console.log("telemetry route: hello succeeded, newer-zeta state visible, no page attachment or agent RPCs");
    await telemetryChatPage.goto(origin);
    const newChat = telemetryChatPage.getByRole("button", { name: "new chat" });
    const takeControl = telemetryChatPage.getByRole("button", { name: "take control", exact: true });
    await waitFor(async () => await newChat.isEnabled() || await takeControl.isVisible(), "chat role after telemetry opened first");
    if (!await newChat.isEnabled()) telemetryFailures.push("chat opened after telemetry did not get controller");
  } finally {
    telemetryPage.off("request", recordTelemetryRequest);
    await telemetryPage.close();
  }
  let page = await browser.newPage();
  const errors: string[] = [];
  const requestFailures: string[] = [];
  const consoleErrors: string[] = [];
  const requestPath = (url: string) => { try { return new URL(url).pathname; } catch { return "<invalid-url>"; } };
  const expectedNotFoundUrl = `${origin}/api/pages/not-a-real-page`;
  const discoveryUrl = `${origin}/api/zeta/discovery`;
  const frames: string[] = [];
  const connectionRows: Array<{ socketId: number; attempt: number; role: string | null; lifecycle: "open" | "closed"; direction?: "sent" | "received"; method?: string }> = [];
  let nextSocket = 0;
  page.on("websocket", (socket) => {
    const socketId = nextSocket++;
    const attempt = socketId + 1;
    const row = { socketId, attempt, role: null as string | null, lifecycle: "open" as const };
    connectionRows.push(row);
    socket.on("framesent", (event) => {
      const payload = String(event.payload); frames.push(payload); frameLog.push([new Date().toISOString(), socketId, "sent", payload]); frameRing.record(socketId, "sent", payload);
      try { const frame = JSON.parse(payload) as { method?: unknown; params?: { role?: unknown } }; if (frame.method === "hello" && (frame.params?.role === "controller" || frame.params?.role === "observer")) row.role = frame.params.role; connectionRows.push({ ...row, lifecycle: "open", direction: "sent", method: typeof frame.method === "string" ? frame.method : undefined }); } catch { /* raw protocol payload remains in frameLog */ }
    });
    socket.on("framereceived", (event) => {
      const payload = String(event.payload); frames.push(payload); frameLog.push([new Date().toISOString(), socketId, "received", payload]); frameRing.record(socketId, "received", payload);
      try { const frame = JSON.parse(payload) as { method?: unknown }; connectionRows.push({ ...row, lifecycle: "open", direction: "received", method: typeof frame.method === "string" ? frame.method : undefined }); } catch { /* raw protocol payload remains in frameLog */ }
    });
    socket.on("close", () => connectionRows.push({ ...row, lifecycle: "closed" }));
  });
  page.on("pageerror", (e) => errors.push(`${e.message}${requestFailures.length ? `; latest request failure: ${requestFailures.at(-1)}` : ""}${consoleErrors.length ? `; latest console error: ${consoleErrors.at(-1)}` : ""}`));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${requestPath(request.url())}: ${request.failure()?.errorText ?? "unknown failure"}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${requestPath(message.location().url)}: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const dockHead = (tab: Page) => tab.locator(".page-chat-head");
  // the chat's modes are switches in the composer, in the rail, the sheet, and a full-width chat alike
  const modeSwitch = (tab: Page, name: "create mode" | "auto-approve", checked?: boolean) => tab.locator(`#message-composer [data-write-surface="composer.${name === "create mode" ? "create-mode" : "auto-approve"}"]${checked === undefined ? "" : `[aria-checked="${checked}"]`}`);
  const clickCreateMode = async (enabled: boolean) => {
    await gateWait.playwright(modeSwitch(page, "create mode", enabled), "waitFor");
    await modeSwitch(page, "create mode").click();
  };
  const waitCreateMode = (enabled: boolean) => gateWait.playwright(modeSwitch(page, "create mode", enabled), "waitFor");
  const mobileSheet = {
    closed: null,
    button: "pointer",
    keyboard: "keyboard",
    resize: "resize",
    switcher: "pointer",
  } as const;
  const setupMobileSheet = async (tab: Page, height: number, state: keyof typeof mobileSheet = "closed", width = 390) => {
    const opener = mobileSheet[state];
    const bar = tab.locator(".page-chat-bar");
    const dialog = tab.getByRole("dialog", { name: "page chat", exact: true });
    const closeButton = dialog.getByRole("button", { name: "close page chat", exact: true });
    const settleClosed = async () => {
      const wasFocused = await tab.evaluate(() => Boolean(document.activeElement?.closest(".page-chat-docked #message-composer") && !matchMedia("(width < 1280px)").matches));
      await tab.setViewportSize({ width, height });
      if (wasFocused) {
        // A focused resize opens the sheet. Do not close until that commit happened.
        await gateWait.playwright(tab, "waitForFunction", () => Boolean(document.activeElement?.closest('#page-chat-sheet[aria-modal="true"] #message-composer')));
      }
      if (wasFocused || await closeButton.count()) await gateWait.playwright(closeButton, "click");
      await gateWait.playwright(tab, "waitForFunction", () => {
        const sheet = document.querySelector<HTMLElement>("#page-chat-sheet");
        if (!matchMedia("(width < 1280px)").matches) return false;
        return !!sheet && sheet.inert && !sheet.hasAttribute("role") && getComputedStyle(sheet).visibility === "hidden" && !sheet.getAnimations().length;
      });
    };
    const checkOpen = async (via: NonNullable<typeof opener>) => {
      await gateWait.playwright(tab.locator("#page-chat-sheet"), "waitFor", { state: "attached" });
      // Mutation delivery runs after the open commit's layout effects, before paint or any timer.
      const probe = await tab.evaluateHandle(({ via, selector }) => {
        const sheet = document.querySelector<HTMLElement>("#page-chat-sheet")!;
        const start = document.activeElement;
        const isVisible = (element: HTMLElement | null | undefined) => Boolean(element?.checkVisibility({ visibilityProperty: true }));
        function probeEdge(edge: HTMLElement | undefined, next: HTMLElement | undefined, shiftKey: boolean) {
          if (!edge || !next) return false;
          edge.focus();
          if (document.activeElement !== edge) return false;
          const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
          edge.dispatchEvent(event);
          return event.defaultPrevented && document.activeElement === next;
        }
        function readOpening() {
          const active = document.activeElement as HTMLElement | null;
          const close = sheet.querySelector<HTMLElement>('button[aria-label="close page chat"]');
          const initial = via === "resize" ? active === start && Boolean(active?.closest("#message-composer")) : active === close;
          const focus = initial && isVisible(active) && isVisible(close);
          const controls = [...sheet.querySelectorAll<HTMLElement>(selector)].filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && isVisible(element));
          const backward = focus && probeEdge(controls[0], controls.at(-1), true);
          const forward = focus && probeEdge(controls.at(-1), controls[0], false);
          if (focus && active !== document.activeElement) active?.focus();
          return { focus, backward, forward, active: active?.getAttribute("aria-label") ?? active?.tagName, visibility: getComputedStyle(sheet).visibility, tabbables: controls.length };
        }
        let result: ReturnType<typeof readOpening> | undefined;
        const observer = new MutationObserver(() => {
          if (!sheet.matches('[role="dialog"][aria-modal="true"]')) return;
          observer.disconnect();
          result = readOpening();
        });
        observer.observe(sheet, { attributes: true, attributeFilter: ["aria-modal"] });
        return { read: () => result, stop: () => observer.disconnect() };
      }, { via, selector: focusable });
      try {
        if (via === "resize") await tab.setViewportSize({ width: 390, height });
        else if (via === "keyboard") await bar.press("Enter");
        else await bar.click();
        const proof = await gateWait.playwright(tab, "waitForFunction", (probe) => probe.read(), probe);
        const result = await proof.jsonValue();
        await proof.dispose();
        if (!result.focus) throw new Error(`390px page chat ${via}: opening did not immediately focus a visible ${via === "resize" ? "composer" : "close page chat button"}: ${JSON.stringify(result)}`);
        if (!result.backward || !result.forward) throw new Error(`390px page chat ${via}: first-frame Tab escaped the modal sheet: ${JSON.stringify(result)}`);
      } finally {
        await probe.evaluate(probe => probe.stop());
        await probe.dispose();
      }
    };
    await settleClosed();
    if (opener === "resize") {
      await tab.setViewportSize({ width: 1440, height });
      const composer = tab.locator('.page-chat-docked #page-chat-sheet:not([inert]) #message-composer').getByRole("textbox", { name: "message" });
      await composer.focus();
      if (!await composer.evaluate(element => element === document.activeElement && !matchMedia("(width < 1280px)").matches)) throw new Error("390px page chat resize: expected a focused desktop composer");
    }
    if (opener) await checkOpen(opener);
    if (state !== "switcher") return;
    const trigger = dockHead(tab).locator('[aria-haspopup="listbox"]');
    await trigger.click();
    const row = dockHead(tab).getByRole("option", { selected: true });
    if (!await row.evaluate((node) => node === document.activeElement)) throw new Error("page chat popup did not take focus on open");
    if (await tab.locator("#message-composer").count() !== 1) throw new Error("page chat popup duplicated the composer");
    if (screenshotDir) await tab.screenshot({ path: join(screenshotDir, `s2-header-${state}-390.png`), animations: "disabled" });
    await tab.keyboard.press("Escape");
    if (await trigger.getAttribute("aria-expanded") !== "false" || !await trigger.evaluate((node) => node === document.activeElement)) throw new Error("popup Escape did not close only the popup and restore its trigger");
    await tab.keyboard.press("Escape");
    await gateWait.playwright(dialog, "waitFor", { state: "hidden" });
    if (!await bar.evaluate((node) => node === document.activeElement)) throw new Error("sheet Escape did not restore focus to the page chat bar");

  };
  try {
    // On the old build the first assertion fails. Free the slot so the banner is still tested with a controller present.
    const takeControl = telemetryChatPage.getByRole("button", { name: "take control", exact: true });
    if (telemetryFailures.length) await takeControl.click({ timeout: 10_000 });
    await waitFor(async () => await telemetryChatPage.getByRole("button", { name: "new chat" }).isEnabled(), "chat controller for telemetry banner check");
    const observerTelemetry = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await legacyTelemetry(observerTelemetry);
      await observerTelemetry.goto(`${origin}/telemetry`);
      await waitFor(async () => await observerTelemetry.getByText("telemetry · needs a newer zeta", { exact: true }).isVisible(), "observer telemetry connected");
      const banner = observerTelemetry.getByRole("complementary", { name: "observer mode" });
      if (!await banner.getByText("this page is read-only", { exact: true }).isVisible()) telemetryFailures.push("telemetry opened with a chat controller did not show the read-only banner");
      if (await observerTelemetry.getByRole("button", { name: "take control", exact: true }).count()) telemetryFailures.push("telemetry offered take control");
      if (telemetryFailures.length) throw new Error(telemetryFailures.join("\n"));
      const captureRecovery = async (size: string) => {
        if (!screenshotDir) return;
        const name = `telemetry-observer-${size}.png`;
        await observerTelemetry.screenshot({ path: join(screenshotDir, name), animations: "disabled" });
        telemetryArtifacts.push(name);
      };
      for (const viewport of [{ width: 360, height: 740 }, { width: 360, height: 780 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 1440, height: 900 }]) {
        const size = `${viewport.width}x${viewport.height}`;
        await observerTelemetry.setViewportSize(viewport);
        if (!await banner.isVisible()) throw new Error(`telemetry recovery ${size}: read-only banner is hidden`);
        await observerTelemetry.evaluate(() => document.fonts.ready.then(() => undefined));
        const notice = observerTelemetry.locator(".telemetry-placeholder");
        if (await notice.evaluate(element => element.scrollTop) !== 0) throw new Error("telemetry recovery must be tested without scrolling");
        for (const action of [notice.getByRole("button", { name: "check again", exact: true }), notice.getByRole("link", { name: "back to chats", exact: true })]) {
          const geometry = await action.evaluate(element => {
            const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
            const hit = element.contains(document.elementFromPoint(left + width / 2, top + height / 2));
            return { top, bottom, width, height, hit, inViewport: left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight };
          });
          if (!geometry.inViewport || !geometry.hit || geometry.width < 44 || geometry.height < 44) throw new Error(`telemetry recovery ${size}: ${await action.textContent()} not fully visible and hit-testable at 44px minimum: ${JSON.stringify(geometry)}`);
        }
        await captureRecovery(size);
        if (viewport.width === 360 || (viewport.width <= 480 && screenshotDir)) {
          const geometry = await notice.evaluate(element => {
            element.scrollTop = element.scrollHeight;
            const pane = element.getBoundingClientRect();
            const step = element.querySelector("ol li:last-child")!.getBoundingClientRect();
            const row = element.querySelector(".telemetry-actions")!.getBoundingClientRect();
            return { scrollTop: element.scrollTop, stepTop: step.top, stepBottom: step.bottom, rowTop: row.top, visible: step.top >= Math.max(0, pane.top) && step.bottom <= Math.min(innerHeight, pane.bottom, row.top) };
          });
          if (viewport.width === 360 && (!geometry.visible || (viewport.height === 740 && !geometry.scrollTop))) throw new Error(`telemetry recovery ${size}: last step not fully visible above actions after scrolling: ${JSON.stringify(geometry)}`);
          await captureRecovery(`${size}-bottom`);
          await notice.evaluate(element => { element.scrollTop = 0; });
        }
      }
      console.log("telemetry observer: chat can control zeta, read-only banner visible, no take-control button");
    } finally { await observerTelemetry.close(); }
  } finally { await telemetryChatPage.close(); }
  const capturePageState = async (state: string, target: Locator, mobileHeight = 760, desktopHeight = 900, assertFrame?: (viewport: string) => Promise<void>) => {
    for (const width of [390, 1280, 1440, 1920]) {
      if (width === 390) {
        await setupMobileSheet(page, mobileHeight);
        const drawerClose = page.getByRole("button", { name: "close menu", exact: true });
        if (await drawerClose.count() && await drawerClose.isVisible()) await drawerClose.click({ force: true });
        await waitFor(async () => {
          const sidebar = await page.locator(".sidebar").evaluate((element) => {
            const style = getComputedStyle(element);
            return { transform: style.transform, right: element.getBoundingClientRect().right };
          });
          const sheet = await page.locator(".page-chat-surface").evaluate((element) => {
            const style = getComputedStyle(element);
            return { transform: style.transform, visibility: style.visibility };
          });
          return sidebar.right <= 0 && sidebar.transform !== "matrix(1, 0, 0, 1, 0, 0)" && sheet.visibility === "hidden" && sheet.transform !== "matrix(1, 0, 0, 1, 0, 0)";
        }, "mobile overlays settled");
        await waitFor(async () => await target.evaluate((element) => {
          element.scrollIntoView({ block: "center", inline: "nearest" });
          const box = element.getBoundingClientRect();
          if (![box.top, box.right, box.bottom, box.left].every(Number.isFinite)) return false;
          if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false;
          // Hit the visible center, not a rounded corner outside the button.
          const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
          const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && (hit === element || element.contains(hit)));
        }), `state ${state} target visible and unobscured`);
      } else {
        await page.setViewportSize({ width, height: desktopHeight });
      }
      await page.evaluate(() => { scrollTo(0, 0); document.querySelector<HTMLElement>(".page-frame")?.scrollTo(0, 0); });
      if (assertFrame) await assertFrame(`${width}px`);
      const captureName = state === "page-chat-closed" && width === 390
          ? "page-chat-closed-390x844.png"
          : `state-${state}-${width}.png`;
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, captureName), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const pageChatLayout = () => page.evaluate(() => {
    const describe = (element: Element | null) => {
      if (!element) return null;
      const node = element as HTMLElement;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const ancestors: { tag: string; className: string; display: string; visibility: string; ariaHidden: string | null; rect: { width: number; height: number } }[] = [];
      for (let current: Element | null = node.parentElement; current; current = current.parentElement) {
        const currentNode = current as HTMLElement;
        const currentStyle = getComputedStyle(currentNode);
        const currentRect = currentNode.getBoundingClientRect();
        ancestors.push({ tag: current.tagName, className: currentNode.className, display: currentStyle.display, visibility: currentStyle.visibility, ariaHidden: current.getAttribute("aria-hidden"), rect: { width: currentRect.width, height: currentRect.height } });
      }
      return { display: style.display, visibility: style.visibility, rect: { width: rect.width, height: rect.height }, ariaHidden: element.getAttribute("aria-hidden"), ancestors };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      mobileQuery: matchMedia("(width < 1280px)").matches,
      pageChat: describe(document.querySelector(".page-chat")),
      surface: describe(document.querySelector(".page-chat-surface")),
      transcript: describe(document.querySelector(".transcript")),
    };
  });
  await page.goto(origin);
  const setupAlert = page.getByRole("alert");
  await gateWait.playwright(setupAlert, "waitFor", { timeout: 20000 });
  if (!(await setupAlert.innerText()).includes("add it to $ZETA_HOME/mcp.json"))
    throw new Error(`missing mcp setup instruction: ${redact(await page.locator("body").innerText())}`);
  await Bun.write(join(zetaHome, "mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `${origin}/mcp/` } } }));
  zetaProcess.kill("SIGTERM");
  if (!(await waitForExit(zetaProcess, 15_000))) {
    zetaProcess.kill("SIGKILL");
    await waitForExit(zetaProcess, 5_000);
    throw new Error("zeta shutdown timeout after 15 seconds");
  }
  await restartZeta("restarted zeta");
  let field = page.getByRole("textbox", { name: "message" });
  await gateWait.playwright(field, "waitFor", { timeout: 20000 }).catch(async () => {
    throw new Error(
      `composer missing: ${redact(await page.locator("body").innerText())} errors=${redact(errors.join(" | "))} logs=${redact(logs.get(zetaProcess) ?? "")} discovery fields unavailable`,
    );
  });
  if (await setupAlert.count()) throw new Error("mcp setup alert remained after a successful attach");
  await gateWait.playwright(page.locator(".transcript"), "waitFor", { state: "visible" }).catch(async (error) => {
    throw new Error(`${error}; page-chat layout=${JSON.stringify(await pageChatLayout())}`);
  });
  const homeSessionId = async () =>
    page.locator("[data-session-id]").getAttribute("data-session-id", { timeout: 20_000 }).catch(async (error) => {
      throw new Error(`${error}\nhome session id missing at ${page.url()}: ${redact(await page.locator("body").innerText({ timeout: 10_000 }))}`);
    });
  const first = await homeSessionId();
  if (!first) throw new Error("home session id missing");
  const requests = () =>
    frames
      .map((frame) => {
        try {
          return JSON.parse(frame);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const zetaSessionCount = () => requests().filter((frame) => frame.method === "new_session").length;
  // `/` or a page route with no chat named opens that page's most recent chat in the sidebar's order
  const newestChatId = async (pageId: string) => ((await (await fetch(`${origin}/api/chats?limit=200`, { signal: AbortSignal.timeout(10_000) })).json()) as { chats: { session_id: string; page_id: string }[] }).chats.find((chat) => chat.page_id === pageId)?.session_id;
  const chatCount = async () => ((await (await fetch(`${origin}/api/chats?limit=200`, { signal: AbortSignal.timeout(10_000) })).json()) as { chats: unknown[] }).chats.length;
  const awaitApprovalMode = approvalModeWaiter(requests, waitFor);
  if (
    requests().filter(
      (frame) =>
        frame.method === "resume" &&
        frame.params?.session_id === "stale-session-id",
    ).length !== 2
  )
    throw new Error("stale session was not resumed once before and once after setup recovery");
  if (requests().filter((frame) => frame.method === "new_session").length !== 1)
    throw new Error("stale session did not fall back to exactly one replacement");
  await assertServerAskWins(page, first, requests, awaitApprovalMode);
  await expectBrowserErrors(page, [{ method: "GET", url: expectedNotFoundUrl, status: 404 }], async () => {
    await page.goto(`${origin}/not-a-real-page`);
  await gateWait.playwright(page.getByRole("alert").filter({ hasText: "page not found" }), "waitFor", { timeout: 20_000 });
  await page.getByRole("main").getByRole("button", { name: "new chat", exact: true }).click();
  await gateWait.playwright(page.getByRole("textbox", { name: "message", exact: true }), "waitFor", { timeout: 20_000 });
  });
  const unknownRouteSession = await homeSessionId();
  if (!unknownRouteSession || unknownRouteSession === first) throw new Error("unknown-route new chat did not create a new session");
  if (!(await page.locator(".empty-chat").count())) throw new Error("unknown-route new chat did not show an empty chat");
  await page.goto(`${origin}/?chat=${first}`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message", exact: true }), "waitFor", { timeout: 20_000 });
  const assistantReady = page.getByText("assistant ready", { exact: true });
  const assistantReadyBefore = await assistantReady.count();
  const approval = page.locator('[data-part="approval"][data-state="pending"]');
  const approvalBefore = await approval.count();
  await field.fill("prove chat");
  await field.press("Enter");
  await waitFor(async () => (await assistantReady.count()) > assistantReadyBefore, "assistant ready").catch(async (error) => { throw new Error(`${error}\nassistant missing body=${redact(await page.locator("body").innerText())} errors=${redact(errors.join(" | "))} logs=${redact(logs.get(zetaProcess) ?? "")}`); });
  await waitFor(async () => (await approval.count()) > approvalBefore, "initial approval");
  // A reload while the turn waits for approval attaches to the live turn with `resume` (`resume_attach`): the page
  // binding comes back at once and the same pending approval shows, so the approved page tool runs.
  const framesBeforeReload = requests().length;
  await gateWait.playwright(page, "reload");
  await waitFor(async () => (await approval.count()) > approvalBefore, "pending approval after reload").catch(async (error) => { throw new Error(`${error}\nreload during approval body=${redact(await page.locator("body").innerText())}`); });
  const reloadFrames = requests().slice(framesBeforeReload);
  const reloadResume = reloadFrames.find((frame) => frame.method === "resume" && frame.params?.session_id === first);
  if (!reloadResume?.params?.mcp_bindings?.length) throw new Error("reload did not resume the waiting chat with the page binding");
  const reloadAttach = reloadFrames.slice(reloadFrames.indexOf(reloadResume) + 1).find((frame) => frame.id === reloadResume.id && (frame.result || frame.error));
  if (reloadAttach?.result?.attached !== "live_turn") throw new Error(`reload resume did not attach to the live turn: ${redact(JSON.stringify(reloadAttach?.error ?? reloadAttach?.result ?? null))}`);
  if (await page.getByText("a turn is already running").count()) throw new Error("reload during approval showed the busy error");
  // "new chat" while this turn waits keeps the new chat's box and says why no chat was created; nothing typed there may
  // reach the waiting chat. "open it" goes back to the waiting chat and its approval.
  await page.getByRole("button", { name: "new chat" }).first().click();
  const busyNotice = page.getByRole("alert").filter({ hasText: "is still running, so zeta cannot start a new chat yet" });
  await gateWait.playwright(busyNotice, "waitFor", { timeout: 20_000 });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "busy-new-chat-1440x900.png") });
  // Enter there is refused and keeps a failed row. A reload opens the waiting chat (the newest), so a notice says the
  // row waits for a new chat; "open" shows it in the new-chat box again without making a chat. It is never sent.
  const unsentText = "unsent while the other chat waits";
  await field.fill(unsentText);
  await field.press("Enter");
  const unsentRow = page.locator('[data-part="composer-queued"][data-failed]').filter({ hasText: unsentText });
  await gateWait.playwright(unsentRow, "waitFor", { timeout: 20_000 });
  await gateWait.playwright(page, "reload");
  const unsentNotice = page.getByRole("status").filter({ hasText: "1 unsent message for a new chat" });
  await gateWait.playwright(unsentNotice, "waitFor", { timeout: 20_000 }).catch(async (error) => { throw new Error(`${error}\nno unsent notice after reload body=${redact(await page.locator("body").innerText())}`); });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "unsent-new-chat-notice-1440x900.png") });
  const framesBeforeOpen = requests().length;
  await unsentNotice.getByRole("button", { name: "open", exact: true }).click();
  await gateWait.playwright(unsentRow, "waitFor", { timeout: 20_000 });
  if (requests().slice(framesBeforeOpen).some((frame) => frame.method === "new_session")) throw new Error("open of the unsent notice made a chat");
  if (requests().some((frame) => (frame.method === "send" || frame.method === "steer") && frame.params?.text === unsentText)) throw new Error("text written for a new chat was sent");
  await unsentRow.getByRole("button", { name: /^cancel message/ }).click();
  await gateWait.playwright(unsentRow, "waitFor", { state: "detached", timeout: 20_000 });
  // a reload opens the page's newest chat again: the waiting one, with its approval
  await gateWait.playwright(page, "reload");
  await waitFor(async () => (await approval.count()) > approvalBefore && await homeSessionId() === first, "pending approval after a busy new chat");
  const approvalComplete = page.getByText("approval complete", { exact: true });
  const approvalCompleteBefore = await approvalComplete.count();
  const paginationSeed = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.executemany(\"INSERT INTO chat(session_id,page_id,title,created_at,updated_at) VALUES(?,'home',?,'2020-01-01T00:00:00Z',?)\", [(f'older-{i:03}', f'older chat {i:02}', f'2020-01-01T{i // 60:02}:{i % 60:02}:00Z') for i in range(105)]); db.commit(); db.close()"], env);
  if (!(await waitForExit(paginationSeed, 10_000)) || paginationSeed.exitCode !== 0)
    throw new Error(`pagination seed exited ${paginationSeed.exitCode}`);
  const paginationSearch = page.locator(".chat-search input");
  const searchedPagination = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/chats" && new URL(response.url()).searchParams.get("q") === "older chat");
  await paginationSearch.fill("older chat");
  await searchedPagination;
  const resetPagination = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/chats" && !new URL(response.url()).searchParams.has("q"));
  await paginationSearch.fill("");
  await resetPagination;
  await gateWait.playwright(page.locator(".chat-row").nth(49), "waitFor");
  let olderHeld = false;
  let releaseOlder!: () => void;
  const olderReleased = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const holdOlder = async (route: Route) => {
    if (!new URL(route.request().url()).searchParams.has("before")) return route.continue();
    olderHeld = true;
    await olderReleased;
    await route.continue().catch(() => {});
  };
  await page.route("**/api/chats?**", holdOlder);
  try {
    await page.getByRole("button", { name: "load 50 older" }).click();
    await waitFor(async () => olderHeld, "held older-chats response");
    const olderRefresh = gateWait.playwright(page, "waitForResponse", (response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/chats" && Number(url.searchParams.get("limit")) > 50;
    }, { timeout: 20_000 }).catch(() => { throw new Error("timed out waiting for older chats response after turn-completion refresh"); });
    await approval.nth(approvalBefore).getByRole("button", { name: "approve", exact: true }).click();
    await waitFor(async () => (await approvalComplete.count()) > approvalCompleteBefore, "approval complete");
    const approvedPageTool = JSON.parse(await Bun.file(control).text()).tool_results?.find((result: { call_id: string }) => result.call_id === "proof-inspect");
    if (!approvedPageTool || approvedPageTool.is_error) throw new Error(`page tool approved after a reload did not run: ${redact(JSON.stringify(approvedPageTool ?? null))}`);
    releaseOlder();
    await olderRefresh;
    await gateWait.playwright(page.locator('.chat-list[data-list-state="ready"]:not([data-loaded-count="50"])'), "waitFor", { timeout: 20_000 });
    if (await page.locator(".chat-row").count() <= 50) throw new Error("chat refresh discarded older rows after forced order");
  } finally {
    releaseOlder();
    await page.unroute("**/api/chats?**", holdOlder);
  }
  const beforeTrim = await page.locator(".chat-list").getAttribute("data-loaded-count");
  const trimPagination = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.execute(\"DELETE FROM chat WHERE session_id LIKE 'older-%'\"); db.commit(); db.close()"], env);
  if (!(await waitForExit(trimPagination, 10_000)) || trimPagination.exitCode !== 0)
    throw new Error(`pagination trim exited ${trimPagination.exitCode}`);
  const trimSearch = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/chats" && new URL(response.url()).searchParams.get("q") === "trim pagination");
  await paginationSearch.fill("trim pagination");
  await trimSearch;
  const trimmedPagination = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/chats" && !new URL(response.url()).searchParams.has("q"));
  await paginationSearch.fill("");
  await trimmedPagination;
  await gateWait.playwright(page.locator(`.chat-list[data-list-state="ready"]:not([data-loaded-count="${beforeTrim}"])`), "waitFor", { timeout: 20_000 });
  const own = await readDiscovery(ownDiscovery);
  const shellHtml = await fetch(origin).then((response) => response.text());
  const shellToken = shellHtml.match(/<meta name="achilles-shell" content="([^"]+)">/)?.[1];
  if (!shellToken) throw new Error("achilles shell secret is unavailable");
  const connected = await fetch(discoveryUrl, { headers: { "X-Achilles-Shell": shellToken } }).then((response) => response.json()) as { url: string };
  if (sharedProcess.exitCode !== null || zetaProcess.exitCode !== null) throw new Error("one of the unrelated zeta serves exited during chat");
  if (shared.pid === own.pid || shared.port === own.port) throw new Error("shared and achilles zeta serves did not remain distinct");
  if (new URL(connected.url).port !== String(own.port)) throw new Error("achilles connected to the shared zeta serve");
  const firstSetSettingsBeforeReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  const second = await gateShell(page, first, waitFor, gateWait);
  const stablePlace = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try { await gateStablePlace(stablePlace, origin, gateWait); }
  finally { await stablePlace.close(); }
  const focusPaginationSeed = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.executemany(\"INSERT INTO chat(session_id,page_id,title,created_at,updated_at) VALUES(?,'home',?,'2020-01-01T00:00:00Z',?)\", [(f'older-{i:03}', f'older chat {i:02}', f'2020-01-01T00:{i:02}:00Z') for i in range(55)]); db.commit(); db.close()"], env);
  if (!(await waitForExit(focusPaginationSeed, 10_000)) || focusPaginationSeed.exitCode !== 0)
    throw new Error(`focus pagination seed exited ${focusPaginationSeed.exitCode}`);
  const workspaceUrl = page.url();
  const assertActive = async (name: string, target: Locator) => {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return { tag: element?.tagName, text: element?.textContent?.trim().slice(0, 120), data: element ? Object.fromEntries([...element.attributes].filter((attribute) => attribute.name.startsWith("data-")).map((attribute) => [attribute.name, attribute.value])) : {} };
    });
    throw new Error(`${name} focused ${JSON.stringify(active)}`);
  };
  const reloadShell = async () => {
    await page.goto(workspaceUrl);
    await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
    await gateWait.playwright(page.locator('.chat-list[data-list-state="ready"]'), "waitFor", { timeout: 20_000 });
  };
  const waitForListChange = async (selector: ".chat-list" | ".page-list", before: number, response: Promise<unknown>, label: string) => {
    await response;
    await gateWait.playwright(page.locator(`${selector}[data-list-state="ready"]:not([data-loaded-count="${before}"])`), "waitFor", { timeout: 20_000 }).catch(() => {
      throw new Error(`${label} response completed without a new ready list state`);
    });
  };
  const focusRows: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "new chat row stays in view",
      run: async () => {
        // a new chat's row is inserted above the list's first row; it must stay visible below the sticky heads
        await reloadShell();
        const back = page.url();
        const rows = page.locator(".chat-row");
        await gateWait.playwright(rows.nth(49), "waitFor");
        const firstBefore = await rows.first().getAttribute("data-chat-id");
        await page.locator("button.new-chat").click();
        await waitFor(async () => await rows.first().getAttribute("data-chat-id") !== firstBefore && await rows.first().evaluate((row) => row.classList.contains("current")), "new chat row on top of the list");
        const view = await page.locator(".chat-list").evaluate(async (list) => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const heads = list.querySelector(".chat-group h2")!.getBoundingClientRect().bottom;
          return { scrollTop: list.scrollTop, rowTop: list.querySelector(".chat-row.current")!.getBoundingClientRect().top, heads };
        });
        if (view.scrollTop !== 0 || view.rowTop < view.heads - 1) throw new Error(`new chat row is hidden under the sticky list heads: ${JSON.stringify(view)}`);
        await page.goto(back);
      },
    },
    {
      name: "chat load-older success",
      run: async () => {
        await reloadShell();
        const rows = page.locator(".chat-row");
        await gateWait.playwright(rows.nth(49), "waitFor");
        if (await rows.count() !== 50) throw new Error("chat pagination did not show its first 50 rows");
        const renameTitle = await rows.first().locator("strong").innerText();
        await rows.first().locator(".chat-row-rename").click();
        const renameInput = page.locator(".chat-row-edit");
        await assertActive("chat row rename input", renameInput);
        await page.keyboard.type("typed by keyboard");
        if (await renameInput.inputValue() !== "typed by keyboard") throw new Error(`chat row rename did not take keyboard input: ${await renameInput.inputValue()}`);
        await page.keyboard.press("End");
        await assertActive("chat row rename input after End", renameInput);
        await page.keyboard.press("Escape");
        await gateWait.playwright(renameInput, "waitFor", { state: "detached" });
        if (await rows.first().locator("strong").innerText() !== renameTitle) throw new Error("escape did not cancel the chat row rename");
        await rows.last().focus();
        await page.keyboard.press("Tab");
        const loadOlder = page.getByRole("button", { name: "load 50 older" });
        await assertActive("chat load-older button", loadOlder);
        const boundaryChat = await rows.last().getAttribute("data-chat-id");
        if (!boundaryChat) throw new Error("chat pagination boundary is missing its id");
        await loadOlder.click();
        await gateWait.playwright(page.locator('.chat-list[data-list-state="ready"]:not([data-loaded-count="50"])'), "waitFor", { timeout: 20_000 });
        if (await rows.count() <= 50) throw new Error("load 50 older did not add chat rows");
        const firstNewlyLoaded = page.locator(`[data-chat-id="${boundaryChat}"] + .chat-row`);
        await gateWait.playwright(firstNewlyLoaded, "waitFor", { state: "attached" });
        await assertActive("chat load-older success", firstNewlyLoaded);
      },
    },
    {
      name: "empty older batch",
      run: async () => {
        await reloadShell();
        const search = page.locator(".chat-search input");
        await gateWait.playwright(search, "waitFor");
        // once "load 50 older" is clicked, the server has only the first page: a before= request gets an
        // empty batch, and a chat-list reload (which can answer the click instead) gets at most 50 rows and
        // no next cursor. before the click, reloads pass, so the button stays until the gate clicks it.
        await page.evaluate(() => document.addEventListener("click", (event) => {
          if ((event.target as Element).closest(".load-older")) (window as { olderClicked?: boolean }).olderClicked = true;
        }, { capture: true }));
        const emptyOlder = async (route: Route) => {
          const url = new URL(route.request().url());
          if (url.searchParams.has("before")) return route.fulfill({ json: { chats: [], next: null, approval_count: 0 } });
          const clicked = await page.evaluate(() => (window as { olderClicked?: boolean }).olderClicked === true).catch(() => false);
          if (url.searchParams.has("q") || !clicked) return route.continue();
          url.searchParams.set("limit", String(Math.min(50, Number(url.searchParams.get("limit") ?? 50))));
          const response = await route.fetch({ url: url.toString() });
          // a newer list reload may have cancelled this request already.
          await route.fulfill({ response, json: { ...(await response.json()), next: null } }).catch(() => {});
        };
        await page.route("**/api/chats?**", emptyOlder);
        const before = Number(await page.locator(".chat-list").getAttribute("data-loaded-count"));
        await page.getByRole("button", { name: "load 50 older" }).click();
        await gateWait.playwright(page.getByRole("button", { name: "load 50 older" }), "waitFor", { state: "detached" });
        await gateWait.playwright(page.locator(`.chat-list[data-list-state="ready"][data-loaded-count="${before}"]`), "waitFor", { timeout: 20_000 });
        await page.unroute("**/api/chats?**", emptyOlder);
        const refreshed = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/chats" && new URL(response.url()).searchParams.has("q"));
        await search.fill("older chat 54");
        await refreshed;
        await gateWait.playwright(page.locator(".chat-group h2", { hasText: "1 results" }), "waitFor");
        await assertActive("empty older batch later refresh", search);
      },
    },
    {
      name: "page show-more non-final",
      run: async () => {
        await page.goto(`${origin}/pages`);
        const links = page.locator(".page-list a");
        const showMore = page.getByRole("button", { name: "show more pages" });
        await gateWait.playwright(showMore, "waitFor");
        const before = await links.count();
        const continuation = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        await showMore.click();
        await waitForListChange(".page-list", before, continuation, "non-final page continuation");
        await waitFor(async () => await links.nth(before).evaluate((link) => document.activeElement === link), "non-final page continuation focus");
        if (!(await showMore.count())) throw new Error("non-final page continuation removed show more");
        await assertActive("page show-more non-final", links.nth(before));
      },
    },
    {
      name: "page show-more final",
      run: async () => {
        await page.goto(`${origin}/pages`);
        const links = page.locator(".page-list a");
        const showMore = page.getByRole("button", { name: "show more pages" });
        await gateWait.playwright(showMore, "waitFor");
        const beforeFirst = await links.count();
        const firstContinuation = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        await showMore.click();
        await waitForListChange(".page-list", beforeFirst, firstContinuation, "first page continuation before final");
        const beforeFinal = await links.count();
        const finalContinuation = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        await showMore.click();
        await waitForListChange(".page-list", beforeFinal, finalContinuation, "final page continuation");
        await waitFor(async () => await links.nth(beforeFinal).evaluate((link) => document.activeElement === link), "final page continuation focus");
        if (await showMore.count()) throw new Error("final page continuation kept show more");
        await assertActive("page show-more final", links.nth(beforeFinal));
      },
    },
    {
      name: "page continuation retry",
      run: async () => {
        await page.goto(`${origin}/pages`);
        const links = page.locator(".page-list a");
        const showMore = page.getByRole("button", { name: "show more pages" });
        await gateWait.playwright(showMore, "waitFor");
        const before = await links.count();
        let fail = true;
        const failContinuation = async (route: Route) => {
          if (fail && new URL(route.request().url()).searchParams.has("before")) {
            fail = false;
            await route.fulfill({ status: 503, body: "synthetic page continuation failure" });
          } else await route.continue();
        };
        await page.route("**/api/pages?**", failContinuation);
        await expectBrowserErrors(page, [{ method: "GET", url: `${origin}/api/pages`, status: 503 }], async () => {
          await showMore.click();
          await gateWait.playwright(page.getByText("the page catalog did not load", { exact: true }), "waitFor");
        });
        await page.unroute("**/api/pages?**", failContinuation);
        await page.getByRole("button", { name: "retry", exact: true }).click();
        await gateWait.playwright(showMore, "waitFor");
        const retryContinuation = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        await showMore.click();
        await waitForListChange(".page-list", before, retryContinuation, "page continuation after retry");
        await waitFor(async () => await links.nth(before).evaluate((link) => document.activeElement === link), "page continuation retry focus");
        await assertActive("page continuation retry", links.nth(before));
      },
    },
    {
      name: "focus moved before commit",
      run: async () => {
        await page.goto(`${origin}/pages`);
        let release!: () => void;
        let seen = false;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const holdContinuation = async (route: Route) => {
          if (!new URL(route.request().url()).searchParams.has("before")) return route.continue();
          seen = true;
          await held;
          await route.continue();
        };
        await page.route("**/api/pages?**", holdContinuation);
        const links = page.locator(".page-list a");
        const before = await links.count();
        const search = page.locator(".chat-search input");
        try {
          await page.getByRole("button", { name: "show more pages" }).click();
          await waitFor(async () => seen, "held continuation before moving focus");
          await search.focus();
          const continuation = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
          release();
          await waitForListChange(".page-list", before, continuation, "held continuation rows published");
          await assertActive("focus moved before commit", search);
        } finally {
          release();
          await page.unroute("**/api/pages?**", holdContinuation);
        }
      },
    },
    {
      name: "drawer open",
      run: async () => {
        await reloadShell();
        await setupMobileSheet(page, 760);
        await page.getByRole("button", { name: "open menu" }).click();
        const first = page.locator(".sidebar").locator("button:not(:disabled), a[href], input:not(:disabled)").first();
        await waitFor(async () => await first.evaluate((element) => document.activeElement === element), "drawer first focusable focus");
        await assertActive("drawer open", first);
      },
    },
    {
      name: "drawer close",
      run: async () => {
        const menu = page.getByRole("button", { name: "open menu" });
        await page.keyboard.press("Escape");
        await waitFor(async () => await menu.evaluate((element) => document.activeElement === element), "drawer menu button focus restore");
        await assertActive("drawer close", menu);
        await page.setViewportSize({ width: 1440, height: 900 });
      },
    },
  ];
  for (const row of focusRows) {
    await row.run();
    console.log(`focus after commit: ${row.name}`);
  }
  await reloadShell();
  await gateTranscript(page, waitFor, requests, control, gateWait);
  await gateReloadMidTurn(page, waitFor, requests, gateWait);
  if (requests().some((frame) => frame.method === "resume" && frame.params?.session_id === "foreign-session"))
    throw new Error("hostile chat query reached zeta resume");
  await assertServerAskWins(page, second, requests, awaitApprovalMode);
  const firstSetSettingsAfterReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  if (firstSetSettingsAfterReopen !== firstSetSettingsBeforeReopen)
    throw new Error("reopening an ask chat under an ask server sent set_settings");
  const credential = (
    await Bun.file(join(achillesHome, "credentials/home")).text()
  ).trim();
  secrets.push(credential);
  const mcpSessions = new Map<string, string>();
  const mcp = async (
    token: string,
    id: number,
    method: string,
    params: object,
  ) => {
    const session = mcpSessions.get(token);
    const response = await fetch(`${origin}/mcp/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const next = response.headers.get("mcp-session-id");
    if (next) mcpSessions.set(token, next);
    if (!response.ok)
      throw new Error(`mcp ${method} failed: ${response.status} ${redact(await response.text())}`);
    return response.json();
  };
  const homeMcp = (id: number, method: string, params: object, token = credential) =>
    mcp(token, id, method, params);
  const pageIndexRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/pages") pageIndexRequests.push(request.url());
  });
  await homeMcp(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "gate", version: "1" },
  });
  const catalogReady = page.getByText("catalog ready", { exact: true });
  const catalogReadyBefore = await catalogReady.count();
  const catalogRequestBefore = (JSON.parse(await Bun.file(control).text()).request_count ?? 0) as number;
  const pageRequestsBeforeStreamingTurn = pageIndexRequests.length;
  await field.fill("catalog refresh");
  let releaseToggle!: () => void;
  let toggleReached = false;
  const toggleRelease = new Promise<void>((resolve) => { releaseToggle = resolve; });
  const holdToggle = async (route: Route) => { toggleReached = true; await toggleRelease; await route.continue(); };
  await page.route("**/api/pages/home/create-mode", holdToggle);
  const toggleResponse = gateWait.playwright(page, "waitForResponse", (response) => response.url().endsWith("/api/pages/home/create-mode"));
  const toggleClick = clickCreateMode(false);
  try {
    await waitFor(async () => toggleReached, "create mode toggle request");
    const pendingMode = modeSwitch(page, "create mode").and(page.locator('[aria-busy="true"]'));
    await gateWait.playwright(pendingMode, "waitFor", { state: "visible" });
    if (!(await pendingMode.isDisabled())) throw new Error("create mode toggle pending state was not disabled");
    await field.press("Enter");
  } finally {
    releaseToggle();
    try { await toggleClick; }
    finally { await page.unroute("**/api/pages/home/create-mode", holdToggle); }
  }
  const toggleResult = await toggleResponse;
  if (!toggleResult.ok()) throw new Error(`create mode toggle failed: ${toggleResult.status()}`);
  await waitCreateMode(true);
  if (screenshotDir) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await modeSwitch(page, "create mode", true).waitFor();
    const createPlace = page.getByRole("link", { name: "create", exact: true });
    if (new URL((await createPlace.getAttribute("href")) ?? "", origin).pathname !== "/create") throw new Error("contextual mode hid the separate create place link");
    await page.screenshot({ path: join(screenshotDir, "v5-chat-create-on-1440x900.png"), animations: "disabled" });
  }
  await waitFor(async () => (await catalogReady.count()) > catalogReadyBefore && ((JSON.parse(await Bun.file(control).text()).request_count ?? 0) > catalogRequestBefore), "catalog ready");
  if (pageIndexRequests.length !== pageRequestsBeforeStreamingTurn)
    throw new Error(`streaming turn made ${pageIndexRequests.length - pageRequestsBeforeStreamingTurn} extra /api/pages requests`);
  const backendSchemas = JSON.parse(await Bun.file(control).text()).schemas ?? [];
  if (!backendSchemas.includes("achilles__create_tool"))
    throw new Error(
      `backend did not receive achilles__create_tool catalog: ${JSON.stringify(backendSchemas)}`,
    );
  for (const [index, { path }] of surfaceRoutes.entries()) {
    const refused = await homeMcp(100 + index, "tools/call", {
      name: "create_page", arguments: { route: path, title: "reserved route probe", package: { source: "export default function Page(){return <main />}", dependencies: {} } },
    });
    if (!refused.result?.isError || (await fetch(`${origin}/api/pages${path}`)).status !== 404)
      throw new Error(`create_page did not refuse reserved route ${path}`);
  }
  const createApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "create_page" });
  const createApprovalBefore = await createApproval.count();
  const createRequestBefore = (JSON.parse(await Bun.file(control).text()).request_count ?? 0) as number;
  const annotationComplete = page.getByText("annotation complete", { exact: true });
  const annotationCompleteBefore = await annotationComplete.count();
  await field.fill("create page");
  await field.press("Enter");
  await waitFor(async () => (await createApproval.count()) > createApprovalBefore && ((JSON.parse(await Bun.file(control).text()).request_count ?? 0) > createRequestBefore), "create page approval").catch(async (error) => {
    throw new Error(
      `${error}\nbackend did not receive achilles__create_page catalog: ${await safeControl()}`,
    );
  });
  await createApproval.nth(createApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await waitFor(async () => (await annotationComplete.count()) > annotationCompleteBefore, "create page completion");
  await gateWait.playwright(page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^idle$/ }), "waitFor", { state: "attached", timeout: 20_000 });
  await page.getByRole("navigation", { name: "places" }).getByRole("link", { name: "pages", exact: true }).click();
  const pageSection = page.locator('.page-list[data-list-state="ready"]');
  await gateWait.playwright(pageSection, "waitFor");
  if (screenshotDir) {
    for (const [width, height] of [[1440, 900], [1440, 760], [390, 760]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(screenshotDir, `page-index-${width}x${height}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  const showMorePages = page.getByRole("button", { name: "show more pages" });
  await pageSection.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await gateWait.playwright(showMorePages, "waitFor", { state: "visible", timeout: 20000 }).catch(() => { throw new Error("show more pages is not visible in the page section"); });
  await showMorePages.focus();
  const pagesBeforeMore = Number(await page.locator(".page-list").getAttribute("data-loaded-count"));
  const morePagesResponse = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
  await page.keyboard.press("Enter");
  await waitForListChange(".page-list", pagesBeforeMore, morePagesResponse, "show more pages keyboard continuation");
  const secondBatchPage = page.locator('.page-list a[href^="/gate-page-27"]');
  await gateWait.playwright(secondBatchPage, "waitFor", { state: "visible", timeout: 20000 });
  await waitFor(async () => await secondBatchPage.evaluate((element) => document.activeElement === element), "focused first new page link");
  await secondBatchPage.click();
  await gateWait.playwright(page, "waitForURL", (url) => new URL(url).pathname === "/gate-page-27");
  await page.goto(`${origin}/pages`);
  await gateWait.playwright(pageSection, "waitFor");
  const readingLink = page.locator('.page-list a[href^="/reading"]');
  await gateWait.playwright(readingLink, "waitFor", { timeout: 20000 });
  const chatsBeforeReading = await chatCount();
  const sessionsBeforeReading = zetaSessionCount();
  await readingLink.click({ timeout: 20_000 });
  await gateWait.playwright(page, "waitForURL", (url) => new URL(url).pathname === "/reading", { timeout: 20_000 });
  // an agent-created page renders only its compiled React package
  await gateWait.playwright(page.locator(".page-frame"), "waitFor", { state: "visible", timeout: 20_000 }).catch(async (error) => {
    throw new Error(`${error}\ncreated page notice did not appear before chat creation: ${redact(await page.locator("body").innerText())}; errors=${redact(errors.join(" | "))}; console=${redact(consoleErrors.join(" | "))}`);
  });
  if ((await page.getByText("loading chat…", { exact: true }).count()) || await chatCount() !== chatsBeforeReading || zetaSessionCount() !== sessionsBeforeReading)
    throw new Error("created page notice did not appear before chat creation");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "created-page-before-first-send.png"), fullPage: true, timeout: 20_000 });
  // Let the selected-chat attach read the old title before the sidebar PATCH, but deliver it afterward.
  let heldAttach: { chatId: string; release: (deliver: boolean) => void } | undefined;
  const selectedCatalogue = (url: URL) => url.pathname === "/api/chats" && url.searchParams.get("limit") === "200" && url.searchParams.has("include");
  const holdSelectedAttach = async (route: Route) => {
    // Creation itself looks up the chat before it writes the chat to the address.
    const selected = new URL(page.url()).searchParams.get("chat");
    if (heldAttach || !selected || selected !== new URL(route.request().url()).searchParams.get("include")) return route.fallback();
    const response = await route.fetch({ timeout: 20_000 });
    const deliver = await new Promise<boolean>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("waiting for the gate to release the selected-chat catalogue")), 30_000);
      heldAttach = { chatId: selected, release: (value) => { clearTimeout(deadline); resolve(value); } };
    });
    if (deliver) await route.fulfill({ response }); else await route.abort();
  };
  await page.route(selectedCatalogue, holdSelectedAttach);
  try {
    await field.fill("open created page", { timeout: 20_000 });
    await field.press("Enter", { timeout: 20_000 });
    // A fast scripted reply can move from running to idle in one browser render.
    await waitFor(async () => JSON.parse(await Bun.file(control).text()).page_open_turn_barrier === "held", "held first page turn");
    await gateWait.playwright(page.locator(".run-state.state-running, .page-chat-readouts.state-running"), "waitFor", { timeout: 20_000 });
    const firstPageChat = await homeSessionId();
    await gateWait.playwright(page.locator(`[data-chat-id="${firstPageChat}"]`), "waitFor", { timeout: 20_000 });
    const mcpConfigPath = join(zetaHome, "mcp.json");
    const baselineMcp = await readFile(mcpConfigPath);
    const config = JSON.parse(baselineMcp.toString());
    const oauth = oauthFixture();
    try {
      await Bun.write(mcpConfigPath, JSON.stringify({ ...config, servers: { ...config.servers, ...oauth.config.servers } }));
      await refuseMcpOAuth(browser, origin);
    } finally {
      oauth.stop();
      await writeFile(mcpConfigPath, baselineMcp);
    }
    if (!zetaProcess.kill("SIGUSR2")) throw new Error("could not release the first page turn");
    await waitFor(async () => Boolean(heldAttach), "old selected-chat attach catalogue held");
    const { chatId, release } = heldAttach!;
    if (chatId !== firstPageChat || new URL(page.url()).searchParams.get("chat") !== firstPageChat) throw new Error("the page opened from /pages did not select the active chat after the first send");
    const row = page.locator(`[data-chat-id="${chatId}"]`);
    const currentRow = row.and(page.locator('[aria-current="page"]'));
    await gateWait.playwright(currentRow, "waitFor", { timeout: 20_000 });
    const title = "reading catalog notes";
    await currentRow.press("F2", { timeout: 20_000 });
    const input = row.getByRole("textbox", { name: /^rename / });
    await input.fill(title, { timeout: 20_000 });
    const patch = page.waitForResponse((reply) => new URL(reply.url()).pathname === `/api/chats/${chatId}` && reply.request().method() === "PATCH" && reply.request().postDataJSON()?.titled_by_user === true, { timeout: 20_000 });
    await input.press("Enter", { timeout: 20_000 });
    if (!(await patch).ok()) throw new Error("current row rename PATCH failed");
    await gateWait.playwright(row.getByText(title, { exact: true }), "waitFor", { timeout: 20_000 });
    const dockTitle = dockHead(page).getByText(title, { exact: true });
    await gateWait.playwright(dockTitle, "waitFor", { state: "visible" });
    const frameStart = requests().length;
    release(true);
    await waitFor(async () => {
      const frames = requests().slice(frameStart);
      const join = frames.findIndex((frame) => frame.method === "session_history_and_subscribe" && frame.params?.session_id === chatId);
      // The idle replay reads status after its join. Wait for the reply before checking the committed view.
      const status = join < 0 ? undefined : frames.slice(join + 1).find((frame) => frame.method === "status");
      return Boolean(status && frames.some((frame) => frame.id === status.id && frame.result));
    }, "released selected-chat attach finished replay");
    await gateWait.playwright(page.getByText("new page ready", { exact: true }), "waitFor", { timeout: 20_000 });
    await gateWait.playwright(page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^idle$/ }), "waitFor", { state: "attached", timeout: 20_000 });
    await gateWait.playwright(page, "waitForFunction", () => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))), undefined, { timeout: 20_000 });
    if (!await dockTitle.isVisible()) throw new Error(`stale attach reverted the visible dock title: ${await dockHead(page).locator("strong").innerText()}`);
    console.log("pages catalog: list and continuation opened dynamic pages; existing chat rename updated the row");
    console.log("forced title order: rename PATCH succeeded; stale attach released; visible dock title stayed renamed");
  } finally {
    heldAttach?.release(false);
    await page.unroute(selectedCatalogue, holdSelectedAttach);
  }
  if (screenshotDir) {
    const readingUrl = page.url();
    const oneChat = async (tab: Page, name: string) => {
      await setupMobileSheet(tab, 844, "button");
      await gateWait.playwright(dockHead(tab).getByRole("button", { name: /, 1 chat$/ }), "waitFor");
      await tab.screenshot({ path: join(screenshotDir, `s2-header-one-chat-${name}-390.png`), animations: "disabled" });
    };
    await oneChat(page, "controller");
    const oneChatObserver = await browser.newPage();
    try {
      await oneChatObserver.goto(readingUrl);
      await gateWait.playwright(oneChatObserver.locator(".observer-banner"), "waitFor");
      await oneChat(oneChatObserver, "observer");
    } finally { await oneChatObserver.close(); }
    await setupMobileSheet(page, 844);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  if (screenshotDir) {
    const captureInsets = async (width: number) => {
      const surface = page.locator(".page-chat-docked .page-chat-surface");
      const user = surface.locator('[data-part="message-content"]').filter({ hasText: /^open created page$/ });
      await gateWait.playwright(user, "waitFor", { state: "visible" });
      const insets = await surface.evaluate((node) => {
        const user = [...node.querySelectorAll('[data-part="message-content"]')].find((row) => row.textContent === "open created page")!.closest('[data-virtual-id]')!;
        const reply = [...node.querySelectorAll('[data-part="message"][data-role="assistant"]')].find((row) => row.textContent === "new page ready")!;
        const transcript = node.querySelector(".transcript")!;
        const left = node.getBoundingClientRect().left;
        return { user: user.getBoundingClientRect().left - left, reply: reply.getBoundingClientRect().left - left, transcript: transcript.getBoundingClientRect().left - left };
      });
      console.log(`page chat message insets at ${width}px: ${JSON.stringify(insets)}`);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `page-chat-transcript-${width}.png`), animations: "disabled" });
    };
    // Capture the narrow fixture via its manual opener; the focused resize is tested below.
    await field.evaluate((composer) => (composer as HTMLElement).blur());
    for (const width of [1280, 1440, 1920, 390]) {
      if (width === 390) {
        await setupMobileSheet(page, 844, "button");
      } else {
        await page.setViewportSize({ width, height: 900 });
      }
      await captureInsets(width);
    }
    await setupMobileSheet(page, 844);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  const resizeComposer = await field.elementHandle();
  if (!resizeComposer) throw new Error("page chat resize: no composer before resize");
  const resizeDraft = "draft survives resize";
  await field.fill(resizeDraft);
  await field.focus();
  for (const width of [1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const state = await resizeComposer.evaluate((composer) => ({ focused: document.activeElement === composer, active: document.activeElement?.tagName, draft: (composer as HTMLTextAreaElement).value }));
    if (!state.focused || state.draft !== resizeDraft)
      throw new Error(`page chat resize to ${width}px did not keep the same composer focused with its draft: ${JSON.stringify(state)}`);
  }
  await resizeComposer.dispose();
  await field.fill("");
  console.log("page chat resize kept the same composer focused and retained its draft in both directions");
  if (await chatCount() !== chatsBeforeReading + 1) throw new Error("first created-page send did not create exactly one chat");
  if (zetaSessionCount() !== sessionsBeforeReading + 1) throw new Error("first created-page send did not create exactly one zeta session");
  await page.goto(origin);
  await gateWait.playwright(field, "waitFor", { timeout: 20000 });
  const createdPage = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (createdPage.route !== "/reading") throw new Error("create_page did not create /reading");
  await gateWait.playwright(field, "waitFor", { timeout: 20_000 });
  const chatOne = await homeSessionId();
  if (!chatOne || chatOne !== first) throw new Error("create_page did not run in the first home chat");
  await page.keyboard.press(appShortcut("Shift+O"));
  await waitFor(async () => {
    const current = await homeSessionId();
    return Boolean(current && current !== chatOne);
  }, "new home chat after create_page");
  const chatTwo = await homeSessionId();
  if (!chatTwo) throw new Error("second home chat session id missing");
  const transcriptBeforeDiscovery = await page.locator('[data-part="message"]').count();
  await gateWait.playwright(page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^idle$/ }), "waitFor", { state: "attached", timeout: 20_000 });
  const discoveryPrompt = "list achilles resources, then inspect /reading";
  await field.fill(discoveryPrompt);
  await field.press("Enter");
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).inspect_turn_barrier === "held", "scripted inspect turn");
  const discoverySend = requests().find((frame) => frame.method === "send" && frame.params?.text === discoveryPrompt);
  if (discoverySend?.params?.session_id !== chatTwo)
    throw new Error(`new-chat discovery prompt did not start in ${chatTwo}: ${JSON.stringify(discoverySend)}`);
  zetaProcess.kill("SIGUSR1");
  const inspectApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "inspect_page" });
  await waitFor(async () => (await inspectApproval.count()) > 0, "inspect_page approval after scripted turn");
  await inspectApproval.getByRole("button", { name: "approve", exact: true }).click();
  await gateWait.playwright(page.getByText("new chat tools complete", { exact: true }), "waitFor", { timeout: 20_000 });
  await gateWait.playwright(page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^idle$/ }), "waitFor", { state: "attached", timeout: 20_000 });
  const newChatTranscript = await page.locator('[data-part="message"]').nth(transcriptBeforeDiscovery).innerText();
  if (newChatTranscript.includes("MCP server achilles is unavailable") || (await page.locator("body").innerText()).includes("MCP server achilles is unavailable"))
    throw new Error("new chat transcript reported achilles as unavailable after resources discovery");
  const discoveryControl = JSON.parse(await Bun.file(control).text());
  if (!discoveryControl.tool_results?.some((result: { call_id: string; is_error: boolean }) => result.call_id === "discover-resources" && !result.is_error))
    throw new Error(`mcp_discover resources call did not succeed: ${await safeControl()}`);
  if (!discoveryControl.tool_results?.some((result: { call_id: string; is_error: boolean }) => result.call_id === "inspect-after-discovery" && !result.is_error))
    throw new Error(`achilles inspect_page call did not succeed after resources discovery: ${await safeControl()}`);
  console.log(`two-chat page tools asserted: ${chatOne} created /reading; ${chatTwo} discovered resources and inspected it`);
  const homeInspect = await homeMcp(11, "tools/call", {
    name: "inspect_page",
    arguments: { route: "/reading" },
  });
  const homeInspectValue = JSON.parse(homeInspect.result?.content?.[0]?.text ?? "{}");
  if (
    homeInspect.result?.isError ||
    homeInspectValue.route !== "/reading" ||
    homeInspectValue.tools?.[0]?.name !== "add_book" ||
    JSON.stringify(homeInspectValue).includes("credentials") ||
    JSON.stringify(homeInspectValue).includes(achillesHome)
  )
    throw new Error(`home inspect_page summary mismatch: ${JSON.stringify(homeInspectValue)}`);
  const theme = process.env.GATE_THEME ?? "g1-dark";
  await page.goto(`${origin}/reading?theme=${encodeURIComponent(theme)}`);
  const themeProof = await page.evaluate(() => ({ requested: new URL(location.href).searchParams.get("theme"), applied: document.documentElement.dataset.achillesTheme ?? "auto" }));
  if (themeProof.applied !== theme) throw new Error(`requested theme ${theme} was not applied: ${JSON.stringify(themeProof)}`);
  if (screenshotDir) await writeFile(join(screenshotDir, "run-proof.txt"), [
    `private temp homes: true`,
    `external competing controller attached: false`,
    `gate-owned shared controller pid: ${sharedProcess.pid ?? "unknown"}`,
    `gate-owned achilles controller pid: ${zetaProcess.pid ?? "unknown"}`,
    `requested theme: ${themeProof.requested}`,
    `applied theme: ${themeProof.applied}`,
    `390 capture: reload, mobile drawer open, settled before screenshot`,
    `raw capture: arguments truncated by zeta marker asserted in the rendered disclosure`,
  ].join("\n") + "\n");
  await gateWait.playwright(field, "waitFor", { timeout: 20000 });

  await page.setViewportSize({ width: 1440, height: 1400 });
  const desktopViewport = page.viewportSize();
  const assertClosedFrame = async (viewport: string) => {
    const frame = await page.evaluate(() => {
      const describe = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { visibility: style.visibility, transform: style.transform, display: style.display, rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } };
      };
      const target = document.querySelector<HTMLElement>(".page-frame");
      const targetBox = target?.getBoundingClientRect();
      const point = targetBox ? { x: (Math.max(0, targetBox.left) + Math.min(innerWidth, targetBox.right)) / 2, y: (Math.max(0, targetBox.top) + Math.min(innerHeight, targetBox.bottom)) / 2 } : null;
      const hit = point ? document.elementFromPoint(point.x, point.y) : null;
      const overlays = [".page-chat-bar", ".page-chat-drawer", ".page-chat-backdrop", ".page-chat-surface"].flatMap((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        const rect = element?.getBoundingClientRect();
        return element && rect && rect.width > 0 && rect.height > 0 ? [{ selector, rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } }] : [];
      });
      const intersects = (left: DOMRect, right: { top: number; right: number; bottom: number; left: number }) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        bar: document.querySelector<HTMLElement>(".page-chat-bar")?.getAttribute("aria-expanded"),
        surface: describe(".page-chat-surface"),
        drawer: describe(".sidebar"),
        target: targetBox && { top: targetBox.top, right: targetBox.right, bottom: targetBox.bottom, left: targetBox.left, width: targetBox.width, height: targetBox.height },
        targetHit: Boolean(hit && target && (hit === target || target.contains(hit))),
        overlayCoversTarget: Boolean(targetBox && overlays.some(({ rect }) => intersects(targetBox, rect))),
        scroll: { window: scrollY, content: target?.scrollTop ?? -1 },
        overlays,
      };
    });
    if (frame.viewport.width !== 390 || frame.viewport.height !== 844)
      throw new Error(`closed frame has wrong viewport: ${JSON.stringify(frame)}`);
    if (frame.bar !== "false" || frame.surface?.visibility !== "hidden" || frame.surface.transform === "matrix(1, 0, 0, 1, 0, 0)" || !frame.drawer || frame.drawer.rect.right > 0 || frame.drawer.transform === "matrix(1, 0, 0, 1, 0, 0)")
      throw new Error(`closed frame overlays are not hidden and offscreen: ${JSON.stringify(frame)}`);
    if (!frame.target || !frame.targetHit || frame.overlayCoversTarget || frame.scroll.window !== 0 || frame.scroll.content !== 0)
      throw new Error(`closed frame target is not visible and unobscured: ${JSON.stringify(frame)}`);
  };
  await capturePageState("page-chat-closed", page.locator(".page-frame"), 844, 900, async (viewport) => {
    if (viewport === "390px") {
      await assertClosedFrame(viewport);
      return;
    }
    const dock = await page.locator(".page-view.docked").evaluate((grid) => {
      const pane = grid.querySelector<HTMLElement>(":scope > .page-frame")!;
      const rail = grid.querySelector<HTMLElement>(":scope > .page-chat")!;
      return {
        tracks: getComputedStyle(grid).gridTemplateColumns,
        paneWidth: pane.getBoundingClientRect().width,
        railWidth: rail.getBoundingClientRect().width,
        divider: getComputedStyle(rail).borderLeftWidth,
        modal: Boolean(rail.querySelector('[role="dialog"], [aria-modal], .page-chat-backdrop, [aria-label="close page chat"]')),
        composers: rail.querySelectorAll("#message-composer").length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    if (dock.tracks !== `${dock.paneWidth}px 360px` || dock.railWidth !== 360 || dock.divider !== "1px" || dock.modal || dock.composers !== 1 || dock.overflow)
      throw new Error(`${viewport} page chat has incorrect dock geometry: ${JSON.stringify(dock)}`);
    console.log(`${viewport} page chat dock: ${JSON.stringify(dock)}`);
  });
  await setupMobileSheet(page, 760);
  const pageChatBar = page.locator(".page-chat-bar");
  await gateWait.playwright(pageChatBar, "waitFor", { state: "visible" });
  if (await pageChatBar.getAttribute("aria-expanded") !== "false") throw new Error(`page chat was not closed after matrix: ${JSON.stringify(await pageChatLayout())}`);
  const closedGeometry = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".page-chat-bar")?.getBoundingClientRect();
    const action = document.querySelector<HTMLElement>(".page-frame")?.getBoundingClientRect();
    return { barBottom: bar?.bottom ?? 0, barHeight: bar?.height ?? 0, actionBottom: action?.bottom ?? 0, viewport: innerHeight };
  });
  if (closedGeometry.actionBottom > closedGeometry.viewport - closedGeometry.barHeight + 1)
    throw new Error(`390px page content is under the closed page chat bar: ${JSON.stringify(closedGeometry)}`);
  await page.reload();
  await setupMobileSheet(page, 760, "button");
  await setupMobileSheet(page, 760, "resize");
  await setupMobileSheet(page, 760, "keyboard");
  const pageChatDialog = page.getByRole("dialog", { name: "page chat" });
  const backdropTabIndex = await page.locator(".page-chat-backdrop").evaluate((element) => (element as HTMLElement).tabIndex);
  if (backdropTabIndex >= 0) throw new Error(`page chat backdrop is in sequential focus order: tabIndex=${backdropTabIndex}`);
  await page.keyboard.press("Tab");
  if (!await pageChatDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
    throw new Error("390px page chat real Tab escaped the modal sheet");
  if (await page.locator(".page-chat-backdrop").evaluate((element) => element === document.activeElement))
    throw new Error("390px page chat real Tab focused the backdrop");
  const timelineHeight = await page.locator(".page-chat-surface .transcript").evaluate((element) => element.clientHeight);
  if (timelineHeight <= 0) throw new Error(`390px page chat timeline has no usable height: ${timelineHeight}`);
  await page.keyboard.press("ControlOrMeta+Comma");
  const nativeSettings = page.getByRole("dialog", { name: "settings" });
  await gateWait.playwright(nativeSettings, "waitFor", { state: "visible" });
  const nativeInitial = nativeSettings.locator("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])").first();
  await nativeInitial.focus();
  await nativeInitial.evaluate((node) => { if (document.activeElement !== node) throw new Error("settings initial focus was not stable"); });
  const nativeBeforeTabHandle = await page.evaluateHandle(() => document.activeElement);
  const nativeBeforeTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  await page.keyboard.press("Tab");
  const nativeAfterTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  if (!(await nativeSettings.evaluate((dialog) => dialog.contains(document.activeElement)))) throw new Error(`native settings Tab did not advance inside the page chat sheet: before=${JSON.stringify(nativeBeforeTab)} active=${JSON.stringify(nativeAfterTab)}`);
  if (await nativeBeforeTabHandle.evaluate((node) => node === document.activeElement)) throw new Error(`native settings focus did not advance in the page chat sheet: before=${JSON.stringify(nativeBeforeTab)} active=${JSON.stringify(nativeAfterTab)}`);
  const nativeAfterTabHandle = await page.evaluateHandle(() => document.activeElement);
  await page.keyboard.press("Shift+Tab");
  const nativeAfterShiftTab = await page.evaluate(() => ({ name: document.activeElement?.getAttribute("aria-label"), id: document.activeElement?.id, outerHTML: document.activeElement?.outerHTML }));
  if (!await nativeSettings.evaluate((dialog) => dialog.contains(document.activeElement)) || await nativeAfterTabHandle.evaluate((node) => node === document.activeElement)) throw new Error(`native settings reverse Tab did not advance inside the page chat sheet: before=${JSON.stringify(nativeBeforeTab)} afterTab=${JSON.stringify(nativeAfterTab)} active=${JSON.stringify(nativeAfterShiftTab)}`);
  await page.keyboard.press("Escape");
  await gateWait.playwright(nativeSettings, "waitFor", { state: "hidden" });
  const pageChatLast = page.locator(".page-chat-surface button:not(:disabled), .page-chat-surface a[href], .page-chat-surface input:not(:disabled), .page-chat-surface textarea:not(:disabled), .page-chat-surface [tabindex]:not([tabindex='-1'])").last();
  await pageChatLast.focus();
  await page.keyboard.press("Tab");
  if (!(await pageChatDialog.evaluate((dialog) => dialog.contains(document.activeElement)))) throw new Error("page chat focus trap did not resume after native settings closed");
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))))
      throw new Error("390px page chat tab focus escaped the modal sheet");
  }
  await pageChatDialog.evaluate((dialog) => Promise.all(dialog.getAnimations().map((animation) => animation.finished)));
  const backgroundControl = page.locator(".page-frame").first();
  const backgroundControlBox = await backgroundControl.boundingBox();
  if (!backgroundControlBox) throw new Error("background chat control was not measurable behind page chat sheet");
  // wait for the sheet's own transition, not an arbitrary delay: a click during the
  // transition can use a stale box and miss the native dialog backdrop.
  await pageChatDialog.evaluate((dialog) => Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const outsideClick = await pageChatDialog.evaluate((dialog, box) => {
    const rect = dialog.getBoundingClientRect();
    const surface = document.querySelector<HTMLElement>(".page-chat-surface")?.getBoundingClientRect();
    const point = { x: box.x + box.width / 2, y: (surface?.top ?? 0) - 1 };
    const hit = document.elementFromPoint(point.x, point.y);
    const animations = dialog.getAnimations({ subtree: true }).map((animation) => ({ playState: animation.playState, currentTime: animation.currentTime }));
    return {
      error: null,
      point,
      hit: hit ? { tag: hit.tagName, id: hit.id, className: hit.className, backdrop: hit.matches(".page-chat-backdrop"), backgroundControl: Boolean(hit.closest(".page-frame")) } : null,
      dialog: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, modal: dialog.matches(":modal") },
      surface: surface ? { left: surface.left, top: surface.top, right: surface.right, bottom: surface.bottom } : null,
      animations,
    };
  }, backgroundControlBox);
  if (outsideClick.error || !outsideClick.point || !outsideClick.surface || !outsideClick.hit?.backdrop || outsideClick.animations.some(({ playState }) => playState !== "finished"))
    throw new Error(`page chat backdrop was not ready for outside click: ${JSON.stringify(outsideClick)}`);
  const { point } = outsideClick;
  if (point.x > outsideClick.surface.left && point.x < outsideClick.surface.right && point.y > outsideClick.surface.top && point.y < outsideClick.surface.bottom)
    throw new Error(`page chat backdrop click point landed inside the sheet: ${JSON.stringify(outsideClick)}`);
  const pathBeforeOutsideClick = new URL(page.url()).pathname;
  await page.evaluate(() => {
    const backdrop = document.querySelector<HTMLButtonElement>(".page-chat-backdrop");
    if (!backdrop) throw new Error("page chat backdrop disappeared before click");
    (window as typeof window & { __pageChatBackdropClick?: { target: string; backdrop: boolean } }).__pageChatBackdropClick = { target: "", backdrop: false };
    backdrop.addEventListener("click", (event) => {
      const state = (window as typeof window & { __pageChatBackdropClick?: { target: string; backdrop: boolean } }).__pageChatBackdropClick;
      if (!state) return;
      state.target = (event.target as Element).tagName;
      state.backdrop = event.target === backdrop;
    }, { once: true });
  });
  await page.mouse.click(point.x, point.y);
  const backdropClick = await page.evaluate(() => {
    const state = (window as typeof window & { __pageChatBackdropClick?: { target: string; backdrop: boolean } }).__pageChatBackdropClick;
    delete (window as typeof window & { __pageChatBackdropClick?: unknown }).__pageChatBackdropClick;
    return state;
  });
  if (!backdropClick?.backdrop)
    throw new Error(`page chat outside click did not target the backdrop: ${JSON.stringify({ outsideClick, backdropClick })}`);
  await gateWait.playwright(pageChatDialog, "waitFor", { state: "hidden" });
  if (new URL(page.url()).pathname !== pathBeforeOutsideClick)
    throw new Error("background chat control activated through open page chat sheet");
  await setupMobileSheet(page, 760, "button");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "page-chat-open-390x760.png"), fullPage: true });
  await field.fill("sb7 page stream");
  await field.press("Enter");
  await waitFor(async () => (await page.locator(".page-chat-surface").innerText()).includes("sb7 stream line 119"), "sb7 stream line 119");
  const insetGeometry = await page.evaluate(() => {
    const transcript = [...document.querySelectorAll<HTMLElement>('.page-chat-surface [data-part="message"]')].find((element) => element.textContent?.includes("sb7 stream line 119"));
    const title = document.querySelector<HTMLElement>("#page-chat-title");
    const composer = document.querySelector<HTMLElement>('.page-chat-surface [data-part="composer"]');
    const transcriptBox = transcript?.getBoundingClientRect();
    const titleBox = title?.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect();
    return { transcriptLeft: transcriptBox?.left ?? null, titleLeft: titleBox?.left ?? null, composerLeft: composerBox?.left ?? null, composerRight: composerBox?.right ?? null };
  });
  if (insetGeometry.transcriptLeft === null || insetGeometry.titleLeft === null || Math.abs(insetGeometry.transcriptLeft - insetGeometry.titleLeft) > 1)
    throw new Error(`390px open page chat transcript content is not aligned with the sheet title: ${JSON.stringify(insetGeometry)}`);
  if (insetGeometry.composerLeft === null || insetGeometry.composerRight === null || insetGeometry.titleLeft === null || Math.abs(insetGeometry.composerLeft - insetGeometry.titleLeft) > 1 || Math.abs(insetGeometry.composerRight - (390 - insetGeometry.titleLeft)) > 1)
    throw new Error(`390px open page chat composer outer gutter is not aligned with the sheet title: ${JSON.stringify(insetGeometry)}`);
  const streamProof = await page.locator(".page-chat-surface").evaluate((surface) => {
    const text = surface.textContent ?? "";
    const lines = text.match(/sb7 stream line \d{3}/g) ?? [];
    const scroll = surface.querySelector<HTMLElement>('[data-part="timeline-scroll"]');
    const gap = scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : -1;
    const expected = Array.from({ length: 120 }, (_, index) => `sb7 stream line ${String(index).padStart(3, "0")}`);
    return { lines: lines.length, orderedUnique: lines.length === expected.length && lines.every((line, index) => line === expected[index]) && new Set(lines).size === lines.length, first: text.includes("sb7 stream line 000"), last: text.includes("sb7 stream line 119"), lastVisible: gap <= 1, gap };
  });
  if (streamProof.lines !== 120 || !streamProof.orderedUnique || !streamProof.first || !streamProof.last || !streamProof.lastVisible || streamProof.gap > 1)
    throw new Error(`390px page chat did not retain and follow all 120 chunks: ${JSON.stringify(streamProof)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "page-chat-last-chunk-open-390x760.png"), fullPage: true });
  await setupMobileSheet(page, 760);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "page-chat-closed-after-stream-390x760.png"), fullPage: true });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  const readingSessionId = await homeSessionId();
  if (!readingSessionId || readingSessionId === first)
    throw new Error("reading page did not get its own zeta session");
  const addBookApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "add_book" });
  const bookAdded = page.getByText("book added", { exact: true });
  await field.fill("add Synthetic Book");
  await field.press("Enter");
  await gateWait.playwright(addBookApproval, "waitFor", { timeout: 20000 }).catch(async (error) => {
    throw new Error(
      `${error}\nbackend=${await safeControl()}\nzeta-log=${redact(logs.get(zetaProcess) ?? "")}\nachilles-log=${redact(logs.get(app) ?? "")}`,
    );
  });
  await addBookApproval.getByRole("button", { name: "approve", exact: true }).click();
  await gateWait.playwright(bookAdded, "waitFor", { timeout: 20000 });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "tool-summary-single-record-1440.png"), fullPage: true });
  const readingModeResponse = gateWait.playwright(page, "waitForResponse", (response) => response.url().endsWith(`/api/pages/${createdPage.id}/create-mode`));
  await clickCreateMode(false);
  if (!(await readingModeResponse).ok()) throw new Error("reading page create mode toggle failed");
  await waitCreateMode(true);

  const readingCredential = (
    await Bun.file(join(achillesHome, "credentials", createdPage.id)).text()
  ).trim();
  secrets.push(readingCredential);
  await mcp(readingCredential, 200, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "gate", version: "1" },
  });
  const codeWrite = await mcp(readingCredential, 201, "tools/call", {
    name: "write_page",
    arguments: {
      source: 'import { createRoot } from "react-dom/client"; function Page(){return <main>revision two</main>} createRoot(document.getElementById("root")!).render(<Page />);',
      dependencies: {},
      expected_revision: 1,
    },
  });
  if (codeWrite.result?.isError || JSON.parse(codeWrite.result?.content?.[0]?.text ?? "{}").revision !== 2)
    throw new Error(`code write before restore failed: ${JSON.stringify(codeWrite)}`);
  const codeRestore = await mcp(readingCredential, 202, "tools/call", {
    name: "restore_version",
    arguments: { kind: "code", version: 1, expected_version: 2 },
  });
  const restoredCode = JSON.parse(codeRestore.result?.content?.[0]?.text ?? "{}");
  if (codeRestore.result?.isError || restoredCode.revision !== 3 || restoredCode.restored_from !== 1)
    throw new Error(`code restore failed: ${JSON.stringify(codeRestore)}`);

  const readingModeOffResponse = gateWait.playwright(page, "waitForResponse", (response) => response.url().endsWith(`/api/pages/${createdPage.id}/create-mode`));
  await clickCreateMode(true);
  if (!(await readingModeOffResponse).ok()) throw new Error("reading page create mode reset failed");
  await waitCreateMode(false);

  await page.goto(origin);
  await gateWait.playwright(field, "waitFor", { timeout: 20000 });
  // `/` opens the newest home chat, not the home chat: the sends below run in it and must not move page.zeta_session_id
  const newestHome = await newestChatId("home");
  if (!newestHome || newestHome === first || await homeSessionId() !== newestHome) throw new Error(`/ did not open the most recent home chat: ${newestHome} shown ${await homeSessionId()}`);
  const catalog = await homeMcp(2, "tools/list", {});
  const names =
    catalog.result?.tools?.map(
      (tool: { name: string }) => `achilles__${tool.name}`,
    ) ?? [];
  if (
    !names.includes("achilles__create_page") ||
    !names.includes("achilles__create_tool")
  )
    throw new Error(
      `missing achilles__create_tool catalog assertion: ${JSON.stringify(names)}`,
    );
  const createToolSchema = catalog.result?.tools?.find(
    (tool: { name: string }) => tool.name === "create_tool",
  )?.inputSchema;
  const bundleSchema = createToolSchema?.properties?.bundle;
  const implementationSchema = bundleSchema?.properties?.implementation;
  if (
    bundleSchema?.additionalProperties !== false ||
    !Array.isArray(bundleSchema?.required) ||
    JSON.stringify(implementationSchema?.properties?.operation?.enum) !==
      JSON.stringify(["list", "get", "insert", "update"])
  )
    throw new Error("create_tool catalog does not expose the declarative bundle shape");
  const toolBundle = {
    format_version: 1,
    kind: "data_operation",
    name: "annotate_trace",
    description: "add an annotation",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, id: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    implementation: {
      operation: "insert",
      collection: "trace_annotations",
      data_schema: {
        type: "object",
        properties: { text: { type: "string" }, id: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  };
  const generated = await homeMcp(7, "tools/call", {
    name: "create_tool",
    arguments: { bundle: toolBundle },
  });
  if (generated.result?.isError)
    throw new Error(`create_tool failed: ${JSON.stringify(generated)}`);
  await homeMcp(8, "tools/list", {});
  const sessionBeforeToolTurn = await homeSessionId();
  const controlBeforeTool = JSON.parse(await Bun.file(control).text());
  const pidBeforeToolTurn = controlBeforeTool.pid;
  const resumesBeforeToolTurn = requests().filter(
    (frame) => frame.method === "resume" || frame.method === "new_session",
  ).length;
  const annotationApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "annotate_trace" });
  const annotationApprovalBefore = await annotationApproval.count();
  const generatedAnnotationCompleteBefore = await annotationComplete.count();
  await field.fill("annotate from the live zeta session");
  await field.press("Enter");
  await waitFor(async () => {
    const state = JSON.parse(await Bun.file(control).text());
    return state.request_count > (controlBeforeTool.request_count ?? 0) && state.last_message.includes("annotate from the live zeta session");
  }, "generated tool backend request");
  const nextTurnCatalog = JSON.parse(await Bun.file(control).text());
  if (!nextTurnCatalog.schemas.includes("achilles__annotate_trace"))
    throw new Error(`backend did not receive generated tool catalog: ${JSON.stringify(nextTurnCatalog.schemas)}`);
  // the seeded home page reads its records through the sandboxed frame bridge
  const homeFrame = page.frameLocator('iframe[title="custom page"]');
  await gateWait.playwright(homeFrame.getByText("trace annotations: none", { exact: true }), "waitFor", { state: "visible", timeout: 20000 });
  await waitFor(async () => (await annotationApproval.count()) > annotationApprovalBefore, "annotation approval").catch(async (error) => {
    throw new Error(
      `${error}\nannotation approval missing: backend=${await safeControl()} zeta-log=${redact(logs.get(zetaProcess) ?? "")}`,
    );
  });
  await annotationApproval.nth(annotationApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await waitFor(async () => (await annotationComplete.count()) > generatedAnnotationCompleteBefore, "generated tool completion").catch(async (error) => {
      throw new Error(
        `${error}\nbackend=${await safeControl()}\nzeta-log=${redact(logs.get(zetaProcess) ?? "")}\nachilles-log=${redact(logs.get(app) ?? "")}`,
      );
    });
  if ((await homeSessionId()) !== sessionBeforeToolTurn)
    throw new Error("generated tool turn changed the home session id");
  const controlAfterTool = JSON.parse(await Bun.file(control).text());
  if (controlAfterTool.pid !== pidBeforeToolTurn)
    throw new Error("generated tool turn changed the zeta server pid");
  const resumesAfterToolTurn = requests().filter(
    (frame) => frame.method === "resume" || frame.method === "new_session",
  ).length;
  if (resumesAfterToolTurn !== resumesBeforeToolTurn)
    throw new Error("generated tool turn remounted or resumed the zeta session");
  if (!controlAfterTool.schemas.includes("achilles__annotate_trace"))
    throw new Error(
      `backend did not receive generated tool catalog: ${JSON.stringify(controlAfterTool.schemas)}`,
    );
  const annotationResult = controlAfterTool.tool_results?.find(
    (result: { call_id: string }) => result.call_id === "annotate",
  );
  if (!annotationResult || annotationResult.is_error)
    throw new Error(`generated tool result was missing or failed: ${JSON.stringify(controlAfterTool.tool_results)}`);
  await gateWait.playwright(homeFrame.getByText("trace annotations: from zeta", { exact: true }), "waitFor", { timeout: 20000 });
  // a page write needs no click approval: the frame inserts through the bridge with the page credential
  await homeFrame.getByRole("button", { name: "add frame note", exact: true }).click();
  await gateWait.playwright(homeFrame.getByText("frame notes: from the frame", { exact: true }), "waitFor", { timeout: 20000 });
  const frameNotes = await (await fetch(`${origin}/api/pages/home/records/frame_notes`, { headers: { Authorization: `Bearer ${credential}` } })).json();
  if (!Array.isArray(frameNotes) || frameNotes.length !== 1 || frameNotes[0].text !== "from the frame") throw new Error(`frame insert did not store one record: ${JSON.stringify(frameNotes)}`);
  console.log("compiled home page listed a tool-written record and stored a frame-written record");
  const homeRecords = await (
    await fetch(`${origin}/api/pages/home/records/trace_annotations`, {
      headers: { Authorization: `Bearer ${credential}` },
    })
  ).json();
  if (!Array.isArray(homeRecords) || homeRecords.length !== 1)
    throw new Error(
      `expected exactly one page-scoped record, got ${JSON.stringify(homeRecords)} backend=${await safeControl()} zeta-log=${redact(logs.get(zetaProcess) ?? "")} body=${redact(await page.locator("body").innerText())}`,
    );
  await waitForIdleTurn(page, waitFor);
  const createdPageId = createdPage.id;
  const secondCredential = (
    await Bun.file(join(achillesHome, `credentials/${createdPageId}`)).text()
  ).trim();
  secrets.push(secondCredential);
  await mcp(secondCredential, 9, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "gate", version: "1" },
  });
  const secondCatalog = await mcp(secondCredential, 10, "tools/list", {});
  const secondNames =
    secondCatalog.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
  if (JSON.stringify(secondNames) !== JSON.stringify(["inspect_page", "add_book", "list_books", "update_book"]))
    throw new Error(`reading page tools were not created atomically: ${JSON.stringify(secondNames)}`);
  const secondRecords = await (
    await fetch(`${origin}/api/pages/${createdPageId}/records/books`, {
      headers: { Authorization: `Bearer ${secondCredential}` },
    })
  ).json();
  if (secondRecords.length !== 1 || !secondRecords.some((record: { title?: string }) => record.title === "Synthetic Book"))
    throw new Error(`reading page did not retain its book: ${JSON.stringify(secondRecords)}`);

  if (createdPage.route !== "/reading") throw new Error("created page route changed");
  const versionTwo = {
    ...toolBundle,
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, label: { type: "string" } },
      required: ["text", "label"],
      additionalProperties: false,
    },
  };
  const updated = await homeMcp(12, "tools/call", {
    name: "create_tool",
    arguments: { bundle: versionTwo },
  });
  if (updated.result?.isError)
    throw new Error(`tool version update failed: ${JSON.stringify(updated)}`);
  await field.fill("observe version two");
  await field.press("Enter");
  await gateWait.playwright(page.getByText("v2 turn", { exact: true }), "waitFor", { timeout: 20000 });
  await waitForIdleTurn(page, waitFor);
  const v2Control = JSON.parse(await Bun.file(control).text());
  const v2Schemas = v2Control.schemas ?? [];
  if (!v2Schemas.some((name: string) => name === "achilles__annotate_trace"))
    throw new Error("live session did not see generated tool version two");
  const v2Schema = v2Control.schema_documents.find(
    (schema: { name: string }) => schema.name === "achilles__annotate_trace",
  );
  const rollback = await fetch(
    `${origin}/api/pages/home/tools/annotate_trace/rollback`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${credential}`,
        Origin: origin,
      },
      body: JSON.stringify({ version: 1, expected_version: 2 }),
    },
  );
  if (!rollback.ok) throw new Error(`rollback failed: ${rollback.status}`);
  await Bun.sleep(500);
  await field.fill("observe rollback");
  await field.press("Enter");
  await gateWait.playwright(page.getByText("rollback turn", { exact: true }), "waitFor", { timeout: 20000 });
  const rollbackControl = JSON.parse(await Bun.file(control).text());
  const rollbackSchemas = rollbackControl.schemas ?? [];
  if (
    !rollbackSchemas.some((name: string) => name === "achilles__annotate_trace")
  )
    throw new Error("live session lost generated tool after rollback");
  const rollbackSchema = rollbackControl.schema_documents.find(
    (schema: { name: string }) => schema.name === "achilles__annotate_trace",
  );
  if (JSON.stringify(rollbackSchema) === JSON.stringify(v2Schema))
    throw new Error("rollback did not change the live generated schema");
  const allowPage = await homeMcp(15, "tools/call", {
    name: "create_page",
    arguments: { route: "/allow", title: "allow mode" },
  });
  if (allowPage.result?.isError || (await fetch(`${origin}/api/pages/allow`)).status !== 200)
    throw new Error(`could not create allow-mode gate page: ${JSON.stringify(allowPage)}`);
  await page.goto(`${origin}/allow`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  await page.setViewportSize({ width: 390, height: 760 });
  const shellChat = page.locator(".page-chat");
  const shellComposer = page.locator('[data-part="composer"] textarea[aria-label="message"]');
  const shellGeometry = await page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>(".page-chat");
    const transcript = chat?.querySelector<HTMLElement>(".transcript");
    const composer = document.querySelector<HTMLElement>('[data-part="composer"]');
    return {
      chatClass: chat?.className ?? "",
      transcriptHeight: transcript?.getBoundingClientRect().height ?? 0,
      composerVisible: Boolean(composer && getComputedStyle(composer).display !== "none" && composer.getBoundingClientRect().height > 0),
      barCount: document.querySelectorAll(".page-chat-bar").length,
      dialogCount: document.querySelectorAll('.page-chat [role="dialog"]').length,
    };
  });
  if (!(await shellChat.count()) || !shellGeometry.chatClass.includes("page-chat-docked") || shellGeometry.transcriptHeight <= 0 || !shellGeometry.composerVisible || shellGeometry.barCount !== 1 || shellGeometry.dialogCount !== 1 || !(await shellComposer.isVisible()) || await shellComposer.isDisabled())
    throw new Error(`390px page chat lost its mobile sheet geometry: ${JSON.stringify(shellGeometry)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "page-chat-390x760.png"), fullPage: true });
  await page.getByRole("button", { name: "close page chat" }).click();
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  const off = await fetch(`${origin}/api/pages/home/create-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  if (!off.ok) throw new Error(`create mode off failed: ${off.status}`);
  const homeAfterOff = (await (await fetch(`${origin}/api/pages/home`)).json())
    .zeta_session_id;
  if (homeAfterOff !== first)
    throw new Error("create-mode toggle changed home session id");
  const lateCreateTool = await homeMcp(13, "tools/call", { name: "create_tool", arguments: { bundle: toolBundle } });
  if (!lateCreateTool.result?.isError) throw new Error("late create_tool call was accepted");
  const late = await homeMcp(4, "tools/call", {
    name: "create_page",
    arguments: {
      route: "/late",
      title: "late",
      package: { source: "export default function Page(){return <main>late</main>}", dependencies: {} },
    },
  });
  if (!late.result?.isError || (await fetch(`${origin}/api/pages/late`)).status !== 404) throw new Error("late create_page call mutated state");

  const reconnectOn = await fetch(`${origin}/api/pages/home/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  if (!reconnectOn.ok) throw new Error(`reconnect create mode on failed: ${reconnectOn.status}`);
  const homeAfterCreate = (await (await fetch(`${origin}/api/pages/home`)).json()).zeta_session_id;
  let reconnectPage = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (reconnectPage.zeta_session_id !== readingSessionId || readingSessionId === homeAfterCreate) throw new Error("reading page session changed before reopen");
  await page.goto(`${origin}/reading`); await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  reconnectPage = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (reconnectPage.zeta_session_id !== readingSessionId) throw new Error("reading page session changed after reopen");
  await gateWait.playwright(page.locator(".page-frame"), "waitFor", { state: "visible", timeout: 20_000 });
  const homeOpened = await newestChatId("home");
  if (!homeOpened) throw new Error("no listed home chat before achilles restart");
  const homeIdleWrite = gateWait.playwright(page, "waitForResponse", (response) => {
    if (response.request().method() !== "PATCH" || requestPath(response.url()) !== `/api/chats/${encodeURIComponent(homeOpened)}`) return false;
    try { return JSON.parse(response.request().postData() ?? "null")?.last_state === "idle"; } catch { return false; }
  }).catch(() => { throw new Error("missing home idle state write before achilles restart"); });
  await page.goto(origin);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  await page.locator('[data-part="timeline-scroll"]').evaluate((element) => { element.scrollTop = 0; });
  await gateWait.playwright(page.locator('[data-part="message"]').first(), "waitFor", { timeout: 20_000 }).catch(() => { throw new Error("reconnected home did not render prior transcript content"); });
  if (!(await homeIdleWrite).ok()) throw new Error("home idle state write failed before achilles restart");
  const zetaPidBeforeRestart = JSON.parse(await Bun.file(control).text()).pid;
  let failedToggleFinished = false;
  const failToggle = async (route: Route) => {
    await route.fulfill({ status: 503, body: "unavailable" });
    failedToggleFinished = true;
  };
  await page.route("**/api/pages/home/create-mode", failToggle);
  const failedToggleClick = clickCreateMode(true);
  try { await waitFor(async () => failedToggleFinished, "failed create mode toggle request"); }
  finally {
    try { await failedToggleClick; }
    finally { await page.unroute("**/api/pages/home/create-mode", failToggle); }
  }
  const toggleAlert = page.locator(".create-mode-alert").filter({ hasText: "could not update create mode" });
  await gateWait.playwright(toggleAlert, "waitFor", { state: "visible" });
  const retryToggle = toggleAlert.getByRole("button", { name: "retry", exact: true });
  if (!(await retryToggle.isVisible())) throw new Error("create mode error retry was not visible above the transcript");
  await retryToggle.click();
  await waitCreateMode(false);
  app.kill("SIGTERM");
  await new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app = await startAchilles(appEnv, "achilles restart");
  const homeAfterRestart = (await (await fetch(`${origin}/api/pages/home`)).json()).zeta_session_id;
  const createdAfterRestart = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (homeAfterRestart !== homeAfterCreate || createdAfterRestart.zeta_session_id !== reconnectPage.zeta_session_id) throw new Error("page sessions changed across achilles restart");
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  if (await homeSessionId() !== homeOpened) throw new Error("achilles restart changed the open home chat");
  await awaitApprovalMode("session_settings", homeOpened, "ask", "ask-mode session after achilles restart");
  if (await page.locator('[data-write-surface="composer.auto-approve"][aria-checked="true"]').count()) throw new Error("ask-mode session showed the auto-approve marker after achilles restart");
  const refreshCountBeforeRestartToggle = requests().filter((frame) => frame.method === "mcp_refresh_tools").length;
  const restartedToggleResponse = gateWait.playwright(page, "waitForResponse", (response) => response.request().method() === "POST" && requestPath(response.url()) === "/api/pages/home/create-mode");
  await clickCreateMode(false);
  if (!(await restartedToggleResponse).ok()) throw new Error("post-restart create mode toggle request failed");
  await waitFor(async () => requests().filter((frame) => frame.method === "mcp_refresh_tools").length > refreshCountBeforeRestartToggle, "post-restart tool refresh request");
  const restartedRefreshIndex = requests().findLastIndex((frame) => frame.method === "mcp_refresh_tools");
  const restartedRefresh = requests()[restartedRefreshIndex];
  await waitFor(async () => requests().slice(restartedRefreshIndex + 1).some((frame) => frame.id === restartedRefresh?.id && (frame.result || frame.error)), "post-restart tool refresh result");
  const restartedRefreshResult = requests().slice(restartedRefreshIndex + 1).find((frame) => frame.id === restartedRefresh?.id && (frame.result || frame.error));
  if (restartedRefreshResult?.error) throw new Error(`post-restart tool refresh did not enable create mode without a zeta restart: ${JSON.stringify(restartedRefreshResult.error)}`);
  await waitCreateMode(true);
  if (await page.getByText("restart zeta serve, then reload", { exact: false }).count()) throw new Error("automatic post-restart tool refresh showed the manual restart message");
  const beforeReconnect = JSON.parse(await Bun.file(control).text());
  const restartAnnotationApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "annotate_trace" });
  const restartApprovalBefore = await restartAnnotationApproval.count();
  const reconnectIdleWrite = gateWait.playwright(page, "waitForResponse", (response) => {
    if (response.request().method() !== "PATCH" || requestPath(response.url()) !== `/api/chats/${encodeURIComponent(homeOpened)}`) return false;
    try { return JSON.parse(response.request().postData() ?? "null")?.last_state === "idle"; } catch { return false; }
  }).catch(() => { throw new Error("missing reconnect idle state write before achilles restart"); });
  await field.fill("post-reconnect catalog"); await field.press("Enter");
  await waitFor(async () => {
    const state = JSON.parse(await Bun.file(control).text());
    return state.request_count > (beforeReconnect.request_count ?? 0) && state.last_message.includes("post-reconnect catalog");
  }, "post-reconnect backend request");
  await waitFor(async () => (await restartAnnotationApproval.count()) > restartApprovalBefore, "post-restart generated tool approval");
  await restartAnnotationApproval.nth(restartApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await gateWait.playwright(page.getByText("post-reconnect complete", { exact: true }), "waitFor", { timeout: 20000 });
  if (!(await reconnectIdleWrite).ok()) throw new Error("reconnect idle state write failed before achilles restart");
  const postReconnect = JSON.parse(await Bun.file(control).text());
  if (postReconnect.pid !== zetaPidBeforeRestart) throw new Error("zeta pid changed during achilles reconnect");
  if (!postReconnect.schemas.includes("achilles__create_page") || !postReconnect.schemas.includes("achilles__create_tool")) throw new Error(`post-restart turn did not receive create tools: ${JSON.stringify(postReconnect.schemas)}`);
  const restartAnnotationResult = postReconnect.tool_results?.find((result: { call_id: string }) => result.call_id === "annotate-after-restart");
  if (!restartAnnotationResult || restartAnnotationResult.is_error) throw new Error(`generated tool did not recover after achilles restart: ${JSON.stringify(postReconnect.tool_results)}`);
  const restartRecords = await (await fetch(`${origin}/api/pages/home/records/trace_annotations`, { headers: { Authorization: `Bearer ${credential}` } })).json();
  const restartRecordTexts = Array.isArray(restartRecords) ? restartRecords.map((record: { text?: string }) => record.text).sort() : [];
  if (JSON.stringify(restartRecordTexts) !== JSON.stringify(["after achilles restart", "from zeta"])) throw new Error(`post-restart generated tool result was not recorded: ${JSON.stringify(restartRecords)}`);
  if ((logs.get(zetaProcess) ?? "").toLowerCase().includes("failed to mount")) throw new Error("zeta failed to mount a bound server after the achilles restart");
  mcpSessions.delete(credential);
  await mcp(credential, 3, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gate", version: "1" } });
  const invalid = await mcp(credential, 5, "tools/call", { name: "create_page", arguments: { route: "/invalid", title: "invalid", package: { source: "", dependencies: {} } } });
  if (!invalid.result?.isError || (await fetch(`${origin}/api/pages/invalid`)).status !== 404) throw new Error("invalid page package published");
  const reconnectCreatedPage = await mcp(credential, 6, "tools/call", { name: "create_page", arguments: { route: "/cross", title: "cross", package: { source: "export default function Page(){return <main>cross</main>}", dependencies: {} } } });
  if (reconnectCreatedPage.result?.isError || (await fetch(`${origin}/api/pages/cross`)).status !== 200) throw new Error("reconnected MCP client could not create a code page");
  console.log("reconnect refresh asserted: achilles restarted mid-session; create mode and the next turn used the refreshed catalog without restarting zeta");

  await homeMcp(14, "tools/list", {});
  const lateAnnotation = await homeMcp(15, "tools/call", { name: "annotate_trace", arguments: { text: "after create mode", id: "late-annotation" } });
  if (lateAnnotation.result?.isError) throw new Error(`generated tool failed after create mode: ${JSON.stringify(lateAnnotation)}`);
  const lateRecords = await (await fetch(`${origin}/api/pages/home/records/trace_annotations`, { headers: { Authorization: `Bearer ${credential}` } })).json();
  if (!Array.isArray(lateRecords) || lateRecords.length !== 3) throw new Error(`late generated tool result was not recorded: ${JSON.stringify(lateRecords)}`);

  app.kill("SIGTERM");
  await new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app = await startAchilles({ ...env, ACHILLES_APPROVAL: "allow" }, "allow-mode achilles restart");
  await page.goto(`${origin}/allow`);
  const allowField = page.getByRole("textbox", { name: "message" });
  await gateWait.playwright(allowField, "waitFor", { timeout: 20000 });
  await allowField.fill("start allow-mode chat", { timeout: 20_000 });
  await allowField.press("Enter", { timeout: 20_000 });
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).allow_open_request === true, "allow-mode opening request");
  await gateWait.playwright(page.getByText("allow page ready", { exact: true }), "waitFor", { timeout: 20_000 });
  const allowSession = await homeSessionId();
  if (!allowSession) throw new Error("allow-mode page session id missing");
  await gateWait.playwright(page.locator('[data-write-surface="composer.auto-approve"][aria-checked="true"]'), "waitFor", { state: "visible" });
  await awaitApprovalMode("set_settings", allowSession, "allow", "allow-mode session settings");
  const allowSetSettingsBeforeReload = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === allowSession).length;
  await page.reload();
  await gateWait.playwright(allowField, "waitFor", { timeout: 20000 });
  await awaitApprovalMode("session_settings", allowSession, "allow", "reloaded allow-mode session");
  const allowSetSettingsAfterReload = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === allowSession).length;
  if (allowSetSettingsAfterReload !== allowSetSettingsBeforeReload)
    throw new Error("reloading an allow-mode session sent a no-op set_settings frame");
  const allowApprovalBefore = await approval.count();
  const beforeAllowTurn = JSON.parse(await Bun.file(control).text());
  await allowField.fill("run the allow-mode tool");
  await allowField.press("Enter");
  await gateWait.playwright(page.getByText("allow complete", { exact: true }), "waitFor", { timeout: 20000 });
  const afterAllowTurn = JSON.parse(await Bun.file(control).text());
  if ((afterAllowTurn.request_count ?? 0) < (beforeAllowTurn.request_count ?? 0) + 2)
    throw new Error("allow-mode tool did not complete in this turn");
  const allowResult = afterAllowTurn.tool_results?.find((result: { call_id: string }) => result.call_id === "allow-read");
  if (!allowResult || allowResult.is_error) throw new Error(`allow-mode tool result missing: ${JSON.stringify(afterAllowTurn.tool_results)}`);
  if (await approval.count() !== allowApprovalBefore) throw new Error("allow-mode tool showed an approval card");

  // A page tool called while a reload has the page away (the `turn_reconnect` grace) waits for the page binding and
  // runs once on the binding the reloaded page re-sends. zeta announces the call (tool_start), then the test server
  // holds it before it reaches the page tools until the old page's binding is gone, and the reloaded page cannot
  // connect until the call was made with no binding.
  await page.goto(`${origin}/reading`);
  await gateWait.playwright(allowField, "waitFor", { timeout: 20_000 });
  const readingChatBeforeReload = await homeSessionId();
  await dockHead(page).getByRole("button", { name: "new page chat" }).click();
  await waitFor(async () => {
    const current = await homeSessionId();
    return Boolean(current && current !== readingChatBeforeReload);
  }, "new allow-mode reading chat");
  const reloadChat = await homeSessionId();
  await gateWait.playwright(page.locator('[data-write-surface="composer.auto-approve"][aria-checked="true"]'), "waitFor", { state: "visible" });
  const reloadBooks = async () => {
    const response = await fetch(`${origin}/api/pages/${createdPage.id}/records/books?field=title&equals=${encodeURIComponent('"Reload Book"')}`, { headers: { Authorization: `Bearer ${readingCredential}` } });
    if (!response.ok) throw new Error(`reload book query failed: ${response.status}`);
    return (await response.json()) as unknown[];
  };
  if ((await reloadBooks()).length !== 0) throw new Error("Reload Book existed before the reload case");
  const armControl = JSON.parse(await Bun.file(control).text());
  const suspendsBeforeReload = armControl.bound_suspends ?? 0;
  await writeControl(control, { ...armControl, hold_reload_tool: true });
  await allowField.fill("add Reload Book across a reload");
  await allowField.press("Enter");
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).reload_tool_barrier === "held", "add_book call held before it reaches the page tools");
  await waitFor(async () => requests().some((frame) => frame.method === "event" && frame.params?.event === "tool_start" && frame.params?.tool_call?.id === "reload-add-book"), "add_book tool_start announced to the page");
  const heldDiscovery: Route[] = [];
  const holdDiscovery = (route: Route) => { heldDiscovery.push(route); };
  await page.route(discoveryUrl, holdDiscovery);
  const framesBeforeToolReload = requests().length;
  await page.reload({ waitUntil: "commit" });
  await waitFor(async () => (JSON.parse(await Bun.file(control).text()).bound_suspends ?? 0) > suspendsBeforeReload, "old page binding detached by the reload");
  const heldToolControl = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...heldToolControl, release_reload_tool_barrier: true, hold_reload_history: reloadChat });
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).detached_add_book_calls === 1, "add_book called with no page binding");
  await page.unroute(discoveryUrl, holdDiscovery);
  await Promise.all(heldDiscovery.map((route) => route.fallback()));
  // The reply commits while the reloaded page loads its history: zeta publishes assistant_message before it writes
  // the reply's history row, so the test server holds the page's first history read until the reply was published
  // with its row held, then holds the row until the page has loaded. The reply must still show.
  await waitFor(async () => {
    const document = JSON.parse(await Bun.file(control).text());
    return document.reload_history_barrier === "held" && document.reload_row_barrier === "held"
      && requests().slice(framesBeforeToolReload).some((frame) => frame.method === "event" && frame.params?.event === "assistant_message");
  }, "reply published to the reloaded page while its history read and the reply's row are held");
  const heldHistoryControl = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...heldHistoryControl, release_reload_history_barrier: true });
  await waitFor(async () => await page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^running$/ }).first().isVisible(), "reloaded page shows the kept turn running");
  const heldRowControl = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...heldRowControl, release_reload_row_barrier: true });
  await gateWait.playwright(page.getByText("reload book added", { exact: true }), "waitFor", { timeout: 20_000 }).catch(async (error) => {
    throw new Error(`${error}\npage after the reload during add_book: ${redact(await page.locator("body").innerText())}`);
  });
  await waitForIdleTurn(page, waitFor);
  if (await page.getByText("reload book added", { exact: true }).count() !== 1) throw new Error("the reply committed during the reloaded page's load showed more than once");
  const afterToolReload = JSON.parse(await Bun.file(control).text());
  const reloadToolResult = afterToolReload.tool_results?.find((result: { call_id: string }) => result.call_id === "reload-add-book");
  if (!reloadToolResult || reloadToolResult.is_error)
    throw new Error(`add_book called during the reload grace did not run: ${JSON.stringify(afterToolReload.tool_results)}`);
  const reloadBookRows = await reloadBooks();
  if (reloadBookRows.length !== 1) throw new Error(`add_book during the reload grace wrote ${reloadBookRows.length} records, not 1`);
  if (afterToolReload.detached_add_book_calls !== 1) throw new Error(`add_book reached zeta ${afterToolReload.detached_add_book_calls} times with no binding`);
  const toolReloadResume = requests().slice(framesBeforeToolReload).find((frame) => frame.method === "resume" && frame.params?.session_id === reloadChat);
  if (!toolReloadResume?.params?.mcp_bindings?.length) throw new Error("reloaded page did not re-send the page binding with resume");
  if (requests().slice(framesBeforeToolReload).some((frame) => JSON.stringify(frame).includes('"reason":"disconnect"')))
    throw new Error("zeta cancelled the turn on reload (reason disconnect)");
  console.log("reload during a page tool call asserted: the call made with no binding waited, ran once on the reloaded page's binding, and the turn finished");

  // A foreground tool still running across a reload: the output it printed before the reload shows on the reloaded
  // page while it runs (`in_flight_replay`), and every line shows once after it ends. The tool waits for a file.
  const transcript = page.locator(".transcript");
  const toolLines = async () => { const text = await transcript.innerText(); return ["tool-line before-reload", "tool-line after-reload"].map((line) => text.split(line).length - 1); };
  await allowField.fill("run a tool across a reload");
  await allowField.press("Enter");
  const reloadTool = transcript.locator('[data-part="tool"][data-id="tool:reload-bash"]');
  const revealReloadTool = () => reloadTool.evaluateAll((cards) => {
    const card = cards[0];
    if (card instanceof HTMLDetailsElement && !card.open) card.querySelector<HTMLElement>("summary")?.click();
  });
  await waitFor(async () => {
    await revealReloadTool();
    return (await toolLines())[0] === 1;
  }, "running tool output shown before the reload");
  await page.reload();
  await waitFor(async () => await page.locator(".run-state, .page-chat-readouts").filter({ hasText: /^running$/ }).first().isVisible(), "reloaded page shows the running tool's turn");
  const runningTool = page.locator('[data-part="tool"][data-state="streaming"]').filter({ hasText: "tool-line before-reload" });
  await waitFor(async () => {
    await revealReloadTool();
    return (await runningTool.count()) === 1;
  }, "running tool output from before the reload shown on the reloaded page while the tool runs").catch(async (error) => {
    throw new Error(`${error}\ntranscript after the reload during a running tool: ${redact((await transcript.innerText()).slice(-1500))}`);
  });
  if ((await toolLines())[0] !== 1) throw new Error(`running tool output showed ${(await toolLines())[0]} times after the reload, not once`);
  await Bun.write(join(cwd, "release-reload-tool"), "");
  await gateWait.playwright(page.getByText("reload tool complete", { exact: true }), "waitFor", { timeout: 20_000 });
  await waitForIdleTurn(page, waitFor);
  if ((await toolLines()).some((count) => count !== 1) || await page.getByText("reload tool complete", { exact: true }).count() !== 1)
    throw new Error(`after the tool ended, its lines showed ${JSON.stringify(await toolLines())} times and the reply ${await page.getByText("reload tool complete", { exact: true }).count()} times, not once each`);
  console.log("reload during a running tool asserted: output from before the reload showed once while the tool ran, and once after it ended");

  // A reload during a woken turn's setup (a background task ended; zeta has not sent turn_start yet) attaches to
  // that turn: the page shows the chat, not a busy error, the turn calls a page tool on the re-sent binding, and
  // the forced ask mode the reloaded page asks for is applied only after the turn ends (never during the setup). The test server holds the woken turn in its setup while achilles restarts in ask mode.
  await allowField.fill("start a background task");
  await allowField.press("Enter");
  await gateWait.playwright(page.getByText("background task started", { exact: true }), "waitFor", { timeout: 20_000 });
  await waitForIdleTurn(page, waitFor);
  const wakeChat = await homeSessionId();
  if (!wakeChat) throw new Error("woken-turn chat id missing");
  const wakeArm = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...wakeArm, hold_wake_setup: true });
  await Bun.write(join(cwd, "release-wake-task"), "");
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).wake_setup_barrier === "held", "woken turn held in its setup");
  const restartAchilles = async (approval: "allow" | "ask") => {
    app.kill("SIGTERM");
    if (!(await waitForExit(app, 15_000))) throw new Error("achilles did not stop after SIGTERM");
    app = await startAchilles({ ...env, ACHILLES_APPROVAL: approval }, `achilles restart in ${approval} mode`);
  };
  await restartAchilles("ask");
  const framesBeforeWakeReload = requests().length;
  await page.reload();
  await gateWait.playwright(allowField, "waitFor", { timeout: 20_000 });
  const wakeFrames = () => requests().slice(framesBeforeWakeReload);
  const replyTo = (method: string) => {
    const frames = wakeFrames();
    const sent = frames.findLast((frame) => frame.method === method && frame.params?.session_id === wakeChat);
    return sent && frames.slice(frames.indexOf(sent) + 1).find((frame) => frame.id === sent.id && (frame.result || frame.error));
  };
  await waitFor(async () => Boolean(replyTo("resume")), "reloaded page resumed the chat in the woken turn's setup");
  const wakeAttach = replyTo("resume");
  if (wakeAttach?.result?.attached !== "live_turn") throw new Error(`reload in a woken turn's setup did not attach to it: ${redact(JSON.stringify(wakeAttach?.error ?? { attached: wakeAttach?.result?.attached ?? null }))}`);
  await gateWait.playwright(page.locator('[data-write-surface="composer.auto-approve"][aria-checked="true"]'), "waitFor", { state: "visible" });
  // zeta reports the setup as running, so the page keeps the mode pending; an older zeta reported idle and refused it
  if (replyTo("set_settings") && replyTo("set_settings")?.error?.code !== -32004) throw new Error(`ask mode was applied during the woken turn's setup: ${redact(JSON.stringify(replyTo("set_settings")))}`);
  if (await page.getByRole("alert").count()) throw new Error(`reload in a woken turn's setup showed an error: ${redact(await page.getByRole("alert").first().innerText())}`);
  const wakeHeld = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...wakeHeld, release_wake_setup_barrier: true });
  await gateWait.playwright(page.getByText("woken turn complete", { exact: true }), "waitFor", { timeout: 20_000 }).catch(async (error) => {
    throw new Error(`${error}\npage after the reload in a woken turn's setup: ${redact(await page.locator("body").innerText())}`);
  });
  await waitForIdleTurn(page, waitFor);
  const wakeTool = JSON.parse(await Bun.file(control).text()).tool_results?.find((result: { call_id: string }) => result.call_id === "wake-inspect");
  if (!wakeTool || wakeTool.is_error) throw new Error(`the woken turn's page tool did not run on the re-sent binding: ${JSON.stringify(wakeTool ?? null)}`);
  await gateWait.playwright(page.locator('[data-write-surface="composer.auto-approve"][aria-checked="false"]'), "waitFor", { state: "visible", timeout: 20_000 });
  await awaitApprovalMode("set_settings", wakeChat, "ask", "ask mode after the woken turn ended");
  if (await page.getByRole("alert").count()) throw new Error(`the woken turn's end showed an error: ${redact(await page.getByRole("alert").first().innerText())}`);
  await restartAchilles("allow");
  console.log("reload in a woken turn's setup asserted: the page attached, the turn ran a page tool, and ask mode applied after the turn ended");
  await page.goto(`${origin}/allow?chat=${allowSession}`);
  await gateWait.playwright(allowField, "waitFor", { timeout: 20_000 });
  await gateSettings(page, origin, gateWait);
  await gateCreationApprovalDefaults(page, requests, awaitApprovalMode, gateWait);

  await gateVim(page, control, waitFor, async (check) => {
    try {
      await expectBrowserErrors(page, [], async () => {
        await listTokens(ownDiscovery);
        zetaProcess.kill("SIGTERM");
        if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta shutdown timeout during vim read-only gate");
        await check();
      });
    } finally {
      await restartZeta("zeta restart after vim read-only gate");
    }
  }, requests, gateWait);

  const firstSetSettingsBeforeAllowReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  await page.goto(`${origin}/?chat=${first}`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  if (await page.locator('[data-write-surface="composer.auto-approve"][aria-checked="true"]').count()) throw new Error("user ask chat reopened under allow showed auto-approve");
  const firstSetSettingsAfterAllowReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  if (firstSetSettingsAfterAllowReopen !== firstSetSettingsBeforeAllowReopen)
    throw new Error("reopening a user ask chat under an allow server sent set_settings");
  await gatePalette(page, first, waitFor, gateWait);

  await page.goto(`${origin}/allow?chat=${allowSession}`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20_000 });
  let registerFailures = 0;
  const allowPageId = (await (await fetch(`${origin}/api/pages/allow`)).json()).id;
  const registrationFailureUrl = `${origin}/api/pages/${allowPageId}/chats`;
  const registrationFailurePath = new URL(registrationFailureUrl).pathname;
  const registrationExpected = [{ method: "POST", url: registrationFailureUrl, status: 503, count: 2 }];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (registerFailures < 2 && request.method() === "POST" && url.origin === origin && url.pathname === registrationFailurePath) {
      registerFailures += 1;
      await route.fulfill({ status: 503, body: "synthetic registration failure" });
    } else await route.fallback();
  });
  const newSessionsBeforeOrphan = requests().filter((frame) => frame.method === "new_session").length;
  const retryRegistration = page.getByRole("button", { name: "retry creating chat" });
  const registrationFailure = (response: { request(): { method(): string }; url(): string; status(): number }) => response.request().method() === "POST" && response.url() === registrationFailureUrl && response.status() === 503;
  await expectBrowserErrors(page, registrationExpected, async () => {
    const firstFailure = gateWait.playwright(page, "waitForResponse", registrationFailure);
    await page.locator("button.new-chat").click();
    await firstFailure;
    await gateWait.playwright(retryRegistration, "waitFor", { timeout: 20_000 });
    const secondFailure = gateWait.playwright(page, "waitForResponse", registrationFailure);
    await retryRegistration.click();
    await secondFailure;
    await gateWait.playwright(retryRegistration, "waitFor", { timeout: 20_000 });
  });
  const newSessionsAfterFailure = requests().filter((frame) => frame.method === "new_session").length;
  if (newSessionsAfterFailure !== newSessionsBeforeOrphan + 1)
    throw new Error("failed chat registration did not retain exactly one new zeta session");
  await page.unroute("**/api/**");
  await retryRegistration.click();
  await waitFor(async () => {
    const current = await homeSessionId();
    return Boolean(current && current !== allowSession);
  }, "orphan chat retry");
  if (requests().filter((frame) => frame.method === "new_session").length !== newSessionsAfterFailure)
    throw new Error("retrying an orphaned chat created another zeta session");
  await waitFor(async () => {
    const current = await homeSessionId();
    const attached = await page.locator("[data-session-id]").getAttribute("data-session-id");
    return Boolean(current && attached === current && new URL(page.url()).searchParams.get("chat") === current);
  }, "orphan chat ui attachment");

  const draft = "this draft must remain after zeta disconnects";
  const droppedField = page.getByRole("textbox", { name: "message" });
  await droppedField.fill(draft);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-connected-review-1440x900.png"), fullPage: true });
  await expectBrowserErrors(page, [{ method: "GET", url: discoveryUrl, status: 503 }], async () => {
    const discoveryFailure = gateWait.playwright(page, "waitForResponse", (response) => response.request().method() === "GET" && response.url() === discoveryUrl && response.status() === 503);
    await listTokens(ownDiscovery);
    zetaProcess.kill("SIGTERM");
    if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta did not stop for dropped-connection gate");
    await gateWait.playwright(page.getByRole("alert").filter({ hasText: "the connection to zeta was lost" }), "waitFor", { timeout: 20_000 });
    await discoveryFailure;
  });
  if (await droppedField.inputValue() !== draft) throw new Error("dropped connection discarded the composer draft");
  if ((await page.locator("[data-session-id]").count()) !== 1) throw new Error("dropped connection hid the attached transcript");
  if (!(await page.locator(".run-state").innerText()).includes("offline")) throw new Error("dropped connection did not mark the chat offline");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-connection-lost-review-1440x900.png"), fullPage: true });
  await restartZeta("zeta reconnect after dropped connection");
  // automatic reconnect can clear the compact banner before the manual retry click.
  // A bounded click makes disappearance during the action equivalent to automatic recovery.
  const retryNow = page.getByRole("button", { name: "retry now" });
  try {
    await retryNow.click({ timeout: 1_000 });
  } catch {
    // The button may disappear when the app reconnects by itself.
  }
  const recoveredField = page.getByRole("textbox", { name: "message", exact: true });
  await gateWait.playwright(recoveredField, "waitFor", { timeout: 20_000 });
  if (await recoveredField.inputValue() !== draft) throw new Error("reconnecting discarded the composer draft");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-connection-recovered-review-1440x900.png"), fullPage: true });

  if (screenshotDir) {
    await listTokens(ownDiscovery);
    zetaProcess.kill("SIGTERM");
    if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta did not stop for first-paint screenshot");
    const heldRequests: Route[] = [];
    const hold = (route: Route) => { heldRequests.push(route); };
    await page.route("**/api/pages**", hold);
    await page.route("**/api/chats**", hold);
    await page.reload({ waitUntil: "domcontentloaded" });
    await gateWait.playwright(page.locator(".sidebar-skeleton").first(), "waitFor", { timeout: 20_000 });
    await gateWait.playwright(page.getByRole("alert").filter({ hasText: "zeta serve is not running" }), "waitFor", { timeout: 20_000 });
    await page.screenshot({ path: join(screenshotDir, "07-first-paint-not-running-review-1440x900.png"), fullPage: true });
    const failedRequests = heldRequests.map((route) => gateWait.playwright(page, "waitForEvent", "requestfailed", (request) => request === route.request())
      .catch(() => { throw new Error(`missing request failure for held route ${route.request().method()} ${requestPath(route.request().url())}`); }));
    await Promise.all(heldRequests.map((route) => route.abort()));
    await Promise.all(failedRequests);
    await page.unroute("**/api/pages**", hold);
    await page.unroute("**/api/chats**", hold);
  }

  // final two-tab observer journey runs after the legacy gate so it cannot change its request assertions.
  if (zetaProcess.exitCode !== null) await restartZeta("observer fallback capture");
  await page.goto(`${origin}/reading`);
  const controllerChat = await page.locator("[data-session-id]").getAttribute("data-session-id", { timeout: 20_000 });
  if (!controllerChat) throw new Error("page-mapped controller chat did not attach");
  await gateWait.playwright(page, "waitForFunction", () =>
    document.querySelectorAll('[data-part="timeline"] [data-id], [data-part="timeline"] [data-virtual-id]').length > 0,
    undefined,
    { timeout: 20_000 },
  );
  const s2Images: string[] = [];
  const s2Shot = async (tab: Page, name: string) => {
    if (!screenshotDir) return;
    s2Images.push(`s2-header-${name}.png`);
    await tab.screenshot({ path: join(screenshotDir, s2Images.at(-1)!), animations: "disabled" });
  };
  await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
  await waitForIdleTurn(page, waitFor);
  const switcher = dockHead(page).locator('[aria-haspopup="listbox"]');
  const assertCurrentChat = async (id: string) => {
    await gateWait.playwright(page.locator(`[data-session-id="${id}"]`), "waitFor", { state: "attached" });
    if (new URL(page.url()).searchParams.get("chat") !== id) throw new Error("page chat switcher did not update the URL");
    await gateWait.playwright(page.locator(`[data-chat-id="${id}"][aria-current="page"]`), "waitFor", { state: "attached" });
  };
  await switcher.click();
  await gateWait.playwright(dockHead(page).getByRole("option", { selected: true }), "waitFor");
  const alternate = dockHead(page).getByRole("option", { selected: false }).first();
  await gateWait.playwright(alternate, "waitFor");
  const alternateTitle = await alternate.locator(".page-chat-choice-title").innerText();
  await s2Shot(page, "switcher-1440");
  await alternate.click();
  const alternateId = new URL(page.url()).searchParams.get("chat");
  if (!alternateId || alternateId === controllerChat) throw new Error("page chat switcher did not select the other page chat");
  await assertCurrentChat(alternateId);
  if (await dockHead(page).locator("strong").textContent() !== alternateTitle) throw new Error("dock title disagreed with selected catalog row");
  await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
  await waitForIdleTurn(page, waitFor);
  const longTitle = "notes on the reading list with a very long title to prove truncation";
  await page.locator('[data-write-surface="header.rename"]').click();
  const titleInput = page.getByRole("textbox", { name: "chat title" });
  await titleInput.fill(longTitle);
  await titleInput.press("Enter");
  await gateWait.playwright(dockHead(page).getByText(longTitle, { exact: true }), "waitFor", { state: "attached" });
  await gateWait.playwright(page.locator(`[data-chat-id="${controllerChat}"]`).getByText(longTitle, { exact: true }), "waitFor");
  const changeS2Mode = async (name: "create mode" | "auto-approve", checked: boolean) => {
    if ((await modeSwitch(page, name).getAttribute("aria-checked")) === String(checked)) return;
    await modeSwitch(page, name).click();
    await gateWait.playwright(modeSwitch(page, name, checked), "waitFor");
  };
  const headerGeometry = async () => {
    const dimensions = await dockHead(page).evaluate((head) => {
      const title = head.querySelector("strong")!;
      const row = head.querySelector(".page-chat-title-row")!;
      const rowBox = row.getBoundingClientRect();
      const controls = [...row.querySelectorAll("button")];
      return {
        height: head.getBoundingClientRect().height,
        overflow: head.scrollWidth > head.clientWidth,
        ellipsized: title.scrollWidth > title.clientWidth && title.clientHeight < 30 && getComputedStyle(title).textOverflow === "ellipsis",
        oneBaseline: controls.every((button) => Math.abs(button.getBoundingClientRect().top + button.clientHeight / 2 + button.clientTop - (rowBox.top + rowBox.height / 2)) <= 1),
        // desktop controls share the 32 px control height; narrow screens keep 44 px touch targets
        target: innerWidth <= 760 ? 44 : 32,
        touchTargets: controls.length === (innerWidth <= 760 ? 3 : 2) && controls.every((button) => button.getBoundingClientRect().width >= (innerWidth <= 760 ? 44 : 32) && button.getBoundingClientRect().height === (innerWidth <= 760 ? 44 : 32)),
      };
    });
    if (dimensions.height !== dimensions.target + 9 || dimensions.overflow || !dimensions.ellipsized || !dimensions.oneBaseline || !dimensions.touchTargets) throw new Error(`page chat header geometry: ${JSON.stringify(dimensions)}`);
  };
  const popupBounds = async () => {
    if (!await dockHead(page).locator(".page-chat-popup").evaluate((node) => {
      const popup = node.getBoundingClientRect();
      const surface = node.closest(".page-chat-surface")!.getBoundingClientRect();
      return popup.top >= surface.top && popup.bottom <= surface.bottom && popup.left >= surface.left && popup.right <= surface.right;
    })) throw new Error("page chat popup escaped the rail or sheet");
  };
  const outsideCloses = async (trigger: ReturnType<Page["locator"]>) => {
    const composer = page.locator('.page-chat-surface textarea[aria-label="message"]');
    const cases = [
      { name: "header background", act: () => dockHead(page).click({ position: { x: 4, y: 2 } }), focus: trigger },
      ...(page.viewportSize()!.width === 1440 ? [{ name: "sidebar background", act: () => page.locator(".brand-row strong").click(), focus: trigger }] : []),
      { name: "composer", act: () => composer.click(), focus: composer },
      { name: "Escape", act: () => page.keyboard.press("Escape"), focus: trigger },
    ];
    for (const [index, { name, act, focus }] of cases.entries()) {
      if (index) await trigger.click();
      await act();
      const context = `${page.viewportSize()!.width}px ${await trigger.getAttribute("aria-haspopup")}: ${name}`;
      if (await trigger.getAttribute("aria-expanded") !== "false") throw new Error(`${context} did not close the popup`);
      if (!await focus.evaluate((node) => node === document.activeElement)) throw new Error(`${context} left focus on the wrong element`);
    }
  };
  const popupPointers = async () => {
    await switcher.click();
    await popupBounds();
    await outsideCloses(switcher);
    await switcher.click();
    await dockHead(page).getByRole("option", { selected: true }).click();
    if (await switcher.getAttribute("aria-expanded") !== "false") throw new Error("pointer did not select the current chat row");
  };
  const captures = async (name: string) => {
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await headerGeometry();
      if (name === "non-default") await popupPointers();
      await s2Shot(page, `${name}-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  await changeS2Mode("auto-approve", true);
  await changeS2Mode("create mode", true);
  await captures("default");
  await changeS2Mode("auto-approve", false);
  await changeS2Mode("create mode", false);
  await captures("non-default");
  // A chat switch owns navigation and focus even when an outside click also closes a popup.
  const sidebarChat = page.locator(`a[data-chat-id="${alternateId}"]`);
  for (const open of [false, true]) {
    if (open) await switcher.click();
    await sidebarChat.click();
    await assertCurrentChat(alternateId);
    if (!await sidebarChat.evaluate((node) => node === document.activeElement) || await switcher.getAttribute("aria-expanded") !== "false") {
      throw new Error(`sidebar chat switch with popup ${open ? "open" : "closed"} did not retain row focus and close the popup`);
    }
    await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
    await waitForIdleTurn(page, waitFor);
  }
  await setupMobileSheet(page, 844, "switcher");
  await setupMobileSheet(page, 844, "button");
  for (const [width, height] of [[360, 780], [390, 844], [430, 844]]) {
    await setupMobileSheet(page, height, "button", width);
    await headerGeometry();
    await popupPointers();
    await s2Shot(page, `sheet-${width}`);
    await switcher.click();
    await dockHead(page).getByRole("option", { selected: false }).first().click();
    await gateWait.playwright(page, "waitForURL", (url) => url.searchParams.get("chat") === alternateId);
    await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
    await setupMobileSheet(page, height, "button", width);
    await gateWait.playwright(dockHead(page).getByText(longTitle, { exact: true }), "waitFor");
  }
  await setupMobileSheet(page, 844, "button");
  await modeSwitch(page, "auto-approve").click();
  await gateWait.playwright(modeSwitch(page, "auto-approve", true), "waitFor");
  await s2Shot(page, "modes-390");
  await switcher.click();
  await page.keyboard.press("ArrowDown");
  const keyboardTitle = await dockHead(page).locator('[role="option"]:focus .page-chat-choice-title').innerText();
  await page.keyboard.press("Enter");
  await gateWait.playwright(page.locator(".page-chat-bar[aria-expanded=false]"), "waitFor");
  await setupMobileSheet(page, 844, "button");
  if (keyboardTitle === longTitle || await dockHead(page).locator("strong").textContent() !== keyboardTitle) throw new Error("mobile arrow/Enter did not select the other chat");
  await dockHead(page).getByRole("button", { name: "new page chat" }).click();
  await gateWait.playwright(page, "waitForURL", (url) => url.pathname === "/reading" && Boolean(url.searchParams.get("chat") && url.searchParams.get("chat") !== controllerChat && url.searchParams.get("chat") !== alternateId));
  await setupMobileSheet(page, 844, "button");
  if (!(await dockHead(page).getByRole("button", { name: "new page chat" }).isDisabled())) throw new Error("new unsent chat did not disable +");
  await gateWait.playwright(dockHead(page).locator('[data-write-surface="page-chat.new"][title="already in a new chat"]:disabled'), "waitFor");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
  await waitForIdleTurn(page, waitFor);
  await dockHead(page).getByRole("button", { name: "new page chat" }).click();
  await gateWait.playwright(page, "waitForURL", (url) => url.pathname === "/reading" && Boolean(url.searchParams.get("chat") && url.searchParams.get("chat") !== controllerChat));
  await gateWait.playwright(dockHead(page).locator('[data-write-surface="page-chat.new"]:disabled'), "waitFor");
  await page.goto(`${origin}/reading?chat=${controllerChat}&theme=${encodeURIComponent(theme)}`);
  await waitForIdleTurn(page, waitFor);
  console.log("s2 page chat header switch/create/modes/rename verified at 1440 and 390");
  const observerLatestSource = await page.locator('[data-part="message"]').last().innerText();
  if (!observerLatestSource.trim()) throw new Error("controller had no source-derived latest chat text");
  const observerPage = await browser.newPage();
  const renderedWriteSurfaceIds = new Set<string>([...mcpWriteSurfaceIds, mcpAddSurfaceId, mcpTestSurfaceId, ...mcpOAuthSurfaceIds, ...agentWriteSurfaceIds]);
  const recordRenderedWriteSurfaces = async (target: typeof observerPage) => {
    for (const id of await target.locator("[data-write-surface]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-write-surface")).filter((id): id is string => Boolean(id)))) renderedWriteSurfaceIds.add(id);
  };
  await recordRenderedWriteSurfaces(page);
  const observerFrames: { direction: "sent" | "received"; payload: string }[] = [];
  const observerSockets: Array<{ socketId: number; attempt: number; role: string | null; lifecycle: "open" | "closed"; direction?: "sent" | "received"; method?: string; helloAccepted?: boolean; helloFeatures?: string[] }> = [];
  const observerHttp: { method: string; path: string; body: string | null }[] = [];
  let observerSocketId = 0;
  observerPage.on("websocket", (socket) => {
    const socketId = observerSocketId++;
    const row = { socketId, attempt: socketId + 1, role: null as string | null, lifecycle: "open" as const };
    observerSockets.push(row);
    let helloId: string | number | undefined;
    socket.on("framesent", (event) => {
      const payload = String(event.payload); observerFrames.push({ direction: "sent", payload });
      try {
        const frame = JSON.parse(payload) as { id?: string | number; method?: unknown; params?: { role?: unknown } };
        if (frame.method === "hello" && (frame.params?.role === "controller" || frame.params?.role === "observer")) {
          row.role = frame.params.role;
          helloId = frame.id;
        }
        observerSockets.push({ ...row, direction: "sent", method: typeof frame.method === "string" ? frame.method : undefined });
      } catch { /* raw frame remains in observerFrames */ }
    });
    socket.on("framereceived", (event) => {
      const payload = String(event.payload); observerFrames.push({ direction: "received", payload });
      const frame = decodeFrame(payload) as { id?: string | number; method?: string; result?: { capabilities?: { features?: string[] } } } | null;
      if (!frame) return;
      const helloReply = helloId !== undefined && frame.id === helloId;
      observerSockets.push({ ...row, direction: "received", method: helloReply ? "hello" : frame.method, ...(helloReply ? { helloAccepted: Object.hasOwn(frame, "result"), helloFeatures: frame.result?.capabilities?.features } : {}) });
    });
    socket.on("close", () => observerSockets.push({ ...row, lifecycle: "closed" }));
  });
  observerPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) observerHttp.push({ method: request.method(), path: url.pathname, body: request.postData() });
  });
  await observerPage.goto(`${origin}/reading?chat=${controllerChat}`);
  const observerStorageBefore = await observerPage.evaluate(() => JSON.stringify({ ...localStorage }));
  const observerBanner = observerPage.locator(".observer-banner");
  await gateWait.playwright(observerBanner, "waitFor", { state: "visible" });
  await recordRenderedWriteSurfaces(observerPage);
  if (!(await observerBanner.innerText()).includes("another tab controls zeta") || !(await observerBanner.innerText()).includes("live and read-only")) throw new Error("observer banner did not explain the live read-only state");
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  await gateWait.playwright(dockHead(observerPage).locator('[data-write-surface="page-chat.new"]:disabled'), "waitFor");
  for (const name of ["auto-approve", "create mode"] as const) {
    const item = modeSwitch(observerPage, name);
    if (!(await item.isDisabled()) || !(await item.getAttribute("title"))?.includes("read-only")) throw new Error("observer chat mode write was enabled or unexplained");
  }
  await recordRenderedWriteSurfaces(observerPage);
  await s2Shot(observerPage, "observer-1440");
  await setupMobileSheet(observerPage, 844, "button");
  await s2Shot(observerPage, "observer-390");
  for (const name of ["auto-approve", "create mode"] as const) {
    if (!await modeSwitch(observerPage, name).isDisabled()) throw new Error("mobile observer can change a mode");
  }
  await setupMobileSheet(observerPage, 844);
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  if (screenshotDir) await writeFile(join(screenshotDir, "s2-header-manifest.json"), JSON.stringify({ head: (await Bun.$`git rev-parse HEAD`.text()).trim(), theme, captures: [...s2Images, "s2-header-switcher-390.png", "s2-header-one-chat-controller-390.png", "s2-header-one-chat-observer-390.png"] }, null, 2) + "\n");
  const observerReason = await observerPage.locator("#tab-authority-description").innerText();
  if (!observerReason.includes("read-only")) throw new Error("observer page did not expose a read-only reason");
  const observerNewChat = observerPage.locator("button.new-chat");
  if (!(await observerNewChat.isDisabled())) throw new Error("observer new-chat control was editable");
  await waitFor(async () => (await observerPage.locator('[data-part="timeline"] [data-id], [data-part="timeline"] [data-virtual-id]').count()) > 0, "observer transcript rows");
  const observerMutationMethods = protocolMutationMethods;
  const observerStorageAtActions = await observerPage.evaluate(() => JSON.stringify({ ...localStorage }));
  const observerFrameCountAtActions = observerFrames.length;
  const observerHttpCountAtActions = observerHttp.length;
  const observerComposer = observerPage.getByRole("textbox", { name: "message", exact: true });
  if (await observerComposer.count()) {
    if (await observerComposer.isEditable()) throw new Error("observer composer was editable");
    await observerComposer.press("Enter");
  }
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  await observerPage.keyboard.press(appShortcut("Comma"));
  const observerSettings = observerPage.getByRole("dialog", { name: "settings", exact: true });
  await gateWait.playwright(observerSettings.getByText("only a tab that controls zeta can change auto-approve or reset.", { exact: true }), "waitFor", { state: "visible" });
  for (const control of [observerSettings.getByRole("switch", { name: "auto-approve default", exact: true }), observerSettings.getByRole("button", { name: "reset to defaults", exact: true })]) {
    if (!await control.isDisabled()) throw new Error("observer could edit new-chat defaults or reset them");
  }
  for (const id of ["theme", "ui-font", "code-font", "size", "density", "vim"]) {
    const buttons = observerSettings.locator(`[data-write-surface="settings.${id}"]`).locator("xpath=self::button | .//button");
    if (!await buttons.count() || (await buttons.evaluateAll((elements) => elements.some((button) => button.matches(":disabled"))))) throw new Error(`observer display preference ${id} was absent or locked`);
  }
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "observer-settings-1440x900.png") });
  await observerSettings.getByRole("button", { name: "esc", exact: true }).click();
  await observerPage.keyboard.press(appShortcut("k"));
  const palette = observerPage.getByRole("dialog", { name: "command palette" });
  await gateWait.playwright(palette, "waitFor", { state: "visible" });
  if (!await palette.getByText("toggle vim mode", { exact: true }).isVisible()) throw new Error("observer palette hid the local vim mode toggle");
  if (await palette.getByText("toggle create mode", { exact: true }).count()) throw new Error("observer palette exposed the shared create mode toggle");
  await observerPage.keyboard.press("Escape");
  const observerWritableControls = observerPage.locator("[data-part='approval'] button:not(:disabled)");
  if (await observerWritableControls.count()) throw new Error("observer exposed an enabled approval action");
  if (await observerPage.evaluate(() => JSON.stringify({ ...localStorage })) !== observerStorageAtActions) throw new Error("observer action matrix changed settings storage");
  if (observerFrames.slice(observerFrameCountAtActions).some(({ direction, payload }) => direction === "sent" && observerMutationMethods.has((JSON.parse(payload) as { method?: string }).method ?? ""))) throw new Error("observer action matrix sent a mutating websocket request");
  if (observerHttp.slice(observerHttpCountAtActions).some(({ method }) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new Error("observer action matrix issued mutating HTTP");
  const observerRequests = observerFrames.flatMap(({ direction, payload }) => {
    if (direction !== "sent") return [];
    try { const frame = JSON.parse(payload) as { method?: unknown }; return typeof frame.method === "string" ? [frame.method] : []; }
    catch { return []; }
  });
  const unexpectedObserverReads = observerRequests.filter((method) => observerMutationMethods.has(method));
  if (unexpectedObserverReads.length) throw new Error(`observer websocket mutation leak: ${unexpectedObserverReads.join(", ")}`);
  const expectedObserverReads = new Set(["hello", "session_history_and_subscribe", "session_history", "status", "session_settings"]);
  if (!observerRequests.includes("hello") || !observerRequests.includes("session_history_and_subscribe")) throw new Error(`observer websocket read projection incomplete: ${observerRequests.join(", ")}`);
  if (observerRequests.some((method) => !expectedObserverReads.has(method))) throw new Error(`observer websocket unexpected read: ${observerRequests.join(", ")}`);
  if (observerHttp.some(({ method }) => ["POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new Error("observer issued mutating HTTP request");
  if (await observerPage.evaluate(() => JSON.stringify({ ...localStorage })) !== observerStorageBefore) throw new Error("observer changed settings storage");
  if (screenshotDir) {
    const observerMarker = "prove chat";
    await setupMobileSheet(observerPage, 760);
    const drawerClose = observerPage.getByRole("button", { name: "close menu", exact: true });
    if (await drawerClose.isVisible().catch(() => false)) await drawerClose.click({ force: true });
    for (const dialog of await observerPage.locator('[role="dialog"][aria-modal="true"]').all()) {
      const close = dialog.getByRole("button", { name: /close/i }).first();
      if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    }
    const pageChatDialog = observerPage.getByRole("dialog", { name: "page chat" });
    await waitFor(async () => await observerPage.locator(".sidebar").evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().right <= 0 && style.transform !== "matrix(1, 0, 0, 1, 0, 0)";
    }), "observer drawer settled");
    const routeUnderneath = new URL(observerPage.url()).pathname;
    if (routeUnderneath !== "/reading") throw new Error(`observer page route changed before active chat capture: ${routeUnderneath}`);
    await setupMobileSheet(observerPage, 760, "button");
    await pageChatDialog.evaluate((dialog) => Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const surface = observerPage.locator(".page-chat-surface");
    const transcript = surface.locator('[data-part="timeline-scroll"]');
    const marker = surface.locator('[data-part="message"]').filter({ hasText: observerMarker }).first();
    const jumpToLatest = surface.locator('[data-part="jump-to-latest"]');
    if (await jumpToLatest.isVisible().catch(() => false)) await jumpToLatest.click({ force: true });
    const rows = surface.locator('[data-part="message"]');
    await waitFor(async () => {
      if (await marker.isVisible().catch(() => false)) return true;
      for (let index = 0, count = await rows.count(); index < count; index++) if (await rows.nth(index).isVisible().catch(() => false)) return true;
      return false;
    }, "observer source marker or latest");
    const useMarker = await marker.isVisible().catch(() => false);
    let evidence = marker;
    if (!useMarker) {
      let latestIndex = -1;
      for (let index = 0, count = await rows.count(); index < count; index++) if (await rows.nth(index).isVisible().catch(() => false)) latestIndex = index;
      if (latestIndex < 0) throw new Error("observer active chat had no rendered latest row");
      evidence = rows.nth(latestIndex);
    }
    const expectedEvidence = useMarker ? observerMarker : (await evidence.innerText()).trim();
    await transcript.evaluate((element, text) => {
      const scroll = element as HTMLElement;
      const row = [...document.querySelectorAll<HTMLElement>('[data-part="message"]')].find((candidate) => candidate.textContent?.includes(text));
      if (!row) throw new Error(`missing source-derived observer evidence: ${text}`);
      row.scrollIntoView({ block: "center", inline: "nearest" });
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, expectedEvidence);
    await gateWait.playwright(evidence, "waitFor", { state: "visible" });
    const mobileMarker = await evidence.evaluate((element, expected) => {
      const rect = element.getBoundingClientRect();
      const transcriptRect = element.closest('[data-part="timeline-scroll"]')?.getBoundingClientRect();
      const point = document.elementFromPoint(rect.left + Math.min(8, rect.width / 2), rect.top + Math.min(8, rect.height / 2));
      return { text: element.textContent ?? "", rect: rect.toJSON(), transcriptRect: transcriptRect?.toJSON() ?? null, hit: Boolean(point && (point === element || element.contains(point))), expected };
    }, useMarker ? observerMarker : observerLatestSource);
    if (!mobileMarker.text.includes(expectedEvidence) || !mobileMarker.transcriptRect || mobileMarker.rect.top < mobileMarker.transcriptRect.top || mobileMarker.rect.bottom > mobileMarker.transcriptRect.bottom || !mobileMarker.hit)
      throw new Error(`observer active chat evidence is not readable in open sheet: ${JSON.stringify(mobileMarker)}`);
    if (new URL(observerPage.url()).pathname !== routeUnderneath) throw new Error("observer active chat changed the route");
    await observerPage.screenshot({ path: join(screenshotDir, "observer-active-chat-390x760.png"), fullPage: true });
    await observerPage.setViewportSize({ width: 1440, height: 900 });
    await waitFor(async () => {
      const state = await observerPage.evaluate((expected) => {
        const bar = document.querySelector<HTMLElement>(".page-chat-bar");
        const surface = document.querySelector<HTMLElement>(".page-view.docked .page-chat-surface");
        const evidenceElement = [...document.querySelectorAll<HTMLElement>('.page-chat-surface [data-part="message"]')].find((element) => element.textContent?.includes(expected));
        const visible = (element: HTMLElement | null) => {
          if (!element) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const rail = surface?.closest(".page-chat-docked");
        const evidenceRect = evidenceElement?.getBoundingClientRect();
        const point = evidenceRect && document.elementFromPoint(evidenceRect.left + Math.min(8, evidenceRect.width / 2), evidenceRect.top + Math.min(8, evidenceRect.height / 2));
        return {
          mobileQuery: matchMedia("(width < 1280px)").matches,
          barVisible: visible(bar),
          docked: rail?.getBoundingClientRect().width === 360 && getComputedStyle(rail).borderLeftWidth === "1px",
          surfaceVisible: visible(surface),
          surfaceRole: surface?.getAttribute("role"),
          surfaceAriaModal: surface?.getAttribute("aria-modal"),
          evidenceVisible: visible(evidenceElement),
          evidenceHit: Boolean(point && evidenceElement && (point === evidenceElement || evidenceElement.contains(point))),
          evidenceInsideSurface: Boolean(surface && evidenceElement && surface.contains(evidenceElement)),
        };
      }, expectedEvidence);
      return desktopPageChatProof(state);
    }, "observer desktop docked page chat and evidence settled");
    await observerPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await observerPage.screenshot({ path: join(screenshotDir, "observer-active-chat-1440x900.png"), fullPage: true });
  }
  const takeControl = observerBanner.getByRole("button", { name: "take control", exact: true });
  const helloRoles = () => observerSockets.filter((row) => row.direction === "sent" && row.method === "hello").map((row) => row.role).join(",");
  await takeControl.click();
  const takeoverReason = observerPage.getByText(/^at .{1,15} another tab had control\. a chat tab keeps it while it is open; try again after it finishes or closes\.$/);
  await gateWait.playwright(takeoverReason, "waitFor", { state: "visible", timeout: 20_000 });
  if (helloRoles() !== "controller,observer,controller" || observerSockets.some((row) => row.role === "observer" && row.lifecycle === "closed")) throw new Error(`refused takeover did not retain its live observer: ${helloRoles()}`);
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "observer-refused-1440x900.png") });
  await setupMobileSheet(observerPage, 844);
  const observerMenu = observerPage.getByRole("button", { name: "open menu", exact: true });
  const bannerBox = await observerBanner.boundingBox();
  const menuBox = await observerMenu.boundingBox();
  if (!bannerBox || !menuBox || bannerBox.y + bannerBox.height > menuBox.y) throw new Error("observer banner overlapped the mobile header");
  await observerMenu.focus();
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "observer-refused-390x844.png") });
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  await page.close();
  const takeoverStart = observerSockets.length;
  await takeControl.click();
  await waitFor(async () => await observerComposer.isVisible() && await observerComposer.isEditable({ timeout: 1_000 }), "editable composer after take control without reload");
  const controllerHello = observerSockets.slice(takeoverStart).find((row) => row.role === "controller" && row.helloAccepted);
  if (!controllerHello) throw new Error("controller hello was not accepted after closing the controller tab");
  const missingFeatures = ["library_read_v1", "library_write_v1", "session_history_read_v1", "state_read_v1", "home_settings_v1", TELEMETRY_FEATURE]
    .filter((feature) => !controllerHello.helloFeatures?.includes(feature));
  if (missingFeatures.length) throw new Error(`pinned zeta did not negotiate: ${missingFeatures.join(", ")}`);
  if (await observerBanner.isVisible() || await takeoverReason.isVisible()) throw new Error("observer banner or refusal reason remained after take control");
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "observer-takeover-no-reload-1440x900.png") });
  await waitFor(async () => observerSockets.some((row) => row.role === "observer" && row.lifecycle === "closed"), "promoted controller released its observer socket");
  if (helloRoles() !== "controller,observer,controller,controller") throw new Error(`takeover role sequence mismatch: ${helloRoles()}`);
  await observerPage.reload({ waitUntil: "domcontentloaded" });
  await gateWait.playwright(observerPage.locator(`[data-session-id="${controllerChat}"]`), "waitFor", { state: "attached" });
  const restoredMutation = "restored controller mutation";
  const restoredField = observerPage.getByRole("textbox", { name: "message", exact: true });
  await gateWait.playwright(restoredField, "waitFor", { state: "visible" });
  if (!await restoredField.isEditable()) throw new Error("restored controller composer remained read-only");
  await restoredField.fill(restoredMutation);
  await restoredField.press("Enter");
  await waitFor(async () => observerFrames.some(({ direction, payload }) => direction === "sent" && payload.includes('"method":"send"')), "restored controller mutation");
  const settingsBeforeRestore = await observerPage.evaluate(() => JSON.stringify({ ...localStorage }));
  await observerPage.keyboard.press(appShortcut("Comma"));
  const restoredVim = observerPage.getByRole("switch", { name: "vim mode", exact: true });
  if (await restoredVim.count()) {
    const before = await restoredVim.getAttribute("aria-checked");
    await restoredVim.click();
    await gateWait.playwright(observerPage, "waitForFunction", (expected) => localStorage.getItem("achilles-settings")?.includes(`\"vim\":${expected}`), before !== "true");
    await waitFor(async () => await restoredVim.getAttribute("aria-checked") !== before, "restored vim toggle");
    await restoredVim.click();
  }
  const settingsAfterRestore = await observerPage.evaluate(() => JSON.stringify({ ...localStorage }));
  if (settingsAfterRestore === settingsBeforeRestore) throw new Error("restored controller settings did not write");
  await observerPage.evaluate((snapshot) => { localStorage.clear(); for (const [key, value] of Object.entries(JSON.parse(snapshot) as Record<string, string>)) localStorage.setItem(key, value); }, settingsBeforeRestore);
  if (await observerPage.evaluate(() => JSON.stringify({ ...localStorage })) !== settingsBeforeRestore) throw new Error("restored controller settings did not restore reversibly");
  if (screenshotDir) {
    await observerPage.locator('[data-part="timeline-scroll"]').evaluate((element) => { element.scrollTop = 0; });
    await observerPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await observerPage.screenshot({ path: join(screenshotDir, "observer-controller-restored-1440x900.png"), fullPage: true });
  }

  const connectionHelloRoles = connectionRows.filter((row) => row.direction === "sent" && row.method === "hello").map((row) => row.role);
  if (!connectionHelloRoles.includes("controller")) throw new Error(`controller websocket role was not captured: ${connectionHelloRoles.join(",")}`);
  if (errors.length) throw new Error(`browser errors: ${redact(errors.join(" | "))}`);
  const captured = [...logs.values()].join("\n");
  if (secrets.some((secret) => captured.includes(secret) || errors.some((error) => error.includes(secret)))) throw new Error("captured output contains a zeta token");
  await recordRenderedWriteSurfaces(observerPage);
  const observed = [...renderedWriteSurfaceIds].sort();
  const registry = [...registryWriteSurfaceIds].sort();
  const unknown = observed.filter((id) => !registry.includes(id));
  if (!observed.length || unknown.length) throw new Error(`invalid browser write-surface sample: ${JSON.stringify({ observed, unknown })}`);
  if (screenshotDir) {
    await writeFile(join(screenshotDir, "manifest.json"), JSON.stringify({
      head: (await Bun.$`git rev-parse HEAD`.text()).trim(),
      base: (await Bun.$`git rev-parse origin/main`.text()).trim(),
      clean: (await Bun.$`git status --porcelain`.text()).trim() === "",
      command: "ZETA_CHECKOUT=$PWD/.cache/zeta bun scripts/real-zeta-gate.ts",
      origin,
      zeta: zetaRef,
      timestamps: { started: new Date().toISOString(), completed: new Date().toISOString() },
      viewports: ["390x760", "390x844", "1280x900", "1440x900", "1920x900"],
      routes: [new URL(observerPage.url()).pathname, "/telemetry", "/connections"],
      states: ["observer-a", "observer-b-after-failed-takeover", "controller-c-restored", "telemetry-observer"],
      artifacts: ["page-chat-closed-390x844.png", "page-chat-open-390x760.png", "state-page-chat-closed-1280.png", "state-page-chat-closed-1440.png", "state-page-chat-closed-1920.png", "observer-active-chat-390x760.png", "observer-active-chat-1440x900.png", "observer-controller-restored-1440x900.png", "observer-takeover-no-reload-1440x900.png", ...telemetryArtifacts, ...mcpWriteArtifacts, ...mcpAddArtifacts, ...mcpTestArtifacts, ...mcpOAuthArtifacts, ...agentControlArtifacts],
      writeSurfaceRegistry: registry,
      renderedWriteSurfaceIds: observed,
      unobservedWriteSurfaceIds: registry.filter((id) => !renderedWriteSurfaceIds.has(id)),
      errors,
      failedRequests: [],
      websocket: { connectionRows, observerSockets },
      http: observerHttp,
      storage: { before: observerStorageBefore, restored: await observerPage.evaluate(() => JSON.stringify({ ...localStorage })) },
      privacy: { secretsRedacted: true, tokensPresent: false },
      cleanup: "browser, servers, and temporary homes are removed in finally",
    }, null, 2) + "\n");
    await writeFile(join(screenshotDir, "run-proof.md"), `# observer fallback evidence\n\n- exact head: ${(await Bun.$`git rev-parse HEAD`.text()).trim()}\n- zeta pin: ${zetaRef}\n- final captures: observer-active-chat-390x760.png, observer-active-chat-1440x900.png, observer-controller-restored-1440x900.png, observer-refused-390x844.png, observer-refused-1440x900.png, observer-settings-1440x900.png, observer-takeover-no-reload-1440x900.png\n- registry: ${registryWriteSurfaceIds.length} ids\n- rendered ids observed: ${renderedWriteSurfaceIds.size}\n- websocket roles: ${observerSockets.filter((row) => row.direction === "sent" && row.method === "hello").map((row) => row.role).join(" → ")}\n- observer and rejected-controller mutation checks: passed\n- controller restoration send and reversible settings mutation: passed\n`);
  }
  await gateCreatePlace(observerPage, origin, gateWait);
  if (process.env.SCREENSHOT_PATH) await observerPage.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  passed = true;
  console.log(`real-zeta gate passed: session ${first}, created /reading with tools, late call rejected`);

  }
} finally {
  // the last live server's tokens, read before shutdown and rm(temp) remove its discovery file.
  for (const path of [ownDiscovery, sharedDiscovery]) await readDiscovery(path).catch(() => {});
  try {
    await browser?.close().catch(() => {});
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(
              () => reject(new Error("child did not exit after SIGTERM")),
              5000,
            );
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
    await rm(temp, { recursive: true, force: true });
  } finally {
    if (!passed) await writeArtifacts().catch((error) => console.error(`gate artifacts not written: ${error}`));
  }
}
