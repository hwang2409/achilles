import { useCallback, useEffect, useRef, useState } from "react";
import { listSlashCommands, MODEL_INPUT_IDS_FEATURE, runSlashCommand, sendModelInput, type SlashCommandInfo, type ZetaClient } from "@fulcrum/zeta";
import { restorableFocus } from "../keyboard";
import { WRITE_SURFACE } from "../writeSurfaces";
import { accountStatus, listAccounts, safeAccountId, supportsFeature, supportsRequest, type Account } from "../zeta";
import { useAccountSwitch } from "../accounts/AccountSwitchReview";
import { currentAccount, type ChatDestination } from "../accounts/accountSwitch";
import { getSettings, updateSettings } from "../settings";
import { webSlashCommands } from "./commands";
import "./composer-commands.css";

type Output = { accounts: Account[] } | { text: string; error?: boolean; command?: boolean };

const reason = (error: unknown) => (error instanceof Error && error.message) || "zeta did not answer.";

/**
 * `draft`: the composer's text; a draft that starts with "/" reads the session's slash commands once (again after a
 * failed read). `restore`: puts a refused command's exact text back into the composer.
 */
export function useComposerCommands(client: ZetaClient | null, chat: ChatDestination | null, canWrite: boolean, draft: string, restore: (text: string) => void, advertised = supportsRequest) {
  const sessionId = chat?.id ?? null;
  const openSwitch = useAccountSwitch();
  const [output, setOutput] = useState<Output | null>(null);
  const [slashList, setSlashList] = useState<SlashCommandInfo[] | null | "failed">(null);
  // a failed read is tried again on the next "/"
  if (slashList === "failed" && !draft.startsWith("/")) setSlashList(null);
  const revision = useRef(0);
  const close = useCallback(() => { revision.current++; setOutput(null); }, []);
  useEffect(() => { close(); setSlashList(null); return () => { revision.current++; }; }, [client, sessionId, canWrite, close]);
  const canList = Boolean(canWrite && client && sessionId && advertised(client, "account_list"));
  const canSwitch = Boolean(canList && client && advertised(client, "account_switch"));
  // an older zeta (no slash requests, or no opaque model input) shows no menu and runs nothing
  const canSlash = Boolean(canWrite && client && sessionId && advertised(client, "slash_list") && advertised(client, "slash_run") && supportsFeature(client, MODEL_INPUT_IDS_FEATURE));
  const wantsList = canSlash && draft.startsWith("/") && slashList === null;
  useEffect(() => {
    if (!wantsList || !client || !sessionId) return;
    let live = true;
    // a failed read shows no menu, so the draft still runs through slash_run on enter
    listSlashCommands(client, sessionId).then((list) => webSlashCommands(list.commands), () => "failed" as const).then((commands) => { if (live) setSlashList(commands); });
    return () => { live = false; };
  }, [wantsList, client, sessionId]);

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

  /** `draft`: the exact text enter took out of the composer; a refusal puts it back. */
  async function slash(text: string, draft: string) {
    if (!client || !sessionId) return;
    const request = ++revision.current;
    const show = (next: Output | null) => { if (request === revision.current) setOutput(next); };
    const refuse = (message: string) => {
      if (request !== revision.current) return;
      setOutput({ text: message, error: true });
      restore(draft);
    };
    show({ text: `running ${text}…`, command: true });
    try {
      const result = await runSlashCommand(client, sessionId, text);
      if (result.kind === "output") show({ text: result.text, command: true });
      else if (result.kind === "error") refuse(result.text);
      else if (result.kind === "client_only") refuse(`${text} runs only in the zeta terminal.`);
      else if (result.kind === "unknown") refuse(`${text} is not a command. use // to send it as a message.`);
      else if (result.kind === "model_input" && result.input_id) {
        // the prompt goes out as this command's own message; its echo shows it in the transcript
        const sent = await sendModelInput(client, sessionId, result.input_id);
        if ("accepted" in sent) show(null);
        else refuse("zeta did not accept the command's message.");
      } else refuse("zeta sent a reply this page cannot read.");
    } catch (error) {
      refuse(reason(error));
    }
  }

  return {
    output, close, canSwitch, switchTo, slashList: canSlash ? (slashList === "failed" ? [] : slashList) : null,
    /** `draft`: the exact composer text the command came from */
    run(command: { name: string; arg: string }, opener: HTMLElement | null, draft: string) {
      revision.current++;
      // achilles' own vim mode, as in the palette; zeta's /vim would change the zeta terminal's mode instead
      if (command.name === "vim") {
        const arg = command.arg.toLowerCase();
        const vim = arg === "on" ? true : arg === "off" ? false : arg === "" || arg === "toggle" ? !getSettings().vim : null;
        if (vim === null) {
          setOutput({ text: "use /vim, /vim on, or /vim off.", error: true });
          return false;
        }
        updateSettings({ vim });
        return true;
      }
      if (!canWrite) return false;
      if (command.name !== "accounts" && canSlash) {
        void slash(`/${command.name}${command.arg ? ` ${command.arg}` : ""}`, draft);
        return true;
      }
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

// Only states that matter when choosing an account; the page shows the rest.
const accountHint = (account: Account) => { const { label, tone } = accountStatus(account, Date.now()); return tone === "ok" ? "" : label; };

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
    <p role={"error" in output && output.error ? "alert" : "status"} data-command-text={("command" in output && output.command) || undefined}>{"accounts" in output ? (output.accounts.length ? "accounts" : "no accounts") : output.text}</p>
    <button className="composer-command-close" type="button" onClick={() => { opener?.focus({ preventScroll: true }); close(); }}>close</button>
    {"accounts" in output && <ul>
      {output.accounts.map((account) => <li key={account.account}>
        <span>{account.account}</span>
        <small>{[account.current ? "Current" : account.default ? "Default" : "", accountHint(account)].filter(Boolean).join(" · ")}</small>
        {!account.current && <button type="button" data-write-surface={WRITE_SURFACE.composerAccountSwitch} disabled={!canSwitch || !account.available} aria-label={`Switch to ${account.account}`} onClick={() => switchTo(output.accounts, account.account, opener)}>Switch</button>}
      </li>)}
    </ul>}
  </div>;
}
