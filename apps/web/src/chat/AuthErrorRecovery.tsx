import { useEffect, useId, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { READ_ONLY_REASON, WRITE_SURFACE } from "../writeSurfaces";
import { accountRecovery, listAccounts, supportsRequest, switchAccount } from "../zeta";
import "./auth-error-recovery.css";

type Login = { state: "pending"; authorization_url?: string } | { state: "succeeded" } | { state: "failed" | "idle" | "cancelled"; error?: { message?: string } };

export function AuthErrorRecovery({ client, sessionId, canWrite, onNewChat }: { client: ZetaClient; sessionId: string; canWrite: boolean; onNewChat: () => void }) {
  const reason = useId();
  const [recovery, setRecovery] = useState<ReturnType<typeof accountRecovery>>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [authorization, setAuthorization] = useState("");
  const [recovered, setRecovered] = useState(false);
  const failed = canWrite ? recovery?.failed : undefined;
  const target = canWrite ? recovery?.target : undefined;
  const [provider, name] = failed?.account.split(":") ?? [];
  // login_start always writes the literal default label, not the account marked default in the registry.
  const loginProvider = provider === "anthropic" ? "claude" : provider === "codex" ? "codex" : undefined;
  const browserLogin = name === "default" && loginProvider && supportsRequest(client, "login_start") && supportsRequest(client, "login_status");

  useEffect(() => {
    if (!canWrite || !supportsRequest(client, "account_list")) return;
    let live = true;
    void listAccounts(client, sessionId).then((accounts) => { if (live) setRecovery(accountRecovery(accounts)); }, () => {});
    return () => { live = false; };
  }, [client, sessionId, canWrite]);

  function finishLogin(result: Login) {
    setAuthorization("");
    setBusy(false);
    setRecovered(result.state === "succeeded");
    setNotice(result.state === "succeeded" ? "logged in. send your message again to retry." : ("error" in result && result.error?.message) || "sign-in did not finish. try again.");
  }

  useEffect(() => {
    if (!canWrite || !authorization || !loginProvider) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const result = await client.request("login_status", { provider: loginProvider }) as Login;
          if (live) { if (result.state === "pending") poll(); else finishLogin(result); }
        } catch {
          if (live) finishLogin({ state: "failed", error: { message: "could not check sign-in. try again." } });
        }
      }, 1200);
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [authorization, canWrite, client, loginProvider]);

  async function logIn() {
    if (!canWrite || !failed || busy) return;
    if (!browserLogin) {
      // The CLI takes a provider and label separately. Use shell quoting even for server-supplied labels.
      const label = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(name!) ? name : `'${name!.replaceAll("'", "'\\''")}'`;
      setNotice(`on the zeta host, run: zeta accounts login ${provider} ${label} --replace`);
      return;
    }
    setBusy(true);
    setNotice("starting sign-in…");
    try {
      const result = await client.request("login_start", { provider: loginProvider }) as Login;
      if (result.state !== "pending") return finishLogin(result);
      const url = new URL(result.authorization_url ?? "");
      if (url.protocol !== "https:") throw new Error("invalid sign-in URL");
      setAuthorization(url.href);
      setNotice("finish signing in in the browser, then return here.");
    } catch { finishLogin({ state: "failed", error: { message: "could not start sign-in. try again." } }); }
  }

  async function switchToTarget() {
    if (!canWrite || !target || busy || !supportsRequest(client, "account_switch")) return;
    setBusy(true);
    setNotice(`switching to ${target.account}…`);
    try {
      await switchAccount(client, sessionId, target.account);
      setRecovered(true);
      setNotice(`switched to ${target.account}. send your message again to retry.`);
    } catch {
      setNotice(`could not switch to ${target.account}. try again.`);
    } finally { setBusy(false); }
  }

  return <div className="chat-auth-error" aria-describedby={!canWrite ? reason : undefined}>
    <strong role="status">{failed ? <>account <code>{failed.account}</code> failed</> : "this chat's account failed to sign in"}</strong>
    <p>this chat stays pinned to its account until you switch it.</p>
    <div className="chat-auth-error-actions">
      <button type="button" data-write-surface={WRITE_SURFACE.authLogin} disabled={!failed || busy || recovered} onClick={() => void logIn()}>{failed ? `log in to ${failed.account}` : "log in to this account"}</button>
      {(target || !failed) && <button type="button" data-write-surface={WRITE_SURFACE.authSwitch} disabled={!target || busy || recovered || !supportsRequest(client, "account_switch")} onClick={() => void switchToTarget()}>{target ? `switch this chat to ${target.account}` : "switch this chat to another account"}</button>}
      <button type="button" data-write-surface={WRITE_SURFACE.authNewChat} disabled={!canWrite} onClick={() => { if (canWrite) onNewChat(); }}>new chat</button>
    </div>
    {!canWrite ? <p id={reason}>{READ_ONLY_REASON}</p> : <>
      {!failed && <p>could not identify the failed account. check your zeta accounts or start a new chat.</p>}
      {notice && <p role="status">{notice}</p>}
      {authorization && <a className="chat-auth-login-link" href={authorization} target="_blank" rel="noopener noreferrer">continue to {provider} sign-in (new tab)</a>}
    </>}
  </div>;
}
