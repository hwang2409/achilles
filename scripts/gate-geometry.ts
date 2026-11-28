import type { Page } from "playwright";

// the global :focus-visible ring is a 2px outline at a 2px offset (apps/web/src/style.css)
const focusRing = 4;

// 390 chat: user bubbles and tool rows share the composer's side edges (>= 12 px), and a tool status is never cut.
export async function assertChatInsets(page: Page) {
  const geometry = await page.evaluate(() => {
    const transcript = [...document.querySelectorAll<HTMLElement>(".transcript")].find((element) => !element.closest(".page-chat-docked"));
    const composer = document.querySelector<HTMLElement>('[data-part="composer"]')?.getBoundingClientRect();
    const edges = (element: Element) => { const box = element.getBoundingClientRect(); return { left: Math.round(box.left), right: Math.round(innerWidth - box.right) }; };
    const rows = (selector: string) => [...(transcript?.querySelectorAll(selector) ?? [])].filter((element) => element.getBoundingClientRect().height > 0);
    return {
      composer: composer && { left: Math.round(composer.left), right: Math.round(innerWidth - composer.right) },
      users: rows('[data-part="timeline"] > [data-virtual-id^="user:"] > *').map(edges),
      tools: rows('[data-part="tool"]').map(edges),
      statuses: rows('[data-part="tool-status"]').map((element) => ({ ...edges(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
    };
  });
  const { composer, users, tools, statuses } = geometry;
  const sameEdges = (box: { left: number; right: number }) => composer && Math.abs(box.left - composer.left) <= 1 && Math.abs(box.right - composer.right) <= 1;
  if (!composer || composer.left < 12 || composer.right < 12 || !users.length || !users.every(sameEdges) || !tools.every(sameEdges) ||
    statuses.some((status) => status.scrollWidth > status.clientWidth || status.right < composer.right - 1))
    throw new Error(`390px chat rows do not share the composer's side inset: ${JSON.stringify(geometry)}`);
  return geometry;
}

// 390 page chat header: "Pages / <page> / <chat>" stays one line; the crumb (the middle part) takes the ellipsis.
export async function assertPageCrumbOneLine(page: Page) {
  const geometry = await page.evaluate(() => {
    const crumb = document.querySelector<HTMLElement>(".chat-heading > .page-crumb");
    const header = crumb?.closest(".chat-header")?.getBoundingClientRect();
    const title = crumb?.parentElement?.querySelector(":scope > strong")?.getBoundingClientRect();
    if (!header || !crumb || !title) return null;
    const box = crumb.getBoundingClientRect();
    const style = getComputedStyle(crumb);
    return { headerTop: header.top, headerBottom: header.bottom, top: box.top, bottom: box.bottom, height: box.height, fontSize: parseFloat(style.fontSize),
      whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, titleWidth: title.width };
  });
  if (!geometry || geometry.height >= 2 * geometry.fontSize || geometry.top < geometry.headerTop || geometry.bottom > geometry.headerBottom ||
    geometry.whiteSpace !== "nowrap" || geometry.textOverflow !== "ellipsis" || geometry.titleWidth <= 0)
    throw new Error(`page chat breadcrumb is not one clipped-free line: ${JSON.stringify(geometry)}`);
  return geometry;
}

// agents detail: "‹ all runs" and its focus ring sit inside the scrolling detail panel, which clips anything outside it.
export async function assertAgentsBackInPanel(page: Page) {
  const geometry = await page.evaluate(() => {
    const back = document.querySelector(".agents-back")?.getBoundingClientRect();
    const panel = document.querySelector(".agents-detail-scroll")?.getBoundingClientRect();
    return back && panel ? { back: { top: back.top, left: back.left, right: back.right }, panel: { top: panel.top, left: panel.left, right: panel.right } } : null;
  });
  if (!geometry || geometry.back.top - focusRing < geometry.panel.top || geometry.back.left - focusRing < geometry.panel.left || geometry.back.right + focusRing > geometry.panel.right)
    throw new Error(`agents "all runs" button or its focus ring is outside the detail panel: ${JSON.stringify(geometry)}`);
  return geometry;
}
