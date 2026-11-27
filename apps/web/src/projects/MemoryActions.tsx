import { useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { Confirmation, reviewText, type ReviewText, type Result } from "../surface/Confirmation";
import { createMemoryWriter, memoryWriteAccess, type MemoryAction, type MemoryAttempt, type MemoryOutcome, type MemoryReceipt } from "./memoryWrites";
import { isMemoryId, type MemoryRow } from "./reads";

type Feedback = { projectId: string; message: string; receipt?: MemoryReceipt; error: boolean };
type Review = { form: string; sent: MemoryAttempt; origin: HTMLButtonElement };
const focusBack = (origin: HTMLButtonElement, feedback: boolean) => requestAnimationFrame(() => {
  const notice = feedback && document.querySelector<HTMLElement>("[data-memory-feedback]");
  (notice || (origin.isConnected ? origin : document.querySelector<HTMLElement>("[data-memory-tab]")))?.focus();
});

/** The router keeps the review, exact receipt, and writer above a socket remount. Only `start`, called by a button, may take control. */
export function useMemoryActions(control: { live: () => ZetaClient | null; take: () => Promise<string | null> }) {
  const [writer] = useState(() => createMemoryWriter(() => {
    const client = control.live();
    return client && memoryWriteAccess(client, true) ? client : null;
  }));
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [refresh, setRefresh] = useState(0);

  const tell = (projectId: string, message: string, error: boolean, receipt?: MemoryReceipt) =>
    setFeedback({ projectId, message, error, receipt });
  function end(origin: HTMLButtonElement, showFeedback: boolean) {
    busy.current = false;
    setWorking(false);
    focusBack(origin, showFeedback);
  }

  async function start(origin: HTMLButtonElement, projectId: string, projectName: string, action: MemoryAction,
    rows: readonly MemoryRow[], prior?: MemoryReceipt) {
    if (busy.current) return;
    busy.current = true;
    const path = location.pathname;
    setWorking(true);
    const reason = control.live() ? null : await control.take();
    if (reason !== null) {
      // A refused takeover does not replace the socket or reset the selected rows.
      tell(projectId, reason, true, prior);
      busy.current = false;
      setWorking(false);
      focusBack(origin, true);
      return;
    }
    const prepared = await writer.prepare(projectId, projectName, action, rows, prior);
    if (location.pathname === path && prepared.sent) {
      setReview({ form: writer.open(), sent: prepared.sent, origin });
      return;
    }
    if (prepared.problem) tell(projectId, prepared.problem, true, prepared.refresh ? undefined : prior);
    if (prepared.refresh) setRefresh((n) => n + 1);
    end(origin, !!prepared.problem);
  }

  function close(attempt: Review, result?: Exclude<MemoryOutcome, { status: "unknown" }>) {
    writer.close(attempt.form);
    setReview(null);
    if (result) {
      const committed = result.status === "committed";
      tell(attempt.sent.projectId, result.message, !committed, committed ? result.receipt : result.refresh ? undefined : attempt.sent.prior);
      if (committed || result.refresh) setRefresh((n) => n + 1);
    }
    end(attempt.origin, !!result);
  }

  async function perform(attempt: Review, check: boolean): Promise<Result<{ status: "committed"; receipt: ReviewText }>> {
    let outcome: MemoryOutcome = { status: "unknown" };
    const detach = writer.attach(attempt.form, (result) => { outcome = result; });
    try { await (check ? writer.checkResult : writer.execute)(attempt.form, attempt.sent); }
    finally { detach(); }
    const result = outcome as MemoryOutcome;
    if (result.status === "unknown") return result;
    close(attempt, result);
    // For external reviews, the adapter owns the terminal notice (including unverified outcomes) after unmount.
    if (result.status === "committed") return { status: "committed", receipt: display(result.message) };
    return result.status === "unverified" ? { status: "unknown" }
      : { status: "failed", reason: result.status === "refused" ? "denied" : result.status, final: true };
  }

  return { working, feedback, refresh, start, dismiss: () => setFeedback(null), dialog: review &&
    <MemoryReview key={review.form} sent={review.sent} keep={() => close(review)}
      execute={() => perform(review, false)} checkResult={() => perform(review, true)} /> };
}
export type MemoryActions = ReturnType<typeof useMemoryActions>;

const display = (value: string, max = 300): ReviewText => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) as ReviewText;
const exactUndo = reviewText("you can undo this exact change from its success receipt while zeta retains the transaction.");
const entryCount = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;

type Operations = Pick<Extract<Parameters<typeof Confirmation>[0], { level: 2 }>, "execute" | "checkResult">;
function MemoryReview({ sent, keep, execute, checkResult }: Operations & { sent: MemoryAttempt; keep: () => void }) {
  const action = sent.mutation.op;
  const fields = [{ label: reviewText("base revision"), value: display(sent.revision.slice(0, 12)) }];
  if (action === "undo" && sent.prior) {
    fields.unshift({ label: reviewText("prior action"), value: display(`${sent.prior.action} ${entryCount(sent.prior.ids.length)}`) },
      { label: reviewText("target version"), value: display(sent.prior.versionId) },
      ...sent.prior.ids.map((id) => ({ label: reviewText("entry id"), value: display(id) })));
  } else {
    for (const row of sent.rows) fields.push({ label: display(row.id), value: display(`${display(row.summary, 190) || "(empty)"} · source: ${isMemoryId(row.sourceSession) ? row.sourceSession : "unknown"}`, 332) });
  }
  const accept = action === "accept", undo = action === "undo";
  const label = accept ? reviewText("accept entry") : undo ? reviewText("undo memory change") : display(`resolve ${entryCount(sent.rows.length)}`);
  return <Confirmation level={2} external={{ onKeep: keep }} title={reviewText(`review memory ${action}`)} action={label} effect={label}
    keep={reviewText("keep current memory")} scope={display(`${display(sent.projectName, 160)} · ${isMemoryId(sent.projectId) ? sent.projectId : "unknown id"}`)}
    current={accept ? reviewText("automatic, not accepted") : undo ? reviewText("the accepted/resolved result") : display(`${sent.rows.length} active ${sent.rows.length === 1 ? "entry" : "entries"}`)}
    after={accept ? reviewText("accepted by user; remains active") : undo ? reviewText("zeta restores that retained transaction while preserving later work when possible") : reviewText("resolved; removed from active project context")}
    undo={undo ? reviewText("achilles will not offer another undo; use zeta's memory tools to inspect later history.") : exactUndo}
    fields={fields} proof={{ kind: "scope", label: accept ? reviewText("i reviewed this memory entry") : undo ? reviewText("i reviewed the transaction") : reviewText("i reviewed these memory entries") }}
    execute={execute} checkResult={checkResult} />;
}
