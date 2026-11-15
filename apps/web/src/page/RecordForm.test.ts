import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Saved before register so afterEach restores bun's own fetch, not happy-dom's.
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, createElement } = await import("react");
const { fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { FormBlock } = await import("./RecordForm");

let mounted: ReturnType<typeof render> | null = null;
afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  globalThis.fetch = originalFetch;
});

const schema = (extra: Record<string, unknown> = {}) => ({ type: "object", properties: { title: { type: "string" }, pages: { type: "integer", minimum: 1 }, ...extra }, required: ["title", "pages"] });

// A scripted server: each GET of the tool list returns the current tool; invoke answers 409 until the client sends the current version.
function serve(tool: { version: number; input_schema: unknown }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/tools")) return Response.json({ tools: [{ name: "add_book", operation: "insert", collection: "books", ...tool }] });
    const sent = JSON.parse(String(init?.body)) as { version: number };
    return sent.version === tool.version ? Response.json({ record: {} }) : Response.json({ error: { code: "conflict", path: "", expected: "version" } }, { status: 409 });
  }) as typeof fetch;
  return calls;
}

const block = (refreshKey: string) => createElement(FormBlock, { title: "add book", toolName: "add_book", pageId: "books", credential: "c", refreshKey });

test("a chat turn end (refreshKey change) keeps typed values and the same inputs", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  const title = await screen.findByLabelText(/title/) as HTMLInputElement;
  fireEvent.change(title, { target: { value: "half typed draft" } });
  // The tool gains a field during the turn; the form takes the new schema in place.
  serve({ version: 2, input_schema: schema({ rating: { type: "number" } }) });
  await act(async () => { mounted?.rerender(block("1:0")); });
  await screen.findByLabelText(/rating/);
  expect((screen.getByLabelText(/title/) as HTMLInputElement).value).toBe("half typed draft");
  expect(screen.getByLabelText(/title/)).toBe(title);
});

test("reload tool after a 409 keeps typed values and focuses the first field", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  fireEvent.change(await screen.findByLabelText(/title/), { target: { value: "conflict book" } });
  fireEvent.change(screen.getByLabelText(/pages/), { target: { value: "200" } });
  const calls = serve({ version: 2, input_schema: schema() });
  fireEvent.click(screen.getByRole("button", { name: "add" }));
  const reload = await screen.findByRole("button", { name: "reload tool" });
  reload.focus();
  fireEvent.click(reload);
  await waitFor(() => expect(calls.filter((call) => call.endsWith("/tools")).length).toBe(1));
  await act(async () => { await Promise.resolve(); });
  expect((screen.getByLabelText(/title/) as HTMLInputElement).value).toBe("conflict book");
  expect((screen.getByLabelText(/pages/) as HTMLInputElement).value).toBe("200");
  expect(document.activeElement).toBe(screen.getByLabelText(/title/));
  // The retry now carries the new version and succeeds.
  fireEvent.click(screen.getByRole("button", { name: "add" }));
  expect(await screen.findByText("added")).toBeTruthy();
});
