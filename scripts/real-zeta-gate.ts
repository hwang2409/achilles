import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Locator, Route } from "../apps/web/node_modules/playwright";
import { appShortcut, clickOptionalDetachedLocator, controlSnapshot, writeControl, createFrameRing, createGateWait, diagnostic, redactArtifact } from "./gate-diagnostics";
import { gateShell } from "./gate-shell";
import { gateReloadMidTurn, gateTranscript, waitForIdleTurn } from "./gate-transcript";
import { approvalModeWaiter, assertServerAskWins, gateCreationApprovalDefaults, gateSettings } from "./gate-settings";
import { gatePalette } from "./gate-palette";
import { gateVim } from "./gate-vim";

import { expectBrowserErrors } from "./browser-errors";

const root = new URL("..", import.meta.url).pathname;
const metricBoundaryMatrix = JSON.parse(await readFile(join(root, "apps/web/src/metric-boundary-matrix.json"), "utf8")) as Array<{ label: string; value: string; expectedText: string; classification: string; status?: string }>;
const { chromium } = await import(pathToFileURL(join(root, "apps/web/node_modules/playwright/index.mjs")).href);
const zeta = process.env.ZETA_CHECKOUT ?? join(root, ".cache/zeta");
const zetaRef = (await readFile(join(root, "zeta.rev"), "utf8")).trim();
if (!/^[0-9a-f]{40}$/.test(zetaRef))
  throw new Error("zeta.rev must contain one sha");
