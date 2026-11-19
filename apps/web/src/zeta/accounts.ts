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

/** If more than one provider has a current account, the auth error cannot identify which failed. */
export function accountRecovery(accounts: Account[]): { failed: Account; target: Account | null } | null {
  const current = accounts.filter((item) => item.current);
  const failed = current.length === 1 ? current[0] : undefined;
  if (!failed) return null;
  const candidates = accounts.filter((item) => item !== failed && item.available && providerOf(item.account) === providerOf(failed.account));
  return { failed, target: candidates.find((item) => item.default) ?? candidates[0] ?? null };
}
