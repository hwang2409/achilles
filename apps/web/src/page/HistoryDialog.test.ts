import "../test-dom";
import { afterEach, expect, test } from "bun:test";

const { act, createElement } = await import("react");
const { render, waitFor } = await import("@testing-library/react");
const { HistoryDialog } = await import("./HistoryDialog");

let mounted: ReturnType<typeof render> | null = null;
const opener = { current: null } as { current: HTMLElement | null };
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  globalThis.fetch = originalFetch;
});

test("read-only history loads but disables restore without a POST", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({
      layout: [{ version: 1, created_at: "2026-01-01T00:00:00Z", block_types: ["text"], summary: "text", active: false, action: "create_page", restored_from: null }],
      tools: [],
    });
  }) as typeof fetch;
  mounted = render(createElement(HistoryDialog, {
    pageId: "p1", credential: "c", createMode: true, opener, onClose: () => {}, onChanged: () => {},
    canWrite: false, disabledReason: "this tab is read-only; take control to make changes",
  }));
  await waitFor(() => expect(mounted?.getByText("this tab is read-only; take control to make changes")).toBeTruthy());
  expect((mounted?.getByRole("button", { name: "restore" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.filter((call) => call.startsWith("POST "))).toEqual([]);
});
