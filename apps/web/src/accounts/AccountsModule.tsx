import { useRef, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { ACCOUNT_LIST_IDLE_FEATURE, AccountReadError, NoAnswer, readAccounts, supportsFeature, type Account, type Connection } from "../zeta";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { loginIdentity, type createAccountLogin, type LoginTarget } from "./accountLogin";
import "./accounts.css";

type Props = {
  client: ZetaClient | null;
  connecting: boolean;
  login: ReturnType<typeof createAccountLogin>;
  connection: Pick<Connection, "client" | "withControl" | "retryNow">;
};

// The page's connection-owned status is the receipt for both operations.
const cancelledReview = { status: "committed", value: reviewText("checked"), receipt: reviewText("sign-in result checked") } as const;
const startedReview = { status: "committed", receipt: reviewText("sign-in attempt checked") } as const;
const resetTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const windowLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

function AccountRows({ accounts, stale, signIn }: { accounts: Account[]; stale: boolean; signIn?: (target: LoginTarget, opener: HTMLButtonElement) => void }) {
  return <ul className="account-rows" aria-label={stale ? "last loaded accounts" : "model accounts"} data-stale={stale}>
    {accounts.map(({ account, label, available, current, default: isDefault, usage }) => <li key={account} data-default={isDefault} data-available={available}>
      <div className="account-identity">
        <h3>{account}</h3>
        <p>{label !== account.slice(account.indexOf(":") + 1) && <span>{label}</span>}
          <span className="account-availability">{available ? "available" : "needs sign-in"}</span>
          {isDefault && <span className="account-default">default</span>}
          {current && <span>in use</span>}
        </p>
      </div>
      <div className="account-usage">
        <p>{usage?.freshness === "now" ? "usage up to date" : usage?.freshness === "stale" ? "usage is stale" : "usage unknown"}</p>
        {usage?.windows.map(({ kind, minutes, usedPercent, resetsAt }, index) => <div className="account-window" key={`${kind}-${index}`}>
          <div><span>{windowLabel(minutes)} window</span><span>{percent.format(usedPercent / 100)} used</span></div>
          <meter aria-label={`${account} ${windowLabel(minutes)} usage`} min={0} max={100} value={usedPercent} />
          <time dateTime={new Date(resetsAt).toISOString()}>resets {resetTime.format(resetsAt)}</time>
        </div>)}
        {usage?.refreshFailed && <p className="account-availability" data-failed="true">last usage refresh failed</p>}
      </div>
      {!available && signIn && <button className="account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
        aria-label={`sign in again to ${account}`} onClick={event => signIn({ provider: account.startsWith("anthropic:") ? "claude" : "codex", account }, event.currentTarget)}>sign in again</button>}
    </li>)}
  </ul>;
}

export function AccountsModule({ client, connecting, connection, login }: Props) {
  const attempt = useSyncExternalStore(login.subscribe, login.snapshot);
  const receipt = attempt && "at" in attempt ? attempt : null;
  const active = !!attempt && !receipt;
  const [review, setReview] = useState<{ target: LoginTarget; opener: HTMLButtonElement } | null>(null);
  const signIn = (target: LoginTarget, opener: HTMLButtonElement) => setReview({ target, opener });
  const [readAfter, setReadAfter] = useState<ReturnType<typeof login.catalog>>(null);
  const [last, setLast] = useState<{ client: ZetaClient | null; accounts: Account[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const supported = client && supportsFeature(client, ACCOUNT_LIST_IDLE_FEATURE);
  const latestCatalog = login.catalog();
  const refreshed = latestCatalog !== readAfter ? latestCatalog : null;
  const rows = (refreshed?.value.accounts ?? last?.accounts) ?? [];
  const fresh = !!client && (refreshed ? refreshed.client === client : last?.client === client);
  const canSignIn = fresh && !!supported && !loading && !failure && !active;
  const show = async () => {
    if (!supported || loading || active || review) return;
    heading.current?.focus();
    setLoading(true);
    setFailure(null);
    try {
      const result = await connection.withControl((controller) => readAccounts(controller));
      if ("refused" in result) setFailure(result.refused);
      else {
        setReadAfter(latestCatalog);
        setLast({ client: connection.client, accounts: result.value.accounts });
      }
    } catch (error) {
      setFailure(error instanceof AccountReadError ? error.message : error instanceof NoAnswer ? "zeta did not answer the account request." : "could not read accounts from zeta.");
    } finally {
      setLoading(false);
    }
  };
  const showAction = { label: "show accounts", run: () => void show() };
  return <ModuleFrame title="accounts">
    <div className="accounts-place">
      <h2 ref={heading} tabIndex={-1}>model accounts</h2>
      <p className="account-intro">the accounts zeta can use. achilles shows names and usage only. credentials stay with zeta.</p>
      {active ? null : loading ? <ModuleState kind="loading" title="loading accounts…" />
        : !client ? (connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
          : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />)
        : !supported ? <ModuleState kind="unsupported" title="update zeta to manage accounts here" detail="on this version, use /accounts inside an active chat." />
        : failure ? <ModuleState kind="failed" title="could not load accounts" detail={failure} action={{ ...showAction, label: "try again" }} />
        : !fresh ? <ModuleState kind="empty" title="accounts need control to load" detail="this page borrows control for one read. it will not interrupt another tab." action={showAction} />
        : !rows.length && <ModuleState kind="empty" title="no model accounts yet" detail="sign in to a model provider to start." />}
      {!!rows.length && (!client || supported || loading) && <AccountRows accounts={rows} stale={!fresh || active || loading || !!failure} signIn={canSignIn ? signIn : undefined} />}
      {attempt && <section className="account-login" data-state={attempt.state} aria-label="browser sign-in">
        <div role="status">
          <h3>{loginIdentity(attempt.target)}</h3>
          <p>{attempt.state === "starting" ? "starting browser sign-in…"
            : attempt.state === "pending" ? "waiting for your browser"
            : attempt.state === "cancelling" ? "checking whether sign-in can be cancelled…"
            : attempt.state === "settling" ? "checking the account catalog…"
            : attempt.state === "succeeded" ? "signed in"
            : attempt.state === "cancelled" ? "sign-in cancelled"
            : attempt.state === "unknown" ? "sign-in result unknown"
            : attempt.state === "idle" ? "zeta no longer has a sign-in to check"
            : attempt.state === "blocked" ? "could not open the sign-in tab"
            : attempt.state === "contention" ? "a sign-in for this account is already pending"
            : "sign-in failed"}
            {receipt?.state === "succeeded" && <> at <time dateTime={receipt.at.toISOString()}>{resetTime.format(receipt.at)}</time></>}
          </p>
          {attempt.state === "pending" && <p>sign-in started. finish in the tab that opened. this page updates automatically. reloading this page ends an uncommitted sign-in.</p>}
          {attempt.state === "unknown" && <p>check the account catalog before trying again. zeta ends an uncommitted sign-in when its connection closes.</p>}
          {attempt.state === "blocked" && <p>allow pop-ups for achilles, then try again.</p>}
          {attempt.state === "failed" && <p>{attempt.detail}</p>}
          {receipt?.state === "succeeded" && <p>{fresh && rows.some(row => row.account === loginIdentity(attempt.target) && row.available)
            ? "the catalog shows this account as available for new chats."
            : "check the catalog to see which accounts are available for new chats."}</p>}
        </div>
        {(attempt.state === "pending" || attempt.state === "cancelling") && <Confirmation level={1}
          surface={WRITE_SURFACE.accountLoginCancel} label={reviewText("browser sign-in")} value={reviewText("pending")}
          action={reviewText("cancel sign-in")} keep={reviewText("keep signing in")}
          effect={reviewText("cancel this pending browser sign-in? a credential commit already in progress may still finish.")}
          execute={async () => { await login.cancel(); return cancelledReview; }} checkResult={async () => cancelledReview} onCommitted={() => {}} />}
        {canSignIn && receipt && ["failed", "blocked", "idle", "contention"].includes(receipt.state)
          && <button className="account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
            onClick={event => signIn(receipt.target, event.currentTarget)}>try again</button>}
      </section>}
      {canSignIn && !rows.length && <div className="account-actions">
        <button className="account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "claude" }, event.currentTarget)}>sign in to claude</button>
        <button className="account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "codex" }, event.currentTarget)}>sign in to codex</button>
      </div>}
      {review && <Confirmation level={2} external={{ onKeep: () => { setReview(null); review.opener.focus(); } }}
        action={review.target.account ? reviewText("sign in again") : reviewText("sign in")} keep={reviewText("go back")}
        title={reviewText("review browser sign-in")}
        effect={`start browser sign-in for ${loginIdentity(review.target)}` as ReviewText}
        scope={reviewText("zeta account store on this computer")}
        current={reviewText("not available")} after={reviewText("credentials may be saved and the account becomes available")}
        undo={reviewText("cancel while pending; after credentials save, sign-out is not available from this page on this zeta")}
        proof={{ kind: "scope" }}
        execute={async () => {
          await login.start(review.target);
          setReview(null);
          requestAnimationFrame(() => heading.current?.focus());
          return startedReview;
        }} checkResult={async () => startedReview} />}

    </div>
  </ModuleFrame>;
}
