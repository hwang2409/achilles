import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import React from "react";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import { LayoutBlock, RecordList } from "./App";
import { recordColumns, schemaColumns } from "./page/listColumns";
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
});
