import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { ACCOUNT_LIST_IDLE_FEATURE, AccountReadError, accountStatus, OBSERVER_READ_REASON, readAccounts, supportsFeature, type Account, type Connection } from "../zeta";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { loginIdentity, type createAccountLogin, type LoginTarget } from "./accountLogin";
import { AccountLoginStatus } from "./AccountLoginStatus";
import "./accounts.css";

type Props = {
  client: ZetaClient | null;
  connecting: boolean;
  login: ReturnType<typeof createAccountLogin>;
  connection: Pick<Connection, "client" | "withControl" | "retryNow">;
};

// The page's connection-owned status is the receipt for both operations.
const startedReview = { status: "committed", receipt: reviewText("sign-in attempt checked") } as const;
const resetTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const windowLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
// Returning to the tab re-reads accounts at most this often.
export const WAKE_READ_MS = 30_000;

function ago(time: number, now: number) {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? relative.format(-hours, "hour") : relative.format(-Math.floor(hours / 24), "day");
}
const Time = ({ at, children }: { at: number; children: string }) =>
  <time dateTime={new Date(at).toISOString()} title={resetTime.format(at)}>{children}</time>;

function staleBanner(stale: number, total: number) {
  if (!stale) return null;
  if (stale < total) return `Usage data for ${stale} of ${total} accounts may be out of date.`;
  return total === 1 ? "Usage data may be out of date." : `Usage data for all ${total} accounts may be out of date.`;
}

type SignedIn = { account: string; at: number } | null;
const statusOf = (account: Account, now: number, signedIn: SignedIn) => accountStatus(account, now, signedIn?.account === account.account ? signedIn.at : undefined);

