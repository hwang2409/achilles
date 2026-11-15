import type { ComposerState } from "@fulcrum/react";

export type ComposerError = { kind: "submit" | "stop" | "dropped"; text: string };
/** A message the user sent while another was pending. It is out of the box and goes out in order. */
export type QueuedMessage = { id: number; text: string; failed?: string };
type Send = { attempt: number; sent: string; steer: boolean; queuedId?: number };

/** shortcut: a fixed cap keeps a stuck chat from collecting messages without end; make it a setting if anyone hits it */
export const QUEUE_LIMIT = 20;

export type ComposerModel = {
  state: ComposerState;
  draft: string;
  sending: boolean;
  stopping: boolean;
  /** first in, first out; the head is in flight when `send.queuedId` names it */
  queue: QueuedMessage[];
  /** a send from the box failed; the queue waits until a send from the box succeeds */
  held: boolean;
  /** the queue came from the composer this one replaced; it waits for that composer's send */
  waiting: boolean;
  error?: ComposerError;
  send?: Send;
  nextAttempt: number;
  nextQueueId: number;
};

export type ComposerEffect =
  | { type: "submit"; attempt: number; text: string; steer: boolean }
  | { type: "stop" };

export type ComposerEvent =
  | { type: "state"; state: ComposerState }
  | { type: "edit"; draft: string }
  | { type: "submit"; turnRunning: boolean }
  | { type: "next"; turnRunning: boolean }
  | { type: "confirm"; attempt: number }
  | { type: "reject"; attempt: number; message: string; dropped?: boolean }
  | { type: "dismiss-error" }
  | { type: "settle"; attempt: number }
  | { type: "retry"; id: number }
  | { type: "cancel"; id: number }
  | { type: "cancel-last" }
  | { type: "adopt"; texts: string[] }
  | { type: "adopted"; outcome: SendOutcome }
  | { type: "detach" }
  | { type: "stop" }
  | { type: "stop-reject"; message: string }
  | { type: "stop-settle" };

/** How a send ended: nothing on success; the error, and the text when it was a queued message. */
export type SendOutcome = { failed?: string; text?: string };

export type ComposerTransition = { model: ComposerModel; effect?: ComposerEffect };

export function createComposerModel(draft: string, state: ComposerState): ComposerModel {
  return { state, draft, sending: false, stopping: false, queue: [], held: false, waiting: false, nextAttempt: 1, nextQueueId: 1 };
}

const unsentDraft = (current: string, sent: string) => current.startsWith(sent) ? current.slice(sent.length) : current;
const canSend = (state: ComposerState) => state !== "running" && state !== "read-only";
// the box keeps a pending send's text until zeta confirms it, so only the text after it is new
const inFlightBox = (model: ComposerModel) => model.sending && model.send?.queuedId === undefined && model.draft.startsWith(model.send?.sent ?? "") ? model.send!.sent : "";

/** What Enter does now: send the box, queue it behind pending or queued messages, or nothing. */
export function submitAction(model: ComposerModel): "send" | "queue" | null {
  if (!canSend(model.state)) return null;
  const queues = model.sending || model.waiting || Boolean(model.queue[0]?.failed) || (model.queue.length > 0 && !model.held);
  const text = queues ? model.draft.slice(inFlightBox(model).length) : model.draft;
  return text.trim() ? (queues ? "queue" : "send") : null;
}

/** The one status line both composers show, and its tone. */
export function composerStatus(model: ComposerModel): { text: string; tone?: "warning" | "danger" | "busy" } {
  if (model.error) return { text: model.error.text, tone: model.error.kind === "dropped" ? "warning" : "danger" };
  if (model.stopping) return { text: "stopping", tone: "busy" };
  if (model.sending && model.send?.queuedId === undefined) return { text: model.send?.steer ? "queued for the next step" : "sending", tone: "busy" };
  if (model.queue.some((item) => item.failed)) return { text: "a queued message was not sent. retry or cancel it", tone: "danger" };
  return { text: "" };
}

/** Messages that are waiting and not in flight; the header counts these. */
export const waitingCount = (model: ComposerModel) => model.queue.filter((item) => item.id !== model.send?.queuedId).length;

const start = (model: ComposerModel, text: string, steer: boolean, queuedId?: number): ComposerTransition => {
  const attempt = model.nextAttempt;
  return {
    model: { ...model, sending: true, error: queuedId === undefined && model.error?.kind !== "dropped" ? undefined : model.error, send: { attempt, sent: text, steer, queuedId }, nextAttempt: attempt + 1 },
    effect: { type: "submit", attempt, text, steer },
  };
};

