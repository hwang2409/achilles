import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { wrapTab } from "../keyboard";
import "./confirmation.css";

declare const safeText: unique symbol;
export type ReviewText = string & { readonly [safeText]: true };
// Product copy only. Dynamic values need an explicit display-safe projection in the adapter.
export function reviewText<const T extends string>(text: string extends T ? never : T): ReviewText;
export function reviewText(text: string): ReviewText { return text as ReviewText; }

type Failure = "changed" | "denied" | "not-applied" | "refused";
const failureCopy: Record<Failure, string> = {
  changed: "not changed. the state changed elsewhere; keep the current state and refresh before trying again.",
  denied: "not changed. check your access before trying again.",
  "not-applied": "not changed. the request did not apply; you can try again.",
  refused: "not changed. another tab has control; a chat tab keeps it while it is open. try again after it finishes or closes.",
};

// `message` replaces the fixed copy; build it with a display-safe projection in the adapter.
export type Result<C> = C | { status: "unknown" } | { status: "failed"; reason: Failure; message?: ReviewText };
type Operation<C> = {
  // Return failed only when the write is known not to have applied. Rejections are unknown.
  execute(): Promise<Result<C>>;
  // Read the outcome of the same attempt. Never repeat the write to find out if it applied.
  checkResult(): Promise<Result<C>>;
};
type Committed = { status: "committed"; receipt: ReviewText };
// `surface`: the trigger's `data-write-surface` id.
type Common = { action: ReviewText; keep: ReviewText; effect: ReviewText; surface?: string };
type Inline = Common & Operation<Committed & { value: ReviewText }> & {
  level: 1;
  label: ReviewText;
  value: ReviewText;
  onCommitted(value: ReviewText): void;
  proof?: never;
};
type Review = Common & Operation<Committed> & {
  level: 2;
  title: ReviewText;
  scope: ReviewText;
  current: ReviewText;
  after: ReviewText;
  undo: ReviewText;
  fields?: readonly { label: ReviewText; value: ReviewText | { provided: boolean } }[];
  proof: { kind: "name"; name: ReviewText } | { kind: "scope"; name?: never; label?: ReviewText };
  // Keep the confirmation mounted through completion, along with its focus return target.
  activity: HTMLElement;
};
export type ConfirmationProps = Inline | Review;

type Phase = "idle" | "review" | "pending" | "unknown" | "checking";
type Receipt = { text: ReviewText; at: Date };

