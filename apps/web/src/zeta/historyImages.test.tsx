import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline, type LoadMedia } from "@fulcrum/react";
import { createClient, fromZetaHistory, type ZetaClient } from "@fulcrum/zeta";
// a namespace import, so base code without the loader still reaches the behavior assertions
import * as connection from "./connection";
const { act, cleanup, render } = await import("@testing-library/react");

const realCreate = URL.createObjectURL;
const realObserver = globalThis.IntersectionObserver;
afterEach(() => { cleanup(); document.body.replaceChildren(); URL.createObjectURL = realCreate; globalThis.IntersectionObserver = realObserver; });

// synthetic bytes; zeta's media type is webp although the stored name says png, so the blob type must come from zeta
const IMAGE = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
const CHUNK = 4;
type Read = { handle: string; offset: number };
type Content = { size?: number; missing?: boolean; notOwned?: boolean };

/** A fake zeta: it grants the asked features it offers, and serves content_read in CHUNK-byte chunks. */
async function fakeZeta(content: Content = {}) {
  let receive!: (text: string) => void;
  const reads: Read[] = [];
  const reply = (message: unknown) => queueMicrotask(() => receive(JSON.stringify(message)));
  const client = createClient({
    onMessage(callback) { receive = callback; },
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method === "hello") {
        const offered = ["session_history_fidelity", "content_read"];
        reply({ jsonrpc: "2.0", id, result: { protocol_version: "1.2", capabilities: { features: params.features.filter((name: string) => offered.includes(name)) } } });
        return;
      }
      if (method !== "content_read") throw new Error(`unexpected ${method}`);
      reads.push(params);
      // zeta f5efa62d: content_read reads the connection's own session (connections.py:1083-1100), so a tab that does not
      // hold the chat gets "session is not active"
      if (content.notOwned) { reply({ jsonrpc: "2.0", id, error: { code: -32003, message: "session is not active" } }); return; }
      if (content.missing) { reply({ jsonrpc: "2.0", id, error: { code: -32012, message: "content not found", data: { code: "content_not_found" } } }); return; }
      const size = content.size ?? IMAGE.length;
      const data = IMAGE.subarray(params.offset, params.offset + CHUNK);
      const next = params.offset + data.length;
      reply({ jsonrpc: "2.0", id, result: { handle: params.handle, media_type: "image/webp", title: "shot.png", size, offset: params.offset, data: btoa(String.fromCharCode(...data)), next_offset: next, eof: next >= size } });
    },
  });
  await client.hello(connection.FEATURES);
  return { client, reads };
}

// one sent image, as zeta's history projection writes it: a handle only when content_read was negotiated
const history = (client: ZetaClient) => fromZetaHistory([{
  id: "u-1", role: "user", tool_result: null,
  content: [{ type: "text", text: "look" }, { type: "attachment", name: "shot.png", size: IMAGE.length, ...(client.features.includes("content_read") ? { handle: "mc:u-1:1" } : {}) }],
}]);

async function shown(client: ZetaClient) {
  const blobs: Blob[] = [];
  URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  // the image is in view: fulcrum loads a lazy image only near the viewport
  globalThis.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  const store = createRunStore((flush) => flush());
  for (const event of history(client)) store.dispatch(event);
  const loadMedia: LoadMedia | undefined = (connection as { historyImageLoader?: (client: ZetaClient) => LoadMedia | undefined }).historyImageLoader?.(client);
  const ui = render(<RunProvider store={store} loadMedia={loadMedia}><Timeline /></RunProvider>);
  for (let tick = 0; tick < 20; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { ui, blobs };
}

test("a sent image in history reads every content_read chunk and shows as a thumbnail of zeta's media type", async () => {
  const { client, reads } = await fakeZeta();
  const { ui, blobs } = await shown(client);
  const image = ui.container.querySelector("[data-part=image]");
  expect(image?.getAttribute("data-state")).toBe("ready");
  expect(ui.container.querySelector("[data-part=image] img")?.getAttribute("src")).toBe("blob:test/1");
  expect(ui.container.querySelector("[data-part=file]")).toBeNull();
  expect(reads).toEqual([{ handle: "mc:u-1:1", offset: 0 }, { handle: "mc:u-1:1", offset: 4 }, { handle: "mc:u-1:1", offset: 8 }]);
  expect(blobs).toHaveLength(1);
  expect(blobs[0]!.type).toBe("image/webp");
  expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual([...IMAGE]);
});

test("an image over the cap is not read past its first chunk and shows fulcrum's failure placeholder", async () => {
  const { client, reads } = await fakeZeta({ size: 8 * 1024 * 1024 + 1 });
  const { ui, blobs } = await shown(client);
  expect(ui.container.querySelector("[data-part=image]")?.getAttribute("data-state")).toBe("error");
  expect(ui.container.querySelector("[data-part=image-placeholder]")?.textContent).toContain("image failed to load");
  // fulcrum's own 32 MiB cap would read on until zeta ran out of bytes
  expect(reads).toEqual([{ handle: "mc:u-1:1", offset: 0 }]);
  expect(blobs).toHaveLength(0);
});

test("an image zeta no longer has says so instead of failing", async () => {
  const { client } = await fakeZeta({ missing: true });
  const { ui } = await shown(client);
  expect(ui.container.querySelector("[data-part=image]")?.getAttribute("data-state")).toBe("unavailable");
  expect(ui.container.querySelector("[data-part=image-placeholder]")?.textContent).toContain("image no longer available");
});

// pins today's limit: when zeta lets content_read name a session, a held-elsewhere tab can load the image and this changes
test("a tab that does not hold the chat gets a clear rejection and fulcrum's retryable failure, not a crash", async () => {
  const { client, reads } = await fakeZeta({ notOwned: true });
  const { ui } = await shown(client);
  expect(ui.container.querySelector("[data-part=image]")?.getAttribute("data-state")).toBe("error");
  expect(ui.container.querySelector("[data-part=image-placeholder]")?.textContent).toBe("image failed to loadretry");
  expect(ui.container.querySelector("[data-part=image-placeholder] [data-action=retry]")).not.toBeNull();
  expect(reads.every((read) => read.offset === 0)).toBe(true);
  const loader = (connection as { historyImageLoader?: (client: ZetaClient) => LoadMedia | undefined }).historyImageLoader?.(client);
  await expect(loader?.({ type: "image", source: { kind: "lazy", key: "mc:u-1:1" } }, new AbortController().signal)).rejects.toMatchObject({ code: -32003, message: "session is not active" });
});
