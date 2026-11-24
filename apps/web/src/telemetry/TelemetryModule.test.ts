import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { TelemetryModule } from "./TelemetryModule";

afterEach(cleanup);

test("a connected zeta whose hello did not grant telemetry_read_v1 shows the update notice, not connecting", () => {
  let requests = 0;
  const client = { features: ["delivery_id", "served_turn_end"], request: async () => { requests++; return {}; } } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: "/telemetry" }));
  expect(view.container.querySelector("[data-telemetry-unavailable] [role=status]")?.textContent).toBe("telemetry · needs a newer zeta");
  expect(view.queryByText(/connecting/i)).toBeNull();
  expect(requests).toBe(0);
});

const point = { start_ns: 0, end_ns: 1, sessions: 2, traces: 0, spans: 0, errors: 0, model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, duration_ns: 0 };
const status = { enabled: true, receiver: "ready", endpoint: "builtin", last_export: "ok", last_export_ns: null, raw_days: 14, rollup_days: 90, max_bytes: 1, used_bytes: 0, oldest_raw_ns: null, oldest_rollup_ns: null };
const session = (id: string) => ({ session_id: id, first_ns: 0, last_ns: 1, last_trace_id: "t", profile: "worker", model: "m", span_count: 1, turn_count: 1, model_count: 1, tool_count: 0, error_count: 0, input_tokens: 1, output_tokens: 1, total_tokens: 2 });

test.each([
  ["uses all spans, not just model calls", { spans: 12, errors: 9, model_calls: 1 }, "75%"],
  ["reaches 100% when all spans error and there are no model calls", { spans: 3, errors: 3, model_calls: 0 }, "100%"],
] as const)("overview error rate %s", async (_name, totals, rate) => {
  const client = {
    features: ["telemetry_read_v1"],
    request: async () => ({ status, totals: { ...point, ...totals }, series: [], active_models: 0, active_tools: 0, next_cursor: null }),
  } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: "/telemetry" }));
  await view.findByRole("heading", { name: "telemetry overview" });
  expect(view.container.querySelector("[data-telemetry-metric=errors] [data-metric-detail]")?.firstChild?.textContent).toBe(rate);
  expect(view.container.querySelector("[data-telemetry-metric=errors] [data-metric-detail-label]")?.textContent).toBe(" errored spans / all spans");
});

const failedTools = { ...point, spans: 12, errors: 9, tool_calls: 9, model_calls: 1 };
const call = { calls: 1, errors: 9, duration_ns: 0, p50_ns: 0, p95_ns: 0, last_ns: 0 };
const model = { ...call, model: "sample", provider: null, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
const tool = { ...call, tool_name: "sample", tool_type: null, argument_bytes: 0, result_bytes: 0 };
const modelBucket = { ...point, spans: 1, model_calls: 1 };
const currentHour = Math.floor(Date.now() / 3.6e6) * 3.6e12;

test.each([
  { name: "overview metric", path: "", heading: "telemetry overview", selector: "[data-telemetry-metric=errors] [data-metric-detail]", expected: "75% errored spans / all spans" },
  { name: "overview chart", path: "", heading: "telemetry overview", selector: "[data-chart-errors]", style: "height", expected: null },
  { name: "models row", path: "/models", heading: "models", selector: "[data-selected=true] td:nth-child(4)", expected: "errors 9 · 100%" },
  { name: "tools row", path: "/tools", heading: "tools", selector: "[data-failure-rate]", expected: "100%" },
  { name: "tools meter uses bounded shares on both sides of its scale", path: "/tools", heading: "tools", selector: "tbody tr:last-child [data-aggregate-meter] i", style: "width", expected: "50%" },
  { name: "per-model chart ignores the overview tool errors", path: "/models", heading: "models", selector: "[data-chart-errors]", style: "height", expected: null },
  { name: "per-model chart caps its own errors", path: "/models", heading: "models", selector: "[data-chart-errors]", style: "height", expected: "100%", modelErrors: 9 },
  { name: "per-model chart shows its own errors", path: "/models", heading: "models", selector: "[data-chart-errors]", style: "height", expected: "50%", modelErrors: 1, modelCalls: 2 },
])("bounded error share: $name", async ({ path, heading, selector, style, expected, modelErrors = 0, modelCalls = 1 }) => {
  const client = {
    features: ["telemetry_read_v1"],
    request: async (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case "telemetry_overview": return { status, totals: failedTools, series: [failedTools], active_models: 1, active_tools: 2, next_cursor: null };
        case "telemetry_models": return { items: [model], next_cursor: null };
        case "telemetry_tools": return { items: [tool, { ...tool, tool_name: "other", calls: 2, errors: 1 }], next_cursor: null };
        case "telemetry_series": return {
          points: params.group_by === "model" ? [{ key: '[null,"sample"]', point: { ...modelBucket, spans: modelCalls, model_calls: modelCalls, start_ns: currentHour, end_ns: currentHour + 3.6e12, errors: modelErrors } }] : [],
          next_cursor: null,
        };
        default: throw new Error(`unexpected method: ${method}`);
      }
    },
  } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: `/telemetry${path}` }));
  await view.findByRole("heading", { name: heading, exact: true });
  const element = view.container.querySelector<HTMLElement>(selector);
  expect((style ? element?.style.getPropertyValue(style) : element?.textContent) ?? null).toBe(expected);
});

