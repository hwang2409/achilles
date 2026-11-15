import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Saved before register so afterAll restores bun's own globals, not happy-dom's.
const originalFetch = globalThis.fetch;
const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
// testing-library sets this only on its first import, which another test file may have done and then reset.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => { GlobalRegistrator.unregister(); globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment; });

const { act, createElement } = await import("react");
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { FormBlock } = await import("./RecordForm");

let mounted: ReturnType<typeof render> | null = null;
// Queries come from the render result: `screen` binds to the document that existed when testing-library was first imported, which another test file may do before any DOM.
const view = () => mounted as ReturnType<typeof render>;
afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  globalThis.fetch = originalFetch;
});

// Fields are set through the select: other test files in the same bun process import react-dom before a DOM exists,
// so React falls back to old-IE input-event handling for text inputs, while select change events always work.
const schema = (extra: Record<string, unknown> = {}) => ({ type: "object", properties: { status: { enum: ["to read", "done"] }, title: { type: "string" }, ...extra }, required: ["status"] });

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
const done = JSON.stringify("done");

test("a chat turn end (refreshKey change) keeps typed values and the same inputs", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  const status = await view().findByLabelText(/status/) as HTMLSelectElement;
  fireEvent.change(status, { target: { value: done } });
  // The tool gains a field during the turn; the form takes the new schema in place.
  serve({ version: 2, input_schema: schema({ rating: { type: "number" } }) });
  await act(async () => { mounted?.rerender(block("1:0")); });
  await view().findByLabelText(/rating/);
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(done);
  expect(view().getByLabelText(/status/)).toBe(status);
});

test("reload tool after a 409 keeps typed values and focuses the first field", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  fireEvent.change(await view().findByLabelText(/status/), { target: { value: done } });
  const calls = serve({ version: 2, input_schema: schema() });
  fireEvent.click(view().getByRole("button", { name: "add" }));
  const reload = await view().findByRole("button", { name: "reload tool" });
  reload.focus();
  fireEvent.click(reload);
  await waitFor(() => expect(calls.filter((call) => call.endsWith("/tools")).length).toBe(1));
  await act(async () => { await Promise.resolve(); });
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(done);
  expect(document.activeElement).toBe(view().getByLabelText(/status/));
  // The retry now carries the new version and succeeds.
  fireEvent.click(view().getByRole("button", { name: "add" }));
  expect(await view().findByText("added")).toBeTruthy();
});
