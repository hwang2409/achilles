import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "../apps/web/node_modules/playwright";
import { mcpMethods } from "../apps/web/src/mcp/mcpOwner";

export const mcpWriteArtifacts = ["mcp-config-1440.png", "mcp-trust-390.png", "mcp-remove-200-percent.png", "mcp-stale-1440.png"];
const wait = { timeout: 10_000 };
const projectName = "fixture-project";
const userName = "fixture-user";
const canaries = ["MCP_GATE_ARGUMENT_CANARY", "MCP_GATE_ENV_CANARY"];
const config = (name: string, enabled: boolean, args: string[]) => ({ servers: {
  [name]: { transport: "stdio", command: "echo", args, enabled, env: { FIXTURE_VALUE: canaries[1] } },
} });
const connection = (scope: string, name: string) => `/connections/${scope}/${name}`;
const confirm = (tab: Page) => tab.locator(".confirmation-primary");
const action = (tab: Page, kind: "enabled" | "trusted" | "remove") => tab.locator(`[data-write-surface="mcp.${kind}"]`);
const settings = (tab: Page) => tab.locator(".mcp-actions");

export async function gateMcpWrites(browser: Browser, origin: string, home: string, project: string, screenshotDir?: string) {
  const homeConfig = join(home, "mcp.json"), projectConfig = join(project, ".zeta", "mcp.json"), trust = join(home, "mcp-trust.json");
  if ((await Promise.all([homeConfig, projectConfig, trust].map((path) => Bun.file(path).exists()))).some(Boolean)) throw new Error("MCP gate requires an empty synthetic config");
  await mkdir(join(project, ".zeta"), { recursive: true });
  const projectDoc = config(projectName, true, [canaries[0]!]);
  await Bun.write(homeConfig, JSON.stringify(config(userName, false, [canaries[0]!])));
  await Bun.write(projectConfig, JSON.stringify(projectDoc));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const zoomContext = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const errors: string[] = [], consoleText: string[] = [], methods: string[] = [], roles: string[] = [];
  const ids = new Set<string>();
  for (const view of [context, zoomContext]) await view.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  async function open(path: string, track = true, view = context) {
    const tab = await view.newPage();
    tab.on("pageerror", (error) => errors.push(String(error)));
    tab.on("console", (entry) => consoleText.push(entry.text()));
    if (track) tab.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const { method, params } = JSON.parse(payload);
      if (method === "hello") roles.push(params.role);
      if (Object.values(mcpMethods).some((name) => name === method)) methods.push(method);
    }));
    await tab.goto(`${origin}${path}`, wait);
    return tab;
  }
  async function capture(tab: Page, name?: string) {
    for (const id of await settings(tab).locator("[data-write-surface]").evaluateAll((items) => items.map((item) => item.getAttribute("data-write-surface")!))) ids.add(id);
    const surface = await tab.evaluate(() => JSON.stringify([document.documentElement.outerHTML, location.href, document.cookie,
      { ...localStorage }, { ...sessionStorage }]));
    if (canaries.some((secret) => surface.includes(secret) || [...consoleText, ...errors].some((line) => line.includes(secret)))) throw new Error("MCP config canary escaped redaction");
    const fits = await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    if (!fits) throw new Error("MCP layout overflows the viewport");
    if (name && screenshotDir) await tab.screenshot({ path: join(screenshotDir, name), ...wait });
  }
  async function review(tab: Page, kind: "trusted" | "remove") {
    await action(tab, kind).click(wait);
    const proof = tab.getByRole("textbox", { name: `type ${projectName} to confirm` });
    await proof.waitFor(wait);
    if (await confirm(tab).isEnabled()) throw new Error("MCP level 2 confirm accepted empty proof");
    await proof.fill(projectName, wait);
  }
  const receipt = async (tab: Page) => tab.getByText(/new sessions use this configuration\. running sessions are unchanged\. zeta serve does not need to restart\./).waitFor(wait);
  try {
    const holder = await open("/", false);
    await holder.getByRole("button", { name: "new chat", exact: true }).waitFor(wait);
    const tab = await open(connection("user", userName));
    await action(tab, "enabled").click(wait);
    await confirm(tab).waitFor(wait);
    if (methods.length || roles.join(",") !== "observer") throw new Error("MCP observer acted before confirmation");
    await confirm(tab).click(wait);
    await tab.getByRole("alert").filter({ hasText: "a chat tab keeps control" }).waitFor(wait);
    if (methods.length) throw new Error("MCP observer sent a write while a chat owns control");
    await holder.close();
    for (const word of ["enable", "disable"]) {
      await settings(tab).getByRole("button", { name: word, exact: true }).click(wait);
      await confirm(tab).click(wait);
      await receipt(tab);
    }
    await tab.goto(`${origin}${connection("project", projectName)}`, wait);
    await action(tab, "trusted").waitFor(wait);
    await capture(tab, mcpWriteArtifacts[0]);
    await tab.setViewportSize({ width: 390, height: 844 });
    for (const word of ["trust", "untrust"]) {
      if (await action(tab, "trusted").innerText(wait) !== word) throw new Error("MCP trust did not reflect the project definition");
      await review(tab, "trusted");
      if (word === "trust") await capture(tab, mcpWriteArtifacts[1]);
      await confirm(tab).click(wait);
      await receipt(tab);
    }
    await tab.setViewportSize({ width: 1440, height: 900 });
    await review(tab, "remove");
    await Bun.write(projectConfig, JSON.stringify({ ...projectDoc, changed_out_of_band: true }));
    await confirm(tab).click(wait);
    await tab.getByText(/configuration changed elsewhere\. nothing was written/).waitFor(wait);
    await capture(tab, mcpWriteArtifacts[3]);
    await tab.getByRole("button", { name: "keep current config" }).click(wait);
    const zoom = await open(connection("project", projectName), true, zoomContext);
    await review(zoom, "remove");
    await zoom.getByText(/any OAuth credential is not deleted/).waitFor(wait);
    await capture(zoom, mcpWriteArtifacts[2]);
    await confirm(zoom).click(wait);
    await receipt(zoom);
    await zoom.getByText("connection not found", { exact: true }).waitFor(wait);
    if ((await Bun.file(projectConfig).json()).servers[projectName]) throw new Error("MCP remove did not delete the project configuration");
    if (methods.join(",") !== [mcpMethods.enabled, mcpMethods.enabled, mcpMethods.trusted, mcpMethods.trusted, mcpMethods.remove, mcpMethods.remove].join(","))
      throw new Error("MCP sends did not match the six confirmed attempts");
    await capture(zoom);
    if (errors.length) throw new Error("MCP browser reported an error");
    console.log("MCP observer refusal, enable/disable, trust/untrust, stale review, remove, receipts and redaction verified");
    return ids;
  } finally {
    await Promise.all([context.close(), zoomContext.close()]);
    await Promise.all([homeConfig, projectConfig, trust].map((path) => rm(path, { force: true })));
  }
}
