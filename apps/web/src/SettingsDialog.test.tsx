import "./test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, test } from "bun:test";
import { SettingsDialog } from "./SettingsDialog";
import { resetSettings, updateSettings } from "./settings";
const { cleanup, render } = await import("@testing-library/react");

const globals = globalThis as { Notification?: unknown };
const saved = { notification: globals.Notification, locks: Object.getOwnPropertyDescriptor(navigator, "locks") };
afterEach(() => {
  cleanup();
  resetSettings();
  globals.Notification = saved.notification;
  if (saved.locks) Object.defineProperty(navigator, "locks", saved.locks); else delete (navigator as { locks?: unknown }).locks;
});

function withPermission(permission: NotificationPermission) {
  globals.Notification = { permission, requestPermission: async () => permission };
  Object.defineProperty(navigator, "locks", { configurable: true, value: {} });
}

test("a stored 'on' whose site permission was reset shows the switch off and says why", () => {
  withPermission("default");
  updateSettings({ notify: true });
  const ui = render(<SettingsDialog open={false} onClose={() => {}} canWrite />);
  const toggle = ui.getByRole("switch", { name: "notifications", hidden: true });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.parentElement?.textContent).toBe("off: the browser has no permission now. turn this on to ask again.");
});

test("with the permission given, the stored 'on' shows on", () => {
  withPermission("granted");
  updateSettings({ notify: true });
  const ui = render(<SettingsDialog open={false} onClose={() => {}} canWrite />);
  expect(ui.getByRole("switch", { name: "notifications", hidden: true }).getAttribute("aria-checked")).toBe("true");
});
