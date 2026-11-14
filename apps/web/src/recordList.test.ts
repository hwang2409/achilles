import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const render = (view: unknown, records: Record<string, unknown>[] | null, error: string | null = null) => view ? renderToStaticMarkup(createElement(view as never, { title: "reading", records, total: records?.length ?? 0, error })) : "";

describe("RecordListView", () => {
  test("distinguishes a held fetch, an empty result, and refresh with existing rows", async () => {
    const { RecordListView } = await import("./App");
    const loading = render(RecordListView, null);
    expect(loading).toContain("loading records…");
    expect(loading).not.toContain("no records yet");
    expect(loading).toContain('aria-busy="true"');

    expect(render(RecordListView, [])).toContain("no records yet");

    const refreshing = render(RecordListView, [{ record_id: "book-1", title: "The Dispossessed" }]);
    expect(refreshing).toContain("The Dispossessed");
    expect(refreshing).not.toContain("loading records…");
    expect(refreshing).not.toContain("no records yet");
  });
});
