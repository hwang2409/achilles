import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { createClient } from "@fulcrum/zeta";
import { FEATURES } from "../zeta/connection";

// after test-dom: React must see the registered DOM.
const { act, cleanup, render } = await import("@testing-library/react");
const { SessionsModule } = await import("./SessionsModule");

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realObserver = globalThis.IntersectionObserver;
afterEach(() => {
  cleanup(); history.replaceState(null, "", "/");
  globalThis.fetch = realFetch; URL.createObjectURL = realCreate; globalThis.IntersectionObserver = realObserver;
});

const IMAGE = Uint8Array.from({ length: 6 }, (_, index) => index + 1); // synthetic bytes

/** A fake zeta that holds session "s1" and, with content_read negotiated, puts a handle on the sent image in session_history. */
async function fakeZeta() {
  let receive!: (text: string) => void;
  const reads: string[] = [];
  const reply = (id: number, result: unknown) => queueMicrotask(() => receive(JSON.stringify({ jsonrpc: "2.0", id, result })));
  const client = createClient({
    onMessage(callback) { receive = callback; },
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method === "hello") {
        const offered = ["session_history_fidelity", "content_read"];
        return reply(id, { protocol_version: "1.2", capabilities: { features: params.features.filter((name: string) => offered.includes(name)) } });
      }
      if (method === "list_sessions") return reply(id, { sessions: [{ session_id: "s1", name: "synthetic s1", project_id: null }] });
      if (method === "status") return reply(id, { session: { session_id: "s1" } });
      if (method === "session_history") return reply(id, { next_offset: null, messages: [{
        id: "u-1", role: "user", tool_result: null,
        content: [{ type: "text", text: "look" }, { type: "attachment", name: "shot.png", size: IMAGE.length, handle: "row.u1.mc.1" }],
      }] });
      if (method === "content_read") {
        reads.push(params.handle);
        return reply(id, { handle: params.handle, media_type: "image/png", title: "shot.png", size: IMAGE.length, offset: 0, data: btoa(String.fromCharCode(...IMAGE)), next_offset: IMAGE.length, eof: true });
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await client.hello(FEATURES);
  return { client, reads };
}

test("a sent image in a sessions transcript loads as a thumbnail, not an unsupported-address placeholder", async () => {
  const { client, reads } = await fakeZeta();
  globalThis.fetch = (async () => Response.json({ chats: [] })) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:test/1";
  // the image is in view: fulcrum loads a lazy image only near the viewport
  globalThis.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  history.replaceState(null, "", "/sessions/s1/transcript");
  const ui = render(createElement(SessionsModule, { client, connecting: false, retry: () => {}, newChat: () => {}, chats: [], continueSession: async () => null, advertised: () => true }));
  for (let tick = 0; tick < 30; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const timeline = ui.container.querySelector(".sessions-timeline");
  expect(timeline?.textContent).toContain("look");
  expect(timeline?.textContent).not.toContain("unsupported address");
  expect(timeline?.querySelector("[data-part=image]")?.getAttribute("data-state")).toBe("ready");
  expect(timeline?.querySelector("[data-part=image] img")?.getAttribute("src")).toBe("blob:test/1");
  expect(reads).toEqual(["row.u1.mc.1"]);
});
