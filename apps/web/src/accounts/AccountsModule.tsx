import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { ACCOUNT_LIST_IDLE_FEATURE, AccountReadError, NoAnswer, readAccounts, supportsFeature, type Account, type Connection } from "../zeta";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { loginIdentity, type createAccountLogin, type LoginTarget } from "./accountLogin";
import { AccountSwitchReceipt } from "./AccountSwitchReview";
import { AccountLoginStatus } from "./AccountLoginStatus";
import { usePageAccountSwitch, type SwitchAction } from "./usePageAccountSwitch";

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
const windowLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

function AccountRows({ accounts, stale, signIn, switchAction }: { accounts: Account[]; stale: boolean; signIn?: (target: LoginTarget, opener: HTMLButtonElement) => void; switchAction: SwitchAction }) {
  return <>{accounts.some(({ usage }) => usage?.freshness === "stale") && <p className="text-sm text-muted-foreground">Some usage data may be out of date.</p>}<ul className="divide-y border-y [&>li]:grid [&>li]:gap-4 [&>li]:p-4 [&>li]:wrap-anywhere @min-[35rem]:[&>li]:grid-cols-2" aria-label={stale ? "last loaded accounts" : "model accounts"} data-stale={stale}>
    {accounts.map(({ account, label, available, current, default: isDefault, usage }) => <li key={account} data-default={isDefault} data-available={available}>
      <div className="[&>h3]:font-semibold [&>p]:mt-1.5 [&>p]:flex [&>p]:flex-wrap [&>p]:items-center [&>p]:gap-2 [&>p]:text-sm [&>p]:text-muted-foreground">
        <h3>{account}</h3>
        <p>{label !== account.slice(account.indexOf(":") + 1) && <span>{label}</span>}
          <span className="data-[failed=true]:text-destructive [[data-available=false]_&]:text-destructive">{available ? "available" : "needs sign-in"}</span>
          {isDefault && <Badge variant="secondary">default</Badge>}
          {current && <span>in use</span>}
        </p>
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground">
        {!usage && <p>Usage unavailable</p>}
        {usage?.windows.map(({ kind, minutes, usedPercent, resetsAt }, index) => <div className="grid gap-1 tabular-nums [&>div]:flex [&>div]:flex-wrap [&>div]:justify-between [&>div]:gap-x-3 [&>meter]:h-1 [&>meter]:w-full [&>meter]:accent-muted-foreground [&>meter::-webkit-meter-bar]:rounded-none [&>meter::-webkit-meter-bar]:border-0 [&>meter::-webkit-meter-bar]:bg-border [&>meter::-webkit-meter-optimum-value]:bg-muted-foreground" key={`${kind}-${index}`}>
          <div><span>{windowLabel(minutes)} window</span><span>{percent.format(usedPercent / 100)} used</span></div>
          <meter high={95} optimum={0} aria-label={`${account} ${windowLabel(minutes)} usage`} min={0} max={100} value={usedPercent} />
          <time dateTime={new Date(resetsAt).toISOString()}>resets {resetTime.format(resetsAt)}</time>
        </div>)}
        {usage?.refreshFailed && <p className="data-[failed=true]:text-destructive [[data-available=false]_&]:text-destructive" data-failed="true">last usage refresh failed</p>}
      </div>
      {available && !current && <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" data-write-surface={WRITE_SURFACE.accountPageSwitch}
        aria-label={`switch active chat to ${account}`} disabled={!!switchAction.reason} aria-describedby={switchAction.reason ? "account-switch-reason" : undefined}
        onClick={event => switchAction.open(account, event.currentTarget)}>switch chat</Button>}
      {!available && signIn && <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
        aria-label={`sign in again to ${account}`} onClick={event => signIn({ provider: account.startsWith("anthropic:") ? "claude" : "codex", account }, event.currentTarget)}>sign in again</Button>}
    </li>)}
  </ul></>;
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
  const switchAction = usePageAccountSwitch(client, rows, canSignIn, accounts => {
    setReadAfter(latestCatalog);
    setLast({ client: connection.client, accounts });
  });
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const show = async (focus: boolean) => {
    if (!supported || inFlight.current || active || review) return;
    inFlight.current = true;
    if (focus) heading.current?.focus();
    setLoading(true);
    setFailure(null);
    switchAction.reset();
    try {
      const result = await connection.withControl(async controller => {
        const result = await readAccounts(controller);
        await switchAction.refresh(controller);
        return result;
      });
      if ("refused" in result) { setFailure(result.refused); switchAction.refuse(result.refused); }
      else {
        setReadAfter(latestCatalog);
        setLast({ client: connection.client, accounts: result.value.accounts });
      }
    } catch (error) {
      setFailure(error instanceof AccountReadError ? error.message : error instanceof NoAnswer ? "zeta did not answer the account request." : "could not read accounts from zeta.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
  useEffect(() => {
    if (attempted.current || !supported || fresh || active || review) return;
    attempted.current = true;
    void show(false);
  });
  const showAction = { label: "Try again", run: () => void show(true) };
  return <ModuleFrame title="Accounts" subtitle="View model accounts and usage. Credentials stay with Zeta.">
    <div className="@container grid gap-4 p-4 md:p-8 [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:first-letter:uppercase">
      <h2 ref={heading} tabIndex={-1}>model accounts</h2>
      {active ? null : loading ? <ModuleState kind="loading" title="loading accounts…" />
        : !client ? (connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
          : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />)
        : !supported ? <ModuleState kind="unsupported" title="update zeta to manage accounts here" detail="on this version, use /accounts inside an active chat." />
        : failure ? <ModuleState kind="failed" title="could not load accounts" detail={switchAction.refusal ? undefined : failure} action={showAction} />
        : !fresh ? <ModuleState kind="loading" title="loading accounts…" />
        : !rows.length && <ModuleState kind="empty" title="no model accounts yet" detail="sign in to a model provider to start." />}
      {!!rows.length && (!client || supported || loading) && <AccountRows accounts={rows} stale={!fresh || active || loading || !!failure} signIn={canSignIn ? signIn : undefined} switchAction={switchAction} />}
      <AccountSwitchReceipt />
      {switchAction.reason && supported && <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {!rows.some(row => row.available && !row.current) && <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" data-write-surface={WRITE_SURFACE.accountPageSwitch} disabled aria-describedby="account-switch-reason">switch chat</Button>}
        <p id="account-switch-reason">{switchAction.reason}</p>{switchAction.refusal && !failure && <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" onClick={() => void show(true)}>try again</Button>}
      </div>}
      {attempt && <AccountLoginStatus attempt={attempt} login={login} canSignIn={canSignIn} signIn={signIn}
        available={fresh && rows.some(row => row.account === loginIdentity(attempt.target) && row.available)} />}
      {canSignIn && !rows.length && <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "claude" }, event.currentTarget)}>sign in to claude</Button>
        <Button variant="outline" className="min-h-11 w-fit max-w-full whitespace-normal" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
          onClick={event => signIn({ provider: "codex" }, event.currentTarget)}>sign in to codex</Button>
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
