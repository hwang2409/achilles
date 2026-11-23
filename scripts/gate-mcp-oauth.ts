import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page, WebSocketRoute } from "../apps/web/node_modules/playwright";
import { authMethods as methods } from "../apps/web/src/mcp/mcpAuth";
import { WRITE_SURFACE } from "../apps/web/src/writeSurfaces";

export const mcpOAuthArtifacts = ["mcp-oauth-start-1440.png", "mcp-oauth-pending-1440.png", "mcp-oauth-cancel-390.png", "mcp-oauth-logout-200-percent.png"];
const options = { timeout: 15_000 };
const name = "fixture-oauth";
const oauthPath = `/connections/user/${name}`;
const trigger = (tab: Page, surface: string) => tab.locator(`[data-write-surface="${surface}"]`);
const state = (tab: Page, value: string) => tab.locator(`[data-auth-state="${value}"]`);

export function oauthFixture() {
  const access = "fixture-oauth-access-canary";
  let grants = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const origin = `http://127.0.0.1:${provider.port}`;
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/authorize") return new Response(`<!doctype html><title>synthetic OAuth provider</title>
      <button onclick="finish(true)">approve fixture</button><button onclick="finish(false)">deny fixture</button>
      <script>function finish(allow) {
        const params = new URLSearchParams(location.search);
        const callback = new URL(params.get('redirect_uri'));
        if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1') throw Error('non-loopback callback');
        callback.searchParams.set('state', params.get('state'));
        callback.searchParams.set(allow ? 'code' : 'error', allow ? 'fixture-grant' : 'access_denied');
        location.replace(callback.href);
      }</script>`, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      if (form.get("code") !== "fixture-grant" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      grants++;
      return Response.json({ access_token: access, token_type: "Bearer", expires_in: 3600 });
    }
    return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  } });
  const url = `http://127.0.0.1:${provider.port}/mcp`;
  return { config: { servers: { [name]: { transport: "streamable-http", url, auth: { type: "oauth", client_id: "fixture-client" } } } },
    access, grants: () => grants, stop: () => provider.stop(true) };
}

async function startReview(tab: Page) {
  await trigger(tab, WRITE_SURFACE.mcpAuthStart).click(options);
  const dialog = tab.getByRole("dialog", { name: "review OAuth sign-in" });
  const confirm = dialog.getByRole("button", { name: "sign in", exact: true });
  if (await confirm.isEnabled(options)) throw new Error("OAuth start missed scope proof");
  await dialog.getByRole("checkbox").check(options);
  return confirm;
}

async function capture(tab: Page, dir: string | undefined, index: number) {
  if (!dir) return;
  await Bun.sleep(300); // viewport settlement only; behavior is established by locator/RPC evidence.
  const laidOut = await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    Array.from(document.querySelectorAll("dialog[open] .confirmation-proof, dialog[open] .confirmation-actions")).every((node) => {
      const box = node.getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight;
    }));
  if (!laidOut) throw new Error("OAuth controls overflowed their viewport");
  await tab.screenshot({ path: join(dir, mcpOAuthArtifacts[index]!), animations: "disabled", ...options });
}

function observeWire() {
  const mutations: string[] = [], statuses: string[] = [];
  let feature = false;
  let observer: WebSocketRoute | undefined;
  let drop = false;
  let leaked = false;
  let launch = "";
  return {
    mutations, statuses, negotiated: () => feature,
    dropObserver: async () => { drop = true; await observer?.close({ code: 1011, reason: "fixture disconnect" }); },
    resume: () => { drop = false; },
    getLaunch: () => launch,
    checkLeak: () => leaked,
    install: (tab: Page) => tab.routeWebSocket((url) => url.hostname === "127.0.0.1", (page) => {
      const server = page.connectToServer();
      let role = "";
      let paused = false;
      page.onMessage((message) => {
        const { method, params } = JSON.parse(String(message));
        if (method === "hello") {
          role = params.role;
          if (role === "observer") observer = page;
          if (role === "observer" && drop) { paused = true; void page.close({ code: 1011, reason: "fixture offline" }); return; }
          paused = false;
        }
        if (method === methods.status) statuses.push(role);
        if ([methods.start, methods.cancel, methods.logout].includes(method)) mutations.push(`${role}:${method}`);
        if (launch && String(message).includes(launch)) leaked = true;
        server.send(message);
      });
      server.onMessage((message) => {
        const { result } = JSON.parse(String(message));
        if (result?.capabilities?.features?.includes("mcp_management_v1")) feature = true;
        if (typeof result?.data?.authorization_url === "string") launch = result.data.authorization_url;
        if (!paused) page.send(message);
      });
    }),
  };
}

