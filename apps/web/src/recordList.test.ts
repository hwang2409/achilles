import "./test-dom";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import React from "react";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { LayoutBlock, PageView, RecordList, RecordListView } from "./page/PageView";
import { extendWithRecordKeys, recordColumns, schemaColumns } from "./page/listColumns";
import type { PageTool } from "./page/usePageTools";

const originalFetch = globalThis.fetch;


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

afterEach(cleanup);

afterAll(() => {
  globalThis.fetch = originalFetch;
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


test("record list reveal projection keeps loaded rows and one reachable tab stop", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ record_id: `book-${index + 1}`, title: `book ${index + 1}` }));
  const cases = [
    { name: "collapsed", total: 8, expanded: false, expectedRows: 5, expectedAction: "show 3 more", expectedCount: "5 of 8" },
    { name: "expanded", total: 8, expanded: true, initialAction: "show 3 more", expectedRows: 8, expectedAction: "show less", expectedCount: "8 of 8" },
    { name: "loaded less than server total", total: 1000, expanded: false, records: Array.from({ length: 100 }, (_, index) => ({ record_id: `loaded-${index}`, title: `loaded ${index}` })), expectedRows: 5, expectedAction: "show 95 more", expectedCount: "5 of 1000" },
    { name: "expanded loaded less than server total", total: 1000, expanded: true, initialAction: "show 95 more", records: Array.from({ length: 100 }, (_, index) => ({ record_id: `loaded-${index}`, title: `loaded ${index}` })), expectedRows: 100, expectedAction: "show less", expectedCount: "100 of 1000" },
  ];
  for (const scenario of cases) {
    const result = render(React.createElement(RecordListView, { title: "reading", collection: "books", records: scenario.records ?? rows, columns: ["title"], total: scenario.total, error: null, selectedId: undefined, onSelect: () => {} }));
    if (scenario.expanded) fireEvent.click(result.getByRole("button", { name: scenario.initialAction }));
    expect(result.getAllByRole("row")).toHaveLength(scenario.expectedRows + 1);
    expect(result.getByRole("button").textContent).toBe(scenario.expectedAction);
    expect(result.getByText(scenario.expectedCount)).toBeTruthy();
    if (scenario.name === "collapsed") {
      fireEvent.click(result.getByRole("button", { name: "show 3 more" }));
      fireEvent.focus(result.getAllByRole("row")[6]);
      fireEvent.click(result.getByRole("button", { name: "show less" }));
      const visibleTabStops = result.getAllByRole("row").slice(1).filter((row) => row.getAttribute("tabindex") === "0");
      expect(visibleTabStops).toHaveLength(1);
      expect(visibleTabStops[0]?.getAttribute("data-record-id")).toBe("book-1");
      expect(result.getByRole("button").textContent).toBe("show 3 more");
    }
    cleanup();
  }
});

test("long page metric values stay readable without breaking digit groups", () => {
  const fullValue = "9,999,999,999,999,999";
  const page = { title: "page", route: "/page", layout: { blocks: [{ type: "metric", label: "legacy total", value: fullValue }] } };
  const result = render(React.createElement(PageView, { page, pageId: "metric-wrap", credential: "secret", refreshKey: "0" }));
  const value = result.container.querySelector(".metric-value")!;
  expect(value.classList.contains("metric-value-long")).toBe(false);
  expect(value.textContent).toBe("10,000T");
  expect(value.getAttribute("title")).toBe(fullValue);
  expect(value.getAttribute("aria-label")).toBe(`legacy total: ${fullValue}`);
});

