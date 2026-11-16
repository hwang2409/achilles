import { inFlight, MAYBE_SENT, shownQueue, type ComposerModel } from "./composer-machine";

/** Submitted messages, in send order: the in-flight one first ("sending", or "next step" for a steer), then "queued"; a failed one has retry, edit, and cancel (one that may have been sent: retry and cancel only). */
export function QueuedMessages({ model, onRetry, onRestore, onCancel }: { model: ComposerModel; onRetry: (id: number) => void; onRestore: (id: number) => void; onCancel: (id: number) => void }) {
  const rows = shownQueue(model);
  if (!rows.length) return null;
  const current = inFlight(model);
  return (
    <ol data-part="composer-queue" aria-label="submitted messages">
      {rows.map((item) => {
        const sending = item === current;
        const preview = item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text;
        const label = item.failed === MAYBE_SENT ? "maybe sent" : item.failed ? (item.tries ?? 1) > 1 ? `not sent · ${item.tries} tries` : "not sent" : sending ? model.send?.steer ? "next step" : "sending" : "queued";
        return (
          <li key={item.id} data-part="composer-queued" data-failed={item.failed ? "" : undefined} data-sending={sending || undefined}>
            <span data-part="composer-queued-label">{label}</span>
            <span data-part="composer-queued-text" title={item.text}>{item.text}</span>
            {item.failed ? <button type="button" data-part="composer-queued-retry" aria-label={`retry: ${preview}`} onClick={() => onRetry(item.id)}>retry</button> : null}
            {item.failed && item.failed !== MAYBE_SENT ? <button type="button" data-part="composer-queued-edit" aria-label={`edit: ${preview}`} onClick={() => onRestore(item.id)}>edit</button> : null}
            {sending ? null : <button type="button" data-part="composer-queued-cancel" aria-label={`cancel message: ${preview}`} title="cancel (esc in an empty box cancels the last)" onClick={() => onCancel(item.id)}>×</button>}
            {item.failed ? <span data-part="composer-queued-error" role="alert">{item.failed}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
