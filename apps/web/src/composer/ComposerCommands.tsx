import { useCallback, useEffect, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { restorableFocus } from "../keyboard";
import { WRITE_SURFACE } from "../writeSurfaces";
import { listAccounts, safeAccountId, supportsRequest, type Account } from "../zeta";
import { useAccountSwitch } from "../accounts/AccountSwitchReview";
import { currentAccount, type ChatDestination } from "../accounts/accountSwitch";
import "./composer-commands.css";

type Output = { accounts: Account[] } | { text: string; error?: boolean };

export function useComposerCommands(client: ZetaClient | null, chat: ChatDestination | null, canWrite: boolean) {
  const sessionId = chat?.id ?? null;
  const openSwitch = useAccountSwitch();
  const [output, setOutput] = useState<Output | null>(null);
  const revision = useRef(0);
  const close = useCallback(() => { revision.current++; setOutput(null); }, []);
  useEffect(() => { close(); return () => { revision.current++; }; }, [client, sessionId, canWrite, close]);
  const canList = Boolean(canWrite && client && sessionId && supportsRequest(client, "account_list"));
  const canSwitch = Boolean(canList && client && supportsRequest(client, "account_switch"));

  function switchTo(rows: Account[], to: string, opener: HTMLElement | null) {
    if (!chat || !canSwitch) return;
    if (!safeAccountId(to) || !rows.some(row => row.account === to && row.available && !row.current)) {
      setOutput({ text: "choose an available account that is not already in use (see /accounts).", error: true });
      return;
    }
    openSwitch({ chat, from: currentAccount(rows, to), to, onCatalog: accounts => setOutput({ accounts }) }, WRITE_SURFACE.composerAccountSwitch, opener);
  }

  async function accounts(account: string, opener: HTMLElement | null) {
    if (!client || !sessionId || !canList) return;
    const request = ++revision.current;
    setOutput({ text: "reading accounts…" });
    try {
      const rows = await listAccounts(client, sessionId);
      if (request !== revision.current) return;
      setOutput({ accounts: rows });
      if (account) switchTo(rows, account, opener);
    } catch {
      if (request === revision.current) setOutput({ text: "could not read accounts from zeta.", error: true });
    }
  }

  return {
    output, close, canSwitch, switchTo,
    run(command: { name: string; arg: string }, opener: HTMLElement | null) {
      revision.current++;
      if (!canWrite) return false;
      if (command.name !== "accounts") {
        setOutput({ text: `commands are not available here: /${command.name}. use // to send a literal slash.`, error: true });
        return false;
      }
      if (!canList || (command.arg && !canSwitch)) {
        setOutput({ text: sessionId ? "accounts are not available on this zeta" : "start a chat before using /accounts", error: true });
        return false;
      }
      void accounts(command.arg, opener);
      return true;
    },
  };
}

export function CommandOutput({ commands, opener }: { commands: ReturnType<typeof useComposerCommands>; opener: HTMLElement | null }) {
  const panel = useRef<HTMLDivElement>(null);
  const { output, close, canSwitch, switchTo } = commands;
  const open = Boolean(output);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !event.target.isConnected || (event.target instanceof Element && event.target.closest(".confirmation-dialog")) || panel.current?.contains(event.target) || opener?.contains(event.target)) return;
      const active = document.activeElement;
      // Click runs after the browser has assigned focus, as in the page chat overflow.
      if (!restorableFocus(active) || panel.current?.contains(active)) opener?.focus({ preventScroll: true });
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target instanceof Element && event.target.closest(".confirmation-dialog"))) return;
      event.preventDefault();
      event.stopPropagation();
      opener?.focus({ preventScroll: true });
      close();
    };
    document.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("keydown", onKey, true); };
  }, [open, opener, close]);
  if (!output) return null;
  return <div ref={panel} className="composer-command-output" role="group" aria-label="composer command result">
    <p role={"error" in output && output.error ? "alert" : "status"}>{"accounts" in output ? (output.accounts.length ? "accounts" : "no accounts") : output.text}</p>
    <button className="composer-command-close" type="button" onClick={() => { opener?.focus({ preventScroll: true }); close(); }}>close</button>
    {"accounts" in output && <ul>
      {output.accounts.map((account) => <li key={account.account}>
        <span>{account.account}</span>
        <small>{[account.current ? "current" : account.default ? "default" : "", !account.available ? "needs login" : ""].filter(Boolean).join(" · ")}</small>
        {!account.current && <button type="button" data-write-surface={WRITE_SURFACE.composerAccountSwitch} disabled={!canSwitch || !account.available} aria-label={`switch to ${account.account}`} onClick={() => switchTo(output.accounts, account.account, opener)}>switch</button>}
      </li>)}
    </ul>}
  </div>;
}