test("page metrics render a live static layout value", () => {
  const page = { title: "page", route: "/page", layout: { blocks: [{ type: "metric", label: "score", value: "1" }] } };
  const result = render(React.createElement(PageView, { page, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(result.getByText("1")).toBeTruthy();
  result.rerender(React.createElement(PageView, { page: { ...page, active_layout_version: 2, layout: { blocks: [{ type: "metric", label: "score", value: "2" }] } }, pageId: "metric-page", credential: "secret", refreshKey: "0" }));
  expect(result.getByText("2")).toBeTruthy();
});

test("page-owned metric counts keep unchanged values across layout lifecycles", async () => {
  const metric = (label: string) => ({ type: "metric", label, count: true, collection: `books-${label}` });
  const value = (result: RenderResult, label: string) => [...result.container.querySelectorAll(".metric-label")].find((node) => node.textContent === label)?.closest(".metric-block")?.querySelector(".metric-value")?.textContent;
  const cases = [
    { name: "prepend", initial: [metric("one"), metric("two")], next: [metric("new"), metric("one"), metric("two")], extra: 1 },
    { name: "remove settled", initial: [metric("one"), metric("two")], next: [metric("one")], extra: 0 },
    { name: "remove and re-add in flight", initial: [metric("one"), metric("two")], next: [metric("one")], readd: [metric("one"), metric("two")] },
    { name: "lone metric gains a neighbour", initial: [metric("one")], next: [metric("one"), metric("two")], extra: 1 },
    { name: "strip inserted above", initial: [metric("one"), metric("two")], next: [metric("new"), { type: "list", title: "books", collection: "books", fields: ["title"] }, metric("one"), metric("two")], extra: 2 },
    { name: "list inserted between metrics", initial: [metric("one"), metric("two")], next: [metric("one"), { type: "list", title: "books", collection: "books", fields: ["title"] }, metric("two")], extra: 1 },
    { name: "append metric", initial: [metric("one"), metric("two")], next: [metric("one"), metric("two"), metric("new")], extra: 1 },
    { name: "replace removed metric", initial: [metric("one"), metric("two")], next: [metric("one"), metric("new")], extra: 1 },
  ];
  for (const scenario of cases) {
    holdFetches();
    const page = { title: scenario.name, route: "/page", layout: { blocks: scenario.initial } };
    const result = render(React.createElement(PageView, { page, pageId: `metric-${scenario.name}`, credential: "secret", refreshKey: "0" }));
    const initialCount = scenario.initial.filter((block) => block.type === "metric").length;
    expect(calls).toHaveLength(initialCount);
    for (let index = 0; index < initialCount; index++) {
      if (scenario.readd && index === 1) continue;
      await settle(calls[index], [{ record_id: `${index}-one` }, ...(index ? [{ record_id: `${index}-two` }] : [])]);
    }
    expect(value(result, "one")).toBe("1");
    if (scenario.initial.length > 1 && !scenario.readd) expect(value(result, "two")).toBe("2");
    result.rerender(React.createElement(PageView, { page: { ...page, layout: { blocks: scenario.next } }, pageId: `metric-${scenario.name}`, credential: "secret", refreshKey: "0" }));
    if (scenario.readd) {
      expect(calls).toHaveLength(initialCount);
      result.rerender(React.createElement(PageView, { page: { ...page, layout: { blocks: scenario.readd } }, pageId: `metric-${scenario.name}`, credential: "secret", refreshKey: "0" }));
      expect(calls).toHaveLength(initialCount + 1);
      await settle(calls[initialCount], [{ record_id: "new-value" }, { record_id: "new-value-2" }]);
      expect(value(result, "two")).toBe("2");
      await settle(calls[1], [{ record_id: "stale" }]);
      expect(value(result, "two")).toBe("2");
    } else {
      expect(calls).toHaveLength(initialCount + scenario.extra!);
      for (const call of calls.slice(initialCount)) await settle(call, [{ record_id: "new" }]);
    }
    expect(value(result, "one")).toBe("1");
    if (scenario.next.some((block) => block.type === "metric" && block.label === "two")) expect(value(result, "two"), scenario.name).toBe(scenario.initial.some((block) => block.type === "metric" && block.label === "two") ? "2" : "1");
    expect(value(result, "one")).not.toBe("…");
    if (scenario.next.some((block) => block.type === "metric" && block.label === "two")) expect(value(result, "two")).not.toBe("…");
  }
});

test("page-owned counts refresh for a new generation", async () => {
  holdFetches();
  const metric = { type: "metric", label: "total", count: true, collection: "books" };
  const page = { title: "page", route: "/page", layout: { blocks: [metric] } };
  const result = render(React.createElement(PageView, { page, pageId: "metric-refresh", credential: "secret", refreshKey: "0" }));
  await settle(calls[0], [{ record_id: "one" }]);
  expect(result.getByText("1")).toBeTruthy();
  result.rerender(React.createElement(PageView, { page, pageId: "metric-refresh", credential: "secret", refreshKey: "0:1" }));
  expect(calls).toHaveLength(2);
  await settle(calls[1], [{ record_id: "one" }, { record_id: "two" }]);
  expect(result.getByText("2")).toBeTruthy();
});

test("keyboard and click selection update the row and detail without auto-scroll", async () => {
  holdFetches();
  const page = { title: "reading", route: "/reading", layout: { blocks: [
    { type: "list", title: "books", collection: "books", fields: ["title", "status"] },
    { type: "detail", title: "selected book", collection: "books", fields: ["title"], filter: { field: "status", equals: "reading" } },
  ] } };
  const result = render(React.createElement(PageView, { page, pageId: "selection-page", credential: "secret", refreshKey: "0" }));
  const scrollIntoView = HTMLElement.prototype.scrollIntoView;
  let scrolls = 0;
  HTMLElement.prototype.scrollIntoView = () => { scrolls += 1; };
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
  expect(scrolls).toBe(0);
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});
