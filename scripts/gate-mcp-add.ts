import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";
import { WRITE_SURFACE } from "../apps/web/src/writeSurfaces";

export const mcpAddArtifacts = ["mcp-add-1440.png", "mcp-add-review-390.png", "mcp-add-review-200-percent.png", "mcp-add-project-trust-1440.png"];
const opts = { timeout: 10_000 };
const texts = ["name", "command", "argument", "environment-key", "environment-value", "url", "header-key", "header-value", "id", "secret"] as const;
const mark = (field: typeof texts[number]) => `mcp-add-canary-${field}`;
const receipt = (tab: Page) => tab.getByText(/^new sessions use this configuration/);
const addForm = (tab: Page) => tab.locator("[data-connection-add-form]");
const startAdd = (tab: Page) => tab.locator(`[data-write-surface="${WRITE_SURFACE.mcpAdd}"]`).click(opts);
const control = (tab: Page, name: string) => addForm(tab).locator(`[name="${name}"]`);
const choose = async (tab: Page, label: string, option: string) => {
  await addForm(tab).getByRole("combobox", { name: label, exact: true }).click(opts);
  await tab.getByRole("option", { name: option, exact: true }).click(opts);
};
const button = (tab: Page, name: string) => tab.getByRole("button", { name, exact: true });
const review = async (tab: Page) => {
  await button(tab, "review connection").click(opts);
  await tab.getByRole("alertdialog", { name: "review new connection" }).waitFor(opts);
  if (await button(tab, "add connection").isEnabled()) throw new Error("add review bypasses scope proof");
};
const confirm = async (tab: Page) => {
  await tab.getByRole("checkbox", { name: "i reviewed the scope for this connection" }).check(opts);
  await button(tab, "add connection").click(opts);
};
const fill = async (tab: Page, values: Record<string, string>) => {
  for (const [name, value] of Object.entries(values)) await control(tab, name).fill(value, opts);
};
const assertCleared = async (tab: Page) => {
  if (await addForm(tab).locator('input[type="password"]').evaluateAll((inputs) => inputs.some((item) => (item as HTMLInputElement).value !== ""))) {
    throw new Error("add form retained the private fields");
  }
};

