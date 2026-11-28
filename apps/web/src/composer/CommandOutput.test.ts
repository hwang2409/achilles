import "../test-dom";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import type { Account } from "../zeta";

// after test-dom: React must see the registered DOM.
const { cleanup, render, screen } = await import("@testing-library/react");
const { CommandOutput } = await import("./ComposerCommands");

const now = Date.parse("2026-11-28T12:00:00Z");
beforeEach(() => setSystemTime(now));
afterEach(() => { cleanup(); setSystemTime(); });

// Synthetic accounts only.
const account = (id: string, usedPercent: number, flags: Partial<Account> = {}, error: string | null = null): Account => ({
  account: id, label: id.split(":")[1], detail: null, available: true, current: false, default: false,
  usage: { freshness: "now", error, capturedAt: now - 60_000, windows: [{ kind: "seven_day", usedPercent, minutes: 10080, resetsAt: now + 3_600_000 }] },
  ...flags,
});

test("/accounts hints come from the shared account status", () => {
  const accounts = [
    account("codex:default", 100, { default: true }),
    account("codex:orchard", 0, {}, "authentication failed; log in again"),
    account("anthropic:spare", 0, { available: false }),
    account("anthropic:default", 5, { current: true }),
  ];
  const commands = { output: { accounts }, close() {}, canSwitch: true, switchTo() {} } as unknown as Parameters<typeof CommandOutput>[0]["commands"];
  render(createElement(CommandOutput, { commands, opener: null }));
  const hint = (id: string) => screen.getByText(id).parentElement!.querySelector("small")!.textContent;
  expect(hint("codex:default")).toBe("Default · Limit reached");
  expect(hint("codex:orchard")).toBe("Sign-in expired");
  expect(hint("anthropic:spare")).toBe("Needs sign-in");
  expect(hint("anthropic:default")).toBe("Current");
});
