import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LayoutBlock, RecordList } from "./App";

type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };

type RecordListProps = {
  title: string;
  collection: string;
  pageId: string;
  credential: string;
  refreshKey: string;
};

const originalFetch = globalThis.fetch;
const props: RecordListProps = { title: "reading", collection: "books", pageId: "page-one", credential: "secret", refreshKey: "0:0" };
let calls: Deferred[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

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

function text(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

async function render(listProps: RecordListProps, key = `${listProps.pageId}:${listProps.collection}`) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(RecordList, { key, ...listProps })); });
  return renderer;
}

describe("RecordList", () => {
  test("shows loading instead of empty while the first fetch is held", async () => {
    holdFetches();
    const renderer = await render(props);
    try {
      expect(text(renderer)).toContain("loading records…");
      expect(text(renderer)).not.toContain("no records yet");
      await settle(calls[0], []);
      expect(text(renderer)).toContain("no records yet");
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  test("resets rows when the layout page identity changes", async () => {
    holdFetches();
    const block = { type: "list", title: props.title, collection: props.collection };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(LayoutBlock, { block, pageId: props.pageId, credential: props.credential, refreshKey: props.refreshKey })); });
    try {
      await settle(calls[0], [{ record_id: "book-1", title: "The Dispossessed" }]);

      await act(async () => renderer.update(React.createElement(LayoutBlock, { block, pageId: "page-two", credential: props.credential, refreshKey: props.refreshKey })));
      expect(text(renderer)).toContain("loading records…");
      expect(text(renderer)).not.toContain("The Dispossessed");
    } finally {
      await act(async () => renderer.unmount());
    }
  });

  test("keeps rows on refresh and ignores stale responses", async () => {
    holdFetches();
    const renderer = await render(props);
    try {
      await settle(calls[0], []);
      expect(text(renderer)).toContain("no records yet");

      await act(async () => renderer.update(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:1" })));
      await settle(calls[1], [{ record_id: "book-1", title: "The Dispossessed" }]);
      expect(text(renderer)).toContain("The Dispossessed");

      await act(async () => renderer.update(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:2" })));
      expect(text(renderer)).toContain("The Dispossessed");
      expect(text(renderer)).not.toContain("loading records…");

      await act(async () => renderer.update(React.createElement(RecordList, { key: "page-one:books", ...props, refreshKey: "0:3" })));
      await settle(calls[3], [{ record_id: "book-2", title: "A Wizard of Earthsea" }]);
      await settle(calls[2], [{ record_id: "stale", title: "Old row" }]);
      expect(text(renderer)).toContain("A Wizard of Earthsea");
      expect(text(renderer)).not.toContain("Old row");
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
