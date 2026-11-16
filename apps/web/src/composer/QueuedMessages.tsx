import { useEffect, useState } from "react";
import { inFlight, shownQueue, type ComposerModel } from "./composer-machine";

/** why a held row has no edit: Enter would send the text again with a new id */
const MAYBE_SENT_HINT = "may already be with the agent — retry is safe, edit is off";

/** `navigator.clipboard` exists only in a secure context (not on plain http from a LAN address): copy through a
 * selected hidden textarea there */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try { return document.execCommand("copy"); } finally { area.remove(); }
  } catch { return false; }
}

function CopyButton({ text, preview }: { text: string; preview: string }) {
  const [done, setDone] = useState<"copied" | "copy failed — select the text" | undefined>();
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(undefined), 2_000);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <>
      <button type="button" data-part="composer-queued-copy" aria-label={`copy text: ${preview}`} onClick={() => void copyText(text).then((ok) => setDone(ok ? "copied" : "copy failed — select the text"))}>{done === "copied" ? "copied" : "copy"}</button>
      {done && done !== "copied" ? <span data-part="composer-queued-hint" role="status">{done}</span> : null}
    </>
  );
}

/** Submitted messages, in send order: the in-flight one first ("sending", or "next step" for a steer), then "queued"; a failed one has retry, edit, and cancel (a held one, that zeta may have: retry, copy, and cancel, and a hint why). */
export function QueuedMessages({ model, onRetry, onRestore, onCancel }: { model: ComposerModel; onRetry: (id: number) => void; onRestore: (id: number) => void; onCancel: (id: number) => void }) {
  const rows = shownQueue(model);
  if (!rows.length) return null;
  const current = inFlight(model);
  return (
    <ol data-part="composer-queue" aria-label="submitted messages">
      {rows.map((item) => {
        const sending = item === current;
        const held = Boolean(item.failed && item.held);
        const preview = item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text;
        const label = held ? "maybe sent" : item.failed ? (item.tries ?? 1) > 1 ? `not sent · ${item.tries} tries` : "not sent" : sending ? model.send?.steer ? "next step" : "sending" : "queued";
        return (
          <li key={item.id} data-part="composer-queued" data-failed={item.failed ? "" : undefined} data-sending={sending || undefined}>
            <span data-part="composer-queued-label">{label}</span>
            <span data-part="composer-queued-text" title={item.text}>{item.text}</span>
            {item.failed ? <button type="button" data-part="composer-queued-retry" aria-label={`retry: ${preview}`} onClick={() => onRetry(item.id)}>retry</button> : null}
            {item.failed && !held ? <button type="button" data-part="composer-queued-edit" aria-label={`edit: ${preview}`} onClick={() => onRestore(item.id)}>edit</button> : null}
            {held ? <CopyButton text={item.text} preview={preview} /> : null}
            {sending ? null : <button type="button" data-part="composer-queued-cancel" aria-label={`cancel message: ${preview}`} title="cancel (esc in an empty box cancels the last)" onClick={() => onCancel(item.id)}>×</button>}
            {item.failed ? <span data-part="composer-queued-error" role="alert">{item.failed}</span> : null}
            {held ? <span data-part="composer-queued-hint">{MAYBE_SENT_HINT}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
