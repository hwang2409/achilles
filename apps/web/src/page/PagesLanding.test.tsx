import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PagesLanding } from "./PagesLanding";

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");

test("omits the changed fact for an invalid page date", () => {
  const page = { id: "sample", route: "/sample", title: "sample", created_at: "2025-01-01", create_mode: false, chat_count: 0, created_by_route: null };
  const markup = renderToStaticMarkup(<PagesLanding catalog={{ items: [
    { ...page, updated_at: "2025-01-45" },
    { ...page, id: "valid", route: "/valid", updated_at: "2025-01-01" },
  ], next: null, loading: false, error: false, meta: null }} reload={() => {}} more={async () => {}} />);

  expect(markup).not.toMatch(/invalid date/i);
  expect(markup.match(/changed <time/g)).toHaveLength(1);
});

const live = { id: "reading", route: "/reading", title: "reading", created_at: "2025-01-01", updated_at: "2025-01-01", create_mode: false, chat_count: 0, created_by_route: null, archived_at: null };
const home = { ...live, id: "home", route: "/", title: "home" };

test("a page row renames and archives; home has no archive", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<[string, string | undefined, unknown]> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init?.method, init?.body && JSON.parse(String(init.body))]);
    return Response.json({ ...live, title: "books", archived_at: "2025-02-01" });
  }) as typeof fetch;
  let reloads = 0;
  const view = render(<PagesLanding catalog={{ items: [home, live], next: null, loading: false, error: false, meta: null }} reload={() => { reloads += 1; }} more={async () => {}} />);
  try {
    expect(view.queryByRole("button", { name: "archive home" })).toBeNull();
    expect(view.getByRole("button", { name: "rename home" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "rename reading" }));
    const input = view.getByRole("textbox", { name: "title of reading" }) as HTMLInputElement;
    expect(input.value).toBe("reading");
    fireEvent.change(input, { target: { value: "  books " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(reloads).toBe(1), { timeout: 1000 });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "archive reading" })); });
    await waitFor(() => expect(reloads).toBe(2), { timeout: 1000 });
    expect(calls).toEqual([
      ["/api/pages/reading", "PATCH", { title: "books" }],
      ["/api/pages/reading", "PATCH", { archived: true }],
    ]);
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("archived pages load only when opened and restore from there", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<[string, string | undefined]> = [];
  const archived = { ...live, id: "old", route: "/old", title: "old notes", archived_at: "2025-02-01" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init?.method]);
    if (init?.method === "PATCH") return Response.json({ ...archived, archived_at: null });
    return Response.json({ pages: calls.length > 2 ? [] : [archived], next: null });
  }) as typeof fetch;
  let reloads = 0;
  const view = render(<PagesLanding catalog={{ items: [home, live], next: null, loading: false, error: false, meta: null }} reload={() => { reloads += 1; }} more={async () => {}} />);
  try {
    // the live list is the server's: archived pages are not in it, and nothing is read until the section opens
    expect(view.queryByText("old notes")).toBeNull();
    expect(calls).toEqual([]);
    const summary = view.container.querySelector("details.pages-archived > summary");
    expect(summary?.textContent).toBe("archived pages");
    await act(async () => { fireEvent.click(summary!); });
    await waitFor(() => expect(view.getByRole("link", { name: "old notes /old" })).toBeTruthy(), { timeout: 1000 });
    expect(view.queryByRole("button", { name: "archive old notes" })).toBeNull();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "restore old notes" })); });
    await waitFor(() => expect(view.queryByText("old notes")).toBeNull(), { timeout: 1000 });
    expect(reloads).toBe(1);
    expect(calls).toEqual([
      ["/api/pages?archived=1&limit=200", undefined],
      ["/api/pages/old", "PATCH"],
      ["/api/pages?archived=1&limit=200", undefined],
    ]);
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});
