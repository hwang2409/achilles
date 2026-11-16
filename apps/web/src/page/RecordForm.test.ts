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
const { FormBlock, selectRow } = await import("./RecordForm");

let mounted: ReturnType<typeof render> | null = null;
// Queries come from the render result: `screen` binds to the document that existed when testing-library was first imported, which another test file may do before any DOM.
const view = () => mounted as ReturnType<typeof render>;
afterEach(async () => {
  if (mounted) await act(async () => { mounted?.unmount(); });
  mounted = null;
  selectRow("books", null);
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

// An update tool on a scripted store: invoke checks the revision like the server and answers 409 at /revision when it is stale.
function serveUpdate(stored: Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const tool = { name: "edit_book", operation: "update", collection: "books", version: 1, input_schema: { type: "object", properties: { record_id: { type: "string" }, revision: { type: "integer" }, status: { enum: ["to read", "done"] }, title: { type: "string" } }, required: ["record_id", "revision"] } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/tools")) return Response.json({ tools: [tool] });
    if (url.includes("/records/")) return Response.json([stored]);
    const { arguments: args } = JSON.parse(String(init?.body)) as { arguments: Record<string, unknown> };
    sent.push(args);
    if (args.revision !== stored.revision) return Response.json({ error: { code: "conflict", path: "/revision", expected: "current record revision" } }, { status: 409 });
    Object.assign(stored, args, { revision: Number(stored.revision) + 1 });
    return Response.json({ ...stored });
  }) as typeof fetch;
  return sent;
}
const editBlock = () => createElement(FormBlock, { title: "edit book", toolName: "edit_book", pageId: "books", credential: "c", refreshKey: "0:0" });

test("a selected row fills the update form and its record_id and revision are sent, not shown", async () => {
  const stored = { record_id: "b1", revision: 3, status: "to read", title: "Dune" };
  const sent = serveUpdate(stored);
  mounted = render(editBlock());
  await view().findByText("select a row in the table to edit it");
  act(() => selectRow("books", { collection: "books", record: { ...stored } }));
  const status = await view().findByLabelText(/status/) as HTMLSelectElement;
  expect(status.value).toBe(JSON.stringify("to read"));
  expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune");
  expect(view().queryByLabelText(/record_id/)).toBeNull();
  expect(view().queryByLabelText(/revision/)).toBeNull();
  fireEvent.change(status, { target: { value: done } });
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText("saved")).toBeTruthy();
  expect(sent[0]).toEqual({ record_id: "b1", revision: 3, status: "done", title: "Dune" });
  // the saved row stays selected at its new revision, so a second save does not conflict with itself
  fireEvent.click(view().getByRole("button", { name: "save" }));
  await waitFor(() => expect(sent.length).toBe(2));
  expect(sent[1]?.revision).toBe(4);
  expect(view().queryByText(/changed since you selected it/)).toBeNull();
});

test("a 409 for a row changed from chat keeps typed values; reload row keeps them over the new row", async () => {
  const stored = { record_id: "b1", revision: 3, status: "to read", title: "Dune" };
  const sent = serveUpdate(stored);
  mounted = render(editBlock());
  await view().findByText("select a row in the table to edit it");
  act(() => selectRow("books", { collection: "books", record: { ...stored } }));
  fireEvent.change(await view().findByLabelText(/status/), { target: { value: done } });
  // chat renames the book first
  Object.assign(stored, { title: "Dune Messiah", revision: 4 });
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText(/changed since you selected it/)).toBeTruthy();
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(done);
  fireEvent.click(view().getByRole("button", { name: "reload row" }));
  await waitFor(() => expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune Messiah"));
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(done);
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText("saved")).toBeTruthy();
  expect(sent.at(-1)).toEqual({ record_id: "b1", revision: 4, status: "done", title: "Dune Messiah" });
});

// The page as the user sees it: the records table and the edit form for the same collection.
const { RecordList } = await import("../App");
const editPage = (listKey: string) => createElement("div", null,
  createElement(RecordList, { title: "books", collection: "books", pageId: "books", credential: "c", refreshKey: listKey, columns: ["title", "status"] }),
  editBlock());
const pickRow = async (title: string) => fireEvent.click((await view().findByText(title)).closest("tr") as HTMLElement);

test("an agent write to the selected record updates a clean form at once, and a save uses the new revision", async () => {
  const stored = { record_id: "b1", revision: 3, status: "to read", title: "Dune" };
  const sent = serveUpdate(stored);
  mounted = render(editPage("0:0"));
  await pickRow("Dune");
  expect((await view().findByLabelText(/title/) as HTMLInputElement).value).toBe("Dune");
  // the agent renames the book; the chat turn end reloads the table
  Object.assign(stored, { title: "Dune Messiah", revision: 4 });
  await act(async () => { mounted?.rerender(editPage("0:1")); });
  await waitFor(() => expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune Messiah"));
  expect(view().queryByRole("button", { name: "discard" })).toBeNull();
  fireEvent.change(view().getByLabelText(/status/), { target: { value: done } });
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText("saved")).toBeTruthy();
  expect(sent.at(-1)).toEqual({ record_id: "b1", revision: 4, status: "done", title: "Dune Messiah" });
});

test("an agent write while the form has edits keeps them, says so, and discard loads the new values", async () => {
  const stored = { record_id: "b1", revision: 3, status: "to read", title: "Dune" };
  serveUpdate(stored);
  mounted = render(editPage("0:0"));
  await pickRow("Dune");
  fireEvent.change(await view().findByLabelText(/status/), { target: { value: done } });
  Object.assign(stored, { status: "to read", title: "Dune Messiah", revision: 4 });
  await act(async () => { mounted?.rerender(editPage("0:1")); });
  expect(await view().findByText(/this record changed; your edits are kept/)).toBeTruthy();
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(done);
  fireEvent.click(view().getByRole("button", { name: "discard" }));
  expect((view().getByLabelText(/status/) as HTMLSelectElement).value).toBe(JSON.stringify("to read"));
  expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune Messiah");
  expect(view().queryByText(/this record changed/)).toBeNull();
});
