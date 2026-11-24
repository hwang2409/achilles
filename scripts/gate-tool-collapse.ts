import { chromium } from "../apps/web/node_modules/playwright";

// Bundle the same transcript and tool renderer as the app, without a backend or earlier gate steps.
const build = await Bun.build({ entrypoints: ["./apps/web/src/chat/tool-collapse-fixture.tsx"], target: "browser" });
if (!build.success) throw new AggregateError(build.logs, "could not build tool fixture");
const js = await build.outputs.find((asset) => asset.path.endsWith(".js"))!.text();
const css = await build.outputs.find((asset) => asset.path.endsWith(".css"))!.text();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.setContent(`<style>${css}</style><div id="root" style="height:800px"></div>`);
  await page.addScriptTag({ content: js, type: "module" });
  const card = page.locator('[data-part="tool"]');
  const summary = card.locator('[data-part="tool-header"]');
  const row = card.locator('xpath=ancestor::*[@data-virtual-id][1]');
  const next = row.locator('xpath=following-sibling::*[@data-virtual-id][1]');
  await next.getByText("Next reply").waitFor();
  if (await card.getAttribute("open") !== null || await card.locator('[data-part="tool-body"]').count()) throw new Error("tool details must start collapsed and unmounted");
  const measure = () => row.evaluate((owner) => ({
    height: owner.getBoundingClientRect().height,
    distance: owner.nextElementSibling!.getBoundingClientRect().top - owner.getBoundingClientRect().top,
  }));
  const baseline = await measure();
  await summary.click();
  await card.getByText("raw", { exact: true }).click();
  await card.locator('details[data-part="tool-raw"] pre').waitFor();
  const geometry = async (expected: number, expanded: boolean) => {
    try {
      await page.waitForFunction(({ expected, expanded }) => {
        const card = document.querySelector<HTMLDetailsElement>('[data-part="tool"]')!;
        const owner = card.closest('[data-virtual-id]')!;
        const distance = owner.nextElementSibling!.getBoundingClientRect().top - owner.getBoundingClientRect().top;
        const height = owner.getBoundingClientRect().height;
        return expanded ? height > expected + 24 && distance >= height - 1 : !card.open && Math.abs(height - expected) <= 1 && Math.abs(distance - expected) <= 1;
      }, { expected, expanded }, { timeout: 3000 });
    } catch (error) {
      throw new Error(`${expanded ? "raw disclosure must expand before the next item" : "collapsed tool must restore the original height and next-item position"}: expected ${expected}px, observed ${JSON.stringify(await measure())}`, { cause: error });
    }
  };
  await geometry(baseline.height, true);
  const expanded = await measure();
  await summary.click();
  await geometry(baseline.height, false);
  console.log("tool collapse:", { baseline, expanded, collapsed: await measure() });
} finally {
  await browser.close();
}
