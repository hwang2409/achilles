import { describe, expect, test } from "bun:test";
import { MAYBE_SENT, QUEUE_LIMIT, composerActivity, createComposerModel, shownQueue, enterAction, transition, type ComposerEvent, type ComposerModel } from "./composer-machine";

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
    ["enter while a send is pending queues the box text behind it and empties the box", () => {
      const pending = transition(createComposerModel("first", "idle"), { type: "submit", turnRunning: false }).model;
      expect(pending).toMatchObject({ draft: "", sending: true, queue: [{ id: 1, text: "first" }] });
      const queued = apply(pending, { type: "edit", draft: "second" }, { type: "submit", turnRunning: false });
      expect(queued).toMatchObject({ draft: "", queue: [{ text: "first" }, { text: "second" }] });
      expect(transition(queued, { type: "submit", turnRunning: false }).model.queue).toHaveLength(2);
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
      expect(submitted.model).toMatchObject({ draft: "", sending: true, queue: [{ text: "hello" }] });
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
      expect(failed).toMatchObject({ draft: "", sending: false, error: undefined, queue: [{ text: "hello", failed: "denied", tries: 1 }] });
    }],
    ["the box never changes when a submitted message settles", () => {
      const submitted = transition(createComposerModel("hello again", "idle"), { type: "submit", turnRunning: false }).model;
      expect(apply(submitted, { type: "edit", draft: "hello again later" }, { type: "confirm", attempt: 1 }, { type: "settle", attempt: 1 })).toMatchObject({ draft: "hello again later", queue: [] });
    }],
    ["the in-flight row leaves the list once zeta's transcript shows its prompt", () => {
      const sending = apply(createComposerModel("hello", "idle"), { type: "submit", turnRunning: false }, { type: "edit", draft: "next" }, { type: "submit", turnRunning: false });
      expect(shownQueue(apply(sending, { type: "echo", deliveryId: "d1" })).map((item) => item.text)).toEqual(["hello", "next"]);
      const tracked = apply(sending, { type: "track", attempt: 1, deliveryId: "d1" }, { type: "echo", deliveryId: "d2" });
      expect(shownQueue(tracked).map((item) => item.text)).toEqual(["hello", "next"]);
      expect(shownQueue(apply(tracked, { type: "echo", deliveryId: "d1" })).map((item) => item.text)).toEqual(["next"]);
    }],
    ["the header counts only rows not in flight and shows a failed head", () => {
      const steering = transition(createComposerModel("redirect", "steerable"), { type: "submit", turnRunning: true }).model;
      expect(composerActivity(steering)).toEqual({ sending: true, queued: 0, failed: false });
      const failed = apply(steering, { type: "edit", draft: "later" }, { type: "submit", turnRunning: true }, { type: "reject", attempt: 1, message: "no" }, { type: "settle", attempt: 1 });
      expect(composerActivity(failed)).toEqual({ sending: false, queued: 1, failed: true });
    }],
  ];

  for (const [name, check] of cases) test(name, check);

  test("a row that may have been sent is never edited into a new message: enter cannot send its text with another delivery id", () => {
    const maybe = createComposerModel("", "idle", [{ text: "hello", failed: MAYBE_SENT, deliveryId: "d1" }]);
    const afterEdit = transition(apply(maybe, { type: "restore", id: 1 }), { type: "submit", turnRunning: false });
    expect(afterEdit.effect).toBeUndefined();
    expect(afterEdit.model).toMatchObject({ draft: "", queue: [{ text: "hello", failed: MAYBE_SENT, deliveryId: "d1" }] });
    // retry is the way out: it goes with the same id, so zeta keeps one copy
    expect(transition(apply(maybe, { type: "retry", id: 1 }), { type: "next", turnRunning: false }).effect).toEqual({ type: "submit", attempt: 1, text: "hello", steer: false, deliveryId: "d1" });
    // a row zeta refused holds nothing on zeta's side: edit still puts its text back in the box
    const refused = createComposerModel("", "idle", [{ text: "hello", failed: "refused", deliveryId: "d2" }]);
    expect(apply(refused, { type: "restore", id: 1 })).toMatchObject({ draft: "hello", queue: [] });
  });

  test("read-only keeps the exact draft and blocks submit", () => {
    const readOnly = apply(createComposerModel("unsent draft", "idle"), { type: "state", state: "read-only" });
    expect(readOnly.draft).toBe("unsent draft");
    expect(transition(readOnly, { type: "submit", turnRunning: false }).effect).toBeUndefined();
    expect(apply(readOnly, { type: "state", state: "idle" }).draft).toBe("unsent draft");
  });
});