export function Confirmation(props: ConfirmationProps) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const transition = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const [attempt, setAttempt] = useState<ConfirmationProps>(props);
  const [proof, setProof] = useState("");
  const [failure, setFailure] = useState<{ reason: Failure; message?: ReviewText } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef<HTMLElement | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const retryCheck = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const open = phase !== "idle";
  const locked = open && phase !== "review";
  const proved = attempt.level === 1 || (attempt.proof.kind === "name"
    ? attempt.proof.name.length > 0 && proof === attempt.proof.name
    : proof === "checked");

  useLayoutEffect(() => {
    if (!open) {
      if (returnFocus.current) opener.current?.focus();
      returnFocus.current = false;
      return;
    }
    const node = dialog.current;
    node?.showModal();
    initial.current?.focus();
    return () => { node?.close(); };
  }, [open]);

  useLayoutEffect(() => {
    if (phase === "pending" || phase === "checking") status.current?.focus();
    if (phase === "unknown") retryCheck.current?.focus();
    if (phase === "review" && failure) status.current?.focus();
  }, [phase, failure]);

  const start = () => {
    setAttempt(props);
    setProof("");
    setFailure(null);
    setReceipt(null);
    returnFocus.current = true;
    transition("review");
  };
  const keep = () => {
    if (phaseRef.current === "review") transition("idle");
  };
  const run = async (check: boolean) => {
    if (check ? phaseRef.current !== "unknown" : phaseRef.current !== "review" || !proved) return;
    transition(check ? "checking" : "pending");
    setFailure(null);
    const resolve = <C extends Committed>(op: Operation<C>) =>
      Promise.resolve().then(() => check ? op.checkResult() : op.execute())
        .catch((): Result<C> => ({ status: "unknown" }));
    const result = attempt.level === 1 ? await resolve(attempt).then(result => {
      if (result.status === "committed") attempt.onCommitted(result.value);
      return result;
    }) : await resolve(attempt);
    if (result.status === "unknown") {
      transition("unknown");
    } else if (result.status === "failed") {
      setFailure({ reason: result.reason, message: result.message });
      transition(attempt.level === 1 ? "idle" : "review");
    } else {
      setReceipt({ text: result.receipt, at: new Date() });
      transition("idle");
    }
  };

  const feedback = <p ref={status} tabIndex={-1} className="confirmation-status" data-phase={phase} role={failure ? "alert" : "status"}>
      {phase === "pending" ? (attempt.level === 1 ? "saving…" : "finishing…")
        : phase === "checking" ? "checking result…"
        : phase === "unknown" ? "result unknown. check what happened before trying again. the request will not be sent twice."
        : failure ? failure.message ?? failureCopy[failure.reason] : null}
    </p>;
  const checkButton = phase === "unknown" && <button ref={retryCheck} type="button" onClick={() => void run(true)}>check now</button>;
  const confirmButton = <button ref={node => { if (attempt.level === 1) initial.current = node; }} type={attempt.level === 1 ? "button" : "submit"} onClick={attempt.level === 1 ? () => void run(false) : undefined}
    className="confirmation-primary" disabled={locked || !proved}>{attempt.action}</button>;
  const notice = <div className="confirmation-activity">
    <div role="status">{receipt && <p>{receipt.text} at <time dateTime={receipt.at.toISOString()}>
      {receipt.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>}</div>
    {receipt && props.level === 2 && <button type="button" onClick={() => { setReceipt(null); opener.current?.focus(); }}>dismiss receipt</button>}
  </div>;

  if (props.level === 1 && attempt.level === 1) return <section className="confirmation-inline" aria-labelledby={`${id}-label`}>
    <div className="confirmation-row">
      <span id={`${id}-label`}>{props.label}</span>
      <span className="confirmation-current">{props.value}</span>
      <button ref={opener} type="button" data-write-surface={props.surface} disabled={open} onClick={start}>{props.action}</button>
    </div>
    {open && <div role="group" className="confirmation-bar" aria-labelledby={`${id}-effect`}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); keep(); } }}>
      <p id={`${id}-effect`}>{attempt.effect}</p>
      <div className="confirmation-actions">
        {!locked && confirmButton}
        {!locked && <button type="button" onClick={keep}>{attempt.keep}</button>}
        {checkButton}
      </div>
      {feedback}
    </div>}
    {!open && feedback}
    {notice}
  </section>;

  if (props.level !== 2 || attempt.level !== 2) return null;
  const step = phase === "pending" ? "confirming…" : phase === "checking" ? "checking…"
    : phase === "unknown" ? "result unknown" : failure ? "not changed" : "review";
  return <>
    <button ref={opener} className="confirmation-trigger" type="button" data-write-surface={props.surface} onClick={start}>{props.action}</button>
    {open && createPortal(<dialog ref={dialog} className="confirmation-dialog" data-proof={attempt.proof.kind}
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-effect ${id}-undo`}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); keep(); }}
      onKeyDown={event => {
        if (event.key === "Escape") event.stopPropagation();
        if (event.key !== "Tab") return;
        if (phase === "pending" || phase === "checking") event.preventDefault();
        else wrapTab(event, event.currentTarget);
      }}>
      <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void run(false); }}>
        <header>
          <h2 id={`${id}-title`}>{attempt.title}</h2>
          <div className="confirmation-heading-actions">
            <span>{step}</span>
            <button type="button" className="confirmation-close" aria-label="close confirmation" disabled={locked} onClick={keep}>×</button>
          </div>
        </header>
        <div className="confirmation-body">
          <dl>
            <div><dt>what</dt><dd id={`${id}-effect`}>{attempt.effect}</dd></div>
            <div><dt>where</dt><dd>{attempt.scope}</dd></div>
            <div><dt>now → after</dt><dd>{attempt.current} → {attempt.after}</dd></div>
            {attempt.fields?.map(({ label, value }, index) => <div key={index}><dt>{label}</dt>
              <dd>{typeof value === "string" ? value : value.provided ? "provided" : "not provided"}</dd></div>)}
            <div><dt>undo</dt><dd id={`${id}-undo`}>{attempt.undo}</dd></div>
          </dl>
          {attempt.proof.kind === "name" ? <label className="confirmation-name">
            <span>type <strong>{attempt.proof.name}</strong> to confirm</span>
            <input ref={node => { initial.current = node; }} type="text" value={proof} onChange={event => setProof(event.currentTarget.value)}
              autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={locked} />
          </label> : <label className="confirmation-scope">
            <input ref={node => { initial.current = node; }} type="checkbox" checked={proof === "checked"}
              onChange={event => setProof(event.currentTarget.checked ? "checked" : "")} disabled={locked} />
            {attempt.proof.label ?? "i reviewed the scope"}
          </label>}
          {feedback}
        </div>
        <footer className="confirmation-actions">
          {locked ? checkButton : <button type="button" onClick={keep}>{attempt.keep}</button>}
          {confirmButton}
        </footer>
      </form>
    </dialog>, document.body)}
    {createPortal(notice, props.activity)}
  </>;
}
