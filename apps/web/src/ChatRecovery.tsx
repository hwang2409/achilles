import { useCallback, useEffect, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { accountRecovery, listAccounts, supportsRequest, switchAccount, type Account } from "./zeta";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)) || "unknown error";

/** What the composer shows after a local slash command ran. */
export type CommandOutput =
  | { kind: "accounts"; accounts: Account[] }
  | { kind: "note"; text: string; tone: "danger" | "muted" }
  | { kind: "loading"; text: string }
  | null;

/**
 * Local slash commands for the composer. `/accounts` lists the provider accounts (the in-use one marked) and
 * `/accounts <provider:name>` switches to one; `run` returns true when the draft should be cleared. `switchTo`
 * is shared with the auth-error recovery panel.
 */
export function useComposerCommands(client: ZetaClient | null, sessionId: string | null) {
  const [output, setOutput] = useState<CommandOutput>(null);
  useEffect(() => setOutput(null), [sessionId]);

  const canList = Boolean(client && sessionId && supportsRequest(client, "account_list"));
  const canSwitch = Boolean(client && sessionId && supportsRequest(client, "account_switch"));

  const refresh = useCallback(async () => {
    if (!client || !sessionId) return;
    try {
      setOutput({ kind: "accounts", accounts: await listAccounts(client, sessionId) });
    } catch (error) {
      setOutput({ kind: "note", text: `could not read accounts: ${errorText(error)}`, tone: "danger" });
    }
  }, [client, sessionId]);

  const switchTo = useCallback(async (account: string) => {
    if (!client || !sessionId) return;
    setOutput({ kind: "loading", text: `switching to ${account}…` });
    try {
      await switchAccount(client, sessionId, account);
      await refresh();
    } catch (error) {
      setOutput({ kind: "note", text: `could not switch to ${account}: ${errorText(error)}`, tone: "danger" });
    }
  }, [client, sessionId, refresh]);

  const run = useCallback((command: { name: string; arg: string }) => {
    if (command.name !== "accounts") {
      setOutput({ kind: "note", text: `commands are not available here: /${command.name}`, tone: "danger" });
      return false; // keep the draft so the user can edit or clear it
    }
    if (!canList) {
      setOutput({ kind: "note", text: "accounts are not available on this zeta.", tone: "danger" });
      return true;
    }
    if (command.arg) void switchTo(command.arg);
    else void refresh();
    return true;
  }, [canList, refresh, switchTo]);

  return { output, run, refresh, switchTo, canSwitch, clear: () => setOutput(null) };
}

function AccountList({ accounts, canSwitch, onSwitch, onClose }: { accounts: Account[]; canSwitch: boolean; onSwitch: (account: string) => void; onClose: () => void }) {
  return (
    <div className="composer-accounts" role="group" aria-label="accounts">
      <p className="composer-accounts-title">accounts</p>
      <ul>
        {accounts.map((item) => (
          <li key={item.account}>
            <span className="composer-account-id">{item.account}</span>
            <span className="composer-account-tags">
              {item.current ? "current" : item.default ? "default" : ""}
              {!item.available ? " · needs login" : ""}
            </span>
            {!item.current && canSwitch ? <button type="button" onClick={() => onSwitch(item.account)}>switch</button> : <span />}
          </li>
        ))}
      </ul>
      <div className="composer-notice-actions"><button type="button" onClick={onClose}>close</button></div>
    </div>
  );
}

/** The command output area under the composer: an account list or a one-line note. */
export function CommandOutputView({ output, canSwitch, onSwitch, onDismiss }: { output: CommandOutput; canSwitch: boolean; onSwitch: (account: string) => void; onDismiss: () => void }) {
  if (!output) return null;
  if (output.kind === "loading") return <div className="composer-notice" role="status"><span>{output.text}</span></div>;
  if (output.kind === "note")
    return (
      <div className="composer-notice" role={output.tone === "danger" ? "alert" : "status"} data-tone={output.tone}>
        <span>{output.text}</span>
        <div className="composer-notice-actions"><button type="button" onClick={onDismiss}>dismiss</button></div>
      </div>
    );
  return <AccountList accounts={output.accounts} canSwitch={canSwitch} onSwitch={onSwitch} onClose={onDismiss} />;
}

/**
 * Shown when the chat's last turn failed to authenticate. It names the account that failed, offers to switch this
 * chat to a working account of the same provider, and offers a new chat. With no other account to offer, it hides
 * the switch and says how to fix the login.
 */
export function AuthErrorRecovery({ client, sessionId, message, canSwitch, onSwitch, onNewChat }: { client: ZetaClient; sessionId: string; message: string; canSwitch: boolean; onSwitch: (account: string) => void; onNewChat: () => void }) {
  const [recovery, setRecovery] = useState<{ failed: Account; target: Account | null } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    listAccounts(client, sessionId).then(
      (accounts) => { if (live) setRecovery(accountRecovery(accounts)); },
      () => { if (live) setRecovery(null); },
    );
    return () => { live = false; };
  }, [client, sessionId]);

  const failed = recovery ? `${recovery.failed.account}: login failed` : message;
  const target = recovery?.target ?? null;
  return (
    <div className="create-mode-alert chat-auth-error" role="alert">
      <span>{failed}</span>
      <span className="chat-auth-error-actions">
        {target && canSwitch ? (
          <button type="button" onClick={() => onSwitch(target.account)}>switch this chat to {target.account}</button>
        ) : recovery !== undefined ? (
          <span className="chat-auth-error-fix">run <code>zeta accounts</code> or log in again to fix it</span>
        ) : null}
        <button type="button" onClick={onNewChat}>start a new chat</button>
      </span>
    </div>
  );
}
