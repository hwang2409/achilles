import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import React from "react";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { LayoutBlock, PageView, RecordList } from "./App";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./page/listColumns";
import type { PageTool } from "./page/usePageTools";

const originalFetch = globalThis.fetch;

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };

type RecordListProps = {
  title: string;
  collection: string;
  pageId: string;
  credential: string;
  refreshKey: string;
};

const props: RecordListProps = { title: "reading", collection: "books", pageId: "page-one", credential: "secret", refreshKey: "0:0" };
let calls: Deferred[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(cleanup);

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>((done) => { resolve = done; }), resolve };
}

function response(records: Record<string, unknown>[]) {
  return new Response(JSON.stringify(records), { headers: { "content-type": "application/json", "x-achilles-total": String(records.length) } });
}

function holdFetches() {
  calls = [];
  globalThis.fetch = (() => {
    const call = deferred();
    calls.push(call);
    return call.promise;
  }) as typeof fetch;
}

async function settle(call: Deferred, records: Record<string, unknown>[]) {
  await act(async () => call.resolve(response(records)));
}

function text(result: RenderResult) {
  return result.container.textContent ?? "";
}

function renderList(listProps: RecordListProps, key = `${listProps.pageId}:${listProps.collection}`) {
  return render(React.createElement(RecordList, { key, ...listProps }));
}

describe("RecordList", () => {
  test("shows loading instead of empty while the first fetch is held", async () => {
    holdFetches();
    const result = renderList(props);
    expect(text(result)).toContain("loading records…");
    expect(text(result)).not.toContain("no records yet");
    await settle(calls[0], []);
    expect(text(result)).toContain("no records yet");
  });

  test("resets rows when the layout page identity changes", async () => {
    holdFetches();
    const block = { type: "list", title: props.title, collection: props.collection };
    const result = render(React.createElement(LayoutBlock, { block, pageId: props.pageId, credential: props.credential, refreshKey: props.refreshKey }));
    await settle(calls[0], [{ record_id: "book-1", title: "The Dispossessed" }]);

    result.rerender(React.createElement(LayoutBlock, { block, pageId: "page-two", credential: props.credential, refreshKey: props.refreshKey }));
    expect(text(result)).toContain("loading records…");
    expect(text(result)).not.toContain("The Dispossessed");
  });

  test("keeps rows on refresh and ignores stale responses", async () => {
    holdFetches();
    const result = renderList(props);
    await settle(calls[0], []);
    expect(text(result)).toContain("no records yet");

    result.rerender(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:1" }));
    await settle(calls[1], [{ record_id: "book-1", title: "The Dispossessed" }]);
    expect(text(result)).toContain("The Dispossessed");

    result.rerender(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:2" }));
    expect(text(result)).toContain("The Dispossessed");
    expect(text(result)).not.toContain("loading records…");

    result.rerender(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:3" }));
    await settle(calls[3], [{ record_id: "book-2", title: "A Wizard of Earthsea" }]);
    await settle(calls[2], [{ record_id: "stale", title: "Old row" }]);
    expect(text(result)).toContain("A Wizard of Earthsea");
    expect(text(result)).not.toContain("Old row");
  });

  test("a list block with a filter asks the server for matching records only", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return response([{ record_id: "c-1", name: "Synthetic Ada", group: "work" }]);
    }) as typeof fetch;
    const block = { type: "list", title: "work", collection: "contacts", fields: ["name", "group"], filter: { field: "group", equals: "work" } };
    const result = render(React.createElement(LayoutBlock, { block, pageId: "page-filter", credential: "secret", refreshKey: "0:0" }));
    await act(async () => {});
    const query = new URL(urls[0], "http://x").searchParams;
    expect([query.get("field"), query.get("equals"), query.get("limit")]).toEqual(["group", '"work"', "100"]);
    expect(text(result)).toContain("Synthetic Ada");
  });
});

function headers(result: RenderResult) {
  return [...result.container.querySelectorAll("th")].map((cell) => cell.textContent);
}

function routeFetches(tools: Partial<PageTool>[], records: Record<string, unknown>[]) {
  globalThis.fetch = (async (url: string) => String(url).endsWith("/tools")
    ? new Response(JSON.stringify({ tools }), { headers: { "content-type": "application/json" } })
    : response(records)) as typeof fetch;
}

// stored records come back with sorted keys, newest first
const books = [
  { pages: 300, record_id: "b2", revision: 1, status: "done", title: "Earthsea" },
  { author: "Le Guin", pages: 200, record_id: "b1", revision: 1, status: "to read", title: "The Dispossessed" },
];
const bookSchema = { type: "object", properties: { author: { type: "string" }, pages: { type: "integer" }, status: { type: "string" }, title: { type: "string" } }, required: ["title", "status"] };
// omits "author", which the books records have: this forces the render through extendColumns, not just through the schema.
const bookSchemaWithoutAuthor = { type: "object", properties: { pages: { type: "integer" }, status: { type: "string" }, title: { type: "string" } }, required: ["title", "status"] };

