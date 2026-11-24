import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;

const BUILT_IN = 'otel.endpoint = "http://127.0.0.1:4323/v1/traces"\n';
// the pinned zeta's start error when `zeta[otel]` is missing; CI and the gate run without that extra
const MISSING_OTEL = "OpenTelemetry support is not installed; install zeta[otel]";

/** The telemetry row on /settings against the pinned zeta's temp home. Run it while no chat tab holds control.
 * Without `zeta[otel]` zeta refuses to turn telemetry on (`telemetry_unavailable`); the off path runs on a line written here. */
export async function gateHomeSettings(browser: Browser, origin: string, zetaHome: string, waitFor: WaitFor, screenshotDir?: string) {
  const file = join(zetaHome, "settings.toml");
  const bytes = () => readFile(file).then((data) => data.toString("utf8"), () => null);
  const original = await bytes();
  // non-empty bytes, so "not written" compares real content
  const seeded = `${original ?? ""}# synthetic gate settings\n`;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await writeFile(file, seeded, { mode: 0o600 });
    await tab.goto(`${origin}/settings#telemetry`);
    const row = tab.locator("#telemetry");
    const turnOn = row.getByRole("button", { name: "turn on telemetry", exact: true });
    await waitFor(() => turnOn.isVisible(), "settings telemetry row (off)");
    const confirmOn = async () => {
      await tab.setViewportSize({ width: 720, height: 450 });
      await turnOn.click();
      const dialog = tab.getByRole("alertdialog", { name: "turn on telemetry" });
      const proof = dialog.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" });
      // The effective 200% viewport must show the acknowledgement without first scrolling it into view.
      await proof.evaluate((node) => {
        const label = node.closest("label")!.getBoundingClientRect();
        const footer = node.closest("[data-confirmation]")!.querySelector("footer")!.getBoundingClientRect();
        if (label.top < 0 || label.bottom > footer.top) {
          throw new Error(`expected the telemetry acknowledgement to fit above the footer before interaction: label [${label.top}, ${label.bottom}], footer ${footer.top}`);
        }
      }, undefined, { timeout: 5_000 });
      await tab.setViewportSize({ width: 1440, height: 900 });
      await proof.check();
      await dialog.getByRole("button", { name: "turn on telemetry", exact: true }).click();
      return dialog;
    };
    const dialog = await confirmOn();
    const refusal = dialog.getByRole("alert");
    const refused = `not changed. zeta cannot record telemetry on this computer: ${MISSING_OTEL}`;
    await waitFor(async () => await refusal.textContent().catch(() => "") === refused, "telemetry on refused with zeta's start error");
    if ((await bytes()) !== seeded) throw new Error("a refused telemetry change wrote settings.toml");
    if (screenshotDir) await tab.screenshot({ path: join(screenshotDir, "settings-telemetry-refused-1440x900.png") });
    // Resize after the result arrives: focus alone does not keep a scroll target in view after reflow.
    await tab.setViewportSize({ width: 390, height: 844 });
    await refusal.evaluate((node) => {
      const footer = node.closest("[data-confirmation]")!.querySelector("footer")!;
      const alert = node.getBoundingClientRect();
      const footerTop = footer.getBoundingClientRect().top;
      if (document.activeElement !== node || alert.top < 0 || alert.bottom > footerTop || node.scrollHeight > node.clientHeight) {
        throw new Error(`expected the focused telemetry refusal to fit above the footer after resize: alert [${alert.top}, ${alert.bottom}], footer ${footerTop}`);
      }
    }, undefined, { timeout: 5_000 });
    if (screenshotDir) await tab.screenshot({ path: join(screenshotDir, "settings-telemetry-refused-390x844.png") });
    await tab.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByRole("button", { name: "keep it off", exact: true }).click();
    await turnOn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => { throw new Error("a refused telemetry change did not keep the row off"); });
    const sha = createHash("sha256").update(seeded).digest("hex");
    console.log(`settings telemetry: zeta refused turning it on; the row showed zeta's reason; settings.toml sha256 ${sha} unchanged`);
    // off on a file that has the built-in line, written outside zeta. zeta checks that telemetry can start before
    // the revision, so the stale case runs on off.
    await writeFile(file, BUILT_IN + seeded, { mode: 0o600 });
    await tab.reload();
    const turnOff = row.getByRole("button", { name: "turn off", exact: true });
    const confirmOff = async () => {
      await turnOff.click();
      const group = row.getByRole("group");
      await group.getByRole("button", { name: "turn off", exact: true }).click();
      return group;
    };
    await waitFor(() => turnOff.isVisible(), "settings telemetry row (on)");
    // an edit outside zeta after the page read the file: the change is refused as stale
    const edited = `${BUILT_IN}${seeded}# synthetic gate edit\n`;
    await writeFile(file, edited, { mode: 0o600 });
    const stale = await confirmOff();
    const changed = row.getByText("not changed. the state changed elsewhere; the row now shows the current state.", { exact: true });
    await waitFor(() => changed.isVisible(), "stale telemetry change copy in the row");
    if ((await bytes()) !== edited) throw new Error("a stale telemetry change wrote settings.toml");
    if (await stale.isVisible()) throw new Error("a stale telemetry change left the old review open");
    await waitFor(async () => await tab.evaluate(() => document.activeElement?.textContent) === "turn off", "focus on the row control after a stale change");
    console.log("settings telemetry: an outside edit made the change stale; nothing was written; the row kept the reason and the focus");
    await confirmOff();
    await waitFor(() => row.getByText(/^at .+: telemetry is off\. restart zeta to stop recording\.$/).isVisible(), "telemetry off receipt");
    if ((await bytes()) !== `${seeded}# synthetic gate edit\n`) throw new Error("telemetry off did not remove exactly the built-in line");
    console.log("settings telemetry: off removed exactly the built-in line");
  } finally {
    await tab.close();
    if (original === null) await rm(file, { force: true });
    else await writeFile(file, original, { mode: 0o600 });
  }
}