async function popup(tab: Page) {
  const confirm = await startReview(tab);
  const [child] = await Promise.all([tab.waitForEvent("popup", options), confirm.click(options)]);
  await child.getByRole("button", { name: "approve fixture" }).waitFor(options);
  await state(tab, "pending").waitFor(options);
  if (!await child.evaluate(() => window.opener === null)) throw new Error("OAuth provider had access to the app opener");
  return child;
}

async function verifyPrivacy(tab: Page, launch: string, access: string, logged: string[]) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/launch\//.test(launch)) throw new Error("zeta did not send a one-use loopback launch");
  const app = await tab.evaluate(() => JSON.stringify([document.documentElement.outerHTML, document.URL, history.state,
    ...[localStorage, sessionStorage].map((store) => Object.keys(store).map((key) => [key, store.getItem(key)]))]));
  if ([launch, access].some(secret => app.includes(secret) || logged.some(line => line.includes(secret)))) throw new Error("OAuth handoff leaked into the app");
}

async function checkBlocked(tab: Page, wire: ReturnType<typeof observeWire>) {
  await tab.evaluate(() => { window.open = () => null; });
  await (await startReview(tab)).click(options);
  await tab.getByRole("alert").filter({ hasText: "popup could not open" }).waitFor(options);
  if (wire.mutations.length) throw new Error("blocked popup sent a write");
  await tab.reload(options);
}

async function logout(tab: Page, dir: string | undefined) {
  await trigger(tab, WRITE_SURFACE.mcpAuthLogout).click(options);
  const dialog = tab.getByRole("dialog", { name: "review saved sign-in deletion" });
  const confirm = dialog.getByRole("button", { name: "delete saved sign-in" });
  if (await confirm.isEnabled(options)) throw new Error("OAuth logout missed name proof");
  await dialog.getByRole("textbox").fill(name, options);
  await capture(tab, dir, 3);
  await confirm.click(options);
  await state(tab, "unauthorized").waitFor(options);
  await tab.getByText(/zeta deleted the saved sign-in · configuration kept at/).waitFor(options);
}

async function cancel(tab: Page, dir: string | undefined) {
  const child = await popup(tab);
  try {
    await tab.setViewportSize({ width: 390, height: 844 });
    await trigger(tab, WRITE_SURFACE.mcpAuthCancel).click(options);
    const group = tab.getByRole("group", { name: /already started saving the credential/ });
    await group.waitFor(options);
    await capture(tab, dir, 2);
    await group.getByRole("button", { name: "cancel sign-in" }).click(options);
    await state(tab, "cancelled").waitFor(options);
  } finally { await child.close(); }
}

async function settleDrop(tab: Page, wire: ReturnType<typeof observeWire>) {
  const child = await popup(tab);
  try {
    await wire.dropObserver();
    await tab.getByText(/connection lost · sign-in result unknown/).waitFor(options);
    await child.getByRole("button", { name: "deny fixture" }).click(options);
    wire.resume();
    await state(tab, "failed").waitFor(options);
  } finally { wire.resume(); await child.close(); }
}

