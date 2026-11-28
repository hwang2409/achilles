import { useEffect, useState } from "react";
import { inFlight, MAYBE_SENT_HINT, MAYBE_SENT_LABEL, shownQueue, type ComposerModel } from "./composer-machine";
import { WRITE_SURFACE } from "../writeSurfaces";

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
    // the select takes focus: give it back, so a keyboard user stays on the copy button
    const focused = document.activeElement as HTMLElement | null;
    document.body.append(area);
    area.select();
    try { return document.execCommand("copy"); } finally { area.remove(); focused?.focus({ preventScroll: true }); }
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
        const images = item.images?.length ? `${item.images.length} ${item.images.length === 1 ? "image" : "images"}` : "";
        const text = item.text || images;
        const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
        const label = held ? MAYBE_SENT_LABEL : item.failed ? (item.tries ?? 1) > 1 ? `not sent · ${item.tries} tries` : "not sent" : sending ? model.send?.steer ? "next step" : "sending" : "queued";
        return (
          <li key={item.id} data-part="composer-queued" data-failed={item.failed ? "" : undefined} data-sending={sending || undefined}>
            <span data-part="composer-queued-label">{label}</span>
            <span data-part="composer-queued-text" title={text}>{text}</span>
            {item.text && images ? <span data-part="composer-queued-images">{images}</span> : null}
            <span data-part="composer-queued-actions">
              {item.failed ? <button type="button" data-part="composer-queued-retry" data-write-surface={WRITE_SURFACE.deliveryRetry} aria-label={`retry: ${preview}`} onClick={() => onRetry(item.id)}>retry</button> : null}
              {item.failed && !held ? <button type="button" data-part="composer-queued-edit" aria-label={`edit: ${preview}`} onClick={() => onRestore(item.id)}>edit</button> : null}
              {held ? <CopyButton text={item.text} preview={preview} /> : null}
              {sending ? null : <button type="button" data-part="composer-queued-cancel" aria-label={`cancel message: ${preview}`} title="cancel (esc in an empty box cancels the last)" onClick={() => onCancel(item.id)}>×</button>}
            </span>
            {/* a held row says one thing: maybe not sent, and why retry is safe; its failure text would contradict it */}
            {held ? <span data-part="composer-queued-hint" role="alert">{MAYBE_SENT_HINT}</span> : item.failed ? <span data-part="composer-queued-error" role="alert">{item.failed}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
