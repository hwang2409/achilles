import type { ComposerState } from "@fulcrum/react";

export type ComposerError = { kind: "submit" | "stop"; text: string };
/** A submitted message. It left the box on Enter and goes out in order; `tries` counts failed sends. */
export type QueuedMessage = { id: number; text: string; failed?: string; tries?: number };
/** `deliveryId` is tracked once the request goes out; `echoed` once zeta's transcript shows that prompt */
type Send = { attempt: number; id: number; steer: boolean; deliveryId?: string; echoed?: boolean };

/** shortcut: a fixed cap keeps a stuck chat from collecting messages without end; make it a setting if anyone hits it */
export const QUEUE_LIMIT = 20;

export type ComposerModel = {
  state: ComposerState;
  /** always the next new message; a submitted message never comes back here unless the user asks (edit) */
  draft: string;
  sending: boolean;
  stopping: boolean;
  /** first in, first out; the head is in flight when `send.id` names it */
  queue: QueuedMessage[];
  /** a failed head was put back in the box: the rows behind it wait for the next Enter (the box text, if any, goes first) */
  held?: boolean;
  error?: ComposerError;
  /** says why the box holds text the user did not type here (an unsent message moved in); goes on Enter or when the box empties */
  note?: string;
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
  | { type: "note"; text: string }
  | { type: "submit"; turnRunning: boolean }
  | { type: "next"; turnRunning: boolean }
  | { type: "track"; attempt: number; deliveryId: string }
  | { type: "echo"; deliveryId: string }
  | { type: "confirm"; attempt: number }
  | { type: "reject"; attempt: number; message: string }
  | { type: "settle"; attempt: number }
  | { type: "retry"; id: number }
  | { type: "restore"; id: number }
  | { type: "cancel"; id: number }
  | { type: "cancel-last" }
  | { type: "stop" }
  | { type: "stop-reject"; message: string }
  | { type: "stop-settle" };

export type ComposerTransition = { model: ComposerModel; effect?: ComposerEffect };

export function createComposerModel(draft: string, state: ComposerState): ComposerModel {
  return { state, draft, sending: false, stopping: false, queue: [], nextAttempt: 1, nextQueueId: 1 };
}

const canSend = (state: ComposerState) => state !== "running" && state !== "read-only";
const busy = (model: ComposerModel) => model.sending || model.queue.length > 0;

/** What Enter does now: send the box, queue it behind other messages, or nothing. On an empty box it lets held rows go. */
export function submitAction(model: ComposerModel): "send" | "queue" | null {
  if (!canSend(model.state)) return null;
  if (!model.draft.trim()) return model.held && model.queue.length ? "queue" : null;
  return busy(model) ? "queue" : "send";
}

/** The in-flight message, if any. */
export const inFlight = (model: ComposerModel) => model.sending ? model.queue.find((item) => item.id === model.send?.id) : undefined;

/** The rows to show: the in-flight message leaves the list once the transcript shows it, so it never shows twice. */
export const shownQueue = (model: ComposerModel) => model.send?.echoed ? model.queue.filter((item) => item !== inFlight(model)) : model.queue;

/** The one status line both composers show, and its tone. */
export function composerStatus(model: ComposerModel): { text: string; tone?: "danger" | "busy" } {
  if (model.error) return { text: model.error.text, tone: "danger" };
  if (model.stopping) return { text: "stopping", tone: "busy" };
  if (model.held && model.queue.length) return { text: "the rest wait for your next enter", tone: "busy" };
  if (inFlight(model)) return { text: model.send?.steer ? "next step" : "sending", tone: "busy" };
  if (model.queue[0]?.failed) return { text: "a message was not sent. retry, edit, or cancel it", tone: "danger" };
  return { text: model.note ?? "" };
}

/** What the header shows for this composer: it counts only the rows that are not in flight (an in-flight steer is "next step"). */
export function composerActivity(model: ComposerModel): { sending: boolean; queued: number; failed: boolean } {
  const waiting = model.queue.filter((item) => item !== inFlight(model) && !item.failed).length;
  return { sending: Boolean(inFlight(model)), queued: waiting, failed: Boolean(model.queue[0]?.failed) };
}

const start = (model: ComposerModel, item: QueuedMessage, steer: boolean): ComposerTransition => {
  const attempt = model.nextAttempt;
  return {
    model: { ...model, sending: true, send: { attempt, id: item.id, steer }, nextAttempt: attempt + 1 },
    effect: { type: "submit", attempt, text: item.text, steer },
  };
};

const next = (model: ComposerModel, turnRunning: boolean): ComposerTransition => {
  const head = model.queue[0];
  if (!head || head.failed || model.held || model.sending || !canSend(model.state)) return { model };
  return start(model, head, turnRunning);
};

export function transition(model: ComposerModel, event: ComposerEvent): ComposerTransition {
  switch (event.type) {
    case "state":
      return { model: { ...model, state: event.state, error: event.state !== "running" && event.state !== "steerable" && model.error?.kind === "stop" ? undefined : model.error } };
    case "edit":
      return { model: { ...model, draft: event.draft, error: model.error?.kind === "submit" ? undefined : model.error, note: event.draft.trim() ? model.note : undefined } };
    case "note":
      return { model: { ...model, note: event.text } };
    case "submit": {
      if (!submitAction(model)) return { model };
      if (!model.draft.trim()) return next({ ...model, held: false }, event.turnRunning);
      if (model.queue.length >= QUEUE_LIMIT) return { model: { ...model, error: { kind: "submit", text: `at most ${QUEUE_LIMIT} messages can wait. cancel one or wait for a reply.` } } };
      const item = { id: model.nextQueueId, text: model.draft };
      // the edited text of a failed head keeps its place in front of the rows it held back
      const queued = { ...model, draft: "", error: undefined, note: undefined, held: false, queue: model.held ? [item, ...model.queue] : [...model.queue, item], nextQueueId: model.nextQueueId + 1 };
      return next(queued, event.turnRunning);
    }
    case "next":
      return next(model, event.turnRunning);
    case "track":
      if (model.send?.attempt !== event.attempt) return { model };
      return { model: { ...model, send: { ...model.send, deliveryId: event.deliveryId, echoed: false } } };
    case "echo":
      if (!model.send || model.send.deliveryId !== event.deliveryId) return { model };
      return { model: { ...model, send: { ...model.send, echoed: true } } };
    case "confirm":
      if (model.send?.attempt !== event.attempt) return { model };
      return { model: { ...model, queue: model.queue.filter((item) => item.id !== model.send!.id), send: undefined } };
    case "reject": {
      if (model.send?.attempt !== event.attempt) return { model };
      // a failed message stays first in the list with its error; nothing after it goes out until retry, edit, or cancel
      const { id } = model.send;
      return { model: { ...model, queue: model.queue.map((item) => item.id === id ? { ...item, failed: event.message, tries: (item.tries ?? 0) + 1 } : item) } };
    }
    case "settle":
      if (model.send?.attempt !== event.attempt) return { model: { ...model, sending: false } };
      return { model: { ...model, sending: false, send: undefined } };
    case "retry":
      return { model: { ...model, queue: model.queue.map((item) => item.id === event.id ? { ...item, failed: undefined } : item) } };
    case "restore": {
      // edit a failed message: its text goes back to the front of the box, its row goes away, and the rows behind it wait
      const item = model.queue.find((queued) => queued.id === event.id && queued.failed);
      if (!item) return { model };
      const queue = model.queue.filter((queued) => queued !== item);
      return { model: { ...model, draft: [item.text, model.draft].filter(Boolean).join("\n"), queue, held: queue.length > 0 } };
    }
    case "cancel":
      if (inFlight(model)?.id === event.id) return { model };
      return { model: { ...model, queue: model.queue.filter((item) => item.id !== event.id) } };
    case "cancel-last": {
      const last = model.queue.at(-1);
      return last ? transition(model, { type: "cancel", id: last.id }) : { model };
    }
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
