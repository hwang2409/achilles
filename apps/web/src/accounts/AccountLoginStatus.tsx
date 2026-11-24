import { Confirmation, reviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { loginIdentity, type createAccountLogin, type LoginTarget } from "./accountLogin";

type Login = ReturnType<typeof createAccountLogin>;
const resetTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const cancelledReview = { status: "committed", value: reviewText("checked"), receipt: reviewText("sign-in result checked") } as const;

export function AccountLoginStatus({ attempt, login, available, canSignIn, signIn }: {
  attempt: NonNullable<ReturnType<Login["snapshot"]>>;
  login: Login;
  available: boolean;
  canSignIn: boolean;
  signIn: (target: LoginTarget, opener: HTMLButtonElement) => void;
}) {
  const receipt = "at" in attempt ? attempt : null;
  return <section className="account-login" data-state={attempt.state} aria-label="browser sign-in">
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
    {receipt?.state === "succeeded" && <p>{available
      ? "the catalog shows this account as available for new chats."
      : "check the catalog to see which accounts are available for new chats."}</p>}
  </div>
  {(attempt.state === "pending" || attempt.state === "cancelling") && <Confirmation level={1}
    surface={WRITE_SURFACE.accountLoginCancel} label={reviewText("browser sign-in")} value={reviewText("pending")}
    action={reviewText("cancel sign-in")} keep={reviewText("keep signing in")}
    effect={reviewText("cancel this pending browser sign-in? a credential commit already in progress may still finish.")}
    execute={async () => { await login.cancel(); return cancelledReview; }} checkResult={async () => cancelledReview} onCommitted={() => {}} />}
  {canSignIn && receipt && ["failed", "blocked", "idle", "contention"].includes(receipt.state)
    && <button className="ui-button account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
      onClick={event => signIn(receipt.target, event.currentTarget)}>try again</button>}
</section>;
}
