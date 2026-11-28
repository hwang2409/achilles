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
  return <section className="account-login" data-state={attempt.state} aria-label="Browser sign-in">
  <div role="status">
    <h3>{loginIdentity(attempt.target)}</h3>
    <p>{attempt.state === "starting" ? "Starting browser sign-in…"
      : attempt.state === "pending" ? "Waiting for your browser"
      : attempt.state === "cancelling" ? "Checking whether sign-in can be cancelled…"
      : attempt.state === "settling" ? "Checking the account catalog…"
      : attempt.state === "succeeded" ? "Signed in"
      : attempt.state === "cancelled" ? "Sign-in cancelled"
      : attempt.state === "unknown" ? "Sign-in result unknown"
      : attempt.state === "idle" ? "Zeta no longer has a sign-in to check"
      : attempt.state === "blocked" ? "Could not open the sign-in tab"
      : attempt.state === "contention" ? "A sign-in for this account is already pending"
      : "Sign-in failed"}
      {receipt?.state === "succeeded" && <> at <time dateTime={receipt.at.toISOString()}>{resetTime.format(receipt.at)}</time></>}
    </p>
    {attempt.state === "pending" && <p>Sign-in started. Finish in the tab that opened. This page updates automatically. Reloading this page ends an uncommitted sign-in.</p>}
    {attempt.state === "unknown" && <p>Check the account catalog before trying again. Zeta ends an uncommitted sign-in when its connection closes.</p>}
    {attempt.state === "blocked" && <p>Allow pop-ups for achilles, then try again.</p>}
    {attempt.state === "failed" && <p>{attempt.detail}</p>}
    {receipt?.state === "succeeded" && <p>{available
      ? "The catalog shows this account as available for new chats."
      : "Check the catalog to see which accounts are available for new chats."}</p>}
  </div>
  {(attempt.state === "pending" || attempt.state === "cancelling") && <Confirmation level={1}
    surface={WRITE_SURFACE.accountLoginCancel} label={reviewText("Browser sign-in")} value={reviewText("pending")}
    action={reviewText("Cancel sign-in")} keep={reviewText("Keep signing in")}
    effect={reviewText("cancel this pending browser sign-in? a credential commit already in progress may still finish.")}
    execute={async () => { await login.cancel(); return cancelledReview; }} checkResult={async () => cancelledReview} onCommitted={() => {}} />}
  {canSignIn && receipt && ["failed", "blocked", "idle", "contention"].includes(receipt.state)
    && <button className="ui-button account-action" type="button" data-write-surface={WRITE_SURFACE.accountLogin}
      onClick={event => signIn(receipt.target, event.currentTarget)}>Try again</button>}
</section>;
}
