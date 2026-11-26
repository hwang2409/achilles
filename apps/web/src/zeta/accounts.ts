import type { ZetaClient } from "@fulcrum/zeta";

export const ACCOUNT_LIST_IDLE_FEATURE = "account_list_idle_v1";

type UsageWindow = { kind: "five_hour" | "seven_day" | "primary"; usedPercent: number; minutes: number; resetsAt: number };
export type Account = {
  account: string;
  label: string;
  detail: null;
  available: boolean;
  current: boolean;
  default: boolean;
  usage: { freshness: "now" | "stale" | "usage unknown"; refreshFailed: boolean; windows: UsageWindow[] } | null;
};

export type AccountCatalog = { revision: string | null; accounts: Account[] };

export class AccountReadError extends Error {}
const unreadable = () => new AccountReadError("zeta returned an unreadable account catalog.");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unreadable();
  return value as Record<string, unknown>;
};

const safeUsageErrors = new Set([
  "authentication failed; log in again", "rate limited; retry later", "invalid usage response; retry later",
  "network error; check your connection and retry", "provider error; retry later", "refresh canceled; retry",
  "internal refresh error; retry or restart zeta", "invalid usage response",
]);
const isoTime = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw unreadable();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw unreadable();
  return time;
};

function usage(value: unknown): NonNullable<Account["usage"]> {
  const { freshness, error, snapshot } = record(value);
  if (freshness !== "now" && freshness !== "stale" && freshness !== "usage unknown") throw unreadable();
  if (error !== null && (typeof error !== "string" || !safeUsageErrors.has(error))) throw unreadable();
  const refreshFailed = error !== null;
  if (snapshot === null && freshness === "usage unknown") return { freshness, refreshFailed, windows: [] };
  const { version, captured_at, source, windows } = record(snapshot);
  if (freshness === "usage unknown" || version !== 1 || (source !== "usage_endpoint" && source !== "provider_error") || !Array.isArray(windows) || !windows.length) throw unreadable();
  isoTime(captured_at);
  return { freshness, refreshFailed, windows: windows.map((value): UsageWindow => {
    const { kind, used_percent, window_minutes, resets_at } = record(value);
    if (kind !== "five_hour" && kind !== "seven_day" && kind !== "primary") throw unreadable();
    if (typeof used_percent !== "number" || !Number.isFinite(used_percent) || used_percent < 0 || used_percent > 100) throw unreadable();
    if (typeof window_minutes !== "number" || !Number.isSafeInteger(window_minutes) || window_minutes <= 0) throw unreadable();
    return { kind, usedPercent: used_percent, minutes: window_minutes, resetsAt: isoTime(resets_at) };
  }) };
}

const safeSlug = (value: string) => /^[a-z0-9_-]{1,32}$/.test(value) && !/^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)/.test(value);

export const safeAccountId = (value: string) => /^(?:anthropic|codex):/.test(value) && safeSlug(value.slice(value.indexOf(":") + 1));

function catalog(wire: unknown, idle: boolean): AccountCatalog {
  const result = record(wire);
  const revision = idle ? result.revision : null;
  if (idle && (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision))) throw unreadable();
  const { accounts } = idle ? record(result.data) : result;
  if (!Array.isArray(accounts)) throw unreadable();
  const seen = new Set<string>();
  return { revision: typeof revision === "string" ? revision : null, accounts: accounts.map((value): Account => {
    const { account, label, detail, available, current, default: isDefault, usage: rawUsage } = record(value);
    if (typeof account !== "string" || !safeAccountId(account) || seen.has(account)) throw unreadable();
    if (typeof label !== "string" || !safeSlug(label) || (idle && detail !== null)) throw unreadable();
    if (typeof available !== "boolean" || typeof current !== "boolean" || typeof isDefault !== "boolean") throw unreadable();
    seen.add(account);
    // Legacy detail can contain credential metadata. No caller needs it.
    return { account, label, detail: null, available, current, default: isDefault, usage: !idle && rawUsage === undefined ? null : usage(rawUsage) };
  }) };
}

type AccountClient = Pick<ZetaClient, "request" | "features"> & { authority?: "controller" | "observer" };
const observerRefusal = () => new AccountReadError("this tab cannot read accounts while zeta is full.");

// the default deadline turns an unanswered account_list into an error instead of an endless "loading"
export async function readAccounts(client: AccountClient, sessionId?: string, options: Parameters<ZetaClient["request"]>[2] = { timeoutMs: 12_000 }): Promise<AccountCatalog> {
  if (client.authority === "observer") throw observerRefusal();
  const idle = client.features.includes(ACCOUNT_LIST_IDLE_FEATURE);
  if (!idle && !sessionId) throw new AccountReadError("start a chat before reading accounts on this zeta.");
  let result: unknown;
  try {
    result = await client.request("account_list", idle ? {} : { session_id: sessionId }, options);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === -32008) throw observerRefusal();
    throw new AccountReadError(code === -32602 ? "zeta did not accept the account request." : code === -32005 ? "zeta's account store is unavailable." : "could not read accounts from zeta.");
  }
  return catalog(result, idle);
}

export async function listAccounts(client: ZetaClient, sessionId: string): Promise<Account[]> {
  return (await readAccounts(client, sessionId)).accounts;
}

const providerOf = (account: string) => account.split(":", 1)[0];

/** If more than one provider has a current account, the auth error cannot identify which failed. */
export function accountRecovery(accounts: Account[]): { failed: Account; target: Account | null } | null {
  const current = accounts.filter((item) => item.current);
  const failed = current.length === 1 ? current[0] : undefined;
  if (!failed) return null;
  const candidates = accounts.filter((item) => item !== failed && item.available && providerOf(item.account) === providerOf(failed.account));
  return { failed, target: candidates.find((item) => item.default) ?? candidates[0] ?? null };
}
