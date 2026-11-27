import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import { acceptsBridgeMessage, PageFrame } from "./PageFrame";

const { act, createElement } = await import("react");
const { render, waitFor } = await import("@testing-library/react");

const source = {} as Window;
const event = (data: object, origin = "null", eventSource: MessageEventSource | null = source) =>
  ({ data, origin, source: eventSource }) as MessageEvent;
const valid = { pageId: "home", revision: 3, requestId: "1", method: "list", collection: "notes" };

test("accepts only this opaque frame and declared record methods", () => {
  expect(acceptsBridgeMessage(event(valid), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event({ ...valid, method: "insert" }), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event(valid, location.origin), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event(valid, "null", {} as Window), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, pageId: "other" }), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, revision: 2 }), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, method: "delete" }), source, "home", 3)).toBeFalse();
});

test("a page that moves to a new revision while open reloads its frame, so records calls still answer", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json([]); }) as typeof fetch;
  // a frame's document runs the code of the revision it loaded with, and stamps its bridge calls with that revision
  const loadedWith = new WeakMap<HTMLIFrameElement, number>();
  const frameOf = (view: ReturnType<typeof render>, revision: number) => {
    const frame = view.container.querySelector("iframe")!;
    if (!loadedWith.has(frame)) loadedWith.set(frame, revision);
    return frame;
  };
  const view = render(createElement(PageFrame, { pageId: "home", credential: "c", revision: 1 }));
  try {
    frameOf(view, 1);
    await act(async () => { view.rerender(createElement(PageFrame, { pageId: "home", credential: "c", revision: 2 })); });
    const frame = frameOf(view, 2);
    await act(async () => {
      dispatchEvent(new MessageEvent("message", { origin: "null", source: frame.contentWindow, data: { pageId: "home", revision: loadedWith.get(frame), requestId: "1", method: "list", collection: "notes" } }));
    });
    await waitFor(() => expect(calls).toEqual(["/api/pages/home/records/notes"]), { timeout: 1000 });
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});
