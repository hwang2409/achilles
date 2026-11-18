import "../test-dom";
import { afterEach, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;

const { act, createElement, useState } = await import("react");
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { FormBlock, selectRow } = await import("./RecordForm");
const { EnumListbox } = await import("./EnumListbox");

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

const block = (refreshKey: string, canWrite = true) => createElement(FormBlock, { title: "add book", toolName: "add_book", pageId: "books", credential: "c", refreshKey, canWrite, disabledReason: "this tab is read-only; take control to make changes" });
const done = JSON.stringify("done");
const statusButton = () => view().getByRole("button", { name: /status/ });
const chooseStatus = async (value: string) => { const button = await view().findByRole("button", { name: /status/ }); fireEvent.click(button); fireEvent.click(view().getByRole("option", { name: value })); };

test("read-only insert shows the shared reason and never invokes the tool", async () => {
  const calls = serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0", false));
  await view().findByText("this tab is read-only; take control to make changes");
  expect((view().getByRole("button", { name: "add" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.includes("/invoke"))).toBe(false);
});

test("a chat turn end (refreshKey change) keeps typed values and the same inputs", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  const status = await view().findByRole("button", { name: /status/ });
  expect(status.getAttribute("name")).toBe("status");
  await chooseStatus("done");
  // The tool gains a field during the turn; the form takes the new schema in place.
  serve({ version: 2, input_schema: schema({ rating: { type: "number" } }) });
  await act(async () => { mounted?.rerender(block("1:0")); });
  await view().findByLabelText(/rating/);
  expect(statusButton().textContent).toContain("done");
  expect(statusButton()).toBe(status);
});

test("reload tool after a 409 keeps typed values and focuses the first field", async () => {
  serve({ version: 1, input_schema: schema() });
  mounted = render(block("0:0"));
  await chooseStatus("done");
  const calls = serve({ version: 2, input_schema: schema() });
  fireEvent.click(view().getByRole("button", { name: "add" }));
  const reload = await view().findByRole("button", { name: "reload tool" });
  reload.focus();
  fireEvent.click(reload);
  await waitFor(() => expect(calls.filter((call) => call.endsWith("/tools")).length).toBe(1));
  await act(async () => { await Promise.resolve(); });
  expect(statusButton().textContent).toContain("done");
  expect(document.activeElement).toBe(statusButton());
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
  await view().findByText("select a book in the list to edit it");
  expect((view().getByRole("button", { name: "add" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view().getByLabelText(/title/) as HTMLInputElement).disabled).toBe(true);
  expect((view().getByLabelText(/title/) as HTMLInputElement).placeholder).toBe("—");
  act(() => selectRow("books", { collection: "books", record: { ...stored } }));
  const status = await view().findByRole("button", { name: /status/ });
  expect(status.textContent).toContain("to read");
  expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune");
  expect(view().queryByLabelText(/record_id/)).toBeNull();
  expect(view().queryByLabelText(/revision/)).toBeNull();
  await chooseStatus("done");
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
  await view().findByText("select a book in the list to edit it");
  act(() => selectRow("books", { collection: "books", record: { ...stored } }));
  await chooseStatus("done");
  // chat renames the book first
  Object.assign(stored, { title: "Dune Messiah", revision: 4 });
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText(/changed since you selected it/)).toBeTruthy();
  expect(statusButton().textContent).toContain("done");
  fireEvent.click(view().getByRole("button", { name: "reload row" }));
  await waitFor(() => expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune Messiah"));
  expect(statusButton().textContent).toContain("done");
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
  await chooseStatus("done");
  fireEvent.click(view().getByRole("button", { name: "save" }));
  expect(await view().findByText("saved")).toBeTruthy();
  expect(sent.at(-1)).toEqual({ record_id: "b1", revision: 4, status: "done", title: "Dune Messiah" });
});

test("an agent write while the form has edits keeps them, says so, and discard loads the new values", async () => {
  const stored = { record_id: "b1", revision: 3, status: "to read", title: "Dune" };
  serveUpdate(stored);
  mounted = render(editPage("0:0"));
  await pickRow("Dune");
  await chooseStatus("done");
  Object.assign(stored, { status: "to read", title: "Dune Messiah", revision: 4 });
  await act(async () => { mounted?.rerender(editPage("0:1")); });
  expect(await view().findByText("this record changed (title); your edits are kept — review and save, or discard")).toBeTruthy();
  expect(statusButton().textContent).toContain("done");
  fireEvent.click(view().getByRole("button", { name: "discard" }));
  expect(statusButton().textContent).toContain("to read");
  expect((view().getByLabelText(/title/) as HTMLInputElement).value).toBe("Dune Messiah");
  expect(view().queryByText(/this record changed/)).toBeNull();
});

// EnumListbox interaction stays in this suite because page-form tests own the process-global Happy DOM.
const enumOptions = ["food", "fiction", "music", "travel"] as const;
const enumHarness = () => {
  const [value, setValue] = useState("music");
  return createElement(EnumListbox, { value, options: enumOptions, onChange: setValue, label: "kind" });
};
const enumButton = () => view().getByRole("button", { name: "kind" });
const enumMenu = () => view().getByRole("listbox");
const openEnum = async (key = "Enter") => { fireEvent.keyDown(enumButton(), { key }); await act(async () => Promise.resolve()); };

test("enum listbox opens, navigates, type-aheads, and selects through its public interface", async () => {
  mounted = render(createElement(enumHarness));
  await openEnum();
  expect(enumButton().getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(enumMenu(), { key: "ArrowDown" });
  fireEvent.keyDown(enumMenu(), { key: "ArrowDown" });
  fireEvent.keyDown(enumMenu(), { key: "Home" });
  expect(enumMenu().getAttribute("aria-activedescendant")).toContain("option-0");
  fireEvent.keyDown(enumMenu(), { key: "End" });
  expect(enumMenu().getAttribute("aria-activedescendant")).toContain("option-3");
  fireEvent.keyDown(enumMenu(), { key: "f" });
  fireEvent.keyDown(enumMenu(), { key: "o" });
  expect(enumButton().textContent).toContain("jump fo");
  expect(enumMenu().getAttribute("aria-activedescendant")).toContain("option-0");
  expect(enumMenu().querySelector('[aria-selected="false"] u')?.textContent).toBe("fo");
  fireEvent.keyDown(enumMenu(), { key: "Enter" });
  expect(enumButton().textContent).toContain("food");
  expect(enumButton().getAttribute("aria-expanded")).toBe("false");
});

test("enum listbox escape cancels and returns focus, while selected semantics stay explicit", async () => {
  mounted = render(createElement(enumHarness));
  await openEnum("ArrowUp");
  expect(enumMenu().getAttribute("aria-activedescendant")).toContain("option-3");
  fireEvent.keyDown(enumMenu(), { key: "Escape" });
  expect(enumButton().textContent).toContain("music");
  expect(document.activeElement).toBe(enumButton());
  fireEvent.click(enumButton());
  expect(view().getByRole("option", { name: "music" }).getAttribute("aria-selected")).toBe("true");
});