describe("list columns", () => {
  test("a list block with fields shows exactly those columns in that order", async () => {
    routeFetches([], books);
    const block = { type: "list", title: "reading", collection: "books", fields: ["title", "status"] };
    const result = render(React.createElement(LayoutBlock, { block, pageId: "page-one", credential: "secret", refreshKey: "0:0" }));
    await act(async () => {});
    expect(headers(result)).toEqual(["title", "status"]);
    expect(text(result)).not.toContain("b1");
  });

  test("without fields, the data schema's required fields lead, the rest are sorted, and record_id is hidden", async () => {
    routeFetches([{ name: "add_book", collection: "books", data_schema: bookSchema }, { name: "add_film", collection: "films", data_schema: { type: "object", properties: { director: {} } } }], books);
    const block = { type: "list", title: "reading", collection: "books" };
    const result = render(React.createElement(LayoutBlock, { block, pageId: "page-two", credential: "secret", refreshKey: "0:0" }));
    await act(async () => {});
    expect(headers(result)).toEqual(["title", "status", "author", "pages"]);
  });

  test("the order does not depend on which record is newest", () => {
    expect(recordColumns(books)).toEqual(recordColumns([...books].reverse()));
    expect(recordColumns(books)).toEqual(["author", "pages", "status", "title"]);
    expect(schemaColumns([], "books")).toEqual([]);
  });

  // a partial data_schema, or an input added after the schema was written, must not hide data the
  // record actually has: on main this column showed; the schema-only route silently hid it.
  test("a record key the data schema does not name still shows, after the schema's own columns, sorted", () => {
    const partialSchema = schemaColumns([{ name: "add_note", operation: "insert", collection: "notes", input_schema: {}, version: 1, data_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }], "notes");
    const notes = [{ record_id: "n1", revision: 1, title: "Partial schema", status: "draft" }];
    expect(extendWithRecordKeys(partialSchema, notes)).toEqual(["title", "status"]);
  });

  test("fields: [] behaves like no fields: schema order, then extra record keys, sorted", async () => {
    routeFetches([{ name: "add_book", collection: "books", data_schema: bookSchemaWithoutAuthor }], books);
    const block = { type: "list", title: "reading", collection: "books", fields: [] };
    const result = render(React.createElement(LayoutBlock, { block, pageId: "page-empty-fields", credential: "secret", refreshKey: "0:0" }));
    await act(async () => {});
    expect(headers(result)).toEqual(["title", "status", "pages", "author"]);
  });
});


test("page metrics render a live static layout value", () => {
  const page = { title: "page", route: "/page", layout: { blocks: [{ type: "metric", label: "score", value: "1" }] } };
  const result = render(React.createElement(PageView, { page, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(result.getByText("1")).toBeTruthy();
  result.rerender(React.createElement(PageView, { page: { ...page, active_layout_version: 2, layout: { blocks: [{ type: "metric", label: "score", value: "2" }] } }, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(result.getByText("2")).toBeTruthy();
});

test("page-owned metric counts survive layout edits and refresh after writes", async () => {
  holdFetches();
  const metric = (label: string) => ({ type: "metric", label, count: true, collection: `books-${label}` });
  const page = { title: "page", route: "/page", layout: { blocks: [metric("one"), metric("two")] } };
  const result = render(React.createElement(PageView, { page, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(calls).toHaveLength(2);
  await settle(calls[0], []);
  await settle(calls[1], [{ record_id: "book-1" }]);
  expect(text(result)).toContain("0");
  expect(text(result)).toContain("1");
  result.rerender(React.createElement(PageView, { page: { ...page, layout: { blocks: [metric("new"), metric("one"), metric("two")] } }, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(calls).toHaveLength(3);
  await settle(calls[2], [{ record_id: "book-2" }, { record_id: "book-3" }]);
  expect(text(result)).toContain("2");
  result.rerender(React.createElement(PageView, { page: { ...page, layout: { blocks: [metric("one"), metric("two")] } }, pageId: "metric-page", credential: "secret", refreshKey: "0:1" }));
  expect(calls).toHaveLength(5);
  await settle(calls[3], [{ record_id: "book-4" }]);
  await settle(calls[4], [{ record_id: "book-5" }]);
  expect(text(result)).toContain("1");
});

test("keyboard and click selection update the row and detail", async () => {
  holdFetches();
  const page = { title: "reading", route: "/reading", layout: { blocks: [
    { type: "list", title: "books", collection: "books", fields: ["title", "status"] },
    { type: "detail", title: "selected book", collection: "books", fields: ["title"], filter: { field: "status", equals: "reading" } },
  ] } };
  const result = render(React.createElement(PageView, { page, pageId: "selection-page", credential: "secret", refreshKey: "0" }));
  const first = { record_id: "book-1", title: "first book", status: "reading" };
  const second = { record_id: "book-2", title: "second book", status: "reading" };
  await settle(calls[0], [first, second]);
  await settle(calls[1], [first]);
  const rows = result.getAllByRole("row");
  await act(async () => {
    rows[1].focus();
    fireEvent.keyDown(rows[1], { key: "Enter" });
  });
  expect(rows[1].getAttribute("aria-selected")).toBe("true");
  expect(result.getAllByText("first book").length).toBeGreaterThan(1);
  await act(async () => fireEvent.click(rows[2]));
  expect(rows[2].getAttribute("aria-selected")).toBe("true");
  expect(result.getAllByText("second book").length).toBeGreaterThan(1);
});
