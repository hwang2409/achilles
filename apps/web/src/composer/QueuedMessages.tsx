import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
      <Button variant="outline" size="xs" className="min-h-7 min-w-[9ch] rounded-sm select-none" type="button" data-part="composer-queued-copy" aria-label={`copy text: ${preview}`} onClick={() => void copyText(text).then((ok) => setDone(ok ? "copied" : "copy failed — select the text"))}>{done === "copied" ? "copied" : "copy"}</Button>
      {done && done !== "copied" ? <span className="basis-full text-muted-foreground" data-part="composer-queued-hint" role="status">{done}</span> : null}
    </>
  );
}

/** Submitted messages, in send order: the in-flight one first ("sending", or "next step" for a steer), then "queued"; a failed one has retry, edit, and cancel (a held one, that zeta may have: retry, copy, and cancel, and a hint why). */
export function QueuedMessages({ model, onRetry, onRestore, onCancel }: { model: ComposerModel; onRetry: (id: number) => void; onRestore: (id: number) => void; onCancel: (id: number) => void }) {
  const rows = shownQueue(model);
  if (!rows.length) return null;
  const current = inFlight(model);
  return (
    <ol className="grid gap-px px-[var(--inset)] pt-1.5 text-xs leading-5" data-part="composer-queue" aria-label="submitted messages">
      {rows.map((item) => {
        const sending = item === current;
        const held = Boolean(item.failed && item.held);
        const preview = item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text;
        const label = held ? MAYBE_SENT_LABEL : item.failed ? (item.tries ?? 1) > 1 ? `not sent · ${item.tries} tries` : "not sent" : sending ? model.send?.steer ? "next step" : "sending" : "queued";
        return (
          <li className="group flex min-w-0 flex-wrap items-center gap-2 border-l py-0.5 pl-2 data-[failed]:border-destructive" key={item.id} data-part="composer-queued" data-failed={item.failed ? "" : undefined} data-sending={sending || undefined}>
            <Badge variant="outline" className="rounded-sm text-muted-foreground group-data-[sending]:bg-muted group-data-[failed]:text-destructive" data-part="composer-queued-label">{label}</Badge>
            <span className="min-w-0 flex-auto truncate max-[480px]:group-data-[failed]:basis-0" data-part="composer-queued-text" title={item.text}>{item.text}</span>
            <span className="contents max-[480px]:group-data-[failed]:flex max-[480px]:group-data-[failed]:basis-full max-[480px]:group-data-[failed]:flex-wrap max-[480px]:group-data-[failed]:gap-2" data-part="composer-queued-actions">
              {item.failed ? <Button variant="outline" size="xs" className="min-h-7 rounded-sm select-none" type="button" data-part="composer-queued-retry" data-write-surface={WRITE_SURFACE.deliveryRetry} aria-label={`retry: ${preview}`} onClick={() => onRetry(item.id)}>retry</Button> : null}
              {item.failed && !held ? <Button variant="outline" size="xs" className="min-h-7 rounded-sm select-none" type="button" data-part="composer-queued-edit" aria-label={`edit: ${preview}`} onClick={() => onRestore(item.id)}>edit</Button> : null}
              {held ? <CopyButton text={item.text} preview={preview} /> : null}
              {sending ? null : <Button variant="outline" size="xs" className="min-h-7 rounded-sm select-none" type="button" data-part="composer-queued-cancel" aria-label={`cancel message: ${preview}`} title="cancel (esc in an empty box cancels the last)" onClick={() => onCancel(item.id)}>×</Button>}
            </span>
            {/* a held row says one thing: maybe not sent, and why retry is safe; its failure text would contradict it */}
            {held ? <span className="basis-full text-muted-foreground" data-part="composer-queued-hint" role="alert">{MAYBE_SENT_HINT}</span> : item.failed ? <span className="basis-full text-destructive [overflow-wrap:anywhere]" data-part="composer-queued-error" role="alert">{item.failed}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
