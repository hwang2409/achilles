import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page, WebSocketRoute } from "../apps/web/node_modules/playwright";
import { mcpTestMethod } from "../apps/web/src/mcp/mcpOwner";
import { WRITE_SURFACE } from "../apps/web/src/writeSurfaces";

export const mcpTestArtifacts = ["mcp-test-stdio-1440.png", "mcp-test-http-390.png", "mcp-test-http-200-percent.png", "mcp-test-count-1440.png"];
const opts = { timeout: 15_000 };
const canary = "synthetic-probe-tool-canary";
const initialize = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} };
const tool = { name: canary, description: canary, inputSchema: {} };
const stdio = `
import json, os, sys, time
from pathlib import Path
mode, root = sys.argv[1:]
base = Path(root)
(base / (mode + '.pid')).write_text(str(os.getpid()))
for line in sys.stdin:
    rpc = json.loads(line)
    method = rpc['method']
    with (base / (mode + '.log')).open('a') as log:
        print(method, file=log)
    if method == 'initialize':
        data = {} if mode == 'broken' else ${JSON.stringify(initialize)}
    elif method == 'tools/list':
        if mode == 'slow':
            while not (base / 'release').exists():
                time.sleep(0.02)
        data = {'tools': [${JSON.stringify(tool)}]}
    elif method == 'notifications/initialized':
        continue
    else:
        raise AssertionError('unexpected MCP method')
    print(json.dumps({'jsonrpc': '2.0', 'id': rpc['id'], 'result': data}), flush=True)
`;

// Local synthetic HTTP fixture with socket close and method evidence.
function httpFixture() {
  const methods: string[] = [];
  let opened = false, closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET" && req.headers.get("mcp-session-id") === "fixture-session") {
      opened = true;
      req.signal.addEventListener("abort", () => { closed = true; }, { once: true });
      return new Response(new ReadableStream({
        start(stream) { stream.enqueue(new TextEncoder().encode(": ready\n\n")); },
        cancel() { closed = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const { method, id } = await req.json();
    methods.push(method);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method !== "initialize" && method !== "tools/list") return new Response(null, { status: 400 });
    if (method === "tools/list") await until("HTTP notification stream opened", () => opened);
    return Response.json({ jsonrpc: "2.0", id,
      result: method === "initialize" ? initialize : { tools: [tool, { ...tool, name: `${canary}-other` }] } },
      { headers: { "mcp-session-id": "fixture-session" } });
  } });
  return { url: `http://127.0.0.1:${server.port}/mcp`, methods, closed: () => closed, stop: () => server.stop(true) };
}

