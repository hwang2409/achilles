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
  expect(acceptsBridgeMessage(event({ ...valid, method: "update", id: "r1" }), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event({ ...valid, method: "delete", id: "r1" }), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event({ ...valid, method: "delete" }), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, method: "drop", id: "r1" }), source, "home", 3)).toBeFalse();
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

test("switching to another page at the same revision drops the old page's error line", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  const view = render(createElement(PageFrame, { pageId: "a", credential: "c", revision: 1 }));
  try {
    const frame = view.container.querySelector("iframe")!;
    await act(async () => {
      dispatchEvent(new MessageEvent("message", { origin: "null", source: frame.contentWindow, data: { pageId: "a", revision: 1, runtimeError: "boom" } }));
    });
    await waitFor(() => expect(view.container.querySelector(".page-error")).not.toBeNull(), { timeout: 1000 });
    await act(async () => { view.rerender(createElement(PageFrame, { pageId: "b", credential: "c", revision: 1 })); });
    expect(view.container.querySelector(".page-error")?.textContent ?? null).toBeNull();
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a failed records call replies ok:false with {detail}, so the page's promise rejects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("record not found", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch;
  const view = render(createElement(PageFrame, { pageId: "home", credential: "c", revision: 1 }));
  try {
    const frame = view.container.querySelector("iframe")!;
    const replies: unknown[] = [];
    const page = { postMessage: (reply: unknown) => replies.push(reply) } as unknown as Window;
    Object.defineProperty(frame, "contentWindow", { value: page });
    await act(async () => {
      dispatchEvent(new MessageEvent("message", { origin: "null", source: page, data: { pageId: "home", revision: 1, requestId: "7", method: "delete", collection: "notes", id: "gone" } }));
    });
    await waitFor(() => expect(replies).toEqual([{ requestId: "7", ok: false, result: { detail: "record not found" } }]), { timeout: 1000 });
    expect(view.container.querySelector(".page-error")).toBeNull();
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});
