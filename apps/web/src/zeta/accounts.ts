import type { ZetaClient } from "@fulcrum/zeta";

/** One named provider account as zeta's `account_list` reports it. `account` is `provider:name`. */
export type Account = {
  account: string;
  label: string;
  detail: string | null;
  available: boolean;
  current: boolean;
  default: boolean;
};

/** zeta's `account_list` is per active session (it validates `session_id`). */
export async function listAccounts(client: ZetaClient, sessionId: string): Promise<Account[]> {
  const result = (await client.request("account_list", { session_id: sessionId })) as { accounts?: Account[] };
  return result.accounts ?? [];
}

/** Switch this session's account for its provider. zeta requires the session idle; `account` is `provider:name`. */
export async function switchAccount(client: ZetaClient, sessionId: string, account: string): Promise<void> {
  await client.request("account_switch", { session_id: sessionId, account });
}

const providerOf = (account: string) => account.split(":", 1)[0];

/**
 * After a provider auth error, the account a chat should switch to. The failed account is the provider's in-use
 * (`current`) account; the target is that provider's `default` if it differs, else another of its accounts,
 * preferring one that still has a stored login. `target` is null when the provider has no other account to offer.
 */
export function accountRecovery(accounts: Account[]): { failed: Account; target: Account | null } | null {
  let fallback: { failed: Account; target: null } | null = null;
  for (const failed of accounts.filter((item) => item.current)) {
    const others = accounts.filter((item) => item !== failed && providerOf(item.account) === providerOf(failed.account));
    const target = others.find((item) => item.default) ?? others.find((item) => item.available) ?? others[0] ?? null;
    if (target) return { failed, target };
    fallback ??= { failed, target: null };
  }
  return fallback;
}
