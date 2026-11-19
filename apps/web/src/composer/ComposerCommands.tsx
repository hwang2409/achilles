import { useCallback, useEffect, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { restorableFocus } from "../keyboard";
import { WRITE_SURFACE } from "../writeSurfaces";
import { listAccounts, supportsRequest, switchAccount, type Account } from "../zeta";
import "./composer-commands.css";

type Output = { accounts: Account[] } | { text: string; error?: boolean };

export function useComposerCommands(client: ZetaClient | null, sessionId: string | null, canWrite: boolean) {
  const [output, setOutput] = useState<Output | null>(null);
  const revision = useRef(0);
  const close = useCallback(() => { revision.current++; setOutput(null); }, []);
  useEffect(() => { close(); return () => { revision.current++; }; }, [client, sessionId, canWrite, close]);
  const canList = Boolean(canWrite && client && sessionId && supportsRequest(client, "account_list"));
  const canSwitch = Boolean(canList && client && supportsRequest(client, "account_switch"));

  async function accounts(account?: string) {
    if (!client || !sessionId || !canList) return;
    const request = ++revision.current;
    setOutput({ text: account ? `switching to ${account}…` : "reading accounts…" });
    try {
      if (account) await switchAccount(client, sessionId, account);
      if (request !== revision.current) return;
      const accounts = await listAccounts(client, sessionId);
      if (request === revision.current) setOutput({ accounts });
    } catch (error) {
      if (request === revision.current) setOutput({ text: `could not ${account ? `switch to ${account}` : "read accounts"}: ${error instanceof Error ? error.message : String(error)}`, error: true });
    }
  }

  return {
    output, close, canSwitch,
    switchTo: (account: string) => { if (canSwitch) void accounts(account); },
    run(command: { name: string; arg: string }) {
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
      void accounts(command.arg || undefined);
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
      if (!(event.target instanceof Node) || !event.target.isConnected || panel.current?.contains(event.target) || opener?.contains(event.target)) return;
      const active = document.activeElement;
      // Click runs after the browser has assigned focus, as in the page chat overflow.
      if (!restorableFocus(active) || panel.current?.contains(active)) opener?.focus({ preventScroll: true });
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
        {!account.current && <button type="button" data-write-surface={WRITE_SURFACE.composerAccountSwitch} disabled={!canSwitch} aria-label={`switch to ${account.account}`} onClick={() => { opener?.focus({ preventScroll: true }); switchTo(account.account); }}>switch</button>}
      </li>)}
    </ul>}
  </div>;
}
