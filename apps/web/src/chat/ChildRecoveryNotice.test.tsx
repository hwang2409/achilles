import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { Fallback, Notification, RunProvider, Timeline } from "@fulcrum/react";
import { fromZetaEvent, fromZetaHistory } from "@fulcrum/zeta";
import { stamp } from "../agents/AgentRunDetail";
import { withChildRecovery } from "./ChildRecoveryNotice";
const { act, cleanup, render } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

// zeta's notice data (storage_format.py: the closed child_suspended / child_recovered key sets), synthetic values
const path = "/synthetic/home/sessions/s-1/agents/c-1";
const base = { origin: "agent", child_instance_id: "c-1", child_session_path: path, description: "work", episode: 1, display_only: true };
const paused = { ...base, kind: "child_suspended", logical_id: "child-suspended:a:1:1", text: "suspended: provider unavailable, retrying", code: "server_error", next_retry_at: "2026-11-08T00:00:05+00:00" };
const resumed = { ...base, kind: "child_recovered", logical_id: "child-recovered:a:1:1", text: "child recovered" };
const renderers = { notification: withChildRecovery(Notification), unknown: withChildRecovery(Fallback) };

async function shown(events: ReturnType<typeof fromZetaEvent>) {
  const store = createRunStore((flush) => flush());
  for (const event of events) store.dispatch(event);
  const ui = render(<RunProvider store={store}><Timeline renderers={renderers} /></RunProvider>);
  await act(async () => {});
  return ui;
}

test("live events and history rows show the same readable paused and resumed lines, never the session path", async () => {
  const live = await shown([
    ...fromZetaEvent({ event: "child_suspended", session_id: "s-1", data: { notification_id: "n-1", ...paused } }),
    ...fromZetaEvent({ event: "child_recovered", session_id: "s-1", data: { notification_id: "n-2", ...resumed } }),
  ]);
  const liveLines = [...live.container.querySelectorAll("[data-part=child-recovery]")].map((node) => node.textContent);
  const liveText = live.container.textContent;
  live.unmount();
  const history = await shown(fromZetaHistory([
    { id: "h-1", role: "system", content: [{ type: "text", text: paused.text }], tool_result: null, notification: paused },
    { id: "h-2", role: "system", content: [{ type: "text", text: resumed.text }], tool_result: null, notification: resumed },
  ]));
  const historyLines = [...history.container.querySelectorAll("[data-part=child-recovery]")].map((node) => node.textContent);
  expect(liveLines).toEqual([`work paused · provider unavailable · retries at ${stamp(Date.parse(paused.next_retry_at))}`, "work resumed"]);
  expect(historyLines).toEqual(liveLines);
  // screen readers announce a live pause, like ChatNotification
  expect([...history.container.querySelectorAll("[data-part=child-recovery]")].map((node) => node.getAttribute("role"))).toEqual(["status", "status"]);
  expect(history.container.querySelector("[data-part=child-recovery] time")?.getAttribute("dateTime")).toBe("2026-11-08T00:00:05.000Z");
  for (const text of [liveText, history.container.textContent]) {
    expect(text).not.toContain(path);
    expect(text).not.toContain("child_suspended");
    expect(text).not.toContain("server_error");
  }
});

test("a paused notice without a planned time says retrying stopped; other unknown events keep fulcrum's fallback", async () => {
  const { next_retry_at: _, ...stopped } = paused;
  const ui = await shown([
    ...fromZetaEvent({ event: "child_suspended", session_id: "s-1", data: stopped }),
    ...fromZetaEvent({ event: "synthetic_future_event", session_id: "s-1", data: {} }),
  ]);
  expect(ui.container.querySelector("[data-part=child-recovery]")?.textContent).toBe("work paused · provider unavailable · stopped retrying");
  expect(ui.container.textContent).toContain("synthetic_future_event");
});
