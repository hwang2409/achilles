import { describe, expect, test } from "bun:test";
import { createComposerModel, enterAction, transition, type ComposerEvent, type ComposerModel } from "./composer-machine";

const apply = (model: ComposerModel, ...events: ComposerEvent[]) => events.reduce((current, event) => transition(current, event).model, model);

describe("composer delivery machine", () => {
  const cases: Array<[string, () => void]> = [
    ["success", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit" });
      expect(submitted.effect).toEqual({ type: "submit", attempt: 1, text: "hello", steer: false });
      expect(apply(submitted.model, { type: "confirm", attempt: 1 }, { type: "settle", attempt: 1 })).toMatchObject({ draft: "", sending: false });
    }],
    ["double enter", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit" });
      expect(transition(submitted.model, { type: "submit" }).effect).toBeUndefined();
    }],
    ["enter during IME composition", () => {
      expect(enterAction({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13, mode: "insert" })).toBe("ignore");
      expect(enterAction({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229, mode: "insert" })).toBe("ignore");
    }],
    ["steer while running", () => {
      expect(transition(createComposerModel("redirect", "steerable"), { type: "submit" }).effect).toEqual({ type: "submit", attempt: 1, text: "redirect", steer: true });
    }],
    ["stop", () => {
      const stopping = transition(createComposerModel("kept", "steerable"), { type: "stop" });
      expect(stopping.effect).toEqual({ type: "stop" });
      expect(apply(stopping.model, { type: "stop-settle" })).toMatchObject({ draft: "kept", stopping: false });
    }],
    ["late delivery confirmation", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit" }).model;
      const rejected = apply(submitted, { type: "track", attempt: 1, deliveryId: "delivery-1" }, { type: "reject", attempt: 1, message: "offline", delivered: false }, { type: "settle", attempt: 1 });
      expect(rejected).toMatchObject({ draft: "hello", sending: false, error: { kind: "submit", text: "could not send: offline" } });
      expect(apply(rejected, { type: "confirm", attempt: 1 })).toMatchObject({ draft: "", error: undefined, send: undefined });
    }],
    ["error", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit" }).model;
      const failed = apply(submitted, { type: "reject", attempt: 1, message: "denied", delivered: false }, { type: "settle", attempt: 1 });
      expect(failed).toMatchObject({ draft: "hello", sending: false, error: { kind: "submit", text: "could not send: denied" } });
    }],
    ["draft clears only on confirmed send", () => {
      const submitted = transition(createComposerModel("hello again", "idle"), { type: "submit" }).model;
      expect(apply(submitted, { type: "edit", draft: "hello again later" }, { type: "settle", attempt: 1 }).draft).toBe("hello again later");
      expect(apply(submitted, { type: "edit", draft: "hello again later" }, { type: "confirm", attempt: 1 }).draft).toBe(" later");
    }],
  ];

  for (const [name, check] of cases) test(name, check);

  test("read-only keeps the exact draft and blocks submit", () => {
    const readOnly = apply(createComposerModel("unsent draft", "idle"), { type: "state", state: "read-only" });
    expect(readOnly.draft).toBe("unsent draft");
    expect(transition(readOnly, { type: "submit" }).effect).toBeUndefined();
    expect(apply(readOnly, { type: "state", state: "idle" }).draft).toBe("unsent draft");
  });
});
