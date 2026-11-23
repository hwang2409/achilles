import { useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { ModuleFrame, ModuleState } from "../surface/ModuleState";
import { ACCOUNT_LIST_IDLE_FEATURE, AccountReadError, NoAnswer, readAccounts, supportsFeature, type Account, type Connection } from "../zeta";
import "./accounts.css";

type Props = {
  client: ZetaClient | null;
  connecting: boolean;
  connection: Pick<Connection, "client" | "withControl" | "retryNow">;
};

const resetTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const windowLabel = (minutes: number) => minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

function AccountRows({ accounts, stale }: { accounts: Account[]; stale: boolean }) {
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
    </li>)}
  </ul>;
}

export function AccountsModule({ client, connecting, connection }: Props) {
  const [last, setLast] = useState<{ client: ZetaClient | null; accounts: Account[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const supported = client && supportsFeature(client, ACCOUNT_LIST_IDLE_FEATURE);
  const fresh = last && client && last.client === client;
  const show = async () => {
    if (!supported || loading) return;
    heading.current?.focus();
    setLoading(true);
    setFailure(null);
    try {
      const result = await connection.withControl((controller) => readAccounts(controller));
      if ("refused" in result) setFailure(result.refused);
      else setLast({ client: connection.client, accounts: result.value.accounts });
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
      {loading ? <ModuleState kind="loading" title="loading accounts…" />
        : !client ? (connecting ? <ModuleState kind="loading" title="connecting to zeta…" />
          : <ModuleState kind="offline" title="could not connect to zeta" detail="retrying automatically" action={{ label: "retry now", run: () => connection.retryNow() }} />)
        : !supported ? <ModuleState kind="unsupported" title="update zeta to manage accounts here" detail="on this version, use /accounts inside an active chat." />
        : failure ? <ModuleState kind="failed" title="could not load accounts" detail={failure} action={{ ...showAction, label: "try again" }} />
        : !fresh ? <ModuleState kind="empty" title="accounts need control to load" detail="this page borrows control for one read. it will not interrupt another tab." action={showAction} />
        : last.accounts.length === 0 && <ModuleState kind="empty" title="no model accounts yet" detail="sign in to a model provider on the zeta host to get started." />}
      {last && !!last.accounts.length && (!client || supported || loading) && <AccountRows accounts={last.accounts} stale={!fresh || loading || !!failure} />}
    </div>
  </ModuleFrame>;
}