export function transition(model: ComposerModel, event: ComposerEvent): ComposerTransition {
  switch (event.type) {
    case "state":
      return { model: { ...model, state: event.state, error: event.state !== "running" && event.state !== "steerable" && model.error?.kind === "stop" ? undefined : model.error } };
    case "edit":
      return { model: {
        ...model,
        draft: event.draft,
        send: model.sending ? model.send : undefined,
        error: model.error?.kind === "submit" && !model.sending ? undefined : model.error,
      } };
    case "submit": {
      const action = submitAction(model);
      if (action === "send") return start(model, model.draft, event.turnRunning);
      if (action !== "queue") return { model };
      if (model.queue.length >= QUEUE_LIMIT) return { model: { ...model, error: { kind: "submit", text: `at most ${QUEUE_LIMIT} messages can wait. cancel one or wait for a reply.` } } };
      const kept = inFlightBox(model);
      const text = kept ? model.draft.slice(kept.length).trimStart() : model.draft;
      return { model: { ...model, draft: kept, queue: [...model.queue, { id: model.nextQueueId, text }], nextQueueId: model.nextQueueId + 1 } };
    }
    case "next": {
      const head = model.queue[0];
      if (!head || head.failed || model.sending || model.held || model.waiting || !canSend(model.state)) return { model };
      return start(model, head.text, event.turnRunning, head.id);
    }
    case "confirm": {
      if (model.send?.attempt !== event.attempt) return { model };
      const { queuedId, sent } = model.send;
      if (queuedId !== undefined) return { model: { ...model, queue: model.queue.filter((item) => item.id !== queuedId), send: undefined } };
      return { model: { ...model, held: false, draft: unsentDraft(model.draft, sent), send: undefined, error: model.error?.kind === "submit" || model.error?.kind === "dropped" ? undefined : model.error } };
    }
    case "reject": {
      if (model.send?.attempt !== event.attempt) return { model };
      const { queuedId } = model.send;
      // a failed queued message stays first in the queue with its error; nothing after it goes out until retry or cancel
      if (queuedId !== undefined) return { model: { ...model, queue: model.queue.map((item) => item.id === queuedId ? { ...item, failed: event.message } : item) } };
      return { model: { ...model, held: true, error: { kind: event.dropped ? "dropped" : "submit", text: event.message } } };
    }
    case "dismiss-error":
      return { model: { ...model, error: undefined } };
    case "settle":
      if (model.send?.attempt !== event.attempt) return { model: { ...model, sending: false } };
      return { model: { ...model, sending: false, send: undefined } };
    case "retry":
      return { model: { ...model, queue: model.queue.map((item) => item.id === event.id ? { id: item.id, text: item.text } : item) } };
    case "cancel":
      if (model.send?.queuedId === event.id) return { model };
      return { model: { ...model, queue: model.queue.filter((item) => item.id !== event.id) } };
    case "cancel-last": {
      const last = model.queue.at(-1);
      return last ? transition(model, { type: "cancel", id: last.id }) : { model };
    }
    case "adopt":
      return { model: {
        ...model,
        waiting: true,
        queue: [...event.texts.map((text, index) => ({ id: model.nextQueueId + index, text })), ...model.queue],
        nextQueueId: model.nextQueueId + event.texts.length,
      } };
    case "adopted": {
      if (!model.waiting) return { model };
      const { failed, text } = event.outcome;
      const [head, ...rest] = model.queue;
      const queue = !failed ? model.queue
        : text !== undefined ? [{ id: model.nextQueueId, text, failed }, ...model.queue]
        : head ? [{ ...head, failed: `the message before this one was not sent: ${failed}` }, ...rest] : model.queue;
      return { model: { ...model, waiting: false, queue, nextQueueId: model.nextQueueId + 1 } };
    }
    case "detach":
      return { model: { ...model, waiting: false, queue: model.queue.filter((item) => item.id === model.send?.queuedId) } };
    case "stop":
      if (model.stopping) return { model };
      return { model: { ...model, stopping: true, error: undefined }, effect: { type: "stop" } };
    case "stop-reject":
      return { model: { ...model, error: { kind: "stop", text: `could not stop: ${event.message}` } } };
    case "stop-settle":
      return { model: { ...model, stopping: false } };
  }
}

export type EnterAction = "ignore" | "newline" | "submit";

export function enterAction(input: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number; mode: "insert" | "normal" | "visual" }): EnterAction {
  if (input.key !== "Enter" || input.isComposing || input.keyCode === 229) return "ignore";
  if (input.shiftKey && input.mode === "insert") return "newline";
  return input.shiftKey ? "ignore" : "submit";
}