const temp = await mkdtemp(join(tmpdir(), "achilles-v3-"));
const zetaHome = join(temp, "zeta-home");
const achillesHome = join(temp, "achilles-home");
const ownDiscovery = join(achillesHome, "run/serve.json");
const sharedDiscovery = join(zetaHome, "run/serve.ws.json");
const cwd = join(temp, "cwd");
const control = join(temp, "control.json");
const port = 5200 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const children: ChildProcess[] = [];
const logs = new Map<ChildProcess, string>();
const secrets: string[] = [];
// failure-only CI artifacts: one stamped log per process instance and the full websocket frame log.
const artifactDir = process.env.GATE_ARTIFACT_DIR ?? join(root, ".cache/gate-artifacts");
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
let browser;
try {
  await Bun.spawn(["git", "init", cwd]).exited;
  await mkdir(join(achillesHome, "run"), { recursive: true, mode: 0o700 });
  await Bun.write(join(cwd, "fixture.txt"), "synthetic fixture\n");
  const env = {
    ...process.env,
    PYTHONPATH: zeta,
    ZETA_HOME: zetaHome,
    ACHILLES_HOME: achillesHome,
    ZETA_PROOF_WORKTREE: root,
    ZETA_PROOF_CWD: cwd,
    ZETA_PROOF_CONTROL: control,
    ZETA_PROOF_DISCOVERY: ownDiscovery,
    ZETA_PROOF_ORIGIN: origin,
    ACHILLES_ZETA_DISCOVERY: ownDiscovery,
    ACHILLES_APPROVAL: "ask",
  };
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
      "from achilles.web import _database; import json; db=_database(); db.execute(\"UPDATE page SET zeta_session_id='stale-session-id' WHERE id='home'\"); row=db.execute(\"SELECT document FROM layout_version WHERE page_id='home' ORDER BY version DESC LIMIT 1\").fetchone(); layout=json.loads(row[0]) if row else {'blocks':[]}; layout['blocks'].append({'type':'list','title':'trace annotations','collection':'trace_annotations'}); db.execute(\"INSERT OR IGNORE INTO layout_version VALUES('home',1,'gate',?,datetime('now'))\", (json.dumps(layout),)); db.execute(\"UPDATE layout_version SET document=? WHERE page_id='home' AND version=1\", (json.dumps(layout),)); db.executemany(\"INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)\", [(f'gate-page-{i}', f'/gate-page-{i}', f'gate page {i}', f'2025-01-{i:02d}', f'2025-01-{i:02d}') for i in range(1,46)]); db.commit(); db.close()",
    ],
    env,
  );
  await new Promise<void>((resolve, reject) => {
    seed.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`seed exited ${code}`)),
    );
  });
  let app = start(
    "uv",
    ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)],
    appEnv,
  );
  await waitFor(
    async () =>
      await fetch(origin).then(
        (r) => r.ok,
        () => false,
      ),
    "achilles",
  );
  browser = await chromium.launch({ headless: true });
  let page = await browser.newPage();
  const errors: string[] = [];
  const requestFailures: string[] = [];
  const consoleErrors: string[] = [];
  const requestPath = (url: string) => { try { return new URL(url).pathname; } catch { return "<invalid-url>"; } };
  const expectedNotFoundUrl = `${origin}/api/pages/not-a-real-page`;
  const discoveryUrl = `${origin}/api/zeta/discovery`;
  const frames: string[] = [];
  let nextSocket = 0;
  page.on("websocket", (socket) => {
    const socketId = nextSocket++;
    socket.on("framesent", (event) => { const payload = String(event.payload); frames.push(payload); frameLog.push([new Date().toISOString(), socketId, "sent", payload]); frameRing.record(socketId, "sent", payload); });
    socket.on("framereceived", (event) => { const payload = String(event.payload); frames.push(payload); frameLog.push([new Date().toISOString(), socketId, "received", payload]); frameRing.record(socketId, "received", payload); });
  });
  page.on("pageerror", (e) => errors.push(`${e.message}${requestFailures.length ? `; latest request failure: ${requestFailures.at(-1)}` : ""}${consoleErrors.length ? `; latest console error: ${consoleErrors.at(-1)}` : ""}`));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${requestPath(request.url())}: ${request.failure()?.errorText ?? "unknown failure"}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${requestPath(message.location().url)}: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const captureBlockState = async (state: string, target: Locator, mobileHeight = 760, desktopHeight = 900, assertFrame?: (viewport: string) => Promise<void>) => {
    for (const width of [390, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? mobileHeight : desktopHeight });
      if (width === 390) {
        const pageChatClose = page.getByRole("button", { name: "close page chat", exact: true });
        await clickOptionalDetachedLocator(pageChatClose);
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
          const x = Math.max(box.left + 1, Math.min(box.right - 1, innerWidth / 2));
          const y = Math.max(box.top + 1, Math.min(box.bottom - 1, innerHeight / 2));
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && (hit === element || element.contains(hit)));
        }), `state ${state} target visible and unobscured`);
      }
      await page.evaluate(() => { scrollTo(0, 0); document.querySelector<HTMLElement>(".page-content")?.scrollTo(0, 0); });
      if (assertFrame) await assertFrame(`${width}px`);
      const captureName = state === "metric-boundary"
        ? `metric-boundary-after-${width}x${width === 390 ? mobileHeight : desktopHeight}.png`
        : state === "page-chat-closed" && width === 390
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
      mobileQuery: matchMedia("(max-width: 1099px) and (min-height: 501px)").matches,
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
  await page.getByRole("button", { name: "new chat", exact: true }).click();
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
  const connected = await fetch(discoveryUrl).then((response) => response.json()) as { url: string };
  if (sharedProcess.exitCode !== null || zetaProcess.exitCode !== null) throw new Error("one of the unrelated zeta serves exited during chat");
  if (shared.pid === own.pid || shared.port === own.port) throw new Error("shared and achilles zeta serves did not remain distinct");
  if (new URL(connected.url).port !== String(own.port)) throw new Error("achilles connected to the shared zeta serve");
  const firstSetSettingsBeforeReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  const second = await gateShell(page, first, waitFor, gateWait);
  const focusPaginationSeed = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.executemany(\"INSERT INTO chat(session_id,page_id,title,created_at,updated_at) VALUES(?,'home',?,'2020-01-01T00:00:00Z',?)\", [(f'older-{i:03}', f'older chat {i:02}', f'2020-01-01T00:{i:02}:00Z') for i in range(55)]); db.commit(); db.close()"], env);
  if (!(await waitForExit(focusPaginationSeed, 10_000)) || focusPaginationSeed.exitCode !== 0)
    throw new Error(`focus pagination seed exited ${focusPaginationSeed.exitCode}`);
  const assertActive = async (name: string, target: Locator) => {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      return { tag: element?.tagName, text: element?.textContent?.trim().slice(0, 120), data: element ? Object.fromEntries([...element.attributes].filter((attribute) => attribute.name.startsWith("data-")).map((attribute) => [attribute.name, attribute.value])) : {} };
    });
    throw new Error(`${name} focused ${JSON.stringify(active)}`);
  };
  const reloadShell = async () => {
    await page.reload();
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
        await reloadShell();
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
        await reloadShell();
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
        await reloadShell();
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
          await gateWait.playwright(page.getByText("could not load pages", { exact: true }), "waitFor");
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
        await reloadShell();
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
      name: "target removed before commit",
      run: async () => {
        await reloadShell();
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
        const showMore = page.getByRole("button", { name: "show more pages" });
        await gateWait.playwright(showMore, "waitFor");
        await showMore.click();
        await waitFor(async () => seen, "continuation request was not made");
        const heading = page.locator(".page-list > .list-head");
        await heading.focus();
        await page.keyboard.press("Enter");
        const continued = gateWait.playwright(page, "waitForResponse", (response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        release();
        await continued;
        await page.unroute("**/api/pages?**", holdContinuation);
        await gateWait.playwright(page.locator('.page-list[data-list-state="ready"]:not([data-loaded-count="20"])'), "waitFor", { timeout: 20_000 });
        await page.keyboard.press("Enter");
        await assertActive("target removed before commit", heading);
      },
    },
    {
      name: "drawer open",
      run: async () => {
        await reloadShell();
        await page.setViewportSize({ width: 390, height: 760 });
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
  const modeToggle = page.getByRole("button", { name: "create mode off", exact: true });
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
  const toggleClick = modeToggle.click();
  try {
    await waitFor(async () => toggleReached, "create mode toggle request");
    const pendingMode = page.getByRole("button", { name: "turning on create mode…", exact: true });
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
  await gateWait.playwright(page.getByRole("button", { name: "create mode on", exact: true }), "waitFor");
  if ((await page.getByRole("button", { name: "create mode on" }).getAttribute("aria-pressed")) !== "true")
    throw new Error("create mode toggle did not show on");
  await waitFor(async () => (await catalogReady.count()) > catalogReadyBefore && ((JSON.parse(await Bun.file(control).text()).request_count ?? 0) > catalogRequestBefore), "catalog ready");
  if (pageIndexRequests.length !== pageRequestsBeforeStreamingTurn)
    throw new Error(`streaming turn made ${pageIndexRequests.length - pageRequestsBeforeStreamingTurn} extra /api/pages requests`);
  const backendSchemas = JSON.parse(await Bun.file(control).text()).schemas ?? [];
  if (!backendSchemas.includes("achilles__create_tool"))
    throw new Error(
      `backend did not receive achilles__create_tool catalog: ${JSON.stringify(backendSchemas)}`,
    );
  const createApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "create_page" });
  const createApprovalBefore = await createApproval.count();
  const createRequestBefore = (JSON.parse(await Bun.file(control).text()).request_count ?? 0) as number;
  const pageRequestsBeforeCreate = pageIndexRequests.length;
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
  await gateWait.playwright(page.locator(".run-state").getByText("idle", { exact: true }), "waitFor", { timeout: 20_000 });
  if (pageIndexRequests.length - pageRequestsBeforeCreate !== 1)
    throw new Error(`create_page made ${pageIndexRequests.length - pageRequestsBeforeCreate} /api/pages refetches, expected 1`);
  if (screenshotDir) {
    await page.screenshot({ path: join(screenshotDir, "page-index-1440x900.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 760 });
    await page.screenshot({ path: join(screenshotDir, "page-index-1440x760.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 760 });
    await page.screenshot({ path: join(screenshotDir, "page-index-390x760.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  console.log("page links at create completion", await page.locator(".page-list a").evaluateAll((links) => links.map((link) => ({ href: (link as HTMLAnchorElement).href, text: link.textContent }))));
  console.log("tool call names", await page.locator('[data-part="timeline-frame"]').evaluateAll((frames) => [...new Set(frames.flatMap((frame) => frame.textContent?.match(/(?:achilles__)?create_page/g) ?? []))]));
  const pageSection = page.locator(".page-list");
  const pageHeading = pageSection.locator(":scope > .list-head");
  const pageRowHeight = await page.locator(".page-list a").first().evaluate((element) => element.getBoundingClientRect().height);
  const pageSectionHeight = await pageSection.evaluate((element) => element.clientHeight);
  if (pageSectionHeight < pageRowHeight * 3 || !(await pageHeading.isVisible())) throw new Error(`page section is too short or heading is hidden: ${pageSectionHeight}px for ${pageRowHeight}px rows`);
  const pageCount = pageHeading.locator("b");
  if ((await pageCount.textContent()) !== "20+") throw new Error(`page count should show 20+ while continuation exists: ${await pageCount.textContent()}`);
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
  await pageHeading.focus();
  await page.keyboard.press("Enter");
  const collapsedHeight = await pageSection.evaluate((element) => element.clientHeight);
  const headingHeight = await pageHeading.evaluate((element) => element.getBoundingClientRect().height);
  if (collapsedHeight > headingHeight + 12) throw new Error(`collapsed page section kept reserved space: ${collapsedHeight}px for ${headingHeight}px heading`);
  await pageHeading.focus();
  await page.keyboard.press("Enter");
  await pageSection.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await secondBatchPage.click();
  await gateWait.playwright(page, "waitForURL", (url) => new URL(url).pathname === "/gate-page-27");
  await page.goto(origin);
  const readingLink = page.locator('.page-list a[href^="/reading"]');
  await gateWait.playwright(readingLink, "waitFor", { timeout: 20000 });
  const chatsBeforeReading = await chatCount();
  const sessionsBeforeReading = zetaSessionCount();
  await readingLink.click({ timeout: 20_000 });
  await gateWait.playwright(page, "waitForURL", (url) => new URL(url).pathname === "/reading", { timeout: 20_000 });
  await gateWait.playwright(page.getByText("reading list layout", { exact: true }), "waitFor", { state: "visible", timeout: 20_000 }).catch(async (error) => {
    throw new Error(`${error}\ncreated page layout did not appear before chat creation: ${redact(await page.locator("body").innerText())}; errors=${redact(errors.join(" | "))}; console=${redact(consoleErrors.join(" | "))}`);
  });
  if ((await page.getByText("loading chat…", { exact: true }).count()) || await chatCount() !== chatsBeforeReading || zetaSessionCount() !== sessionsBeforeReading)
    throw new Error("created page layout did not appear before chat creation");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "created-page-before-first-send.png"), fullPage: true, timeout: 20_000 });
  await field.fill("open created page", { timeout: 20_000 });
  await field.press("Enter", { timeout: 20_000 });
  await gateWait.playwright(page.getByText("new page ready", { exact: true }), "waitFor", { timeout: 20_000 });
  await gateWait.playwright(page.locator(".run-state").getByText("idle", { exact: true }), "waitFor", { timeout: 20_000 });
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
  await gateWait.playwright(page.locator(".run-state").getByText("idle", { exact: true }), "waitFor", { timeout: 20_000 });
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
  await gateWait.playwright(page.locator(".run-state").getByText("idle", { exact: true }), "waitFor", { timeout: 20_000 });
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
    homeInspectValue.layout_version !== 1 ||
    homeInspectValue.tools?.[0]?.name !== "add_book" ||
    JSON.stringify(homeInspectValue).includes("credentials") ||
    JSON.stringify(homeInspectValue).includes(achillesHome)
  )
    throw new Error(`home inspect_page summary mismatch: ${JSON.stringify(homeInspectValue)}`);
  const theme = process.env.GATE_THEME ?? "gruvbox-dark";
  await page.goto(`${origin}/reading?theme=${encodeURIComponent(theme)}`);
  const themeProof = await page.evaluate(() => ({ requested: new URL(location.href).searchParams.get("theme"), applied: document.documentElement.dataset.fulcrumTheme ?? "auto" }));
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
  const accessibility = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 390, height: 760 });
  const textMetric = page.locator(".metric-block").filter({ has: page.locator(".metric-label", { hasText: "review status" }) });
  const textMetricGeometry = await textMetric.evaluate((element) => ({
    blockScrollWidth: element.scrollWidth,
    blockClientWidth: element.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
  }));
  if (await textMetric.locator("strong").innerText() !== "waiting on an intentionally long legal and editorial review" || textMetricGeometry.blockScrollWidth > textMetricGeometry.blockClientWidth || textMetricGeometry.documentScrollWidth > textMetricGeometry.viewportWidth)
    throw new Error(`long nonnumeric metric overflowed at 390px: ${JSON.stringify(textMetricGeometry)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "metric-boundary-after-390x844.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "metric-boundary-after-1440x900.png"), fullPage: true });
  const readingMetric = page.locator(".metric-block").filter({ has: page.getByText("reading", { exact: true }) });
  await gateWait.playwright(readingMetric.locator("strong").filter({ hasText: "0" }), "waitFor");
  const booksList = page.locator('.record-list[data-collection="books"]');
  await gateWait.playwright(booksList.getByText("no books yet", { exact: true }), "waitFor", { timeout: 20_000 });
  if (await booksList.locator("header .record-count").innerText() !== "0" || await booksList.getByText("sorted by updated", { exact: true }).count())
    throw new Error("empty books state showed the wrong count or sort label");
  const addBook = booksList.getByRole("button", { name: "add a book", exact: true });
  await addBook.click();
  if (!(await page.locator('.record-form[data-collection="books"][data-operation="insert"] input[name="title"]').evaluate((element) => document.activeElement === element)))
    throw new Error("empty books add action did not focus the insert form");
  const desktopComposer = page.locator('#message-composer textarea[aria-label="message"], #message-composer [role="textbox"]');
  await booksList.getByRole("button", { name: "ask the chat", exact: true }).click();
  await waitFor(async () => (await desktopComposer.inputValue()) === "add a book to this page", "desktop empty-state chat draft");
  if (!(await desktopComposer.evaluate((element) => document.activeElement === element))) throw new Error("empty-state chat action did not focus the composer");
  if ((JSON.parse(await Bun.file(control).text()).requests ?? []).some((request: { method?: string; params?: { text?: string } }) => request.method === "send" && request.params?.text === "add a book to this page")) throw new Error("empty-state chat action sent a message");
  await desktopComposer.fill("");
  await captureBlockState("a-empty", booksList.locator(".record-list-empty"));

  const recordsPattern = `**/api/pages/${createdPage.id}/records/books?*`;
  await page.route(recordsPattern, async (route) => {
    try {
      const response = await route.fetch();
      if (new URL(route.request().url()).searchParams.get("limit") === "100") await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.fulfill({ response });
    } catch (error) {
      if (!String(error).includes("already handled")) throw error;
    }
  });
  await page.reload();
  await gateWait.playwright(page.getByText("books loading…", { exact: true }), "waitFor", { timeout: 20_000 });
  if (await booksList.getByText("no books yet", { exact: true }).count()) throw new Error("loading state flashed the empty state");
  await captureBlockState("b-loading", booksList.locator('[role="status"]'));
  await page.unroute(recordsPattern);

  let failRecords = true;
  await page.route(recordsPattern, async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") === "100" && failRecords) {
      failRecords = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.reload();
  await gateWait.playwright(booksList.getByText("books request failed: Failed to fetch. your data is safe; nothing was changed.", { exact: true }), "waitFor", { timeout: 20_000 });
  await captureBlockState("c-failed", booksList.locator('[role="alert"]'));
  await booksList.getByRole("button", { name: "try again", exact: true }).click();
  await gateWait.playwright(booksList.getByText("no books yet", { exact: true }), "waitFor", { timeout: 20_000 });
  await page.unroute(recordsPattern);

  await page.getByRole("button", { name: "create mode off", exact: true }).click();
  await gateWait.playwright(page.getByRole("button", { name: "create mode on", exact: true }), "waitFor");
  const readingPageCredential = (await Bun.file(join(achillesHome, "credentials", createdPage.id)).text()).trim();
  secrets.push(readingPageCredential);
  await homeMcp(29, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "block-state-gate", version: "1" },
  }, readingPageCredential);
  const updateLayoutSchema = await homeMcp(30, "tools/list", {}, readingPageCredential);
  const updateLayoutTool = updateLayoutSchema.result?.tools?.find((tool: { name: string }) => tool.name === "update_layout") as { inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } } | undefined;
  const updateLayoutProperties = updateLayoutTool?.inputSchema?.properties;
  if (
    !updateLayoutTool ||
    updateLayoutProperties?.layout?.type !== "object" ||
    updateLayoutProperties.expected_version?.type !== "integer" ||
    JSON.stringify(Object.keys(updateLayoutProperties).sort()) !== JSON.stringify(["expected_version", "layout"]) ||
    JSON.stringify([...updateLayoutTool.inputSchema.required ?? []].sort()) !== JSON.stringify(["expected_version", "layout"])
  ) throw new Error(`reading page exposed an unexpected update_layout schema: ${JSON.stringify(updateLayoutSchema)}`);
  const dLayout = structuredClone(homeInspectValue.layout) as { blocks: Array<Record<string, unknown>> };
  dLayout.blocks.push({ type: "form", title: "update book", tool: "update_book" });
  const updatedD = await homeMcp(31, "tools/call", { name: "update_layout", arguments: { layout: dLayout, expected_version: homeInspectValue.layout_version } }, readingPageCredential);
  if (updatedD.result?.isError) throw new Error(`real D update_layout failed: ${JSON.stringify(updatedD)}`);
  await page.reload();
  const updateHeading = page.getByRole("heading", { name: /update book/ });
  await gateWait.playwright(updateHeading, "waitFor", { timeout: 20_000 });
  const disabledTitle = page.locator('.record-form[data-operation="update"] input[name="title"]');
  if (!(await disabledTitle.isDisabled()) || (await disabledTitle.getAttribute("placeholder")) !== "—") throw new Error("no-selection update form did not disable its real field with a placeholder");
  if (!(await page.getByRole("button", { name: "add", exact: true }).last().isDisabled())) throw new Error("no-selection update form save was not disabled");
  if (screenshotDir) {
    await captureBlockState("d-no-selection", page.locator('.record-form[data-operation="update"]'));
    const proofPath = join(screenshotDir, "run-proof.txt");
    await writeFile(proofPath, `${await Bun.file(proofPath).text()}D production path: visible create mode off control clicked; waited for create mode on; authenticated reading-page tools/list exposed update_layout; real update_layout published the complete inspected layout with the update form; waited for the real page reload and attached disabled form; visible create mode on control clicked and waited for create mode off before later journey assertions.\n`);
  }
  // D temporarily enables create mode to publish the real layout update. restore it before the later gate journey even when screenshots are disabled.
  await page.getByRole("button", { name: "create mode on", exact: true }).click();
  await gateWait.playwright(page.getByRole("button", { name: "create mode off", exact: true }), "waitFor");

  await page.setViewportSize({ width: 1440, height: 1400 });
  const desktopViewport = page.viewportSize();
  const matrixStrip = page.locator(".metric-strip").first();
  const matrixBlocks = matrixStrip.locator(".metric-block");
  const assertMetricMatrix = async (viewport: string) => {
    const entries = await matrixBlocks.evaluateAll((elements, expected) => {
      const snapshotGrid = (elements: Element[]) => {
        const strip = document.querySelector<HTMLElement>(".metric-strip");
        const cellElements = [...(strip?.querySelectorAll<HTMLElement>(".metric-block") ?? [])];
        const cells = cellElements.map((cell) => cell.getBoundingClientRect()).sort((a, b) => a.top - b.top || a.left - b.left);
        const rows: DOMRect[][] = [];
        for (const cell of cells) {
          const row = rows.find((candidate) => Math.abs(candidate[0]!.top - cell.top) <= 0.5);
          if (row) row.push(cell); else rows.push([cell]);
        }
        return { strip, cellElements, cells, rows };
      };
      const hasContinuousTopology = ({ cells, rows }: ReturnType<typeof snapshotGrid>) => {
        const continuousRows = rows.every((row) => row.sort((a, b) => a.left - b.left).every((cell, index) => index === 0 || Math.abs(cell.left - row[index - 1]!.right) <= 0.5));
        const columns = new Map<number, DOMRect[]>();
        for (const cell of cells) {
          const key = Math.round(cell.left * 2) / 2;
          columns.set(key, [...(columns.get(key) ?? []), cell]);
        }
        const continuousColumns = [...columns.values()].every((column) => column.sort((a, b) => a.top - b.top).every((cell, index) => index === 0 || Math.abs(cell.top - column[index - 1]!.bottom) <= 0.5));
        return continuousRows && continuousColumns;
      };
      const hasVisibleInsetShadow = (shadow: string, xOffset: number, yOffset: number) => {
        const shadows = [...shadow.matchAll(/((rgba?\([^)]*\)|hsla?\([^)]*\)|#[\da-f]+|[a-z]+)\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?\s+inset)/gi)];
        return shadows.some(([, , color, x, y, blur, spread]) => {
          const alpha = color?.startsWith("rgba") || color?.startsWith("hsla") ? Number(color.match(/,\s*([\d.]+)\s*\)$/)?.[1] ?? 1) : color === "transparent" ? 0 : 1;
          return alpha > 0 && Number(x) === xOffset && Number(y) === yOffset && Number(blur) === 0 && Number(spread ?? 0) === 0;
        });
      };
      const hasCellRightSeparator = (cell: HTMLElement) => hasVisibleInsetShadow(getComputedStyle(cell).boxShadow, -1, 0);
      const hasCellBottomSeparator = (cell: HTMLElement) => hasVisibleInsetShadow(getComputedStyle(cell).boxShadow, 0, -1);
      const hasCellOwnedSeparators = ({ cellElements }: ReturnType<typeof snapshotGrid>) => cellElements.length > 0 && cellElements.every((cell) => hasCellRightSeparator(cell) && hasCellBottomSeparator(cell));
      const hasUnusedTrackPaint = ({ strip, rows }: ReturnType<typeof snapshotGrid>) => {
        if (!strip) return false;
        const stripStyle = getComputedStyle(strip);
        const finalRow = rows.at(-1) ?? [];
        const stripBox = strip.getBoundingClientRect();
        const trackSizes = stripStyle.gridTemplateColumns.split(/\s+/).map(Number.parseFloat);
        const trackCount = trackSizes.length;
        const usedTrackCount = finalRow.length;
        const finalRowHeight = finalRow[0]?.height ?? 0;
        const finalRowTop = finalRow[0]?.top ?? stripBox.bottom;
        const transparent = (color: string) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
        const pseudoPaint = (["::before", "::after"] as const).some((pseudo) => {
          const style = getComputedStyle(strip, pseudo);
          return style.content !== "none" || style.backgroundImage !== "none" || !transparent(style.backgroundColor) || style.borderTopWidth !== "0px" || style.borderRightWidth !== "0px" || style.borderBottomWidth !== "0px" || style.borderLeftWidth !== "0px" || style.boxShadow !== "none";
        });
        const unusedTracks = trackSizes.slice(usedTrackCount).map((width, index) => {
          const left = stripBox.left + strip.clientLeft + trackSizes.slice(0, usedTrackCount + index).reduce((sum, size) => sum + size, 0);
          const rect = { left, right: left + width, top: finalRowTop, bottom: finalRowTop + finalRowHeight };
          const point = { x: left + Math.min(width / 2, width - 1), y: rect.top + Math.min(finalRowHeight / 2, finalRowHeight - 1) };
          const hit = document.elementFromPoint(point.x, point.y);
          const occupied = grid.cellElements.some((cell) => {
            const cellBox = cell.getBoundingClientRect();
            return cellBox.left < rect.right && cellBox.right > rect.left && cellBox.top < rect.bottom && cellBox.bottom > rect.top;
          });
          return hit === strip && !occupied;
        });
        return stripStyle.backgroundImage === "none" && transparent(stripStyle.backgroundColor) && stripStyle.boxShadow === "none" && stripStyle.borderRightWidth === "0px" && stripStyle.borderBottomWidth === "0px" && !pseudoPaint && (trackCount === usedTrackCount || unusedTracks.length === trackCount - usedTrackCount && unusedTracks.every(Boolean));
      };
      const hasStripTopOwner = (strip: HTMLElement) => getComputedStyle(strip).borderTopWidth === "1px";
      const hasStripLeftOwner = (strip: HTMLElement) => getComputedStyle(strip).borderLeftWidth === "1px";
      const hasStripRightPaint = (strip: HTMLElement) => getComputedStyle(strip).borderRightWidth !== "0px" || !["", "0px"].includes(strip.style.getPropertyValue("border-right-width"));
      const hasStripBottomPaint = (strip: HTMLElement) => getComputedStyle(strip).borderBottomWidth !== "0px" || !["", "0px"].includes(strip.style.getPropertyValue("border-bottom-width"));
      const hasStripShadowPaint = (strip: HTMLElement) => getComputedStyle(strip).boxShadow !== "none";
      const hasStripOwnedEdges = ({ strip }: ReturnType<typeof snapshotGrid>) => Boolean(strip) && hasStripTopOwner(strip!) && hasStripLeftOwner(strip!) && !hasStripRightPaint(strip!) && !hasStripBottomPaint(strip!);
      const checkGrid = (grid: ReturnType<typeof snapshotGrid>) => hasContinuousTopology(grid) && hasStripOwnedEdges(grid) && hasCellOwnedSeparators(grid) && hasUnusedTrackPaint(grid);
      const proveMutations = (grid: ReturnType<typeof snapshotGrid>) => {
        const cell = grid.cellElements[0];
        const strip = grid.strip;
        const originalCellShadow = cell?.style.boxShadow ?? "";
        const originalStrip = strip ? { cssText: strip.style.cssText } : null;
        const mutationStyle = document.createElement("style");
        const expectRejected = (message: string, accepted: boolean) => {
          if (accepted) throw new Error(`grid gate accepted ${message}`);
        };
        try {
          if (cell) {
            cell.style.setProperty("box-shadow", "inset 0 -1px 0 var(--fulcrum-border)", "important");
            expectRejected("cell missing its right separator", hasCellRightSeparator(cell));
            cell.style.boxShadow = originalCellShadow;
            cell.style.setProperty("box-shadow", "inset -1px 0 0 var(--fulcrum-border)", "important");
            expectRejected("cell missing its bottom separator", hasCellBottomSeparator(cell));
          }
          if (strip) {
            strip.style.setProperty("border-top", "0", "important");
            expectRejected("strip missing its top owner", hasStripTopOwner(strip));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("border-left", "0", "important");
            expectRejected("strip missing its left owner", hasStripLeftOwner(strip));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("border-right-width", "1px", "important");
            expectRejected("strip right border paint", !hasStripRightPaint(strip));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("border-bottom-width", "1px", "important");
            expectRejected("strip bottom border paint", !hasStripBottomPaint(strip));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("box-shadow", "0 0 0 1px red", "important");
            expectRejected("strip shadow paint", !hasStripShadowPaint(strip));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("background-color", "red", "important");
            expectRejected("strip background color paint", hasUnusedTrackPaint(grid));
            strip.style.cssText = originalStrip!.cssText;
            strip.style.setProperty("background-image", "linear-gradient(red, red)", "important");
            expectRejected("strip background image paint", hasUnusedTrackPaint(grid));
            strip.style.cssText = originalStrip!.cssText;
          }
          mutationStyle.textContent = ".metric-strip::before { content: \"\"; background: red; }";
          document.head.append(mutationStyle);
          expectRejected("strip pseudo paint", getComputedStyle(strip!, "::before").content === "none");
        } finally {
          if (cell) cell.style.boxShadow = originalCellShadow;
          if (strip && originalStrip) strip.style.cssText = originalStrip.cssText;
          mutationStyle.remove();
        }
      };
      const grid = snapshotGrid(elements);
      const gridEdges = checkGrid(grid);
      if (gridEdges && innerWidth === 390) proveMutations(grid);
      return expected.map(({ label, value, expectedText, status: expectedStatus, classification }) => {
      const element = Array.from(elements).find((candidate) => candidate.querySelector(".metric-label")?.textContent === label);
      const block = element as HTMLElement | undefined;
      const labelNode = element?.querySelector<HTMLElement>(".metric-label");
      const rendered = element?.querySelector<HTMLElement>(".metric-value");
      const blockBox = block?.getBoundingClientRect();
      const labelBox = labelNode?.getBoundingClientRect();
      const valueBox = rendered?.getBoundingClientRect();
      const style = block ? getComputedStyle(block) : null;
      const renderedStyle = rendered ? getComputedStyle(rendered) : null;
      const clip = document.querySelector<HTMLElement>(".page-content")?.getBoundingClientRect();
      const points = [
        ...(blockBox ? [{ name: "top-left", x: blockBox.left + 1, y: blockBox.top + 1 }, { name: "top-right", x: blockBox.right - 1, y: blockBox.top + 1 }, { name: "bottom-left", x: blockBox.left + 1, y: blockBox.bottom - 1 }, { name: "bottom-right", x: blockBox.right - 1, y: blockBox.bottom - 1 }] : []),
        ...(labelBox ? [{ name: "label-center", x: labelBox.left + labelBox.width / 2, y: labelBox.top + labelBox.height / 2 }] : []),
        ...(valueBox ? [{ name: "value-center", x: valueBox.left + valueBox.width / 2, y: valueBox.top + valueBox.height / 2 }] : []),
      ];
      const stacks = points.map((point) => ({ ...point, stack: document.elementsFromPoint(point.x, point.y).slice(0, 5).map((node) => ({ tag: node.tagName, id: (node as HTMLElement).id, className: (node as HTMLElement).className })) }));
      const hits = points.every((point) => { const hit = document.elementFromPoint(point.x, point.y); return Boolean(hit && block && (hit === block || block.contains(hit))); });
      const expectedMark = expectedStatus ? `record-mark-${expectedStatus.toLowerCase().replace(/\s+/g, "-")}` : "";
      const painted = valueBox && rendered ? { top: valueBox.top, right: valueBox.right, bottom: valueBox.bottom, left: valueBox.left } : null;
      const numeric = ["finite", "zero", "signed-zero"].includes(classification);
      const scientific = /^[-+]?\d(?:\.\d+)?e[-+]?\d+$/.test(rendered?.innerText ?? "");
      const numericFit = !numeric || Boolean(rendered && rendered.scrollWidth <= rendered.clientWidth && renderedStyle?.textOverflow !== "ellipsis" && renderedStyle?.overflow !== "hidden" && renderedStyle?.whiteSpace === "nowrap" && rendered.innerText.length <= (scientific ? 7 : 5) && (!scientific || renderedStyle.fontSize === "20px"));
      const tokenClipping = !numeric && rendered ? (() => {
        const walker = document.createTreeWalker(rendered, NodeFilter.SHOW_TEXT);
        const tokens: Range[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index ?? 0);
          range.setEnd(node, (match.index ?? 0) + match[0].length);
          tokens.push(range);
        }
        const renderedStyle = getComputedStyle(rendered);
        return tokens.some((range) => {
          const owner = range.startContainer.parentElement?.closest<HTMLElement>(".metric-value-text-token");
          const measure = document.createElement("span");
          measure.textContent = range.toString();
          measure.style.cssText = `position:absolute; visibility:hidden; white-space:nowrap; font:${renderedStyle.font}; letter-spacing:${renderedStyle.letterSpacing};`;
          document.body.append(measure);
          const naturalWidth = measure.getBoundingClientRect().width;
          measure.remove();
          const ownerStyle = owner && getComputedStyle(owner);
          return naturalWidth > rendered.clientWidth + 0.5 && (!owner || ownerStyle?.overflow !== "hidden" || ownerStyle.textOverflow !== "ellipsis" || ownerStyle.whiteSpace !== "nowrap");
        });
      })() : false;
      const textFit = numeric || Boolean(rendered && (rendered.scrollHeight <= rendered.clientHeight || (rendered.classList.contains("metric-value-text") && rendered.clientHeight <= 48))) && !tokenClipping;
      const gridEdgeResult = gridEdges;
      const overlays = [".page-chat-bar", ".page-chat-drawer", ".page-chat-backdrop", ".page-chat-surface"].flatMap((selector) => { const node = document.querySelector<HTMLElement>(selector); const box = node?.getBoundingClientRect(); return box && box.width > 0 && box.height > 0 ? [{ selector, box: { top: box.top, right: box.right, bottom: box.bottom, left: box.left } }] : []; });
      const intersects = (left: DOMRect, right: { top: number; right: number; bottom: number; left: number }) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      const overlayHit = Boolean(blockBox && overlays.some(({ box }) => intersects(blockBox, box)));
      return { label, value, expectedText, expectedStatus, classification, found: Boolean(element), text: rendered?.innerText, title: rendered?.title, aria: rendered?.getAttribute("aria-label"), mark: element?.querySelector(".record-mark")?.className ?? "", expectedMark, numeric, numericFit, textFit, tokenClipping, painted, gridEdges: gridEdgeResult, block: blockBox && { top: blockBox.top, right: blockBox.right, bottom: blockBox.bottom, left: blockBox.left }, clip: clip && { top: clip.top, right: clip.right, bottom: clip.bottom, left: clip.left }, contained: Boolean(blockBox && painted && painted.top >= blockBox.top && painted.right <= blockBox.right && painted.bottom <= blockBox.bottom && painted.left >= blockBox.left), clipContained: Boolean(blockBox && clip && blockBox.top >= clip.top && blockBox.right <= clip.right && blockBox.bottom <= clip.bottom && blockBox.left >= clip.left), hits, stacks, overlayHit, padding: style ? parseFloat(style.paddingInlineEnd) : -1, rightGap: blockBox && valueBox ? blockBox.right - valueBox.right : -1 };
      });
    }, metricBoundaryMatrix);
    const failures = entries.flatMap((entry) => {
      const marker = entry.expectedStatus ? entry.mark.includes(entry.expectedMark) : !entry.mark;
      const exact = entry.found && entry.text === entry.expectedText && entry.title === entry.value && entry.aria === entry.value;
      const geometry = entry.contained && entry.clipContained && entry.hits && !entry.overlayHit && entry.rightGap >= entry.padding && entry.textFit;
      return exact && marker && entry.numericFit && geometry ? [] : [`${entry.label}: ${JSON.stringify({ exact, marker, numericFit: entry.numericFit, geometry, entry })}`];
    });
    for (let index = 0; index < entries.length; index += 1) for (let next = index + 1; next < entries.length; next += 1) {
      const left = entries[index].painted;
      const right = entries[next].painted;
      if (left && right && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) failures.push(`${entries[index].label} overlaps ${entries[next].label}: ${JSON.stringify({ left, right })}`);
    }
    if (entries.some((entry) => entry.tokenClipping)) failures.push("overlong word clipped without ellipsis");
    if (entries.some((entry) => !entry.gridEdges)) failures.push(`row/column edge assertion: metric grid separators are not continuous ${JSON.stringify(entries.find((entry) => !entry.gridEdges)?.gridDiagnostics)}`);
    for (const entry of entries) {
      const counterpart = entry.label.startsWith("marked ") ? entries.find((candidate) => candidate.label === entry.label.replace("marked ", "unmarked ")) : entry.label.startsWith("unmarked ") ? entries.find((candidate) => candidate.label === entry.label.replace("unmarked ", "marked ")) : undefined;
      if (counterpart && entry.text !== counterpart.text) failures.push(`${entry.label}: marker parity differs from ${counterpart.label}`);
    }
    if (viewport === "390px") for (const entry of entries) {
      const metricObject = await accessibility.send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll('.metric-block')).find((element) => element.querySelector('.metric-label')?.textContent === ${JSON.stringify(entry.label)})?.querySelector('.metric-value')` });
      const tree = await accessibility.send("Accessibility.getPartialAXTree", { objectId: metricObject.result.objectId, fetchRelatives: false });
      const names = tree.nodes.map((node) => node.name?.value).filter((name): name is string => typeof name === "string");
      if (names.filter((name) => name === entry.value).length !== 1 || (entry.text !== entry.value && names.includes(entry.text ?? ""))) failures.push(`${entry.label}: chromium AX names=${JSON.stringify(names)}`);
    }
    if (failures.length) throw new Error(`metric boundary matrix failed at ${viewport}: ${JSON.stringify(failures)}`);
  };
  const provedMatrixViewports = new Set<string>();
  await captureBlockState("metric-boundary", matrixStrip, 2400, 1400, async (viewport) => {
    if (viewport === "390px" || viewport === "1440px") {
      provedMatrixViewports.add(viewport);
      await assertMetricMatrix(viewport);
    }
  });
  if (!provedMatrixViewports.has("390px") || !provedMatrixViewports.has("1440px"))
    throw new Error(`missing 1440px proof: ${JSON.stringify([...provedMatrixViewports])}`);
  const assertClosedFrame = async (viewport: string) => {
    const frame = await page.evaluate(() => {
      const describe = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { visibility: style.visibility, transform: style.transform, display: style.display, rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } };
      };
      const target = document.querySelector<HTMLElement>(".record-form-actions button.primary:not(:disabled)");
      const targetBox = target?.getBoundingClientRect();
      const point = targetBox ? { x: Math.max(targetBox.left + 1, Math.min(targetBox.right - 1, innerWidth / 2)), y: Math.max(targetBox.top + 1, Math.min(targetBox.bottom - 1, innerHeight / 2)) } : null;
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
        scroll: { window: scrollY, content: document.querySelector<HTMLElement>(".page-content")?.scrollTop ?? -1 },
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
  await captureBlockState("page-chat-closed", page.locator(".record-form-actions button.primary:not(:disabled)"), 844, 900, async (viewport) => {
    if (viewport === "390px") await assertClosedFrame(viewport);
  });
  await page.setViewportSize({ width: 390, height: 760 });
  const pageChatBar = page.locator(".page-chat-bar");
  await gateWait.playwright(pageChatBar, "waitFor", { state: "visible" });
  if (await pageChatBar.getAttribute("aria-expanded") !== "false") throw new Error(`page chat was not closed after matrix: ${JSON.stringify(await pageChatLayout())}`);
  const closedGeometry = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".page-chat-bar")?.getBoundingClientRect();
    const action = document.querySelector<HTMLElement>(".record-form-actions button")?.getBoundingClientRect();
    return { barBottom: bar?.bottom ?? 0, barHeight: bar?.height ?? 0, actionBottom: action?.bottom ?? 0, viewport: innerHeight };
  });
  if (closedGeometry.actionBottom > closedGeometry.viewport - closedGeometry.barHeight + 1)
    throw new Error(`390px page form action is under the closed page chat bar: ${JSON.stringify(closedGeometry)}`);
  await page.evaluate(() => {
    const originalAdd = window.addEventListener.bind(window);
    const result = { prevented: false, inside: false };
    let armed = true;
    (window as typeof window & { __pageChatFirstFrame?: { result: typeof result; originalAdd: typeof window.addEventListener } }).__pageChatFirstFrame = { result, originalAdd: window.addEventListener };
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      originalAdd(type, listener, options);
      if (armed && type === "keydown" && options === true) {
        armed = false;
        const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        window.dispatchEvent(event);
        result.prevented = event.defaultPrevented;
        result.inside = Boolean(document.activeElement?.closest('[role="dialog"]'));
      }
    }) as typeof window.addEventListener;
  });
  const preChatClick = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".page-chat-surface");
    const close = document.querySelector<HTMLElement>('.page-chat-surface button[aria-label="close page chat"]');
    const style = surface && getComputedStyle(surface);
    return { barExpanded: document.querySelector(".page-chat-bar")?.getAttribute("aria-expanded"), close: { connected: Boolean(close?.isConnected), visible: Boolean(close && style && style.visibility !== "hidden"), disabled: close instanceof HTMLButtonElement && close.disabled }, surface: style && { visibility: style.visibility, transform: style.transform, transition: style.transition }, windowScroll: scrollY, contentScroll: document.querySelector<HTMLElement>(".page-content")?.scrollTop };
  });
  await pageChatBar.click();
  const pageChatDialog = page.getByRole("dialog", { name: "page chat" });
  await gateWait.playwright(pageChatDialog, "waitFor", { state: "visible" });
  const pageChatClose = pageChatDialog.getByRole("button", { name: "close page chat" });
  const focusAfterChatClick = await page.evaluate(() => ({ active: { tag: document.activeElement?.tagName, id: (document.activeElement as HTMLElement | null)?.id, className: (document.activeElement as HTMLElement | null)?.className, aria: document.activeElement?.getAttribute("aria-label"), insideModal: Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')) }, barExpanded: document.querySelector(".page-chat-bar")?.getAttribute("aria-expanded"), layout: { mobileQuery: matchMedia("(max-width: 1099px) and (min-height: 501px)").matches, windowScroll: scrollY, contentScroll: document.querySelector<HTMLElement>(".page-content")?.scrollTop, surface: (() => { const node = document.querySelector<HTMLElement>(".page-chat-surface"); const style = node && getComputedStyle(node); return node && style ? { connected: node.isConnected, visibility: style.visibility, transform: style.transform, transition: style.transition } : null; })() } }));
  if (!focusAfterChatClick.active.insideModal || focusAfterChatClick.active.aria !== "close page chat") throw new Error(`390px page chat click did not focus its close control before Tab: ${JSON.stringify({ preChatClick, focusAfterChatClick, chat: await pageChatLayout() })}`);
  const preTabFocus = await page.evaluate(() => ({
    inside: Boolean(document.activeElement?.closest('[role="dialog"][aria-modal="true"]')),
    close: document.activeElement?.getAttribute("aria-label") === "close page chat",
  }));
  if (!preTabFocus.inside || !preTabFocus.close)
    throw new Error(`390px page chat click did not focus its close control before Tab: ${JSON.stringify(preTabFocus)}`);
  const backdropTabIndex = await page.locator(".page-chat-backdrop").evaluate((element) => (element as HTMLElement).tabIndex);
  if (backdropTabIndex >= 0) throw new Error(`page chat backdrop is in sequential focus order: tabIndex=${backdropTabIndex}`);
  await page.keyboard.press("Tab");
  if (!await pageChatDialog.evaluate((dialog) => dialog.contains(document.activeElement)))
    throw new Error("390px page chat real Tab escaped the modal sheet");
  if (await page.locator(".page-chat-backdrop").evaluate((element) => element === document.activeElement))
    throw new Error("390px page chat real Tab focused the backdrop");
  const firstFrameTabPrevented = await page.evaluate(() => {
    const state = (window as typeof window & { __pageChatFirstFrame?: { result: { prevented: boolean; inside: boolean }; originalAdd: typeof window.addEventListener } }).__pageChatFirstFrame;
    if (!state) return false;
    window.addEventListener = state.originalAdd;
    delete (window as typeof window & { __pageChatFirstFrame?: unknown }).__pageChatFirstFrame;
    return state.result.inside;
  });
  if (!firstFrameTabPrevented) throw new Error("390px page chat first-frame Tab was not trapped inside the modal sheet");
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
  const backgroundControl = page.locator(".record-form-actions button").first();
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
      hit: hit ? { tag: hit.tagName, id: hit.id, className: hit.className, backdrop: hit.matches(".page-chat-backdrop"), backgroundControl: Boolean(hit.closest(".record-form-actions button")) } : null,
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
  await pageChatBar.click();
  await gateWait.playwright(pageChatDialog, "waitFor", { state: "visible" });
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
  await pageChatDialog.getByRole("button", { name: "close page chat" }).click();
  await waitFor(async () => await pageChatBar.getAttribute("aria-expanded") === "false", "page chat close");
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
  const filteredDetailResponse = gateWait.playwright(page, "waitForResponse", (response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/pages/${createdPage.id}/records/books`
      && url.searchParams.get("field") === "status"
      && url.searchParams.get("equals") === '"reading"';
  }, { timeout: 20000 });
  await addBookApproval.getByRole("button", { name: "approve", exact: true }).click();
  await gateWait.playwright(bookAdded, "waitFor", { timeout: 20000 });
  await gateWait.playwright(page.locator(".metric-block").filter({ has: page.getByText("reading", { exact: true }) }).locator("strong").filter({ hasText: "1" }), "waitFor", { timeout: 20000 });
  const detailResponse = await filteredDetailResponse;
  await gateWait.playwright(page, "waitForFunction", () => {
    const text = document.querySelector(".record-detail")?.textContent ?? "";
    return text.includes("Synthetic Book") || text.includes("could not load record");
  }, undefined, { timeout: 20000 });
  const filteredDetailText = await page.locator(".record-detail").innerText();
  if (!filteredDetailText.includes("Synthetic Book"))
    throw new Error(`filtered detail did not render the selected value: status=${detailResponse.status()} text=${JSON.stringify(filteredDetailText)}`);
  if (filteredDetailText.includes("could not load record"))
    throw new Error(`filtered detail showed a load error: ${JSON.stringify(filteredDetailText)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "tool-summary-single-record-1440.png"), fullPage: true });
  const readingModeResponse = gateWait.playwright(page, "waitForResponse", (response) => response.url().endsWith(`/api/pages/${createdPage.id}/create-mode`));
  await page.getByRole("button", { name: "create mode off", exact: true }).click();
  if (!(await readingModeResponse).ok()) throw new Error("reading page create mode toggle failed");
  await gateWait.playwright(page.getByRole("button", { name: "create mode on", exact: true }), "waitFor");

  const readingCredential = (
    await Bun.file(join(achillesHome, "credentials", createdPage.id)).text()
  ).trim();
  secrets.push(readingCredential);
  await mcp(readingCredential, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "metric-validation-gate", version: "1" },
  });
  await mcp(readingCredential, 2, "tools/list", {});
  const invalidMetricCall = await mcp(readingCredential, 3, "tools/call", {
    name: "update_layout",
    arguments: {
      layout: {
        blocks: [
          { type: "metric", label: "invalid", collection: "books", count: "yes" },
        ],
      },
      expected_version: 1,
    },
  });
  const invalidMetricError = JSON.parse(
    invalidMetricCall.result?.content?.[0]?.text ?? "{}",
  );
  if (
    !invalidMetricCall.result?.isError ||
    JSON.stringify(invalidMetricError) !==
      JSON.stringify({
        code: "invalid_input",
        expected: "one valid schema variant",
        path: "/layout/blocks/0",
      })
  )
    throw new Error(
      `invalid metric did not return the safe error document: ${JSON.stringify(invalidMetricCall.result)}`,
    );

  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "tool-summary-failed-1440.png"), fullPage: true });

  const updateLayoutApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "update_layout" });
  const updateLayoutApprovalBefore = await updateLayoutApproval.count();
  await field.fill("layout updated without reload");
  await field.press("Enter");
  await waitFor(async () => (await updateLayoutApproval.count()) > updateLayoutApprovalBefore, "update layout approval");
  await updateLayoutApproval.nth(updateLayoutApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  const seedSummary = Bun.spawn(["uv", "run", "python", "-c", `import json, sqlite3, datetime; from achilles.web import _database; db=_database(); now=datetime.datetime.now(datetime.timezone.utc).isoformat(); db.executemany("INSERT INTO page_record(page_id,collection,record_id,version,revision,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", [(${JSON.stringify(createdPage.id)}, "books", f"summary-{i}", 1, 1, json.dumps({"title": f"Summary Book {i}", "status": "done"}), now, now) for i in range(1, 5)]); db.commit(); db.close()`], { env });
  if (await seedSummary.exited !== 0) throw new Error("could not seed summary records");
  const listSummaryApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "list_books" });
  await gateWait.playwright(listSummaryApproval, "waitFor", { timeout: 20000 });
  await listSummaryApproval.getByRole("button", { name: "approve", exact: true }).click();
  const toolRow = page.locator('[data-part="tool"]', { hasText: "list_books" }).last();
  await gateWait.playwright(toolRow, "waitFor", { timeout: 20000 });
  const summaryBody = toolRow.locator('[data-part="tool-summary-preview"]');
  await gateWait.playwright(summaryBody.getByText("5 rows · 4 done, 1 reading", { exact: true }), "waitFor", { timeout: 20000 });
  await gateWait.playwright(summaryBody.getByText("+ 2 more", { exact: true }), "waitFor", { timeout: 20000 });
  if (screenshotDir) {
    for (const width of [390, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) {
        await page.reload();
        await gateWait.playwright(page.locator(".page-chat-bar"), "waitFor", { timeout: 20000 });
        await page.locator(".page-chat-bar").click();
        await gateWait.playwright(page.getByRole("dialog", { name: "page chat" }), "waitFor", { timeout: 20000 });
      }
      await page.screenshot({ path: join(screenshotDir, `tool-summary-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  if ((await toolRow.locator('[data-part="tool-raw"] pre').count()) !== 0 && (await toolRow.locator('[data-part="tool-raw"] pre').innerText()).includes('"Summary Book 1"'))
    throw new Error("raw list result was visible before opening raw");
  if (process.env.ONLY_TOOL_SUMMARY) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await gateWait.playwright(page.locator(".page-chat-bar"), "waitFor", { timeout: 20000 });
    await page.locator(".page-chat-bar").click();
    await gateWait.playwright(page.getByRole("dialog", { name: "page chat" }), "waitFor", { timeout: 20000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gateWait.playwright(page.locator('[data-part="tool"]', { hasText: "list_books" }).last().locator('[data-part="tool-summary-preview"]').getByText("5 rows · 4 done, 1 reading", { exact: true }), "waitFor", { timeout: 20000 });
  }
  await toolRow.locator('[data-part="tool-raw"] summary').click();
  await gateWait.playwright(toolRow.locator('[data-part="tool-raw"] pre').getByText("Summary Book 1", { exact: false }), "waitFor", { timeout: 20000 });
  if (!(await toolRow.locator('[data-part="tool-raw"] pre').innerText()).includes("arguments truncated by zeta"))
    throw new Error("raw disclosure hid zeta's argument truncation marker");
  const owningVirtualRow = toolRow.locator('xpath=ancestor::*[@data-virtual-id][1]');
  const nextTranscriptRow = owningVirtualRow.locator('xpath=following-sibling::*[@data-virtual-id][1]');
  const rawGeometry = async () => {
    const rawBox = await toolRow.locator('[data-part="tool-raw"]').boundingBox();
    const rowBox = await toolRow.boundingBox();
    const nextBox = await nextTranscriptRow.boundingBox();
    const nextText = (await nextTranscriptRow.innerText().catch(() => "")).slice(0, 160);
    const virtualDebug = await page.locator('[data-part="virtual-debug"]').allTextContents();
    const timeline = page.locator('[data-part="timeline"]');
    const virtualDimensions = await timeline.evaluate((node) => ({
      virtual: node.getAttribute("data-virtual"),
      styleHeight: (node as HTMLElement).style.height,
      clientHeight: (node as HTMLElement).clientHeight,
      scrollHeight: (node as HTMLElement).scrollHeight,
      childCount: node.children.length,
      rows: [...node.children].map((row) => ({ id: row.getAttribute("data-virtual-id"), index: row.getAttribute("data-virtual-index"), top: (row as HTMLElement).offsetTop, height: (row as HTMLElement).offsetHeight })).slice(-8),
    })).catch(() => null);
    return { rawBox, rowBox, nextBox, nextId: await nextTranscriptRow.getAttribute("data-virtual-id"), nextText, virtualDebug, virtualDimensions };
  };
  try {
    await waitFor(async () => {
      const { rawBox, nextBox, nextText } = await rawGeometry();
      return Boolean(rawBox && nextBox && nextText.includes("layout updated") && nextBox.y >= rawBox.y + rawBox.height);
    }, "raw disclosure remeasured before next transcript row");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(await rawGeometry())}`);
  }
  const geometry = await rawGeometry();
  const { rawBox, rowBox, nextBox } = geometry;
  if (!rawBox || !rowBox || !nextBox || !geometry.nextText.includes("layout updated") || nextBox.y < rawBox.y + rawBox.height)
    throw new Error(`raw disclosure overlaps next transcript row: ${JSON.stringify(geometry)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "tool-summary-raw-open-1440.png"), fullPage: true });
  if (process.env.ONLY_TOOL_SUMMARY) {
    const rawSummary = toolRow.locator('[data-part="tool-raw"] summary');
    await rawSummary.click();
    await gateWait.playwright(toolRow.locator('[data-part="tool-raw"] pre'), "waitFor", { state: "detached", timeout: 20000 });
    const closedGeometry = await owningVirtualRow.evaluate((row) => ({ minHeight: (row as HTMLElement).style.minHeight, height: row.getBoundingClientRect().height }));
    const closedNext = await nextTranscriptRow.boundingBox();
    if (closedGeometry.minHeight || !closedNext) throw new Error(`raw close left owned virtual height: ${JSON.stringify({ closedGeometry, closedNext })}`);
    await rawSummary.click();
    await waitFor(async () => {
      await rawGeometry();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const settled = await rawGeometry();
      return Boolean(settled.rawBox && settled.nextBox && settled.nextText.includes("layout updated") && settled.nextBox.y >= settled.rawBox.y + settled.rawBox.height);
    }, "raw disclosure reopened after cleanup");
    const reopened = await rawGeometry();
    if (!reopened.rawBox || !reopened.nextBox || reopened.nextBox.y < reopened.rawBox.y + reopened.rawBox.height)
      throw new Error(`raw disclosure failed after reopen: ${JSON.stringify(reopened)}`);
    console.log(`isolated raw close cleanup passed: ${JSON.stringify({ closedGeometry, closedNext, reopened })}`);
    process.exit(0);
  }
  await gateWait.playwright(page.locator(".page-lead").filter({ hasText: "layout updated without reload" }), "waitFor", { timeout: 20000 });
  const layoutContract = () => page.evaluate(() => {
    const visible = (element: Element) => { const node = element as HTMLElement; const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return Boolean(box.width && box.height && style.display !== "none" && style.visibility !== "hidden"); };
    const labelState = (label: string) => Array.from(document.querySelectorAll(".metric-label")).filter((element) => element.textContent === label).map((element) => ({ visible: visible(element), owner: element.closest(".metric-block")?.outerHTML.slice(0, 240) }));
    return { route: location.pathname, lead: Array.from(document.querySelectorAll(".page-lead")).map((element) => ({ text: element.textContent, visible: visible(element) })), legacy: labelState("legacy total with an unusually long descriptive label"), allBooks: labelState("all books"), reading: labelState("reading"), review: labelState("review status"), tables: Array.from(document.querySelectorAll('.record-list table[data-collection="books"]')).map((element) => ({ visible: visible(element), owner: element.closest(".page-block")?.outerHTML.slice(0, 240) })), detail: Array.from(document.querySelectorAll('.record-detail')).map((element) => ({ visible: visible(element) })), forms: Array.from(document.querySelectorAll('.record-form')).map((element) => ({ visible: visible(element) })), layoutVersion: document.querySelector(".page-layout-version")?.textContent };
  });
  const layoutDiagnostics = async () => ({ contract: await layoutContract(), control: JSON.parse(await Bun.file(control).text()) });
  try {
    await gateWait.playwright(page.locator(".metric-label", { hasText: "all books" }), "waitFor", { state: "visible", timeout: 20000 });
    const contract = await layoutContract();
    if (contract.legacy.length !== 0 || contract.allBooks.length !== 1 || !contract.allBooks[0].visible || contract.reading.length !== 1 || !contract.reading[0].visible || contract.review.length !== 1 || !contract.review[0].visible || contract.tables.length !== 1 || !contract.tables[0].visible || contract.detail.length !== 1 || !contract.detail[0].visible || contract.forms.length !== 1 || !contract.forms[0].visible)
      throw new Error(`replacement layout contract failed: ${JSON.stringify(contract)}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: layout diagnostics=${JSON.stringify(await layoutDiagnostics())}`);
  }
  const afterLayoutUpdate = JSON.parse(await Bun.file(control).text());
  const updateLayoutResult = afterLayoutUpdate.tool_results?.find((result: { call_id: string }) => result.call_id === "update-reading-layout");
  if (!updateLayoutResult || updateLayoutResult.is_error)
    throw new Error(`update_layout tool result was missing or failed: ${JSON.stringify(afterLayoutUpdate.tool_results)}`);
  console.log("open page re-rendered without reload after chat update_layout: page note before books");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "layout-update-without-reload.png"), fullPage: true });
  const allBooksMetric = page.locator(".metric-block").filter({ has: page.getByText("all books", { exact: true }) }).locator("strong");
  try {
    await waitFor(async () => (await allBooksMetric.innerText()) === "5", "exact all-books metric");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: observed=${JSON.stringify(await allBooksMetric.innerText().catch(() => "<missing>"))}`);
  }
  await page.getByRole("row").filter({ hasText: "Synthetic Book" }).click();
  const saveCountRoute = async (route: Route) => {
    await route.fulfill({ status: 200, body: "[]", headers: { "content-type": "application/json", "x-achilles-total": "2" } });
  };
  await page.route("**/api/pages/*/records/books?limit=1", saveCountRoute);
  try {
    await page.getByRole("button", { name: "save", exact: true }).click();
    await waitFor(async () => (await page.locator(".record-form").innerText()).includes("saved"), "form save");
    await waitFor(async () => (await allBooksMetric.innerText()) === "2", "unfiltered metric after form save");
  } finally {
    await page.unroute("**/api/pages/*/records/books?limit=1", saveCountRoute);
  }
  console.log("real page form save refreshed the unfiltered grouped metric");

  const staleLayoutApprovalBefore = await updateLayoutApproval.count();
  await waitFor(async () => (JSON.parse(await Bun.file(control).text()).late_turn_barrier ?? null) === "held", "held final layout response");
  await field.fill("repeat that layout update with the old version");
  await field.press("Enter");
  await waitFor(async () => requests().some((frame) => frame.method === "steer" && frame.params?.text === "repeat that layout update with the old version"), "late steer request");
  const lateSteerIndex = requests().findIndex((frame) => frame.method === "steer" && frame.params?.text === "repeat that layout update with the old version");
  const lateSteer = requests()[lateSteerIndex];
  if (lateSteerIndex < 0 || !lateSteer?.params?.delivery_id) throw new Error("late steer did not include a delivery id");
  await waitFor(async () => requests().some((frame) => frame.id === lateSteer.id && frame.result?.accepted === true), "accepted late steer response");
  const lateControl = JSON.parse(await Bun.file(control).text());
  await writeControl(control, { ...lateControl, release_late_turn_barrier: true });
  await waitFor(async () => requests().slice(lateSteerIndex + 1).some((frame) => frame.method === "event" && frame.params?.event === "turn_end"), "turn end after accepted late steer");
  // zeta starts the next turn with the steer the finished turn did not read
  const lateStatuses = () => {
    const frames = requests();
    const ids = new Set(frames.filter((frame) => frame.method === "delivery_status" && frame.params?.delivery_id === lateSteer.params.delivery_id).map((frame) => frame.id));
    return frames.filter((frame) => frame.method === undefined && ids.has(frame.id) && frame.result?.status).map((frame) => frame.result.status);
  };
  await waitFor(async () => lateStatuses().at(-1) === "delivered", "delivered late steer delivery status");
  if (lateStatuses().includes("dropped")) throw new Error(`late steer was dropped: ${JSON.stringify(lateStatuses())}`);
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).request_count === 19, "next turn carrying the late steer");
  const afterLateSteer = JSON.parse(await Bun.file(control).text());
  const lateMessages = afterLateSteer.user_messages?.filter((text: string) => text === "repeat that layout update with the old version").length;
  if (lateMessages !== 1)
    throw new Error(`the next turn did not carry the late steer exactly once: ${JSON.stringify(afterLateSteer.user_messages)}`);
  await waitFor(async () => await field.inputValue() === "", "draft clear after delivered late steer");
  const lateSteerRequests = requests().filter((frame) => frame.method === "steer" && frame.params?.text === "repeat that layout update with the old version");
  const lateSendRequests = requests().filter((frame) => frame.method === "send" && frame.params?.text === "repeat that layout update with the old version");
  if (lateSteerRequests.length !== 1 || lateSendRequests.length !== 0)
    throw new Error(`achilles sent the late steer ${lateSteerRequests.length} times and resent it ${lateSendRequests.length} times`);
  if (await page.getByRole("button", { name: "dismiss delivery warning", exact: true }).count()) throw new Error("delivered late steer showed a delivery warning");
  await waitFor(async () => (await updateLayoutApproval.count()) > staleLayoutApprovalBefore, "stale layout approval");
  await updateLayoutApproval.nth(staleLayoutApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await gateWait.playwright(page.getByText("layout version conflict: inspect the page and retry with its current version.", { exact: true }), "waitFor", { timeout: 20000 });
  const afterStaleLayout = JSON.parse(await Bun.file(control).text());
  const staleLayoutResult = afterStaleLayout.tool_results?.find((result: { call_id: string }) => result.call_id === "stale-reading-layout");
  if (!staleLayoutResult?.is_error)
    throw new Error(`stale update_layout did not return a tool error: ${JSON.stringify(afterStaleLayout.tool_results)}`);
  console.log("stale chat update_layout showed a readable version conflict");

  await gateWait.playwright(page, "waitForFunction", () =>
      (document.querySelector(".record-detail")?.textContent ?? "").includes(
        "Synthetic Book",
      ), undefined, { timeout: 20000 });
  const storedReadingLayout = async () => {
    const response = await fetch(`${origin}/api/pages/${createdPage.id}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`reading page fetch failed: ${response.status}`);
    const stored = await response.json();
    if (!Array.isArray(stored.layout?.blocks)) throw new Error("reading page layout was missing blocks");
    return {
      version: stored.active_layout_version,
      blocks: stored.layout.blocks,
    };
  };
  const layoutBeforeInvalidMetric = await storedReadingLayout();
  let heldInvalidMetricDetail: Route | undefined;
  let holdInvalidMetricDetail = true;
  const filteredDetailPattern = `**/api/pages/${createdPage.id}/records/books?*`;
  await page.route(filteredDetailPattern, async (route) => {
    const url = new URL(route.request().url());
    if (
      holdInvalidMetricDetail
      && url.searchParams.get("field") === "status"
      && url.searchParams.get("equals") === '"reading"'
    ) {
      heldInvalidMetricDetail = route;
      return;
    }
    await route.continue();
  });
  const invalidLayoutApprovalBefore = await updateLayoutApproval.count();
  await field.fill("replace the page with an invalid metric");
  await field.press("Enter");
  await waitFor(
    async () => (await updateLayoutApproval.count()) > invalidLayoutApprovalBefore,
    "invalid metric layout approval",
  );
  await updateLayoutApproval
    .nth(invalidLayoutApprovalBefore)
    .getByRole("button", { name: "approve", exact: true })
    .click();
  await gateWait.playwright(page
    .getByText(
      "metric update rejected: /layout/blocks/0 must match one valid schema variant.",
      { exact: true },
    ), "waitFor", { timeout: 20000 });
  const afterInvalidMetric = JSON.parse(await Bun.file(control).text());
  const invalidMetricResult = afterInvalidMetric.tool_results?.find(
    (result: { call_id: string }) => result.call_id === "invalid-metric-layout",
  );
  if (!invalidMetricResult?.is_error)
    throw new Error(
      `invalid metric update_layout did not return a tool error: ${JSON.stringify(afterInvalidMetric.tool_results)}`,
    );
  await waitFor(async () => heldInvalidMetricDetail !== undefined, "held invalid metric detail refresh");
  await gateWait.playwright(page.getByText("loading record…", { exact: true }), "waitFor", { timeout: 20000 });
  const layoutAfterInvalidMetric = await storedReadingLayout();
  if (
    layoutAfterInvalidMetric.version !== layoutBeforeInvalidMetric.version
    || JSON.stringify(layoutAfterInvalidMetric.blocks) !== JSON.stringify(layoutBeforeInvalidMetric.blocks)
  )
    throw new Error(`invalid metric update changed the stored page layout: before=${JSON.stringify(layoutBeforeInvalidMetric)} after=${JSON.stringify(layoutAfterInvalidMetric)}`);
  holdInvalidMetricDetail = false;
  await heldInvalidMetricDetail!.continue();
  await gateWait.playwright(page, "waitForFunction", () =>
      (document.querySelector(".record-detail")?.textContent ?? "").includes(
        "Synthetic Book",
      ), undefined, { timeout: 20000 });
  await page.unroute(filteredDetailPattern);
  console.log("invalid metric chat update showed a readable error and kept the stored layout");

  const readingModeOffResponse = gateWait.playwright(page, "waitForResponse", (response) => response.url().endsWith(`/api/pages/${createdPage.id}/create-mode`));
  await page.getByRole("button", { name: "create mode on", exact: true }).click();
  if (!(await readingModeOffResponse).ok()) throw new Error("reading page create mode reset failed");
  await gateWait.playwright(page.getByRole("button", { name: "create mode off", exact: true }), "waitFor");

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
  const emptyRecords = page.locator(".record-list-empty").first();
  await gateWait.playwright(emptyRecords, "waitFor", { state: "visible" });
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
  await waitFor(async () => (await page.locator("tbody td").allTextContents()).includes("from zeta"), "record list inserted record value");
  const recordValues = await page.locator("tbody td").allTextContents();
  if (!recordValues.includes("from zeta")) throw new Error(`record list did not render inserted record value: ${JSON.stringify(recordValues)}`);
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
  if (secondRecords.length !== 5 || !secondRecords.some((record: { title?: string }) => record.title === "Synthetic Book"))
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
    arguments: { route: "/allow", title: "allow mode", layout: { blocks: [] } },
  });
  if (allowPage.result?.isError || (await fetch(`${origin}/api/pages/allow`)).status !== 200)
    throw new Error(`could not create allow-mode gate page: ${JSON.stringify(allowPage)}`);
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`${origin}/allow`);
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  const blocklessChat = page.locator(".page-chat");
  const blocklessComposer = page.locator('[data-part="composer"] textarea[aria-label="message"]');
  const blocklessLayout = await page.evaluate(() => {
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
  if (!blocklessChat.count() || blocklessLayout.chatClass.includes("page-chat-docked") || blocklessLayout.transcriptHeight <= 0 || !blocklessLayout.composerVisible || blocklessLayout.barCount !== 0 || blocklessLayout.dialogCount !== 0 || !(await blocklessComposer.isVisible()) || await blocklessComposer.isDisabled())
    throw new Error(`390px blockless page chat gained sheet semantics or lost its layout: ${JSON.stringify(blocklessLayout)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "blockless-chat-390x760.png"), fullPage: true });
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
      layout: { blocks: [{ type: "text", text: "late" }] },
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
  await waitFor(async () => {
    reconnectPage = await (await fetch(`${origin}/api/pages/reading`)).json();
    return reconnectPage.layout?.blocks?.some((block: { type?: string }) => block.type === "list")
      && (await page.locator("body").innerText()).includes("Synthetic Book");
  }, "reading page inserted book render");
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
  const failedToggleClick = page.getByRole("button", { name: "create mode on", exact: true }).click();
  try { await waitFor(async () => failedToggleFinished, "failed create mode toggle request"); }
  finally {
    try { await failedToggleClick; }
    finally { await page.unroute("**/api/pages/home/create-mode", failToggle); }
  }
  const toggleAlert = page.getByRole("alert").filter({ hasText: "could not update create mode" });
  await gateWait.playwright(toggleAlert, "waitFor", { state: "visible" });
  const retryToggle = toggleAlert.getByRole("button", { name: "retry", exact: true });
  if (!(await retryToggle.isVisible())) throw new Error("create mode error retry was not visible above the transcript");
  await retryToggle.click();
  await gateWait.playwright(page.getByRole("button", { name: "create mode off", exact: true }), "waitFor");
  app.kill("SIGTERM");
  await new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], appEnv);
  await waitFor(async () => (await fetch(origin).then((r) => r.ok, () => false)), "achilles restart");
  const homeAfterRestart = (await (await fetch(`${origin}/api/pages/home`)).json()).zeta_session_id;
  const createdAfterRestart = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (homeAfterRestart !== homeAfterCreate || createdAfterRestart.zeta_session_id !== reconnectPage.zeta_session_id) throw new Error("page sessions changed across achilles restart");
  await gateWait.playwright(page.getByRole("textbox", { name: "message" }), "waitFor", { timeout: 20000 });
  if (await homeSessionId() !== homeOpened) throw new Error("achilles restart changed the open home chat");
  await awaitApprovalMode("session_settings", homeOpened, "ask", "ask-mode session after achilles restart");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("ask-mode session showed the auto-approve marker after achilles restart");
  const refreshCountBeforeRestartToggle = requests().filter((frame) => frame.method === "mcp_refresh_tools").length;
  const restartedToggleResponse = gateWait.playwright(page, "waitForResponse", (response) => response.request().method() === "POST" && requestPath(response.url()) === "/api/pages/home/create-mode");
  await page.getByRole("button", { name: "create mode off", exact: true }).click();
  if (!(await restartedToggleResponse).ok()) throw new Error("post-restart create mode toggle request failed");
  await waitFor(async () => requests().filter((frame) => frame.method === "mcp_refresh_tools").length > refreshCountBeforeRestartToggle, "post-restart tool refresh request");
  const restartedRefreshIndex = requests().findLastIndex((frame) => frame.method === "mcp_refresh_tools");
  const restartedRefresh = requests()[restartedRefreshIndex];
  await waitFor(async () => requests().slice(restartedRefreshIndex + 1).some((frame) => frame.id === restartedRefresh?.id && (frame.result || frame.error)), "post-restart tool refresh result");
  const restartedRefreshResult = requests().slice(restartedRefreshIndex + 1).find((frame) => frame.id === restartedRefresh?.id && (frame.result || frame.error));
  if (restartedRefreshResult?.error) throw new Error(`post-restart tool refresh did not enable create mode without a zeta restart: ${JSON.stringify(restartedRefreshResult.error)}`);
  await gateWait.playwright(page.getByRole("button", { name: "create mode on", exact: true }), "waitFor");
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
  const invalid = await mcp(credential, 5, "tools/call", { name: "create_page", arguments: { route: "/invalid", title: "invalid", layout: { blocks: [{ type: "text", text: "x", extra: true }] } } });
  if (!invalid.result?.isError || (await fetch(`${origin}/api/pages/invalid`)).status !== 404) throw new Error("invalid layout published");
  const reconnectCrossPage = await mcp(credential, 6, "tools/call", { name: "create_page", arguments: { route: "/cross", title: "cross", layout: { blocks: [{ type: "form", title: "x", tool: "other-page" }] } } });
  if (!reconnectCrossPage.result?.isError || (await fetch(`${origin}/api/pages/cross`)).status !== 404) throw new Error("cross-page reference published");
  console.log("reconnect refresh asserted: achilles restarted mid-session; create mode and the next turn used the refreshed catalog without restarting zeta");

  await homeMcp(14, "tools/list", {});
  const lateAnnotation = await homeMcp(15, "tools/call", { name: "annotate_trace", arguments: { text: "after create mode", id: "late-annotation" } });
  if (lateAnnotation.result?.isError) throw new Error(`generated tool failed after create mode: ${JSON.stringify(lateAnnotation)}`);
  const lateRecords = await (await fetch(`${origin}/api/pages/home/records/trace_annotations`, { headers: { Authorization: `Bearer ${credential}` } })).json();
  if (!Array.isArray(lateRecords) || lateRecords.length !== 3) throw new Error(`late generated tool result was not recorded: ${JSON.stringify(lateRecords)}`);

  app.kill("SIGTERM");
  await new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], { ...env, ACHILLES_APPROVAL: "allow" });
  await waitFor(async () => (await fetch(origin).then((r) => r.ok, () => false)), "allow-mode achilles restart");
  await page.goto(`${origin}/allow`);
  const allowField = page.getByRole("textbox", { name: "message" });
  await gateWait.playwright(allowField, "waitFor", { timeout: 20000 });
  await allowField.fill("start allow-mode chat", { timeout: 20_000 });
  await allowField.press("Enter", { timeout: 20_000 });
  await waitFor(async () => JSON.parse(await Bun.file(control).text()).allow_open_request === true, "allow-mode opening request");
  await gateWait.playwright(page.getByText("allow page ready", { exact: true }), "waitFor", { timeout: 20_000 });
  const allowSession = await homeSessionId();
  if (!allowSession) throw new Error("allow-mode page session id missing");
  await gateWait.playwright(page.getByLabel("auto-approve", { exact: true }), "waitFor", { state: "visible" });
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
  await page.locator("button.new-chat").click();
  await waitFor(async () => {
    const current = await homeSessionId();
    return Boolean(current && current !== readingChatBeforeReload);
  }, "new allow-mode reading chat");
  const reloadChat = await homeSessionId();
  await gateWait.playwright(page.getByLabel("auto-approve", { exact: true }), "waitFor", { state: "visible" });
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
  await waitFor(async () => (await page.locator(".run-state").innerText()) === "running", "reloaded page shows the kept turn running");
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
  await waitFor(async () => (await toolLines())[0] === 1, "running tool output shown before the reload");
  await page.reload();
  await waitFor(async () => (await page.locator(".run-state").innerText()) === "running", "reloaded page shows the running tool's turn");
  const runningTool = page.locator('[data-part="tool"][data-state="streaming"]').filter({ hasText: "tool-line before-reload" });
  await waitFor(async () => (await runningTool.count()) === 1, "running tool output from before the reload shown on the reloaded page while the tool runs").catch(async (error) => {
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
    app = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], { ...env, ACHILLES_APPROVAL: approval });
    await waitFor(async () => (await fetch(origin).then((r) => r.ok, () => false)), `achilles restart in ${approval} mode`);
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
  await gateWait.playwright(page.getByLabel("auto-approve", { exact: true }), "waitFor", { state: "visible" });
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
  await gateWait.playwright(page.getByLabel("ask before tools", { exact: true }), "waitFor", { state: "visible", timeout: 20_000 });
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
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("user ask chat reopened under allow showed auto-approve");
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
  await page.keyboard.press(appShortcut("b"));
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connected-review-1440x900.png"), fullPage: true });
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
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connection-lost-review-1440x900.png"), fullPage: true });
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
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connection-recovered-review-1440x900.png"), fullPage: true });

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
  await page.goto(`${origin}/?chat=${first}`);
  const controllerChat = await page.locator("[data-session-id]").getAttribute("data-session-id", { timeout: 20_000 });
  if (controllerChat !== first) throw new Error(`known controller chat did not attach: expected ${first}, got ${controllerChat}`);
  await gateWait.playwright(page, "waitForFunction", () =>
    document.querySelectorAll('[data-part="timeline"] [data-id], [data-part="timeline"] [data-virtual-id]').length > 0,
    undefined,
    { timeout: 20_000 },
  );
  const observerPage = await browser.newPage();
  await observerPage.goto(`${origin}/?chat=${controllerChat}`);
  const observerBanner = observerPage.locator(".observer-banner");
  await gateWait.playwright(observerBanner, "waitFor", { state: "visible" });
  if (!(await observerBanner.innerText()).includes("another tab controls zeta") || !(await observerBanner.innerText()).includes("live and read-only")) throw new Error("observer banner did not explain the live read-only state");
  const observerComposerReason = observerPage.locator('[data-part="composer-reason"]');
  const observerBody = await observerPage.locator("body").innerText();
  if ((await observerComposerReason.count()) && !(await observerComposerReason.first().innerText()).includes("read-only")) throw new Error("observer composer did not explain its disabled state");
  if (!observerBody.includes("read-only")) throw new Error("observer page did not expose a read-only reason");
  const observerNewChat = observerPage.locator("button.new-chat");
  if (!(await observerNewChat.isDisabled())) throw new Error("observer new-chat control was editable");
  if (screenshotDir) {
    await observerPage.setViewportSize({ width: 390, height: 760 });
    await observerPage.screenshot({ path: join(screenshotDir, "observer-active-chat-390x760.png"), fullPage: true });
    await observerPage.setViewportSize({ width: 1440, height: 900 });
    await observerPage.screenshot({ path: join(screenshotDir, "observer-active-chat-1440x900.png"), fullPage: true });
  }
  await observerBanner.getByRole("button", { name: "take control", exact: true }).click();
  await gateWait.playwright(observerBanner.getByText("stayed live and read-only", { exact: false }), "waitFor", { state: "visible" });
  await page.close();
  await observerBanner.getByRole("button", { name: "take control", exact: true }).click();
  await gateWait.playwright(observerBanner, "waitFor", { state: "hidden" });
  if (await observerComposerReason.count()) throw new Error("observer remained read-only after controller closed");
  if (screenshotDir) {
    await observerPage.locator('[data-part="timeline-scroll"]').evaluate((element) => { element.scrollTop = 0; });
    await observerPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await observerPage.screenshot({ path: join(screenshotDir, "observer-controller-restored-1440x900.png"), fullPage: true });
  }

  if (errors.length) throw new Error(`browser errors: ${redact(errors.join(" | "))}`);
  const captured = [...logs.values()].join("\n");
  if (secrets.some((secret) => captured.includes(secret) || errors.some((error) => error.includes(secret)))) throw new Error("captured output contains a zeta token");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  passed = true;
  console.log(`real-zeta gate passed: session ${first}, created /reading with tools, late call rejected`);

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
