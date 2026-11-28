import type { ZetaClient } from "@fulcrum/zeta";

export const ACCOUNT_LIST_IDLE_FEATURE = "account_list_idle_v1";

type UsageWindow = { kind: "five_hour" | "seven_day" | "primary"; usedPercent: number; minutes: number; resetsAt: number };
type Usage = { error: string | null } & (
  | { freshness: "usage unknown"; capturedAt: null; windows: [] }
  | { freshness: "now" | "stale"; capturedAt: number; windows: UsageWindow[] }
);
export type Account = {
  account: string;
  label: string;
  detail: null;
  available: boolean;
  current: boolean;
  default: boolean;
  usage: Usage | null;
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

function usage(value: unknown): Usage {
  const { freshness, error, snapshot } = record(value);
  if (freshness !== "now" && freshness !== "stale" && freshness !== "usage unknown") throw unreadable();
  if (error !== null && (typeof error !== "string" || !safeUsageErrors.has(error))) throw unreadable();
  if (snapshot === null && freshness === "usage unknown") return { freshness, error, capturedAt: null, windows: [] };
  const { version, captured_at, source, windows } = record(snapshot);
  if (freshness === "usage unknown" || version !== 1 || (source !== "usage_endpoint" && source !== "provider_error") || !Array.isArray(windows) || !windows.length) throw unreadable();
  return { freshness, error, capturedAt: isoTime(captured_at), windows: windows.map((value): UsageWindow => {
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

// zeta's FRESH_FOR (accounts/usage.py): a reading older than this is "stale".
export const USAGE_FRESH_MS = 15 * 60_000;
export const SIGN_IN_FAILED = "authentication failed; log in again";

export type WindowStatus = UsageWindow & { passed: boolean; limited: boolean; stale: boolean };
export type AccountStatus = {
  label: "Needs sign-in" | "Sign-in expired" | "Limit reached" | "Available" | "Signed in";
  tone: "ok" | "warn" | "danger";
  signIn: boolean;
  /** The usage refresh problem the row shows. Null for zeta's auth error: the label and sign-in action already say it. */
  refreshError: string | null;
  windows: WindowStatus[];
  /** The next time this status changes by the clock alone; Infinity when none. */
  next: number;
};

/**
 * The one source for an account row: its label, every bar, and every window line.
 * `signedInAt` is a succeeded sign-in for this account; zeta keeps the usage auth error until the next usage refresh.
 */
export function accountStatus({ available, usage }: Account, now: number, signedInAt = -Infinity): AccountStatus {
  const old = !usage || usage.freshness !== "now" || now - usage.capturedAt > USAGE_FRESH_MS;
  const windows = (usage?.windows ?? []).map((window): WindowStatus => {
    const passed = window.resetsAt <= now;
    // Usage only grows inside a window, so a full reading holds until its reset, as zeta's known_exhausted.
    const limited = window.usedPercent >= 100 && !passed;
    return { ...window, passed, limited, stale: passed || (old && !limited) };
  });
  const times = windows.map(({ resetsAt }) => resetsAt);
  if (usage?.capturedAt != null && !old) times.push(usage.capturedAt + USAGE_FRESH_MS + 1);
  const next = Math.min(...times.filter(time => time > now));
  const refreshError = usage?.error && usage.error !== SIGN_IN_FAILED ? usage.error : null;
  const status = (label: AccountStatus["label"], tone: AccountStatus["tone"], signIn = false) => ({ label, tone, signIn, refreshError, windows, next });
  if (!available) return status("Needs sign-in", "danger", true);
  if (usage?.error === SIGN_IN_FAILED && signedInAt <= (usage.capturedAt ?? -Infinity)) return status("Sign-in expired", "danger", true);
  if (windows.some(({ limited }) => limited)) return status("Limit reached", "warn");
  return windows.length && windows.every(({ stale }) => !stale) ? status("Available", "ok") : status("Signed in", "ok");
}
