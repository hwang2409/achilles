import { expect, test } from "bun:test";
import { continuationHref, mappingFailed } from "./continueChat";

const home = { session_id: "session", page_route: "/" };
const mapped = { ...home, page_route: "/books" };
const list = (chat?: typeof home) => Response.json({ chats: chat ? [chat] : [], next: null });
const lookup = "GET /api/chats?limit=200&include=session";
const post = 'POST /api/pages/home/chats {"session_id":"session"}';

test.each([
  { name: "existing home", replies: () => [list(home)], href: "/?chat=session#continue-chat", calls: [lookup] },
  { name: "existing page", replies: () => [list(mapped)], href: "/books?chat=session#continue-chat", calls: [lookup] },
  { name: "unmapped", replies: () => [list(), Response.json(home)], href: "/?chat=session#continue-chat", calls: [lookup, post] },
  { name: "concurrent 409", replies: () => [list(), new Response(null, { status: 409 }), list(mapped)], href: "/books?chat=session#continue-chat", calls: [lookup, post, lookup] },
  { name: "registration failure", replies: () => [list(), new Response(null, { status: 500 })], href: null, calls: [lookup, post] },
])("routes continuation: $name", async ({ replies, href, calls }) => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  const responses = replies();
  globalThis.fetch = (async (path, init) => {
    seen.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${init.body}` : ""}`);
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
  try {
    const run = continuationHref("session", AbortSignal.timeout(2000));
    if (href) expect(await run).toBe(href);
    else await expect(run).rejects.toThrow(mappingFailed);
    expect(seen).toEqual(calls);
  } finally { globalThis.fetch = original; }
});