test("a filter change turns paging off until its first page arrives, so the old page's cursor never goes out with the new filter", async () => {
  const sessions: Record<string, unknown>[] = [];
  let releaseFiltered = () => {};
  const client = {
    features: ["telemetry_read_v1"],
    protocolVersion: "1",
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "telemetry_overview") return { status, totals: point, series: [], active_models: 0, active_tools: 0, next_cursor: null };
      sessions.push(params);
      const page = { items: [session(`s${sessions.length}`)], next_cursor: "c1", as_of_ns: 1 };
      if (params.status === "error" && !params.cursor) await new Promise<void>((resolve) => { releaseFiltered = resolve; });
      return page;
    },
  } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: "/telemetry/sessions" }));
  try {
    const older = () => view.getByRole("button", { name: "older sessions" }) as HTMLButtonElement;
    await waitFor(() => expect(older().disabled).toBe(false));
    await act(async () => { fireEvent.click(view.getByRole("checkbox")); });
    await act(async () => { fireEvent.click(older()); });
    expect(sessions.filter((params) => params.cursor === "c1" && params.status === "error")).toEqual([]);
    expect(older().disabled).toBe(true);
    await act(async () => { releaseFiltered(); });
    await waitFor(() => expect(older().disabled).toBe(false));
    await act(async () => { fireEvent.click(older()); });
    await waitFor(() => expect(sessions.at(-1)).toMatchObject({ cursor: "c1", status: "error" }));
  } finally {
    releaseFiltered();
  }
});

test("the profile listbox sends the chosen profile, and its any row clears it even when a profile is named any", async () => {
  const sessions: Record<string, unknown>[] = [];
  const client = {
    features: ["telemetry_read_v1"],
    protocolVersion: "1",
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "telemetry_overview") return { status, totals: point, series: [], active_models: 0, active_tools: 0, next_cursor: null };
      sessions.push(params);
      return { items: [{ ...session("s1"), profile: "any" }, { ...session("s2"), profile: "worker" }], next_cursor: null, as_of_ns: 1 };
    },
  } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: "/telemetry/sessions" }));
  const pick = async (index: number) => {
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "profile" })); });
    await act(async () => { fireEvent.click(view.getAllByRole("option")[index]); });
  };
  await waitFor(() => expect(view.getAllByRole("row").length).toBeGreaterThan(1));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "profile" })); });
  expect(view.getAllByRole("option").map((option) => option.textContent?.replace("✓", ""))).toEqual(["any", "any", "worker"]);
  await act(async () => { fireEvent.keyDown(view.getByRole("listbox"), { key: "Escape" }); });
  await pick(1);
  await waitFor(() => expect(sessions.at(-1)).toMatchObject({ profile: "any" }));
  await pick(2);
  await waitFor(() => expect(sessions.at(-1)).toMatchObject({ profile: "worker" }));
  await pick(0);
  await waitFor(() => expect(sessions.at(-1)?.profile ?? null).toBeNull());
});
