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
  expect(view.container.querySelector(".tm-eyebrow")?.textContent).toBe("telemetry · needs a newer zeta");
  expect(view.queryByText(/connecting/i)).toBeNull();
  expect(requests).toBe(0);
});

const point = { start_ns: 0, end_ns: 1, sessions: 2, traces: 0, spans: 0, errors: 0, model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, duration_ns: 0 };
const status = { enabled: true, receiver: "ready", endpoint: "builtin", last_export: "ok", last_export_ns: null, raw_days: 14, rollup_days: 90, max_bytes: 1, used_bytes: 0, oldest_raw_ns: null, oldest_rollup_ns: null };
const session = (id: string) => ({ session_id: id, first_ns: 0, last_ns: 1, last_trace_id: "t", profile: "worker", model: "m", span_count: 1, turn_count: 1, model_count: 1, tool_count: 0, error_count: 0, input_tokens: 1, output_tokens: 1, total_tokens: 2 });

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
