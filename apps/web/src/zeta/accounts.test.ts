import { expect, test } from "bun:test";
import { accountRecovery, accountStatus, SIGN_IN_FAILED, USAGE_FRESH_MS, type Account } from "./accounts";

const account = (id: string, flags: Partial<Account> = {}): Account => ({
  account: id,
  label: id.split(":")[1] ?? id,
  detail: null,
  usage: null,
  available: true,
  current: false,
  default: false,
  ...flags,
});

test("offers the provider default when the in-use account failed", () => {
  const accounts = [
    account("anthropic:default", { current: true }),
    account("anthropic:personal", { default: true }),
    account("codex:work", { default: true }),
  ];
  const recovery = accountRecovery(accounts);
  expect(recovery?.failed.account).toBe("anthropic:default");
  expect(recovery?.target?.account).toBe("anthropic:personal");
});

test("prefers a provider account that still has a stored login over one without", () => {
  const accounts = [
    account("anthropic:default", { current: true, default: true }),
    account("anthropic:stale", { available: false }),
    account("anthropic:spare", { available: true }),
  ];
  expect(accountRecovery(accounts)?.target?.account).toBe("anthropic:spare");
});

test("no other account of the provider: failed is reported with no target", () => {
  const recovery = accountRecovery([account("anthropic:default", { current: true, default: true })]);
  expect(recovery?.failed.account).toBe("anthropic:default");
  expect(recovery?.target).toBeNull();
});

test("zero or multiple in-use accounts: do not guess which failed", () => {
  expect(accountRecovery([account("anthropic:default", { current: true }), account("codex:work", { current: true })])).toBeNull();
  expect(accountRecovery([account("anthropic:personal", { default: true })])).toBeNull();
});

const now = Date.parse("2026-11-28T12:00:00Z");
const usage = (usedPercent: number, resetsAt: number, capturedAt: number, error: string | null = null): Account["usage"] =>
  ({ freshness: now - capturedAt > USAGE_FRESH_MS ? "stale" : "now", error, capturedAt, windows: [{ kind: "seven_day", usedPercent, minutes: 10080, resetsAt }] });
const hour = 3_600_000;

test("accountStatus: one label per shape, and Available only when every bar is current and below full", () => {
  const rows: [string, Account["usage"], Partial<Account>, string][] = [
    ["reset passed", usage(100, now - hour, now - 14 * 24 * hour), {}, "Signed in"],
    ["full current window", usage(100, now + hour, now - 60_000), {}, "Limit reached"],
    ["full window read long ago", usage(100, now + hour, now - 24 * hour), {}, "Limit reached"],
    ["stale read", usage(40, now + 24 * hour, now - USAGE_FRESH_MS - 1), {}, "Signed in"],
    ["auth error", usage(0, now + 24 * hour, now - 19 * 24 * hour, SIGN_IN_FAILED), {}, "Sign-in failed"],
    ["other refresh error", usage(10, now + 24 * hour, now - 60_000, "rate limited; retry later"), {}, "Available"],
    ["no login", usage(0, now + 24 * hour, now - 60_000), { available: false }, "Needs sign-in"],
    ["no usage", null, {}, "Signed in"],
    ["normal", usage(47, now + 24 * hour, now - USAGE_FRESH_MS), {}, "Available"],
  ];
  for (const [name, value, flags, label] of rows) {
    const status = accountStatus(account("codex:x", { usage: value, ...flags }), now);
    expect([name, status.label]).toEqual([name, label]);
    if (status.label === "Available") expect([name, status.windows.some(({ usedPercent, stale }) => usedPercent >= 100 || stale)]).toEqual([name, false]);
    expect([name, status.signIn]).toEqual([name, label === "Needs sign-in" || label === "Sign-in failed"]);
  }
});

test("accountStatus: next is the first time the status changes by the clock alone", () => {
  const fresh = accountStatus(account("codex:x", { usage: usage(10, now + hour, now - 60_000) }), now);
  expect(fresh.next).toBe(now - 60_000 + USAGE_FRESH_MS + 1);
  const read = account("codex:x", { usage: usage(10, now + hour, now - 60_000) });
  expect(accountStatus(read, fresh.next - 1).label).toBe("Available");
  expect(accountStatus(read, fresh.next).label).toBe("Signed in");
  expect(accountStatus(account("codex:x", { usage: usage(100, now + hour, now - 24 * hour) }), now).next).toBe(now + hour);
  expect(accountStatus(account("codex:x", { usage: usage(100, now - hour, now - 24 * hour) }), now).next).toBe(Infinity);
});
