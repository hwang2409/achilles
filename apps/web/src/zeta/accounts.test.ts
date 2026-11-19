import { expect, test } from "bun:test";
import { accountRecovery, type Account } from "./accounts";

const account = (id: string, flags: Partial<Account> = {}): Account => ({
  account: id,
  label: id.split(":")[1] ?? id,
  detail: null,
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
