import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { AccountLoginStatus } from "../accounts/AccountLoginStatus";
import { type createAccountLogin, type LoginTarget } from "../accounts/accountLogin";
import { useAccountSwitch } from "../accounts/AccountSwitchReview";
import type { ChatDestination } from "../accounts/accountSwitch";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import { surfaceHref } from "../surface/routes";
import { READ_ONLY_REASON, WRITE_SURFACE } from "../writeSurfaces";
import { ACCOUNT_LIST_IDLE_FEATURE, accountRecovery, listAccounts, supportsFeature, supportsRequest } from "../zeta";
import "./auth-error-recovery.css";

const started = { status: "committed", receipt: reviewText("sign-in attempt checked") } as const;

export function AuthErrorRecovery({ client, chat, canWrite, onNewChat, code, login }: {
  client: ZetaClient; chat: ChatDestination; canWrite: boolean; onNewChat: () => void; code?: string; login: ReturnType<typeof createAccountLogin>;
}) {
  const reason = useId();
  const [recovery, setRecovery] = useState<ReturnType<typeof accountRecovery>>(null);
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<{ target: LoginTarget; opener: HTMLButtonElement; key: number }>();
  const openSwitch = useAccountSwitch();
  const attempt = useSyncExternalStore(login.subscribe, login.snapshot);
  const failed = canWrite ? recovery?.failed : undefined;
  const target = canWrite ? recovery?.target : undefined;
  const attemptHere = failed && attempt?.target.account === failed.account ? attempt : null;
  const busy = attempt && !("at" in attempt);
  const [provider, name] = failed?.account.split(":") ?? [];
  const browserLogin = supportsFeature(client, ACCOUNT_LIST_IDLE_FEATURE) && supportsRequest(client, "login_start") && supportsRequest(client, "login_status");

  useEffect(() => {
    if (!canWrite || !supportsRequest(client, "account_list")) return;
    let live = true;
    void listAccounts(client, chat.id).then((accounts) => { if (live) setRecovery(accountRecovery(accounts)); }, () => {});
    return () => { live = false; };
  }, [client, chat.id, canWrite]);

  function logIn(opener: HTMLButtonElement) {
    if (!canWrite || !failed || busy) return;
    if (!browserLogin) {
      // Catalog ids contain only a validated provider and slug.
      setNotice(`on the zeta host, run: zeta accounts login ${provider} ${name} --replace`);
      return;
    }
    setReview(prior => ({ target: { provider: provider === "anthropic" ? "claude" : "codex", account: failed.account }, opener, key: (prior?.key ?? 0) + 1 }));
  }

  return <div className="chat-auth-error" aria-describedby={!canWrite ? reason : undefined}>
    <strong role="status">this chat can't reach its account</strong>
    <p>this chat is pinned to {failed ? <code>{failed.account}</code> : "its account"}, which failed to sign in{failed && code ? <> (<code>{code}</code>)</> : null}. the chat stays pinned so it never switches accounts on you by surprise.</p>
    <div className="chat-auth-error-actions">
      <button type="button" data-write-surface={WRITE_SURFACE.authLogin} disabled={!failed || !!busy || attemptHere?.state === "succeeded"} onClick={event => logIn(event.currentTarget)}>{failed ? `sign in again to ${failed.account}` : "sign in to this account"}</button>
      {(target || !failed) && <button type="button" data-write-surface={WRITE_SURFACE.authSwitch} disabled={!target || !!busy || !supportsRequest(client, "account_switch")} onClick={event => {
        if (failed && target) openSwitch({ chat, from: failed.account, to: target.account, onCatalog: () => setRecovery(null) }, WRITE_SURFACE.authSwitch, event.currentTarget);
      }}>{target ? `switch this chat to ${target.account}` : "switch this chat to another account"}</button>}
      <button type="button" data-write-surface={WRITE_SURFACE.authNewChat} disabled={!canWrite} onClick={() => { if (canWrite) onNewChat(); }}>new chat</button>
      <a href={surfaceHref("/accounts")}>/accounts</a>
    </div>
    {!canWrite ? <p id={reason}>{READ_ONLY_REASON}</p> : <>
      {!failed && !notice && <p>check the catalog to see which accounts need sign-in.</p>}
      {notice && <p role="status">{notice}</p>}
      {attemptHere && <AccountLoginStatus attempt={attemptHere} login={login} canSignIn={!busy} signIn={(_, opener) => logIn(opener)}
        available={!!login.catalog()?.value.accounts.some(row => row.account === failed?.account && row.available)} />}
      {attemptHere?.state === "succeeded" && <p>send your message again to retry.</p>}
    </>}
    {review && <Confirmation key={review.key} level={2} surface={WRITE_SURFACE.authLogin} external={{ opener: () => review.opener }}
      title={reviewText("review browser sign-in")} action={reviewText("sign in again")} keep={reviewText("go back")}
      effect={`start browser sign-in for ${review.target.account}` as ReviewText} scope={reviewText("zeta account store on this computer")}
      current={reviewText("sign-in required")} after={reviewText("credentials may be saved; the failed request is not retried")}
      undo={reviewText("cancel while pending; after credentials save, sign-out is not available here")}
      proof={{ kind: "scope" }} execute={async () => { await login.start(review.target); return started; }} checkResult={async () => started} />}
  </div>;
}
