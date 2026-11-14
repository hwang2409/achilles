import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailRecordView, type DetailFilter } from "./DetailRecord";

const filter: DetailFilter = { field: "run_id", equals: "run-002" };
const base = { title: "annotation", collection: "annotations", fields: ["run_id", "verdict", "notes"], filter, error: null };

describe("DetailRecordView", () => {
  test("renders one, zero, and multiple matching records", () => {
    const one = renderToStaticMarkup(createElement(DetailRecordView, { ...base, records: [{ run_id: "run-002", verdict: "bad", notes: "" }], total: 1 }));
    expect(one).toContain("<dt>verdict</dt><dd>bad</dd>");
    expect(one).toContain("<dt>notes</dt><dd>—</dd>");
    expect(one).not.toContain("records match");

    const zero = renderToStaticMarkup(createElement(DetailRecordView, { ...base, records: [], total: 0 }));
    expect(zero).toContain("no annotations with run_id = run-002 yet");
    expect(zero).not.toContain('role="alert"');

    const many = renderToStaticMarkup(createElement(DetailRecordView, { ...base, records: [{ run_id: "run-002", verdict: "newest" }], total: 3 }));
    expect(many).toContain("<dt>verdict</dt><dd>newest</dd>");
    expect(many).toContain("3 records match");
  });
});
