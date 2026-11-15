import { describe, expect, test } from "bun:test";
import { QUEUE_LIMIT, createComposerModel, enterAction, transition, type ComposerEvent, type ComposerModel } from "./composer-machine";

const apply = (model: ComposerModel, ...events: ComposerEvent[]) => events.reduce((current, event) => transition(current, event).model, model);

describe("composer delivery machine", () => {
  const cases: Array<[string, () => void]> = [
    ["success", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit", turnRunning: false });
      expect(submitted.effect).toEqual({ type: "submit", attempt: 1, text: "hello", steer: false });
      expect(apply(submitted.model, { type: "confirm", attempt: 1 }, { type: "settle", attempt: 1 })).toMatchObject({ draft: "", sending: false });
    }],
    ["duplicate input", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit", turnRunning: false });
      expect(transition(submitted.model, { type: "submit", turnRunning: false }).effect).toBeUndefined();
    }],
    ["enter while it cannot send keeps the draft and sends nothing", () => {
      const running = transition(createComposerModel("kept while running", "running"), { type: "submit", turnRunning: true });
      expect(running).toEqual({ model: expect.objectContaining({ draft: "kept while running", queue: [] }) });
    }],
    ["enter while a send is pending moves only the new text out of the box into the queue", () => {
      const pending = transition(createComposerModel("first", "idle"), { type: "submit", turnRunning: false }).model;
      const queued = apply(pending, { type: "edit", draft: "first\nsecond" }, { type: "submit", turnRunning: false });
      expect(queued).toMatchObject({ draft: "first", sending: true, queue: [{ id: 1, text: "second" }] });
      expect(transition(queued, { type: "submit", turnRunning: false }).model.queue).toHaveLength(1);
      expect(apply(queued, { type: "confirm", attempt: 1 }, { type: "settle", attempt: 1 })).toMatchObject({ draft: "", queue: [{ text: "second" }] });
    }],
    ["the queue has a cap and says so", () => {
      let model = transition(createComposerModel("first", "idle"), { type: "submit", turnRunning: false }).model;
      for (let index = 0; index <= QUEUE_LIMIT; index += 1) model = apply(model, { type: "edit", draft: `m${index}` }, { type: "submit", turnRunning: false });
      expect(model.queue).toHaveLength(QUEUE_LIMIT);
      expect(model).toMatchObject({ draft: `m${QUEUE_LIMIT}`, error: { kind: "submit" } });
    }],
    ["remount or restart seeds the exact published draft", () => {
      const published = apply(createComposerModel("", "idle"), { type: "edit", draft: "first\n\n  third" });
      expect(createComposerModel(published.draft, "idle").draft).toBe("first\n\n  third");
    }],
    ["submit await has no frontend cancellation operation", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit", turnRunning: false });
      expect(submitted.model).toMatchObject({ draft: "hello", sending: true });
    }],
    ["enter during IME composition", () => {
      expect(enterAction({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13, mode: "insert" })).toBe("ignore");
      expect(enterAction({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229, mode: "insert" })).toBe("ignore");
    }],
    ["steer while running", () => {
      expect(transition(createComposerModel("redirect", "steerable"), { type: "submit", turnRunning: true }).effect).toEqual({ type: "submit", attempt: 1, text: "redirect", steer: true });
    }],
    ["stale steerable UI sends after the turn ended", () => {
      expect(transition(createComposerModel("next", "steerable"), { type: "submit", turnRunning: false }).effect).toEqual({ type: "submit", attempt: 1, text: "next", steer: false });
    }],
    ["stop await has no frontend cancellation operation", () => {
      const stopping = transition(createComposerModel("kept", "steerable"), { type: "stop" });
      expect(stopping.effect).toEqual({ type: "stop" });
      expect(stopping.model).toMatchObject({ draft: "kept", stopping: true });
    }],
    ["stop publish rejects", () => {
      const stopping = transition(createComposerModel("kept", "steerable"), { type: "stop" }).model;
      expect(apply(stopping, { type: "stop-reject", message: "denied" }, { type: "stop-settle" })).toMatchObject({ draft: "kept", stopping: false, error: { kind: "stop", text: "could not stop: denied" } });
    }],
    ["read-only clears a stale stop error", () => {
      const stopping = transition(createComposerModel("kept", "steerable"), { type: "stop" }).model;
      const failed = apply(stopping, { type: "stop-reject", message: "denied" }, { type: "stop-settle" });
      expect(apply(failed, { type: "state", state: "read-only" }).error).toBeUndefined();
    }],
    ["submit publish rejects", () => {
      const submitted = transition(createComposerModel("hello", "idle"), { type: "submit", turnRunning: false }).model;
      const failed = apply(submitted, { type: "reject", attempt: 1, message: "denied" }, { type: "settle", attempt: 1 });
      expect(failed).toMatchObject({ draft: "hello", sending: false, error: { kind: "submit", text: "denied" } });
    }],
    ["draft clears only on confirmed send", () => {
      const submitted = transition(createComposerModel("hello again", "idle"), { type: "submit", turnRunning: false }).model;
      expect(apply(submitted, { type: "edit", draft: "hello again later" }, { type: "settle", attempt: 1 }).draft).toBe("hello again later");
      expect(apply(submitted, { type: "edit", draft: "hello again later" }, { type: "confirm", attempt: 1 }).draft).toBe(" later");
    }],
  ];

  for (const [name, check] of cases) test(name, check);

  test("read-only keeps the exact draft and blocks submit", () => {
    const readOnly = apply(createComposerModel("unsent draft", "idle"), { type: "state", state: "read-only" });
    expect(readOnly.draft).toBe("unsent draft");
    expect(transition(readOnly, { type: "submit", turnRunning: false }).effect).toBeUndefined();
    expect(apply(readOnly, { type: "state", state: "idle" }).draft).toBe("unsent draft");
  });
});
