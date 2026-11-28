import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import { ArchivedBar, PageCrumbMenu, type ChangedPage } from "./PageArchive";

const { act, createElement } = await import("react");
const { fireEvent, render, waitFor } = await import("@testing-library/react");

const page = { id: "reading", title: "reading list" };

function mockFetch(reply: (body: unknown) => Response) {
  const original = globalThis.fetch;
  const calls: Array<[string, string | undefined, unknown]> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body && JSON.parse(String(init.body));
    calls.push([String(input), init?.method, body]);
    return reply(body);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("an archived page's bar says archived and restores it", async () => {
  const fetches = mockFetch(() => Response.json({ ...page, route: "/reading", archived_at: null }));
  const changed: ChangedPage[] = [];
  const view = render(createElement(ArchivedBar, { page, onChanged: (value: ChangedPage) => changed.push(value) }));
  try {
    const bar = view.getByRole("status");
    expect(bar.textContent).toStartWith("archived·restore");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "restore reading list" })); });
    await waitFor(() => expect(changed).toEqual([{ ...page, route: "/reading", archived_at: null }]), { timeout: 1000 });
    expect(fetches.calls).toEqual([["/api/pages/reading", "PATCH", { archived: false }]]);
  } finally {
    view.unmount();
    fetches.restore();
  }
});

test("a refused restore shows the server's reason", async () => {
  const fetches = mockFetch(() => new Response("page not found", { status: 404 }));
  const view = render(createElement(ArchivedBar, { page, onChanged: () => {} }));
  try {
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "restore reading list" })); });
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("page not found"), { timeout: 1000 });
  } finally {
    view.unmount();
    fetches.restore();
  }
});

test("the header crumb menu renames and archives the page, and esc closes it", async () => {
  const fetches = mockFetch((body) => Response.json({ ...page, route: "/reading", archived_at: null, ...(body as object) }));
  const changed: unknown[] = [];
  const view = render(createElement(PageCrumbMenu, { page, onChanged: (value: ChangedPage) => changed.push(value) }));
  try {
    const trigger = view.getByRole("button", { name: "reading list" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(view.getByRole("button", { name: "rename page" }), { key: "Escape" });
    expect(view.queryByRole("button", { name: "rename page" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("button", { name: "rename page" }));
    const input = view.getByRole("textbox", { name: "page title" }) as HTMLInputElement;
    expect(input.maxLength).toBe(200);
    fireEvent.change(input, { target: { value: "books" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    // a blank title is not sent
    fireEvent.click(view.getByRole("button", { name: "reading list" }));
    fireEvent.click(view.getByRole("button", { name: "rename page" }));
    fireEvent.change(view.getByRole("textbox", { name: "page title" }), { target: { value: "   " } });
    await act(async () => { fireEvent.keyDown(view.getByRole("textbox", { name: "page title" }), { key: "Enter" }); });

    fireEvent.click(view.getByRole("button", { name: "reading list" }));
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "archive page" })); });
    await waitFor(() => expect(changed).toHaveLength(2), { timeout: 1000 });
    expect(fetches.calls).toEqual([
      ["/api/pages/reading", "PATCH", { title: "books" }],
      ["/api/pages/reading", "PATCH", { archived: true }],
    ]);
  } finally {
    view.unmount();
    fetches.restore();
  }
});
