import { expect, test } from "bun:test";
import { mergePage, modelKey, modelTrends } from "./aggregates";
import { formatLatency, formatPercent, formatTokens } from "./format";

const model = (provider: string | null, model: string, calls: number) => ({
  provider, model, calls, errors: 0, duration_ns: 0, p50_ns: 0, p95_ns: 0,
  input_tokens: 0, output_tokens: 0, total_tokens: 0, last_ns: 0,
});

test("a later cursor page updates overlaps without moving rows or collapsing equal names from different providers", () => {
  const first = model(null, "sample", 10);
  const second = model("example", "sample", 4);
  const last = model("example", "other", 2);
  const updated = { ...second, calls: 3 };
  expect(mergePage([first, second], { items: [updated, last], next_cursor: "opaque", as_of_ns: 100 }, modelKey)).toEqual({
    items: [first, updated, last], next_cursor: "opaque", as_of_ns: 100,
  });
});

test("the model trend retains UTC spacing and distinguishes an omitted model from a zero bucket", () => {
  const hour = 3.6e12;
  const point = { start_ns: hour, end_ns: hour * 2, model_calls: 4, errors: 1, total_tokens: 123, spans: 4,
    sessions: 1, traces: 1, tool_calls: 0, input_tokens: 100, output_tokens: 23, duration_ns: 100 };
  const trends = modelTrends([{ key: '[null,"\\u00e9"]', point }], { start_ns: 1, end_ns: hour * 2 + 1 }, "hour");
  const shown = trends.get(modelKey(model(null, "é", 4)));
  expect(shown?.map(({ start_ns, model_calls }) => [start_ns, model_calls])).toEqual([[0, 0], [hour, 4], [hour * 2, 0]]);
  const { errors, ...modelPoint } = point;
  expect(shown?.[1]).toEqual({ ...modelPoint, errored_model_calls: errors });
  expect(trends.has(modelKey(model("example", "é", 0)))).toBe(false);
});

test("aggregate metrics keep nanosecond units, sub-percent failure rates and token magnitude", () => {
  expect([formatLatency(40e6), formatLatency(0.9e9), formatLatency(94.2e9), formatLatency(492e9)]).toEqual(["40 ms", "0.9 s", "94.2 s", "8m 12s"]);
  expect([formatPercent(38, 6541), formatPercent(0, 6541), formatPercent(0, 0)]).toEqual(["0.6%", "0.0%", null]);
  expect([formatTokens(0), formatTokens(61_520), formatTokens(94_100_000)]).toEqual(["0", "62K", "94.1M"]);
});
