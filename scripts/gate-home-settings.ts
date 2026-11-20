import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";

type WaitFor = (check: () => Promise<boolean>, label: string) => Promise<void>;

/** The telemetry row on /settings against the pinned zeta's temp home. Run it while no chat tab holds control.
 * A zeta without `zeta[otel]` may refuse to turn telemetry on (`telemetry_unavailable`); both outcomes are checked. */
export async function gateHomeSettings(browser: Browser, origin: string, zetaHome: string, waitFor: WaitFor, screenshotDir?: string) {
  const file = join(zetaHome, "settings.toml");
  const bytes = () => readFile(file).then((data) => data.toString("utf8"), () => null);
  const original = await bytes();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await tab.goto(`${origin}/settings#telemetry`);
    const row = tab.locator("#telemetry");
    const turnOn = row.getByRole("button", { name: "turn on telemetry", exact: true });
    await waitFor(() => turnOn.isVisible(), "settings telemetry row (off)");
    const confirmOn = async () => {
      await turnOn.click();
      const dialog = tab.getByRole("dialog", { name: "turn on telemetry" });
      await dialog.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" }).check();
      await dialog.getByRole("button", { name: "turn on telemetry", exact: true }).click();
      return dialog;
    };
    const dialog = await confirmOn();
    const receipt = row.getByText(/^telemetry is on\. if zeta\[otel\] is not installed, turn it off here before you restart zeta\. at /);
    const refusal = dialog.getByRole("alert");
    await waitFor(async () => await receipt.isVisible() || /^not changed\./.test(await refusal.textContent().catch(() => "") ?? ""), "telemetry on outcome");
    if (await receipt.isVisible()) {
      const on = await bytes();
      if (!on?.includes('endpoint = "http://127.0.0.1:4323/v1/traces"')) throw new Error("telemetry on did not write the built-in endpoint line");
      if (!(await row.innerText()).includes("restart zeta serve")) throw new Error("telemetry on receipt did not list zeta serve");
      if (screenshotDir) await tab.screenshot({ path: join(screenshotDir, "settings-telemetry-on.png") });
      await row.getByRole("button", { name: "turn off", exact: true }).click();
      await row.getByRole("group").getByRole("button", { name: "turn off", exact: true }).click();
      await waitFor(() => row.getByText(/^telemetry is off\. restart zeta to stop recording\. at /).isVisible(), "telemetry off receipt");
      // a missing file hashes as empty bytes; on then off leaves an empty file
      if ((await bytes()) !== (original ?? "")) throw new Error("telemetry off did not restore the exact original bytes");
      console.log("settings telemetry: on wrote the built-in line and listed zeta serve; off restored the exact bytes");
    } else {
      const text = await refusal.textContent();
      if (!text?.startsWith("not changed. zeta cannot record telemetry on this computer: ")) throw new Error(`telemetry on was refused with unexpected copy: ${text}`);
      if ((await bytes()) !== original) throw new Error("a refused telemetry change wrote settings.toml");
      await dialog.getByRole("button", { name: "keep it off", exact: true }).click();
      if (!await turnOn.isVisible()) throw new Error("a refused telemetry change did not keep the row off");
      console.log("settings telemetry: zeta refused turning it on; the row showed why and stayed off");
    }
    // an edit outside zeta after the page read the file: the change is refused as stale
    const edited = `${(await bytes()) ?? ""}# synthetic gate edit\n`;
    await writeFile(file, edited, { mode: 0o600 });
    const stale = await confirmOn();
    const changed = row.getByText("not changed. the state changed elsewhere; the row now shows the current state.", { exact: true });
    await waitFor(() => changed.isVisible(), "stale telemetry change copy in the row");
    if ((await bytes()) !== edited) throw new Error("a stale telemetry change wrote settings.toml");
    if (await stale.isVisible()) throw new Error("a stale telemetry change left the old review open");
    await waitFor(async () => await tab.evaluate(() => document.activeElement?.textContent) === "turn on telemetry", "focus on the row control after a stale change");
    console.log("settings telemetry: an outside edit made the change stale; nothing was written; the row kept the reason and the focus");
  } finally {
    await tab.close();
    if (original === null) await rm(file, { force: true });
    else await writeFile(file, original, { mode: 0o600 });
  }
}