function AccountRows({ accounts, now, stale, signedIn, signIn }: { accounts: Account[]; now: number; stale: boolean; signedIn: SignedIn; signIn?: (target: LoginTarget, opener: HTMLButtonElement) => void }) {
  const rows = accounts.map(account => ({ ...account, status: statusOf(account, now, signedIn) }));
  const banner = staleBanner(rows.filter(({ status }) => status.windows.some(window => window.stale)).length, rows.length);
  return <>{banner && <p className="account-stale">{banner}</p>}<ul className="account-rows" aria-label={stale ? "Last loaded accounts" : "Model accounts"} data-stale={stale}>
    {rows.map(({ account, label, current, default: isDefault, usage, status }) => <li key={account} data-tone={status.tone}>
      <div className="account-identity">
        <h3>{account}</h3>
        <p>{label !== account.slice(account.indexOf(":") + 1) && <span>{label}</span>}
          <span className="account-availability">{status.label}</span>
          {isDefault && <span className="account-default">Default</span>}
          {current && <span>In use</span>}
        </p>
        {status.signIn && signIn && <button className="ui-button account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          aria-label={`Sign in again to ${account}`} onClick={event => signIn({ provider: account.startsWith("anthropic:") ? "claude" : "codex", account }, event.currentTarget)}>Sign in again</button>}
      </div>
      <div className="account-usage">
        {!usage && <p>Usage unavailable</p>}
        {usage?.capturedAt != null && status.windows.map(({ kind, minutes, usedPercent, resetsAt, passed, stale }, index) =>
          <div className="account-window" key={`${kind}-${index}`} data-stale={stale}>
            <div><span>{windowLabel(minutes)} window</span><span>{passed && "Was "}{percent.format(usedPercent / 100)} used</span></div>
            <meter high={stale ? undefined : 95} optimum={0} aria-label={`${account} ${windowLabel(minutes)} usage`} min={0} max={100} value={usedPercent} />
            <p>{passed ? "Reset passed" : <>Resets <time dateTime={new Date(resetsAt).toISOString()}>{resetTime.format(resetsAt)}</time></>}
              {" · last read "}<Time at={usage.capturedAt}>{ago(usage.capturedAt, now)}</Time></p>
          </div>)}
        {status.refreshError && <p className="account-refresh-failed">Usage refresh failed: {status.refreshError}</p>}
      </div>
    </li>)}
  </ul></>;
}

export function AccountsModule({ client, connecting, connection, login }: Props) {
  const attempt = useSyncExternalStore(login.subscribe, login.snapshot);
  const receipt = attempt && "at" in attempt ? attempt : null;
  const active = !!attempt && !receipt;
  const signedIn = receipt?.state === "succeeded" ? { account: loginIdentity(receipt.target), at: receipt.at.getTime() } : null;
  const [review, setReview] = useState<{ target: LoginTarget; opener: HTMLButtonElement } | null>(null);
  const signIn = (target: LoginTarget, opener: HTMLButtonElement) => setReview({ target, opener });
  const [readAfter, setReadAfter] = useState<ReturnType<typeof login.catalog>>(null);
  const [last, setLast] = useState<{ client: ZetaClient | null; accounts: Account[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A background (wake) read that failed keeps the rows; the next read clears it.
  const [wakeFailed, setWakeFailed] = useState(false);
  const place = useRef<HTMLDivElement>(null);
  // The title belongs to ModuleFrame; focusing it on arrival keeps keyboard focus off <body>.
  const focusTitle = () => {
    const title = place.current?.closest(".module-frame")?.querySelector("h1");
    if (!title) return;
    title.tabIndex = -1;
    title.focus();
  };
  useEffect(focusTitle, []);
  const [now, setNow] = useState(Date.now);
  const supported = client && supportsFeature(client, ACCOUNT_LIST_IDLE_FEATURE);
  // an observer tab (zeta was full) waits for the banner's take control, then reads as controller
  const observer = (client as { authority?: string } | null)?.authority === "observer";
  const latestCatalog = login.catalog();
  const refreshed = latestCatalog !== readAfter ? latestCatalog : null;
  const rows = (refreshed?.value.accounts ?? last?.accounts) ?? [];
  const fresh = !!client && (refreshed ? refreshed.client === client : last?.client === client);
  const canSignIn = fresh && !!supported && !loading && !failure && !active;
  // Re-render when a reset passes or a reading turns stale, so no row reads as current after its time.
  const next = Math.min(...rows.map(row => statusOf(row, now, signedIn).next));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now(), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [next, now]);
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const lastRead = useRef(-Infinity);
  const show = async ({ focus = false, quiet = false } = {}) => {
    if (!supported || inFlight.current || active || review) return;
    inFlight.current = true;
    lastRead.current = Date.now();
    if (focus) focusTitle();
    if (!quiet) {
      setLoading(true);
      setFailure(null);
    }
    const fail = (reason: string) => quiet ? setWakeFailed(true) : setFailure(reason);
    try {
      const result = await connection.withControl(readAccounts);
      if ("refused" in result) fail(result.refused);
      else {
        setFailure(null);
        setWakeFailed(false);
        setReadAfter(latestCatalog);
        setLast({ client: connection.client, accounts: result.value.accounts });
      }
    } catch (error) {
      fail(error instanceof AccountReadError ? error.message : "could not read accounts from zeta.");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setNow(Date.now());
    }
  };
  // Back on the tab (also after sleep, when timers ran late): re-read the clock, and accounts at most every WAKE_READ_MS.
  const wake = useRef(() => {});
  wake.current = () => {
    if (document.visibilityState === "hidden") return;
    setNow(Date.now());
    if (fresh && !observer && Date.now() - lastRead.current >= WAKE_READ_MS) void show({ quiet: true });
  };
  useEffect(() => {
    const onWake = () => wake.current();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => { window.removeEventListener("focus", onWake); document.removeEventListener("visibilitychange", onWake); };
  }, []);
  useEffect(() => { attempted.current = false; }, [observer]);
  useEffect(() => {
    if (attempted.current || !supported || observer || fresh || active || review) return;
    attempted.current = true;
    void show();
  });
  const showAction = { label: "Try again", run: () => void show({ focus: true }) };
  return <ModuleFrame title="Accounts">
    <div className="accounts-place" ref={place}>
      {active ? null : loading ? <ModuleState kind="loading" title="Loading accounts…" />
        : !client ? (connecting ? <ModuleState kind="loading" title="Connecting to zeta…" />
          : <ModuleState kind="offline" title="Could not connect to zeta" detail="Retrying automatically" action={{ label: "Retry now", run: () => connection.retryNow() }} />)
        : !supported ? <ModuleState kind="unsupported" title="Update zeta to manage accounts here" detail="On this version, use /accounts inside an active chat." />
        : observer && !failure ? <ModuleState kind="observer" title={OBSERVER_READ_REASON} />
        : failure ? <ModuleState kind="failed" title="Could not load accounts" detail={failure} action={showAction} />
        : !fresh ? <ModuleState kind="loading" title="Loading accounts…" />
        : !rows.length && <ModuleState kind="empty" title="No model accounts yet" detail="Sign in to a model provider to start." />}
      {wakeFailed && fresh && !failure && !loading && !!rows.length && <p className="account-stale" role="status">Could not refresh accounts. Showing the last read.</p>}
      {!!rows.length && (!client || supported || loading) && <AccountRows accounts={rows} now={now} stale={!fresh || active || loading || !!failure} signedIn={signedIn} signIn={canSignIn ? signIn : undefined} />}
      {attempt && <AccountLoginStatus attempt={attempt} login={login} canSignIn={canSignIn} signIn={signIn}
        available={fresh && rows.some(row => row.account === loginIdentity(attempt.target) && row.available)} />}
      {canSignIn && !rows.length && <div className="account-actions">
        <button className="ui-button account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "claude" }, event.currentTarget)}>Sign in to Claude</button>
        <button className="ui-button account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "codex" }, event.currentTarget)}>Sign in to Codex</button>
      </div>}
      {review && <Confirmation level={2} external={{ onKeep: () => { setReview(null); review.opener.focus(); } }}
        action={review.target.account ? reviewText("Sign in again") : reviewText("Sign in")} keep={reviewText("Go back")}
        title={reviewText("Review browser sign-in")}
        effect={`start browser sign-in for ${loginIdentity(review.target)}` as ReviewText}
        scope={reviewText("zeta account store on this computer")}
        current={rows.find(row => row.account === review.target.account)?.available ? reviewText("signed in, but zeta reports authentication failed") : reviewText("not available")} after={reviewText("credentials may be saved and the account becomes available")}
        undo={reviewText("cancel while pending; after credentials save, sign-out is not available from this page on this zeta")}
        proof={{ kind: "scope" }}
        execute={async () => {
          await login.start(review.target);
          setReview(null);
          requestAnimationFrame(focusTitle);
          return startedReview;
        }} checkResult={async () => startedReview} />}

    </div>
  </ModuleFrame>;
}
