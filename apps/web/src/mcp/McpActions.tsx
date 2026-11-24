import { useState, type RefObject } from "react";
import { Confirmation, reviewText, type ReviewText, type Result } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import type { McpAttempt, McpOutcome, McpOwner } from "./mcpOwner";
import type { McpRow } from "./mcpReads";

const copy = {
  stale: "configuration changed elsewhere. nothing was written; review the refreshed configuration and confirm again.",
  changed: "configuration changed elsewhere and does not match this action. review the current configuration.",
  busy: "zeta is busy. nothing was written; try again later.",
  unavailable: "zeta could not read the current project or configuration. nothing was written.",
  invalid: "zeta refused the name or fields. nothing was written.",
  refused: "nothing was written. a chat tab keeps control while it is open; try again after it finishes or closes.",
  unsupported: "update zeta to manage mcp connections here. nothing was written.",
  conflict: "another connection change is in progress. nothing was sent.",
  cancelled: "this change was cancelled before it was applied.",
} as const;
const labels = { enable: reviewText("enable"), disable: reviewText("disable"), trust: reviewText("trust"), untrust: reviewText("untrust"), remove: reviewText("remove") };
const keep = reviewText("keep current config");
const yes = reviewText("enabled"), no = reviewText("disabled");
const running = "running sessions are unchanged until restart.";
const trustEffect = reviewText("zeta will fingerprint the exact current project definition when you trust it. changing its command, arguments, environment, URL, headers, OAuth, or client settings clears this trust.");

export function mcpReceipt(outcome: Extract<McpOutcome, { status: "committed" }>) {
  const base = "new sessions use this configuration. running sessions are unchanged. zeta serve does not need to restart.";
  const restart = outcome.restart;
  if (!restart) return reviewText(`${base} the current configuration matches; restart details were not available.`);
  const sessions = restart.sessions.length ? ` these running sessions may need restart: ${restart.sessions.join(", ")}.`
    : restart.complete ? " no running sessions were reported as needing restart." : "";
  // The owner projects only validated session identities into the receipt.
  return `${base}${sessions}${restart.complete ? "" : " the restart scan was incomplete; other running sessions may need restart."}` as ReviewText;
}

export function mcpFailure(result: Exclude<McpOutcome, { status: "committed" }>): Result<never> {
  if (result.status === "unknown") return { status: "unknown" };
  return { status: "failed", reason: "not-applied", message: reviewText(copy[result.status]), final: true };
}

function operation(owner: McpOwner, reviewed: McpAttempt) {
  let sent = reviewed;
  async function perform(check: boolean): Promise<Result<{ status: "committed"; receipt: ReviewText; value: ReviewText }>> {
    const form = owner.open();
    let outcome: McpOutcome = { status: "unknown" };
    const detach = owner.attach(form, (result) => { outcome = result; });
    try { await (check ? owner.check : owner.execute)(form, sent); }
    finally { detach(); owner.close(form); }
    const result = outcome as McpOutcome;
    if (result.status === "committed") return { status: "committed", receipt: mcpReceipt(result), value: sent.action === "enabled" && sent.value ? yes : no };
    return mcpFailure(result);
  }
  return { execute: () => { sent = { ...reviewed }; return perform(false); }, checkResult: () => perform(true) };
}

type Review = { id: number; sent: McpAttempt; origin: HTMLButtonElement };
export function McpActions({ owner, row, revision, online, heading }: {
  owner: McpOwner; row: McpRow | null; revision?: string; online: boolean; heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const available = online && !!revision;
  const start = (origin: HTMLButtonElement, action: "trusted" | "remove") => {
    if (!available || !row || !revision) return;
    const target = { name: row.name, scope: row.scope, revision };
    setReview((prior) => ({ id: (prior?.id ?? 0) + 1, origin,
      sent: action === "remove" ? { ...target, action } : { ...target, action, value: !row.trusted } }));
  };
  const enable = row && revision && { action: "enabled", name: row.name, scope: row.scope, revision, value: !row.enabled } as const;
  return <>
    {row && <section className="mcp-actions" aria-label="configuration actions">
      {enable && <Confirmation level={1} label={reviewText("new sessions")} value={row.enabled ? yes : no}
        action={row.enabled ? labels.disable : labels.enable} disabled={!available} surface={WRITE_SURFACE.mcpEnabled}
        keep={keep} effect={row.enabled ? reviewText(`new sessions will not receive this configured server; ${running}`)
          : reviewText(`new sessions can receive this configured server if it meets the trust and configuration requirements; ${running}`)}
        {...operation(owner, enable)} onCommitted={() => {}} />}
      <div className="mcp-review-actions">
        {row.scope === "project" && row.config.transport === "stdio" && <button type="button" disabled={!available} data-write-surface={WRITE_SURFACE.mcpTrusted}
          className="ui-button" onClick={(event) => start(event.currentTarget, "trusted")}>{row.trusted ? labels.untrust : labels.trust}</button>}
        <button type="button" disabled={!available} data-write-surface={WRITE_SURFACE.mcpRemove} className="ui-button mcp-remove" onClick={(event) => start(event.currentTarget, "remove")}>{labels.remove}</button>
      </div>
    </section>}
    <div ref={setActivity} />
    {review && <McpReview key={review.id} owner={owner} sent={review.sent} activity={activity ?? undefined}
      opener={() => review.origin.isConnected && !review.origin.disabled ? review.origin : heading.current} />}
  </>;
}

function McpReview({ owner, sent, activity, opener }: {
  owner: McpOwner; sent: McpAttempt; activity?: HTMLElement; opener: () => HTMLElement | null;
}) {
  const remove = sent.action === "remove";
  const trust = sent.action === "trusted" && sent.value;
  const action = remove ? labels.remove : trust ? labels.trust : labels.untrust;
  // The read projection guarantees a display-safe, round-tripping name; proof must be exact.
  const name = sent.name as ReviewText;
  return <Confirmation level={2} external={{ opener }} activity={activity} title={reviewText(`review ${action}`)} action={action} keep={keep}
    scope={reviewText(sent.scope)} proof={{ kind: "name", name }}
    current={remove ? reviewText("configuration on disk") : trust ? reviewText("not trusted") : reviewText("trusted")}
    after={remove ? reviewText("configuration deleted") : trust ? reviewText("trusted for new sessions") : reviewText("not trusted for new sessions")}
    effect={remove ? reviewText(`the configuration is deleted from this scope. ${running} any OAuth credential is not deleted.`)
      : reviewText(`trust changes apply to new sessions. ${running}`)}
    undo={remove ? reviewText("this removal cannot be undone here.") : trustEffect}
    {...operation(owner, sent)} />;
}
