import type { ComposerModel } from "./composer-machine";

/** Messages sent while another was pending: out of the box, in send order, each with cancel (and retry when it failed). */
export function QueuedMessages({ model, onRetry, onCancel }: { model: ComposerModel; onRetry: (id: number) => void; onCancel: (id: number) => void }) {
  if (!model.queue.length) return null;
  return (
    <ol data-part="composer-queue" aria-label="queued messages">
      {model.queue.map((item) => {
        const sending = model.send?.queuedId === item.id;
        const preview = item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text;
        return (
          <li key={item.id} data-part="composer-queued" data-failed={item.failed ? "" : undefined} data-sending={sending || undefined}>
            <span data-part="composer-queued-label">{item.failed ? "not sent" : sending ? "sending" : "queued"}</span>
            <span data-part="composer-queued-text" title={item.text}>{item.text}</span>
            {item.failed ? <span data-part="composer-queued-error" role="alert" title={item.failed}>{item.failed}</span> : null}
            {item.failed ? <button type="button" data-part="composer-queued-retry" aria-label={`retry: ${preview}`} onClick={() => onRetry(item.id)}>retry</button> : null}
            {sending ? null : <button type="button" data-part="composer-queued-cancel" aria-label={`cancel queued message: ${preview}`} title="cancel (esc in an empty box cancels the last)" onClick={() => onCancel(item.id)}>×</button>}
          </li>
        );
      })}
    </ol>
  );
}