async function until(operation: string, check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + opts.timeout;
  do { if (await check()) return; await Bun.sleep(30); } while (performance.now() < deadline);
  throw new Error(`timed out: ${operation}`);
}
const trigger = (tab: Page) => tab.locator(`[data-write-surface="${WRITE_SURFACE.mcpTest}"]`);
const dialog = (tab: Page) => tab.getByRole("alertdialog", { name: "review connection test" });
async function review(tab: Page, expected: string) {
  await trigger(tab).click(opts);
  await dialog(tab).getByText(expected, { exact: false }).waitFor(opts);
  const confirm = dialog(tab).getByRole("button", { name: "test connection" });
  if (await confirm.isEnabled()) throw new Error("MCP test did not require the scope proof");
  await dialog(tab).getByRole("checkbox").check(opts);
  return confirm;
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function gateMcpTest(browser: Browser, origin: string, home: string, project: string, dir?: string) {
  const userConfig = join(home, "mcp.json"), projectConfig = join(project, ".zeta", "mcp.json");
  if ((await Promise.all([userConfig, projectConfig].map((path) => Bun.file(path).exists()))).some(Boolean)) throw new Error("test gate requires empty synthetic MCP config");
  const root = await mkdtemp(join(project, "mcp-probe-"));
  const http = httpFixture();
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const zoom = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const methods: string[] = [], roles: string[] = [];
  let privateLeak = false, refreshed = false;
  let lost: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
  let feature = false;
  const configure = (mode: string) => ({ transport: "stdio", command: "python3", args: ["-c", stdio, mode, root] });
  const open = async (name: string, context = desktop, scope = "user") => {
    const tab = await context.newPage();
    await tab.routeWebSocket((url) => url.hostname === "127.0.0.1", (page) => {
      const server = page.connectToServer();
      page.onMessage((message) => {
        const { method, params } = JSON.parse(String(message));
        if (method === "hello") roles.push(params.role);
        if (method === "mcp_refresh_tools") refreshed = true;
        if (method === mcpTestMethod) {
          methods.push(params.name);
          if (params.name === "slow") lost = { page, server };
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (String(message).includes("mcp_management_v1")) feature = true;
        if (String(message).includes(canary)) privateLeak = true;
        page.send(message);
      });
    });
    await tab.goto(`${origin}/connections/${scope}/${name}`, opts);
    return tab;
  };
  const capture = async (tab: Page, name: string) => {
    if (!dir) return;
    // Let the resized layout's transitions settle, then check for horizontal overflow.
    await Bun.sleep(300);
    await dialog(tab).locator("form").or(tab.locator("[data-test-result]")).first().waitFor(opts);
    await tab.waitForFunction(async () => {
      const layout = () => JSON.stringify(document.querySelector("[data-confirmation], .mcp-test")?.getBoundingClientRect());
      const before = layout();
      await new Promise(requestAnimationFrame);
      return before === layout();
    }, undefined, opts);
    if (!await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw new Error("MCP test layout overflowed");
    await tab.screenshot({ path: join(dir, name), animations: "disabled", ...opts });
  };
  const pidOf = async (mode: string) => Number(await Bun.file(join(root, `${mode}.pid`)).text());
  const reaped = async (mode: string) => { const pid = await pidOf(mode); await until(`reap ${mode} child`, () => !alive(pid)); };
  const log = async (mode: string) => Bun.file(join(root, `${mode}.log`)).text().catch(() => "");
  const allowlist = ["initialize", "notifications/initialized", "tools/list"];
  try {
    await mkdir(join(project, ".zeta"), { recursive: true });
    await Bun.write(userConfig, JSON.stringify({ servers: { stdio: configure("stdio"), broken: configure("broken"), slow: configure("slow"), http: { transport: "streamable-http", url: http.url } } }));
    await Bun.write(projectConfig, JSON.stringify({ servers: { untrusted: configure("untrusted") } }));
    const holder = await desktop.newPage();
    await holder.goto(`${origin}/`, opts);
    await holder.getByRole("button", { name: "new chat", exact: true }).waitFor(opts);
    const tab = await open("stdio");
    let confirm = await review(tab, "starts the configured local child process");
    if (!feature || methods.length || roles.join() !== "observer") throw new Error("probe opened without feature or borrowed control during review");
    await confirm.click(opts);
    await tab.getByRole("alert").filter({ hasText: "a chat tab keeps control" }).waitFor(opts);
    if (methods.length) throw new Error("probe sent while a chat owned control");
    await holder.close();
    await dialog(tab).getByRole("button", { name: "keep without testing" }).click(opts);
    confirm = await review(tab, "starts the configured local child process");
    await capture(tab, mcpTestArtifacts[0]!);
    await confirm.click(opts);
    await tab.getByText("1 tool (last test in this tab)", { exact: true }).waitFor(opts);
    await reaped("stdio");
    await capture(tab, mcpTestArtifacts[3]!);
    await tab.close();
    const remote = await open("http");
    await remote.setViewportSize({ width: 390, height: 844 });
    confirm = await review(remote, "makes network requests to the configured HTTP endpoint");
    await capture(remote, mcpTestArtifacts[1]!);
    await confirm.click(opts);
    await remote.getByText("2 tools (last test in this tab)", { exact: true }).waitFor(opts);
    await until("HTTP transport close", http.closed);
    if ((await remote.content()).includes(canary)) throw new Error("probe tool text reached the DOM");
    await remote.close();
    const scaled = await open("http", zoom);
    await review(scaled, "makes network requests to the configured HTTP endpoint");
    await capture(scaled, mcpTestArtifacts[2]!);
    await scaled.close();
    const broken = await open("broken");
    await (await review(broken, "starts the configured local child process")).click(opts);
    await broken.getByText("failed (last test in this tab)", { exact: true }).waitFor(opts);
    await reaped("broken");
    await broken.close();
    const untrusted = await open("untrusted", desktop, "project");
    await untrusted.getByText("trust this project stdio connection before testing it.").waitFor(opts);
    if (await trigger(untrusted).count()) throw new Error("untrusted project stdio offered a test action");
    await untrusted.close();
    const dropped = await open("slow");
    await (await review(dropped, "starts the configured local child process")).click(opts);
    await until("slow tools/list entered", async () => (await log("slow")).includes("tools/list"));
    if (!lost) throw new Error("no controller socket to drop");
    await lost.server.close();
    await lost.page.close();
    await Bun.write(join(root, "release"), "go");
    await dropped.getByRole("alert").filter({ hasText: "result unknown" }).waitFor(opts);
    await until("observer reconnect after probe drop", () => roles.at(-1) === "observer");
    await dropped.locator(".mcp-offline").waitFor({ state: "hidden", ...opts });
    await reaped("slow");
    const next = await desktop.newPage();
    await next.goto(`${origin}/`, opts);
    await next.getByRole("button", { name: "new chat", exact: true }).waitFor(opts);
    if (methods.join() !== "stdio,http,broken,slow") throw new Error("MCP tests did not match the four confirmed requests");
    for (const calls of [http.methods, (await log("stdio")).trim().split("\n"), (await log("slow")).trim().split("\n")]) {
      if (calls.join() !== allowlist.join()) throw new Error("probe did not initialize and list only");
    }
    if ((await log("broken")).trim() !== "initialize" || await log("untrusted") || privateLeak || refreshed) throw new Error("failure, trust, or wire privacy proof failed");
    console.log("MCP tests: stdio and HTTP counts, failure, no-call, reap and socket-close, observer refusal, untrusted no-send, drop without retry and control release verified");
    return WRITE_SURFACE.mcpTest;
  } finally {
    await Bun.write(join(root, "release"), "cleanup");
    await Promise.all([desktop.close(), zoom.close(), http.stop()]);
    await Promise.all([userConfig, projectConfig, root].map((path) => rm(path, { force: true, recursive: path === root })));
  }
}
