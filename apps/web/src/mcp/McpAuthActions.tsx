import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Confirmation, reviewText, type Result } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { mcpFailure } from "./McpActions";
import type { AuthAttempt, AuthOutcome } from "./mcpAuth";
import type { McpOwner } from "./mcpOwner";
import type { McpRow } from "./mcpReads";

const actions = { start: reviewText("sign in"), cancel: reviewText("cancel sign-in"), logout: reviewText("delete saved sign-in") };
const keep = reviewText("keep current state");
const unchecked = reviewText("OAuth configured (sign-in not checked)");
const unverifiable = reviewText("zeta cannot verify saved sign-in state if the reply is lost.");
const captions = {
  idle: unchecked,
  pending: reviewText("sign-in pending · finish in the popup"),
  succeeded: reviewText("zeta reports that this sign-in attempt completed"),
  failed: reviewText("zeta could not complete this sign-in attempt"),
  cancelled: reviewText("zeta cancelled this sign-in attempt"),
  unauthorized: reviewText("zeta deleted the saved sign-in · configuration kept"),
  unknown: reviewText("sign-in result unknown"),
};

function useAuth(owner: McpOwner, row: McpRow | null | undefined) {
  const report = useSyncExternalStore(owner.auth.subscribe, owner.auth.snapshot);
  const tracking = report?.tracking ?? false;
  return { state: report && report.scope === row?.scope && report.name === row.name ? report.state : null,
    tracking, name: report?.name };
}

export function McpPendingElsewhere({ owner, row, online }: { owner: McpOwner; row: McpRow | null | undefined; online: boolean }) {
  const { state, tracking } = useAuth(owner, row?.config.oauth ? row : null);
  if (!tracking || state) return null;
  return <div className="mcp-auth-global" role="status">
    <span>another OAuth attempt is in progress or still being checked.</span>
    <button type="button" disabled={!online} onClick={() => void owner.auth.checkNow()}>check now</button>
  </div>;
}

function resultOf(outcome: AuthOutcome): Result<{ status: "committed"; receipt: typeof unchecked; value: typeof unchecked }> {
  if (outcome.status === "auth") return { status: "committed", receipt: captions[outcome.state], value: captions[outcome.state] };
  if (outcome.status === "popup-blocked") return { status: "failed", reason: "not-applied", final: true,
    message: reviewText("the sign-in popup could not open. allow popups and open a new sign-in review.") };
  if (outcome.status === "busy") return { status: "failed", reason: "not-applied", final: true,
    message: reviewText("another OAuth attempt is in progress. this request was not applied.") };
  return outcome.status === "committed" ? { status: "unknown" } : mcpFailure(outcome);
}

type Review = { id: number; attempt: AuthAttempt; origin: HTMLButtonElement };
export function McpAuth({ owner, row, revision, online, heading }: {
  owner: McpOwner; row: McpRow; revision: string; online: boolean; heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { state, tracking, name } = useAuth(owner, row);
  const [review, setReview] = useState<Review | null>(null);
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const flight = useRef<string | null>(null);
  const reviewId = useRef(0);
  const ownPending = Boolean(state && tracking);
  useLayoutEffect(() => () => { if (flight.current) owner.close(flight.current); }, [owner]);

  function operation(attempt: AuthAttempt) {
    async function perform(check: boolean) {
      const form = owner.open();
      flight.current = form;
      let outcome: AuthOutcome = { status: "unknown" };
      try { await owner.authAction(form, attempt, check, (value) => { outcome = value; }); }
      finally { owner.close(form); flight.current = null; }
      return resultOf(outcome);
    }
    return { execute: () => perform(false), checkResult: () => perform(true) };
  }
  const trigger = (action: "start" | "logout", disabled: boolean, surface: string) => <button type="button" disabled={disabled}
    data-write-surface={surface} onClick={(event) => setReview({ id: ++reviewId.current, origin: event.currentTarget, attempt: { action, name: row.name, scope: row.scope, trusted: row.trusted, config: row.config, revision } })}>{actions[action]}</button>;

  return <section className="mcp-auth" aria-label="OAuth sign-in">
    <p role="status" data-auth-state={state ?? "idle"}>{!online && ownPending ? "connection lost · sign-in result unknown until zeta reconnects" : captions[state ?? "idle"]}</p>
    <div className="mcp-auth-buttons">
      {trigger("start", !online || tracking, WRITE_SURFACE.mcpAuthStart)}
      {trigger("logout", !online || (tracking && !ownPending && name === row.name), WRITE_SURFACE.mcpAuthLogout)}
      {ownPending && <button type="button" disabled={!online} onClick={() => void owner.auth.checkNow()}>check now</button>}
    </div>
    {state && state !== "idle" && state !== "unauthorized" && <Confirmation level={1} action={actions.cancel} label={reviewText("sign-in attempt")} value={reviewText("in progress or waiting for status")}
      surface={WRITE_SURFACE.mcpAuthCancel} disabled={!online || !ownPending} keep={keep} onCommitted={() => {}}
      effect={reviewText("stop this sign-in attempt. if zeta has already started saving the credential, sign-in can still finish.")}
      {...operation({ action: "cancel", name: row.name, scope: row.scope })} />}
    <div ref={setActivity} />
    {review && <AuthReview key={review.id} review={review} operation={operation(review.attempt)} activity={activity ?? undefined}
      close={() => setReview(null)} fallback={() => heading.current} />}
  </section>;
}

function AuthReview({ review, operation, activity, close, fallback }: {
  review: Review; operation: { execute: () => Promise<ReturnType<typeof resultOf>>; checkResult: () => Promise<ReturnType<typeof resultOf>> };
  activity?: HTMLElement; close: () => void; fallback: () => HTMLElement | null;
}) {
  const { attempt, origin } = review;
  const start = attempt.action === "start";
  return <Confirmation level={2} action={actions[start ? "start" : "logout"]} keep={keep} activity={activity}
    external={{ onKeep: close, opener: () => origin.isConnected && !origin.disabled ? origin : fallback() }}
    title={start ? reviewText("review OAuth sign-in") : reviewText("review saved sign-in deletion")}
    scope={reviewText(attempt.scope)} current={start ? unchecked : reviewText("saved credential, if any")}
    after={start ? reviewText("complete sign-in in the browser on the zeta host") : reviewText("credential deleted · configuration kept")}
    effect={start ? reviewText("a popup opens zeta’s one-use loopback link, then redirects to the provider. achilles never receives a token.")
      : reviewText("zeta deletes the saved OAuth credential, not the connection configuration. removing configuration is a separate action.")}
    undo={start ? reviewText("you can cancel the pending attempt here, or delete the saved sign-in after it completes.") : unverifiable}
    proof={start ? { kind: "scope" } : { kind: "name", name: attempt.name as typeof unchecked }} {...operation} />;
}
