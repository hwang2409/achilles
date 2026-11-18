import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import type { ZetaClient } from "@fulcrum/zeta";
import { TelemetryModule } from "./TelemetryModule";

afterEach(cleanup);

test("a connected zeta whose hello did not grant telemetry_read_v1 shows the update notice, not connecting", () => {
  let requests = 0;
  const client = { features: ["delivery_id", "served_turn_end"], request: async () => { requests++; return {}; } } as unknown as ZetaClient;
  const view = render(createElement(TelemetryModule, { client, pathname: "/telemetry" }));
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Telemetry needs a newer zeta");
  expect(view.queryByText(/connecting/i)).toBeNull();
  expect(requests).toBe(0);
});