export async function refuseMcpOAuth(page: Page, origin: string) {
  const tab = await page.context().newPage();
  const wire = observeWire();
  try {
    await wire.install(tab);
    await tab.goto(`${origin}${oauthPath}`, options);
    await (await startReview(tab)).click(options);
    await tab.getByRole("alert").filter({ hasText: "a chat tab keeps control" }).waitFor(options);
    if (wire.mutations.length) throw new Error("OAuth sent while a chat held control");
  } finally { await tab.close(); }
}

async function complete(tab: Page, fixture: ReturnType<typeof oauthFixture>, wire: ReturnType<typeof observeWire>, dir: string | undefined, logged: string[]) {
  const confirm = await startReview(tab);
  await capture(tab, dir, 0);
  // Close just this review; the actual confirmation is still exercised through the click/popup event.
  if (!await confirm.isEnabled(options)) throw new Error("review did not accept scope proof");
  await tab.getByRole("button", { name: "keep current state" }).click(options);
  const child = await popup(tab);
  try {
    await capture(tab, dir, 1);
    const launch = wire.getLaunch();
    await verifyPrivacy(tab, launch, fixture.access, logged);
    const replay = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(options.timeout) });
    if (replay.status !== 404) throw new Error("OAuth launch replay did not return 404");
    await child.getByRole("button", { name: "approve fixture" }).click(options);
    await state(tab, "succeeded").waitFor(options);
    if (fixture.grants() !== 1) throw new Error("OAuth did not exchange the synthetic grant exactly once");
  } finally { await child.close(); }
}

export async function gateMcpOAuth(browser: Browser, origin: string, home: string, dir?: string) {
  const path = join(home, "mcp.json");
  if (await Bun.file(path).exists()) throw new Error("OAuth gate requires empty synthetic config");
  const fixture = oauthFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const zoom = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const tab = await context.newPage();
  const wire = observeWire();
  const logged: string[] = [];
  tab.on("console", (line) => logged.push(line.text()));
  tab.on("pageerror", (error) => logged.push(error.message));
  try {
    await Bun.write(path, JSON.stringify(fixture.config));
    await wire.install(tab);
    await tab.goto(`${origin}${oauthPath}`, options);
    await checkBlocked(tab, wire);
    await complete(tab, fixture, wire, dir, logged);
    await cancel(tab, dir);
    await fetch(wire.getLaunch(), { signal: AbortSignal.timeout(options.timeout) }).then(
      () => { throw new Error("cancel did not close the loopback listener"); }, () => {});
    await settleDrop(tab, wire);
    const zoomTab = await zoom.newPage();
    await wire.install(zoomTab);
    await zoomTab.goto(`${origin}${oauthPath}`, options);
    await logout(zoomTab, dir);
    if (!wire.negotiated() || !wire.statuses.length || wire.statuses.some(role => role !== "observer")) throw new Error("OAuth status did not use a negotiated observer socket");
    if (wire.mutations.join() !== [methods.start, methods.start, methods.cancel, methods.start, methods.logout].map(method => `controller:${method}`).join() || wire.checkLeak()) throw new Error("OAuth requests were duplicated or not private");
    return [WRITE_SURFACE.mcpAuthStart, WRITE_SURFACE.mcpAuthCancel, WRITE_SURFACE.mcpAuthLogout];
  } finally {
    await Promise.all([context.close(), zoom.close()]);
    fixture.stop();
    await rm(path, { force: true });
  }
}

if (import.meta.main) {
  const [origin, home, dir] = Bun.argv.slice(2);
  if (origin && !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) throw new Error("fixture origin must be loopback");
  if (!origin || !home) throw new Error("usage: bun scripts/gate-mcp-oauth.ts ORIGIN SYNTHETIC_ZETA_HOME [SCREENSHOT_DIR]");
  const { chromium } = await import("../apps/web/node_modules/playwright");
  const browser = await chromium.launch({ headless: true });
  try { console.log(`OAuth proof passed: ${(await gateMcpOAuth(browser, origin, home, dir)).join(", ")}`); }
  finally { await browser.close(); }
}
