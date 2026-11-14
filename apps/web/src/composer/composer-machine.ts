import type { ComposerState } from "@fulcrum/react";

export type ComposerError = { kind: "submit" | "stop"; text: string };
type Send = { attempt: number; sent: string; steer: boolean; deliveryId?: string };

export type ComposerModel = {
  state: ComposerState;
  draft: string;
  sending: boolean;
  stopping: boolean;
  error?: ComposerError;
  send?: Send;
  nextAttempt: number;
};

export type ComposerEffect =
  | { type: "submit"; attempt: number; text: string; steer: boolean }
  | { type: "stop" };

export type ComposerEvent =
  | { type: "state"; state: ComposerState }
  | { type: "edit"; draft: string }
  | { type: "submit"; turnRunning: boolean }
  | { type: "track"; attempt: number; deliveryId: string }
  | { type: "confirm"; attempt: number }
  | { type: "reject"; attempt: number; message: string; delivered: boolean }
  | { type: "settle"; attempt: number }
  | { type: "stop" }
  | { type: "stop-reject"; message: string }
  | { type: "stop-settle" };

export type ComposerTransition = { model: ComposerModel; effect?: ComposerEffect };

export function createComposerModel(draft: string, state: ComposerState): ComposerModel {
  return { state, draft, sending: false, stopping: false, nextAttempt: 1 };
}

const unsentDraft = (current: string, sent: string) => current.startsWith(sent) ? current.slice(sent.length) : current;

export function transition(model: ComposerModel, event: ComposerEvent): ComposerTransition {
  switch (event.type) {
    case "state":
      return { model: { ...model, state: event.state, error: event.state !== "running" && event.state !== "steerable" && model.error?.kind === "stop" ? undefined : model.error } };
    case "edit":
      return { model: { ...model, draft: event.draft, send: model.sending ? model.send : undefined, error: model.error?.kind === "submit" && !model.sending ? undefined : model.error } };
    case "submit": {
      if (model.sending || !model.draft.trim() || model.state === "running" || model.state === "read-only") return { model };
      const attempt = model.nextAttempt;
      const steer = event.turnRunning;
      return {
        model: { ...model, sending: true, error: undefined, send: { attempt, sent: model.draft, steer }, nextAttempt: attempt + 1 },
        effect: { type: "submit", attempt, text: model.draft, steer },
      };
    }
    case "track":
      if (model.send?.attempt !== event.attempt || model.send.deliveryId) return { model };
      return { model: { ...model, send: { ...model.send, deliveryId: event.deliveryId } } };
    case "confirm":
      if (model.send?.attempt !== event.attempt) return { model };
      return { model: { ...model, draft: unsentDraft(model.draft, model.send.sent), send: undefined, error: model.error?.kind === "submit" ? undefined : model.error } };
    case "reject":
      if (model.send?.attempt !== event.attempt || event.delivered) return event.delivered ? transition(model, { type: "confirm", attempt: event.attempt }) : { model };
      return { model: { ...model, error: { kind: "submit", text: `could not ${model.send.steer ? "steer" : "send"}: ${event.message}` } } };
    case "settle":
      if (model.send?.attempt !== event.attempt) return { model: { ...model, sending: false } };
      return { model: { ...model, sending: false, send: model.send.deliveryId ? model.send : undefined } };
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