export async function gateMcpAdd(browser: Browser, origin: string, home: string, project: string, dir?: string, processLogs?: () => string) {
  const userFile = join(home, "mcp.json"), projectFile = join(project, ".zeta", "mcp.json"), trustFile = join(home, "mcp-trust.json");
  if ((await Promise.all([userFile, projectFile, trustFile].map((path) => Bun.file(path).exists()))).some(Boolean)) throw new Error("add gate requires empty MCP config");
  await mkdir(join(project, ".zeta"), { recursive: true });
  const consoleText: string[] = [], writes: string[] = [], errors: number[] = [];
  let feature = false;
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const zoom = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  for (const context of [desktop, zoom]) await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  async function open(context = desktop) {
    const tab = await context.newPage();
    tab.on("console", (event) => consoleText.push(event.text()));
    tab.on("pageerror", (error) => consoleText.push(String(error)));
    tab.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const { method } = JSON.parse(payload);
        if (typeof method === "string" && /^mcp_(?!server_list$)/.test(method)) writes.push(method);
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const { result, error } = JSON.parse(payload);
        if (result?.capabilities?.features?.includes("mcp_management_v1")) feature = true;
        if (typeof error?.code === "number") errors.push(error.code);
      });
    });
    await tab.goto(`${origin}/connections`, opts);
    await startAdd(tab);
    return tab;
  }
  async function inspect(tab: Page, artifact?: string) {
    const state = await tab.evaluate(() => JSON.stringify([document.documentElement.outerHTML, location.href, history.state, history.length,
      performance.getEntriesByType("navigation").map((entry) => entry.name), { ...localStorage }, { ...sessionStorage }]));
    if (texts.some((key) => [state, ...consoleText, processLogs?.() ?? ""].some((line) => line.includes(mark(key))))) throw new Error("add canary escaped the form or outbound request");
    if (!await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw new Error("add form overflows viewport");
    if (!artifact || !dir) return;
    // Allow resize and browser font layout to settle, then require a stable visible surface.
    await tab.evaluate(() => document.fonts.ready.then(() => undefined));
    await Bun.sleep(300);
    const layout = () => tab.evaluate(() => JSON.stringify([innerWidth, innerHeight, ...[...document.querySelectorAll("[aria-label='Add a connection'], [role='alertdialog'], [role='dialog']")].map((node) => node.getBoundingClientRect().toJSON())]));
    const before = await layout();
    await tab.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (before !== await layout()) throw new Error("add screenshot layout is not stable");
    await tab.screenshot({ path: join(dir, artifact), animations: "disabled", ...opts });
  }
  async function httpInput(tab: Page, name: string) {
    await choose(tab, "transport", "remote HTTP");
    await control(tab, "oauth").check(opts);
    await button(tab, "add environment").click(opts);
    await button(tab, "add header").click(opts);
    await fill(tab, { name, url: `https://example.invalid/${mark("url")}`, "environment-key": mark("environment-key"), environment: mark("environment-value"),
      "header-key": mark("header-key"), header: mark("header-value"), client_id: mark("id"), client_secret: mark("secret") });
  }
  try {
    let tab = await open();
    if (!feature) throw new Error("pinned zeta hello did not negotiate mcp_management_v1");
    await button(tab, "add argument").click(opts);
    await fill(tab, { name: mark("name"), command: mark("command"), argument: mark("argument") });
    await inspect(tab, mcpAddArtifacts[0]);
    await review(tab);
    await inspect(tab);
    await button(tab, "back to fields").click(opts);
    await assertCleared(tab);
    if (writes.length !== 0) throw new Error("cancelled add wrote to zeta");
    await fill(tab, { name: "fixture-add-local", command: mark("command"), argument: mark("argument") });
    await review(tab);
    await confirm(tab);
    await receipt(tab).waitFor(opts);
    await assertCleared(tab);
    await inspect(tab);
    await tab.close();

    tab = await open(zoom);
    await httpInput(tab, "fixture-add-http");
    await review(tab);
    await inspect(tab, mcpAddArtifacts[2]);
    await confirm(tab);
    await receipt(tab).waitFor(opts);
    await tab.getByRole("link", { name: /fixture-add-http/ }).click(opts);
    await tab.getByText("OAuth configured (sign-in not checked)", { exact: true }).waitFor(opts);
    await assertCleared(tab);
    await inspect(tab);
    await tab.close();

    tab = await open();
    await tab.setViewportSize({ width: 390, height: 844 });
    await choose(tab, "scope", "zeta’s current project");
    await fill(tab, { name: "fixture-add-project", command: mark("command") });
    await review(tab);
    await inspect(tab, mcpAddArtifacts[1]);
    await confirm(tab);
    await receipt(tab).waitFor(opts);
    await assertCleared(tab);
    await button(tab, "open connection to review trust").click(opts);
    await tab.getByRole("heading", { name: "fixture-add-project" }).waitFor(opts);
    await tab.getByRole("region", { name: "connection detail" }).getByText("needs trust").waitFor(opts);
    await button(tab, "trust").waitFor(opts);
    if (await Bun.file(trustFile).exists()) throw new Error("add unexpectedly created trust state");
    await tab.setViewportSize({ width: 1440, height: 900 });
    await inspect(tab, mcpAddArtifacts[3]);
    await tab.close();

    tab = await open();
    const beforeFailures = await Bun.file(userFile).text();
    await fill(tab, { name: "fixture-add-local", command: mark("command") });
    await review(tab);
    await confirm(tab);
    await tab.getByRole("alert").filter({ hasText: "zeta refused the name or fields" }).waitFor(opts);
    await assertCleared(tab);
    await button(tab, "back to fields").click(opts);
    await choose(tab, "transport", "remote HTTP");
    await fill(tab, { name: mark("name"), url: `ftp://example.invalid/${mark("url")}` });
    await review(tab);
    await confirm(tab);
    await tab.getByRole("alert").filter({ hasText: "zeta refused the name or fields" }).waitFor(opts);
    await assertCleared(tab);
    if (await Bun.file(userFile).text() !== beforeFailures || errors.filter((code) => code === -32602).length !== 2) throw new Error("duplicate or malformed add did not fail cleanly");
    await inspect(tab);
    await button(tab, "back to fields").click(opts);
    await choose(tab, "transport", "local command (stdio)");
    await fill(tab, { name: "fixture-stale-add", command: mark("command") });
    await review(tab);
    const outOfBand = JSON.parse(beforeFailures);
    outOfBand.servers["fixture-outside"] = { transport: "stdio", command: "echo", enabled: false };
    await writeFile(userFile, JSON.stringify(outOfBand));
    await confirm(tab);
    await tab.getByRole("alert").filter({ hasText: "configuration changed elsewhere" }).waitFor(opts);
    await assertCleared(tab);
    if (!errors.includes(-32009) || (await Bun.file(userFile).text()).includes("fixture-stale-add")) throw new Error("stale add unexpectedly wrote");
    await button(tab, "back to fields").click(opts);
    await tab.getByRole("link", { name: /fixture-outside/ }).waitFor(opts);
    await fill(tab, { command: mark("command") });
    await review(tab);
    await confirm(tab);
    await receipt(tab).waitFor(opts);
    await assertCleared(tab);
    await inspect(tab);
    if (writes.length !== 7 || writes.some((method) => method !== "mcp_server_add")) throw new Error("unexpected add, trust, refresh, or OAuth request");
    console.log("MCP add: pinned hello, user stdio and HTTP OAuth, project pending trust, duplicate, malformed, stale/review again, cancel and redaction verified");
    return WRITE_SURFACE.mcpAdd;
  } finally {
    await Promise.all([desktop.close(), zoom.close()]);
    await Promise.all([userFile, projectFile, trustFile].map((path) => rm(path, { force: true })));
  }
}
