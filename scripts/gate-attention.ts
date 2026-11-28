import { join } from "node:path";
import type { Browser } from "../apps/web/node_modules/playwright";
import type { Discovery } from "./gate-agent-controls";

export const attentionArtifacts = ["attention-1440.png", "attention-390.png"];
// scripts/attention-server.py seeds the owner with 2 decisions, 1 deferred item, 2 FYI notes and 1 resolved decision
const seeded = { decisions: 3, notes: 2 };

// the session detail's attention badge (zeta's attention_open) links to the attention place, which lists exactly that many
// decisions and deferred items, and the notes apart. The place only reads: no write method leaves the tab.
export async function gateAttention(browser: Browser, origin: string, discovery: Discovery, screenshots?: string) {
  for (const width of [1440, 390]) {
    const tab = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    tab.setDefaultTimeout(20_000);
    const sent: { method: string; params?: Record<string, unknown> }[] = [];
    tab.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      try { const { method, params } = JSON.parse(String(payload)); if (method) sent.push({ method, params }); } catch { /* not json */ }
    }));
    await tab.route("**/api/zeta/discovery", (route) => route.fulfill({ json: discovery }));
    try {
      await tab.goto(`${origin}/sessions`);
      await tab.getByRole("link", { name: /synthetic attention owner/ }).click();
      const badge = tab.locator(".sessions-fields a.sessions-attention-link");
      const count = Number((await badge.textContent())?.match(/^(\d+) open$/)?.[1]);
      if (count !== seeded.decisions) throw new Error(`the attention badge shows ${await badge.textContent()}, expected ${seeded.decisions} open`);
      await badge.click();
      const decisions = tab.getByRole("region", { name: `decisions · ${count}` });
      const notes = tab.getByRole("region", { name: `notes · ${seeded.notes}` });
      await decisions.waitFor();
      const listed = await decisions.getByRole("listitem").allTextContents();
      if (listed.length !== count) throw new Error(`badge ${count} but ${listed.length} decisions listed`);
      if (listed.some((text) => !text.includes("owner") || /resolved/.test(text))) throw new Error(`the decisions list holds another session's or a resolved item: ${listed.join(" | ")}`);
      if (await notes.getByRole("listitem").count() !== seeded.notes) throw new Error("the notes are not listed apart from the decisions");
      const lists = sent.filter((frame) => frame.method === "state_attention").map((frame) => frame.params?.list);
      if (!lists.includes("action") || !lists.includes("fyi")) throw new Error(`the place did not read zeta's split lists: ${lists.join(",")}`);
      const reads = /^(hello|state_|list_sessions$|status$|session_history_read$|session_history$)/;
      const other = sent.map((frame) => frame.method).filter((method) => !reads.test(method));
      if (other.length) throw new Error(`the attention place sent non-read methods: ${other.join(",")}`);
      if (screenshots) await tab.screenshot({ path: join(screenshots, `attention-${width}.png`), fullPage: true });
      console.log(`attention place ${width}: badge ${count} == ${listed.length} listed decisions; ${seeded.notes} notes apart`);
    } finally {
      await tab.close();
    }
  }
}
