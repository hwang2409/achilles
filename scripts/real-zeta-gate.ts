import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Route } from "playwright";
import { controlSnapshot, diagnostic } from "./gate-diagnostics";
import { gateShell } from "./gate-shell";
import { gateTranscript, waitForIdleTurn } from "./gate-transcript";
import { assertServerAskWins, gateCreationApprovalDefaults, gateSettings } from "./gate-settings";
import { gateVim } from "./gate-vim";

import { expectBrowserErrors } from "./browser-errors";

const root = new URL("..", import.meta.url).pathname;
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
const redact = (text: string) => diagnostic(text, secrets);
const safeControl = (text: string) => controlSnapshot(text, secrets);
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
  child.stdout?.on("data", (data) => logs.set(child, logs.get(child)! + data));
  child.stderr?.on("data", (data) => logs.set(child, logs.get(child)! + data));
  return child;
};
const waitFor = async (check: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; backend catalog=${safeControl(await Bun.file(control).text())}`);
};
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
let controllerContext;
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
  const shared = JSON.parse(await Bun.file(sharedDiscovery).text());
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
  await waitFor(async () => await Bun.file(ownDiscovery).exists(), "achilles zeta discovery");
  const pending = JSON.parse(await Bun.file(ownDiscovery).text());
  for (const key of ["controller_token", "observer_token"])
    if (typeof pending[key] === "string") secrets.push(pending[key]);
  const appEnv = env;
  const seed = start(
    "uv",
    [
      "run",
      "python",
      "-c",
      "from achilles.web import _database; import json; db=_database(); db.execute(\"UPDATE page SET zeta_session_id='stale-session-id' WHERE id='home'\"); row=db.execute(\"SELECT document FROM layout_version WHERE page_id='home' ORDER BY version DESC LIMIT 1\").fetchone(); layout=json.loads(row[0]) if row else {'blocks':[]}; layout['blocks'].append({'type':'list','title':'trace annotations','collection':'trace_annotations'}); db.execute(\"INSERT OR IGNORE INTO layout_version VALUES('home',1,'gate',?,datetime('now'))\", (json.dumps(layout),)); db.execute(\"UPDATE layout_version SET document=? WHERE page_id='home' AND version=1\", (json.dumps(layout),)); db.executemany(\"INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)\", [(f'gate-page-{i}', f'/gate-page-{i}', f'gate page {i}', '2025-01-01', f'2025-01-{i:02d}') for i in range(1,46)]); db.commit(); db.close()",
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
  controllerContext = await browser.newContext();
  let page = await controllerContext.newPage();
  const errors: string[] = [];
  const expectedNotFoundUrl = `${origin}/api/pages/not-a-real-page`;
  const discoveryUrl = `${origin}/api/zeta/discovery`;
  const frames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => frames.push(String(event.payload)));
    socket.on("framereceived", (event) => frames.push(String(event.payload)));
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  const setupAlert = page.getByRole("alert");
  await setupAlert.waitFor({ timeout: 20000 });
  if (!(await setupAlert.innerText()).includes("add it to $ZETA_HOME/mcp.json"))
    throw new Error(`missing mcp setup instruction: ${redact(await page.locator("body").innerText())}`);
  await Bun.write(join(zetaHome, "mcp.json"), JSON.stringify({ servers: { achilles: { transport: "streamable-http", url: `${origin}/mcp/` } } }));
  const firstZetaPid = zetaProcess.pid;
  zetaProcess.kill("SIGTERM");
  if (!(await waitForExit(zetaProcess, 15_000))) {
    zetaProcess.kill("SIGKILL");
    await waitForExit(zetaProcess, 5_000);
    throw new Error("zeta shutdown timeout after 15 seconds");
  }
  zetaProcess = start(
    "uv",
    ["run", "--project", zeta, "python", join(root, "scripts/real-zeta-server.py")],
    env,
  );
  await waitFor(async () => {
    try {
      return JSON.parse(await Bun.file(control).text()).pid !== firstZetaPid;
    } catch {
      return false;
    }
  }, "restarted zeta");
  const field = page.getByRole("textbox", { name: "message" });
  await field.waitFor({ timeout: 20000 }).catch(async () => {
    throw new Error(
      `composer missing: ${redact(await page.locator("body").innerText())} errors=${redact(errors.join(" | "))} logs=${redact(logs.get(zetaProcess) ?? "")} discovery fields unavailable`,
    );
  });
  if (await setupAlert.count()) throw new Error("mcp setup alert remained after a successful attach");
  await page.locator(".transcript").waitFor({ state: "visible" });
  const homeSessionId = async () =>
    page.locator("[data-session-id]").getAttribute("data-session-id");
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
  const approvalModeResponse = (method: "session_settings" | "set_settings", sessionId: string) => {
    const messages = requests();
    let requestIndex = messages.length - 1;
    while (
      requestIndex >= 0 &&
      !(messages[requestIndex].method === method && messages[requestIndex].params?.session_id === sessionId)
    ) requestIndex--;
    if (requestIndex < 0) return undefined;
    const response = messages
      .slice(requestIndex + 1)
      .find((frame) => frame.id === messages[requestIndex].id && frame.result);
    return response?.result?.approval_mode;
  };
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
  await assertServerAskWins(page, first, requests(), approvalModeResponse);
  await expectBrowserErrors(page, [{ method: "GET", url: expectedNotFoundUrl, status: 404 }], async () => {
    await page.goto(`${origin}/not-a-real-page`);
  await page.getByRole("alert").filter({ hasText: "page not found" }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "new chat", exact: true }).click();
  await page.getByRole("textbox", { name: "message", exact: true }).waitFor({ timeout: 20_000 });
  });
  const unknownRouteSession = await homeSessionId();
  if (!unknownRouteSession || unknownRouteSession === first) throw new Error("unknown-route new chat did not create a new session");
  if (!(await page.locator(".empty-chat").count())) throw new Error("unknown-route new chat did not show an empty chat");
  await page.goto(`${origin}/?chat=${first}`);
  await page.getByRole("textbox", { name: "message", exact: true }).waitFor({ timeout: 20_000 });
  const assistantReady = page.getByText("assistant ready", { exact: true });
  const assistantReadyBefore = await assistantReady.count();
  const approval = page.locator('[data-part="approval"][data-state="pending"]');
  const approvalBefore = await approval.count();
  await field.fill("prove chat");
  await field.press("Enter");
  await waitFor(async () => (await assistantReady.count()) > assistantReadyBefore, "assistant ready").catch(async () => { throw new Error(`assistant missing body=${redact(await page.locator("body").innerText())} errors=${redact(errors.join(" | "))} logs=${redact(logs.get(zetaProcess) ?? "")}`); });
  await waitFor(async () => (await approval.count()) > approvalBefore, "initial approval");
  const approvalComplete = page.getByText("approval complete", { exact: true });
  const approvalCompleteBefore = await approvalComplete.count();
  await approval.nth(approvalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await waitFor(async () => (await approvalComplete.count()) > approvalCompleteBefore, "approval complete");
  const own = JSON.parse(await Bun.file(ownDiscovery).text());
  const connected = await fetch(discoveryUrl).then((response) => response.json()) as { url: string };
  if (sharedProcess.exitCode !== null || zetaProcess.exitCode !== null) throw new Error("one of the unrelated zeta serves exited during chat");
  if (shared.pid === own.pid || shared.port === own.port) throw new Error("shared and achilles zeta serves did not remain distinct");
  if (new URL(connected.url).port !== String(own.port)) throw new Error("achilles connected to the shared zeta serve");
  const firstSetSettingsBeforeReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  const second = await gateShell(page, first, waitFor);
  const paginationSeed = start("uv", ["run", "python", "-c", "from achilles.web import _database; db=_database(); db.executemany(\"INSERT INTO chat(session_id,page_id,title,created_at,updated_at) VALUES(?,'home',?,'2020-01-01T00:00:00Z',?)\", [(f'older-{i:02}', f'older chat {i:02}', f'2020-01-01T00:{i:02}:00Z') for i in range(55)]); db.commit(); db.close()"], env);
  await new Promise<void>((resolve, reject) => {
    paginationSeed.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`pagination seed exited ${code}`)));
  });
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
    await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  };
  const focusRows: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "chat load-older success",
      run: async () => {
        await reloadShell();
        const rows = page.locator(".chat-row");
        await rows.nth(49).waitFor();
        if (await rows.count() !== 50) throw new Error("chat pagination did not show its first 50 rows");
        await rows.last().focus();
        await page.keyboard.press("Tab");
        const loadOlder = page.getByRole("button", { name: "load 50 older" });
        await assertActive("chat load-older button", loadOlder);
        await page.keyboard.press("Enter");
        await waitFor(async () => (await rows.count()) > 50, "older chats");
        await waitFor(async () => await rows.nth(50).evaluate((row) => document.activeElement === row), "first newly loaded chat row focus");
        await assertActive("chat load-older success", rows.nth(50));
      },
    },
    {
      name: "empty older batch",
      run: async () => {
        await reloadShell();
        const search = page.locator(".chat-search input");
        await search.waitFor();
        const emptyOlder = async (route: Route) => {
          const url = new URL(route.request().url());
          if (url.searchParams.has("before")) await route.fulfill({ json: { chats: [], next: null, approval_count: 0 } });
          else await route.continue();
        };
        await page.route("**/api/chats?**", emptyOlder);
        await page.getByRole("button", { name: "load 50 older" }).click();
        await page.getByRole("button", { name: "load 50 older" }).waitFor({ state: "detached" });
        await page.unroute("**/api/chats?**", emptyOlder);
        const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/chats" && new URL(response.url()).searchParams.has("q"));
        await search.fill("older chat 54");
        await refreshed;
        await page.locator(".chat-group h2", { hasText: "1 results" }).waitFor();
        await assertActive("empty older batch later refresh", search);
      },
    },
    {
      name: "page show-more non-final",
      run: async () => {
        await reloadShell();
        const links = page.locator(".page-list a");
        const showMore = page.getByRole("button", { name: "show more pages" });
        await showMore.waitFor();
        const before = await links.count();
        await showMore.click();
        await waitFor(async () => (await links.count()) > before, "non-final page continuation");
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
        await showMore.waitFor();
        const beforeFirst = await links.count();
        await showMore.click();
        await waitFor(async () => (await links.count()) > beforeFirst, "first page continuation before final");
        const beforeFinal = await links.count();
        await showMore.click();
        await waitFor(async () => (await links.count()) > beforeFinal, "final page continuation");
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
        await showMore.waitFor();
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
          await page.getByText("could not load pages", { exact: true }).waitFor();
        });
        await page.unroute("**/api/pages?**", failContinuation);
        await page.getByRole("button", { name: "retry", exact: true }).click();
        await showMore.waitFor();
        await showMore.click();
        await waitFor(async () => (await links.count()) > before, "page continuation after retry");
        await waitFor(async () => await links.nth(before).evaluate((link) => document.activeElement === link), "page continuation retry focus");
        await assertActive("page continuation retry", links.nth(before));
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
        await showMore.waitFor();
        await showMore.click();
        await waitFor(async () => seen, "continuation request was not made");
        const heading = page.locator(".page-list > .list-head");
        await heading.focus();
        await page.keyboard.press("Enter");
        const continued = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pages" && new URL(response.url()).searchParams.has("before"));
        release();
        await continued;
        await page.unroute("**/api/pages?**", holdContinuation);
        await page.keyboard.press("Enter");
        await waitFor(async () => (await page.locator(".page-list a").count()) > 20, "expanded pages after missing focus target");
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
  await gateTranscript(page, waitFor, requests, control);
  if (requests().some((frame) => frame.method === "resume" && frame.params?.session_id === "foreign-session"))
    throw new Error("hostile chat query reached zeta resume");
  await assertServerAskWins(page, second, requests(), approvalModeResponse);
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
  const homeMcp = (id: number, method: string, params: object) =>
    mcp(credential, id, method, params);
  const pageIndexRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/pages") pageIndexRequests.push(request.url());
  });
  const modeToggle = page.getByRole("button", { name: "create mode off", exact: true });
  const toggleResponse = page.waitForResponse((response) => response.url().endsWith("/api/pages/home/create-mode"));
  await modeToggle.click();
  const toggleResult = await toggleResponse;
  if (!toggleResult.ok()) throw new Error(`create mode toggle failed: ${toggleResult.status()}`);
  await page.getByRole("button", { name: "create mode on", exact: true }).waitFor();
  if ((await page.getByRole("button", { name: "create mode on" }).getAttribute("aria-pressed")) !== "true")
    throw new Error("create mode toggle did not show on");
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
  await field.press("Enter");
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
  await waitFor(async () => (await createApproval.count()) > createApprovalBefore && ((JSON.parse(await Bun.file(control).text()).request_count ?? 0) > createRequestBefore), "create page approval").catch(async () => {
    throw new Error(
      `backend did not receive achilles__create_page catalog: ${safeControl(await Bun.file(control).text())}`,
    );
  });
  await createApproval.nth(createApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await waitFor(async () => (await annotationComplete.count()) > annotationCompleteBefore, "create page completion");
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
  await showMorePages.waitFor({ state: "visible", timeout: 20000 }).catch(() => { throw new Error("show more pages is not visible in the page section"); });
  await showMorePages.focus();
  await page.keyboard.press("Enter");
  const secondBatchPage = page.locator('.page-list a[href^="/gate-page-27"]');
  await secondBatchPage.waitFor({ state: "visible", timeout: 20000 });
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
  await page.waitForURL((url) => new URL(url).pathname === "/gate-page-27");
  await page.goto(origin);
  const readingLink = page.locator('.page-list a[href^="/reading"]');
  await readingLink.waitFor({ timeout: 20000 });
  await readingLink.click();
  await page.waitForURL((url) => new URL(url).pathname === "/reading");
  await page.goto(origin);
  await field.waitFor({ timeout: 20000 });
  const createdPage = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (createdPage.route !== "/reading") throw new Error("create_page did not create /reading");
  await field.waitFor({ timeout: 20_000 });
  const chatOne = await homeSessionId();
  if (!chatOne || chatOne !== first) throw new Error("create_page did not run in the first home chat");
  await page.keyboard.press("Meta+Shift+O");
  await waitFor(async () => {
    const current = await homeSessionId();
    return Boolean(current && current !== chatOne);
  }, "new home chat after create_page");
  const chatTwo = await homeSessionId();
  if (!chatTwo) throw new Error("second home chat session id missing");
  const transcriptBeforeDiscovery = await page.locator('[data-part="message"]').count();
  await page.locator(".run-state").getByText("idle", { exact: true }).waitFor({ timeout: 20_000 });
  await field.fill("list achilles resources, then inspect /reading");
  await field.press("Enter");
  const inspectApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "inspect_page" });
  await inspectApproval.waitFor({ timeout: 20_000 });
  await inspectApproval.getByRole("button", { name: "approve", exact: true }).click();
  await page.getByText("new chat tools complete", { exact: true }).waitFor({ timeout: 20_000 });
  const newChatTranscript = await page.locator('[data-part="message"]').nth(transcriptBeforeDiscovery).innerText();
  if (newChatTranscript.includes("MCP server achilles is unavailable") || (await page.locator("body").innerText()).includes("MCP server achilles is unavailable"))
    throw new Error("new chat transcript reported achilles as unavailable after resources discovery");
  const discoveryControl = JSON.parse(await Bun.file(control).text());
  if (!discoveryControl.tool_results?.some((result: { call_id: string; is_error: boolean }) => result.call_id === "discover-resources" && !result.is_error))
    throw new Error(`mcp_discover resources call did not succeed: ${safeControl(JSON.stringify(discoveryControl.tool_results))}`);
  if (!discoveryControl.tool_results?.some((result: { call_id: string; is_error: boolean }) => result.call_id === "inspect-after-discovery" && !result.is_error))
    throw new Error(`achilles inspect_page call did not succeed after resources discovery: ${safeControl(JSON.stringify(discoveryControl.tool_results))}`);
  console.log(`two-chat page tools asserted: ${chatOne} created /reading; ${chatTwo} discovered resources and inspected it`);
  const homeInspect = await homeMcp(11, "tools/call", {
    name: "inspect_page",
    arguments: { route: "/reading" },
  });
  const homeInspectValue = JSON.parse(homeInspect.result?.content?.[0]?.text ?? "{}");
  if (
    homeInspect.result?.isError ||
    homeInspectValue.route !== "/reading" ||
    homeInspectValue.layout?.version !== 1 ||
    homeInspectValue.tools?.[0]?.name !== "add_book" ||
    JSON.stringify(homeInspectValue).includes("credentials") ||
    JSON.stringify(homeInspectValue).includes(achillesHome)
  )
    throw new Error(`home inspect_page summary mismatch: ${JSON.stringify(homeInspectValue)}`);
  await page.goto(`${origin}/reading`);
  await field.waitFor({ timeout: 20000 });
  const readingSessionId = await homeSessionId();
  if (!readingSessionId || readingSessionId === first)
    throw new Error("reading page did not get its own zeta session");
  const addBookApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "add_book" });
  const bookAdded = page.getByText("book added", { exact: true });
  await field.fill("add Synthetic Book");
  await field.press("Enter");
  await addBookApproval.waitFor({ timeout: 20000 }).catch(async (error) => {
    throw new Error(
      `${error}\nbackend=${safeControl(await Bun.file(control).text())}\nzeta-log=${redact(logs.get(zetaProcess) ?? "")}\nachilles-log=${redact(logs.get(app) ?? "")}`,
    );
  });
  await addBookApproval.getByRole("button", { name: "approve", exact: true }).click();
  await bookAdded.waitFor({ timeout: 20000 });
  await page.goto(origin);
  await field.waitFor({ timeout: 20000 });
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
  const emptyRecords = page.getByText("no records yet", { exact: true });
  await emptyRecords.waitFor({ state: "visible" });
  await waitFor(async () => (await annotationApproval.count()) > annotationApprovalBefore, "annotation approval").catch(async () => {
    throw new Error(
      `annotation approval missing: backend=${safeControl(await Bun.file(control).text())} zeta-log=${redact(logs.get(zetaProcess) ?? "")}`,
    );
  });
  await annotationApproval.nth(annotationApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await waitFor(async () => (await annotationComplete.count()) > generatedAnnotationCompleteBefore, "generated tool completion").catch(async (error) => {
      throw new Error(
        `${error}\nbackend=${safeControl(await Bun.file(control).text())}\nzeta-log=${redact(logs.get(zetaProcess) ?? "")}\nachilles-log=${redact(logs.get(app) ?? "")}`,
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
      `expected exactly one page-scoped record, got ${JSON.stringify(homeRecords)} backend=${safeControl(await Bun.file(control).text())} zeta-log=${redact(logs.get(zetaProcess) ?? "")} body=${redact(await page.locator("body").innerText())}`,
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
  if (JSON.stringify(secondNames) !== JSON.stringify(["add_book", "list_books", "update_book"]))
    throw new Error(`reading page tools were not created atomically: ${JSON.stringify(secondNames)}`);
  const secondRecords = await (
    await fetch(`${origin}/api/pages/${createdPageId}/records/books`, {
      headers: { Authorization: `Bearer ${secondCredential}` },
    })
  ).json();
  if (secondRecords.length !== 1 || secondRecords[0]?.title !== "Synthetic Book")
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
  await page.getByText("v2 turn", { exact: true }).waitFor({ timeout: 20000 });
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
      body: JSON.stringify({ version: 1 }),
    },
  );
  if (!rollback.ok) throw new Error(`rollback failed: ${rollback.status}`);
  await Bun.sleep(500);
  await field.fill("observe rollback");
  await field.press("Enter");
  await page.getByText("rollback turn", { exact: true }).waitFor({ timeout: 20000 });
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
  await page.goto(`${origin}/reading`); await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20000 });
  reconnectPage = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (reconnectPage.zeta_session_id !== readingSessionId) throw new Error("reading page session changed after reopen");
  const readingBody = await page.locator("body").innerText();
  if (reconnectPage.layout?.blocks?.[1]?.type !== "list" || !readingBody.includes("Synthetic Book")) throw new Error("reading page list did not render its inserted book");
  await page.goto(origin);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20000 });
  await page.locator('[data-part="timeline-scroll"]').evaluate((element) => { element.scrollTop = 0; });
  await page.locator('[data-part="message"]').first().waitFor({ timeout: 20_000 }).catch(() => { throw new Error("reconnected home did not render prior transcript content"); });
  const zetaPidBeforeRestart = JSON.parse(await Bun.file(control).text()).pid;
  app.kill("SIGTERM");
  await new Promise<void>((resolve) => app.once("exit", () => resolve()));
  app = start("uv", ["run", "achilles", "serve", "--host", "127.0.0.1", "--port", String(port)], appEnv);
  await waitFor(async () => (await fetch(origin).then((r) => r.ok, () => false)), "achilles restart");
  const homeAfterRestart = (await (await fetch(`${origin}/api/pages/home`)).json()).zeta_session_id;
  const createdAfterRestart = await (await fetch(`${origin}/api/pages/reading`)).json();
  if (homeAfterRestart !== homeAfterCreate || createdAfterRestart.zeta_session_id !== reconnectPage.zeta_session_id) throw new Error("page sessions changed across achilles restart");
  const newSessionsBeforeReload = requests().filter((frame) => frame.method === "new_session").length;
  await page.reload();
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20000 });
  if (await homeSessionId() !== homeAfterRestart) throw new Error("reload changed home session id");
  if (requests().filter((frame) => frame.method === "new_session").length !== newSessionsBeforeReload) throw new Error("reload created a second zeta session");
  if (approvalModeResponse("session_settings", homeAfterRestart) !== "ask") throw new Error("reloaded ask-mode session did not report ask settings");
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("reloaded ask-mode session showed the auto-approve marker");
  const beforeReconnect = JSON.parse(await Bun.file(control).text());
  const restartAnnotationApproval = page.locator('[data-part="approval"][data-state="pending"]', { hasText: "annotate_trace" });
  const restartApprovalBefore = await restartAnnotationApproval.count();
  await field.fill("post-reconnect catalog"); await field.press("Enter");
  await waitFor(async () => {
    const state = JSON.parse(await Bun.file(control).text());
    return state.request_count > (beforeReconnect.request_count ?? 0) && state.last_message.includes("post-reconnect catalog");
  }, "post-reconnect backend request");
  await waitFor(async () => (await restartAnnotationApproval.count()) > restartApprovalBefore, "post-restart generated tool approval");
  await restartAnnotationApproval.nth(restartApprovalBefore).getByRole("button", { name: "approve", exact: true }).click();
  await page.getByText("post-reconnect complete", { exact: true }).waitFor({ timeout: 20000 });
  const postReconnect = JSON.parse(await Bun.file(control).text());
  if (postReconnect.pid !== zetaPidBeforeRestart) throw new Error("zeta pid changed during achilles reconnect");
  if (!postReconnect.schemas.some((schema: string) => schema.startsWith("achilles__"))) throw new Error(`reconnected catalog had no achilles tools: ${JSON.stringify(postReconnect.schemas)}`);
  const restartAnnotationResult = postReconnect.tool_results?.find((result: { call_id: string }) => result.call_id === "annotate-after-restart");
  if (!restartAnnotationResult || restartAnnotationResult.is_error) throw new Error(`generated tool did not recover after achilles restart: ${JSON.stringify(postReconnect.tool_results)}`);
  const restartRecords = await (await fetch(`${origin}/api/pages/home/records/trace_annotations`, { headers: { Authorization: `Bearer ${credential}` } })).json();
  const restartRecordTexts = Array.isArray(restartRecords) ? restartRecords.map((record: { text?: string }) => record.text).sort() : [];
  if (JSON.stringify(restartRecordTexts) !== JSON.stringify(["after achilles restart", "from zeta"])) throw new Error(`post-restart generated tool result was not recorded: ${JSON.stringify(restartRecords)}`);
  if ((logs.get(zetaProcess) ?? "").toLowerCase().includes("failed to mount")) throw new Error("zeta failed to mount a bound server after reload");
  mcpSessions.delete(credential);
  await mcp(credential, 3, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gate", version: "1" } });
  const invalid = await mcp(credential, 5, "tools/call", { name: "create_page", arguments: { route: "/invalid", title: "invalid", layout: { blocks: [{ type: "text", text: "x", extra: true }] } } });
  if (!invalid.result?.isError || (await fetch(`${origin}/api/pages/invalid`)).status !== 404) throw new Error("invalid layout published");
  const reconnectCrossPage = await mcp(credential, 6, "tools/call", { name: "create_page", arguments: { route: "/cross", title: "cross", layout: { blocks: [{ type: "form", title: "x", tool: "other-page" }] } } });
  if (!reconnectCrossPage.result?.isError || (await fetch(`${origin}/api/pages/cross`)).status !== 404) throw new Error("cross-page reference published");
  console.log("reconnect refresh asserted: reload kept the session and refreshed the achilles catalog");
  console.log("expected skip: reload during pending approval waits for fulcrum hello params");

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
  await allowField.waitFor({ timeout: 20000 });
  const allowSession = await homeSessionId();
  if (!allowSession) throw new Error("allow-mode page session id missing");
  await page.getByLabel("auto-approve", { exact: true }).waitFor({ state: "visible" });
  if (approvalModeResponse("set_settings", allowSession) !== "allow")
    throw new Error("allow-mode session settings were not applied");
  const allowSetSettingsBeforeReload = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === allowSession).length;
  await page.reload();
  await allowField.waitFor({ timeout: 20000 });
  if (approvalModeResponse("session_settings", allowSession) !== "allow")
    throw new Error("reloaded allow-mode session did not report allow settings");
  const allowSetSettingsAfterReload = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === allowSession).length;
  if (allowSetSettingsAfterReload !== allowSetSettingsBeforeReload)
    throw new Error("reloading an allow-mode session sent a no-op set_settings frame");
  const allowApprovalBefore = await approval.count();
  const beforeAllowTurn = JSON.parse(await Bun.file(control).text());
  await allowField.fill("run the allow-mode tool");
  await allowField.press("Enter");
  await page.getByText("allow complete", { exact: true }).waitFor({ timeout: 20000 });
  const afterAllowTurn = JSON.parse(await Bun.file(control).text());
  if ((afterAllowTurn.request_count ?? 0) < (beforeAllowTurn.request_count ?? 0) + 2)
    throw new Error("allow-mode tool did not complete in this turn");
  const allowResult = afterAllowTurn.tool_results?.find((result: { call_id: string }) => result.call_id === "allow-read");
  if (!allowResult || allowResult.is_error) throw new Error(`allow-mode tool result missing: ${JSON.stringify(afterAllowTurn.tool_results)}`);
  if (await approval.count() !== allowApprovalBefore) throw new Error("allow-mode tool showed an approval card");
  await gateSettings(page, origin);
  await gateCreationApprovalDefaults(page, requests, approvalModeResponse);

  await gateVim(page, control, waitFor, async (check) => {
    const previousPid = JSON.parse(await Bun.file(control).text()).pid;
    try {
      await expectBrowserErrors(page, [], async () => {
        zetaProcess.kill("SIGTERM");
        if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta shutdown timeout during vim read-only gate");
        await check();
      });
    } finally {
      zetaProcess = start("uv", ["run", "--project", zeta, "python", join(root, "scripts/real-zeta-server.py")], env);
      await waitFor(async () => JSON.parse(await Bun.file(control).text()).pid !== previousPid, "zeta restart after vim read-only gate");
    }
  }, requests);

  const firstSetSettingsBeforeAllowReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  await page.goto(`${origin}/?chat=${first}`);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
  if (await page.getByLabel("auto-approve", { exact: true }).count()) throw new Error("user ask chat reopened under allow showed auto-approve");
  const firstSetSettingsAfterAllowReopen = requests().filter((frame) => frame.method === "set_settings" && frame.params?.session_id === first).length;
  if (firstSetSettingsAfterAllowReopen !== firstSetSettingsBeforeAllowReopen)
    throw new Error("reopening a user ask chat under an allow server sent set_settings");

  await page.goto(`${origin}/allow?chat=${allowSession}`);
  await page.getByRole("textbox", { name: "message" }).waitFor({ timeout: 20_000 });
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
    const firstFailure = page.waitForResponse(registrationFailure);
    await page.getByRole("button", { name: "new chat" }).click();
    await firstFailure;
    await retryRegistration.waitFor({ timeout: 20_000 });
    const secondFailure = page.waitForResponse(registrationFailure);
    await retryRegistration.click();
    await secondFailure;
    await retryRegistration.waitFor({ timeout: 20_000 });
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
  await page.waitForTimeout(1_000);

  const draft = "this draft must remain after zeta disconnects";
  const droppedField = page.getByRole("textbox", { name: "message" });
  await droppedField.fill(draft);
  await page.keyboard.press("Meta+b");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connected-review-1440x900.png"), fullPage: true });
  await expectBrowserErrors(page, [{ method: "GET", url: discoveryUrl, status: 503 }], async () => {
    const discoveryFailure = page.waitForResponse((response) => response.request().method() === "GET" && response.url() === discoveryUrl && response.status() === 503);
    zetaProcess.kill("SIGTERM");
    if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta did not stop for dropped-connection gate");
    await page.getByRole("alert").filter({ hasText: "the connection to zeta was lost" }).waitFor({ timeout: 20_000 });
    await discoveryFailure;
  });
  await waitFor(async () => await droppedField.inputValue({ timeout: 500 }).then((value) => value === draft, () => false), "dropped composer draft");
  if ((await page.locator("[data-session-id]").count()) !== 1) throw new Error("dropped connection hid the attached transcript");
  if (!(await page.locator(".run-state").innerText()).includes("offline")) throw new Error("dropped connection did not mark the chat offline");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connection-lost-review-1440x900.png"), fullPage: true });
  const droppedPid = zetaProcess.pid;
  zetaProcess = start(
    "uv",
    ["run", "--project", zeta, "python", join(root, "scripts/real-zeta-server.py")],
    env,
  );
  await waitFor(async () => {
    try { return JSON.parse(await Bun.file(control).text()).pid !== droppedPid; }
    catch { return false; }
  }, "zeta reconnect after dropped connection");
  await page.getByRole("button", { name: "retry now" }).click();
  const recoveredField = page.getByRole("textbox", { name: "message", exact: true });
  await waitFor(async () => await recoveredField.inputValue({ timeout: 500 }).then((value) => value === draft, () => false), "reconnected composer draft").catch(async () => { throw new Error(`reconnected composer did not restore: ${redact(await page.locator("body").innerText())}`); });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "06-collapsed-connection-recovered-review-1440x900.png"), fullPage: true });

  const previousControllerSession = new URL(page.url()).searchParams.get("chat");
  await page.keyboard.press("Meta+Shift+O");
  await waitFor(() => Promise.resolve(new URL(page.url()).searchParams.get("chat") !== previousControllerSession), "fresh observer-gate chat");
  const observerSession = new URL(page.url()).searchParams.get("chat");
  if (!observerSession) throw new Error("controller page lost its active chat before observer gate");
  const observerPage = await browser.newPage();
  await observerPage.goto(`${origin}/?chat=${encodeURIComponent(observerSession)}`);
  await observerPage.locator(".transcript").waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`observer attach failed: ${await observerPage.locator("body").innerText()}`); });
  await observerPage.getByRole("status").filter({ hasText: "zeta is in use by another tab or app" }).waitFor({ timeout: 20_000 });
  await observerPage.getByRole("cell", { name: "from zeta", exact: true }).waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`observer record list failed: ${await observerPage.locator("body").innerText()}`); });
  await observerPage.goto(`${origin}/reading?chat=${encodeURIComponent(observerSession)}`);
  await observerPage.getByRole("status").filter({ hasText: "zeta is in use by another tab or app" }).waitFor({ timeout: 20_000 });
  await observerPage.getByRole("cell", { name: "Synthetic Book", exact: true }).waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`observer reading page did not render records: ${await observerPage.locator("body").innerText()}`); });
  const assertObserverPageBlocks = async (label: string) => {
    const controls = observerPage.locator(".page-form input, .page-form button");
    if (!(await controls.count()) || !(await controls.evaluateAll((elements) => elements.every((element) => (element as HTMLInputElement | HTMLButtonElement).disabled))))
      throw new Error(`${label} observer form controls were missing or enabled`);
    const record = await observerPage.getByRole("cell", { name: "Synthetic Book", exact: true }).boundingBox();
    const transcript = await observerPage.locator(".transcript").boundingBox();
    if (!record || !transcript || record.y + record.height > transcript.y)
      throw new Error(`${label} observer record overlapped the transcript: record=${JSON.stringify(record)} transcript=${JSON.stringify(transcript)}`);
  };
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  await assertObserverPageBlocks("desktop");
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "09-observer-page-records-form-1440x900.png"), fullPage: true });
  await observerPage.setViewportSize({ width: 390, height: 844 });
  await observerPage.waitForFunction(() => { const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect(); return Boolean(sidebar && sidebar.right <= 0); });
  await assertObserverPageBlocks("mobile");
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "10-observer-page-records-form-390x844.png"), fullPage: true });
  await observerPage.setViewportSize({ width: 1440, height: 900 });
  await observerPage.goto(`${origin}/?chat=${encodeURIComponent(observerSession)}`);
  await observerPage.getByRole("status").filter({ hasText: "zeta is in use by another tab or app" }).waitFor({ timeout: 20_000 });
  if (await observerPage.getByRole("textbox", { name: "message" }).count()) throw new Error("observer page exposed a composer");
  if (!(await observerPage.getByRole("status").filter({ hasText: "another tab or app" }).innerText()).includes("another tab or app")) throw new Error("observer page did not show the controller capacity banner");
  const controllerOutputs = page.locator('[data-part="message"][data-role="assistant"]');
  const observerOutputs = observerPage.locator('[data-part="message"][data-role="assistant"]');
  const controllerOutputBefore = await controllerOutputs.count();
  const observerOutputBefore = await observerOutputs.count();
  await recoveredField.fill("observer live message", { timeout: 20_000 }).catch(async () => { throw new Error(`controller lost its composer after observer attach: ${await page.locator("body").innerText()}`); });
  await recoveredField.press("Enter");
  await page.locator(".transcript").getByText("observer live message", { exact: true }).waitFor({ timeout: 20_000 });
  await waitFor(async () => await controllerOutputs.count() > controllerOutputBefore, "controller live output");
  await observerPage.locator(".transcript").getByText("observer live message", { exact: true }).waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`observer missed live user message without reload: ${await observerPage.locator("body").innerText()}`); });
  await waitFor(async () => await observerOutputs.count() > observerOutputBefore, "observer live output").catch(async () => { throw new Error(`observer missed live output without reload: ${await observerPage.locator("body").innerText()}`); });
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "08-observer-read-only-review-1440x900.png"), fullPage: true });
  const readableObserverMessage = observerPage.locator(".transcript").getByText("observer live message", { exact: true });
  await observerPage.getByRole("button", { name: "take control" }).click();
  await observerPage.getByRole("button", { name: "cancel", exact: true }).waitFor({ timeout: 5_000 });
  await observerPage.getByText("waiting for the other tab or app to close…", { exact: true }).waitFor({ timeout: 5_000 });
  await readableObserverMessage.waitFor({ timeout: 5_000 });
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "11-takeover-waiting-transcript-1440x900.png"), fullPage: true });
  await observerPage.getByRole("button", { name: "cancel", exact: true }).click();
  await observerPage.getByRole("button", { name: "take control", exact: true }).waitFor({ timeout: 5_000 });
  await observerPage.getByRole("button", { name: "take control", exact: true }).click();
  await observerPage.getByRole("button", { name: "retry", exact: true }).waitFor({ timeout: 25_000 });
  await readableObserverMessage.waitFor({ timeout: 5_000 });
  if (screenshotDir) await observerPage.screenshot({ path: join(screenshotDir, "12-takeover-failed-transcript-1440x900.png"), fullPage: true });
  await controllerContext.close();
  await observerPage.getByRole("button", { name: "retry", exact: true }).click();
  const takeoverField = observerPage.getByRole("textbox", { name: "message", exact: true });
  const replaceMissingChat = observerPage.locator(".full-state").getByRole("button", { name: "new chat", exact: true });
  await Promise.race([takeoverField.waitFor({ timeout: 20_000 }), replaceMissingChat.waitFor({ timeout: 20_000 })]);
  if (await replaceMissingChat.isVisible()) await replaceMissingChat.click();
  await takeoverField.waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`takeover retry did not gain control: ${await observerPage.locator("body").innerText()}`); });
  await waitFor(async () => (await observerPage.locator(".run-state").innerText()).includes("idle"), "takeover retry idle");
  await takeoverField.fill("takeover retry message");
  await takeoverField.press("Enter");
  await observerPage.locator(".transcript").getByText("takeover retry message", { exact: true }).waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`takeover controller could not send: ${await observerPage.locator("body").innerText()}`); });
  page = observerPage;

  if (screenshotDir) {
    zetaProcess.kill("SIGTERM");
    if (!(await waitForExit(zetaProcess, 15_000))) throw new Error("zeta did not stop for first-paint screenshot");
    const heldRequests: Route[] = [];
    const hold = (route: Route) => { heldRequests.push(route); };
    await page.route("**/api/pages**", hold);
    await page.route("**/api/chats**", hold);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".sidebar-skeleton").first().waitFor({ timeout: 20_000 });
    await page.getByRole("alert").filter({ hasText: "zeta serve is not running" }).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(screenshotDir, "07-first-paint-not-running-review-1440x900.png"), fullPage: true });
    await Promise.all(heldRequests.map((route) => route.abort().catch(() => {})));
    await page.unroute("**/api/pages**", hold);
    await page.unroute("**/api/chats**", hold);
  }

  if (errors.length) throw new Error(`browser errors: ${redact(errors.join(" | "))}`);
  const captured = [...logs.values()].join("\n");
  if (secrets.some((secret) => captured.includes(secret) || errors.some((error) => error.includes(secret)))) throw new Error("captured output contains a zeta token");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  console.log(`real-zeta gate passed: session ${first}, created /reading with tools, late call rejected`);

} finally {
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
}
