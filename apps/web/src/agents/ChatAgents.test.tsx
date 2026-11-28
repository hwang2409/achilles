import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { ChatAgents } from "./ChatAgents";
import { createAgentRunsReader } from "./reads";
const { act, cleanup, render } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

const running = { run_id: "a:1", session_id: "a", parent_run_id: null, status: "running", agent_type: "worker", description: "check sample", accepts_follow_ups: false, turns_used: 1, tool_count: 0, current_step: "thinking", started_at: "2026-01-02T00:00:00Z", finished_at: null, elapsed_seconds: 5 };

test("a run that ends after the report rereads once; a failed reread does not retry", async () => {
  const methods: string[] = [];
  const client = { features: ["agent_run_catalog_v1"], request: async (method: string) => {
    methods.push(method);
    if (methods.length === 1) return { revision: "sample", data: { items: [running] } };
    // the old loop rereads forever; park the sixth read so the test ends and the count shows it
    if (methods.length > 5) return new Promise(() => {});
    throw Object.assign(new Error("test rpc error"), { code: -32005 });
  } } as unknown as ZetaClient;
  const done = { id: "sub-agent:a:1", type: "sub_agent", status: "done", childRunId: "a:1" };
  const store = { subscribe: () => () => {}, getItem: (id: string) => id === done.id ? done : undefined } as never;
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const ui = render(<ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  try {
    for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(methods).toEqual(["agent_run_catalog", "agent_run_catalog"]);
    expect(ui.getByText("zeta could not read agent runs right now")).toBeTruthy();
  } finally { ui.unmount(); }
});

test("a suspended child says when zeta retries, counts down, offers cancel and no message box", async () => {
  jest.useFakeTimers();
  // own the clock: fake timers move Date differently across bun versions
  let clock = Date.parse("2026-11-08T00:00:00Z");
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const suspended = { ...running, accepts_follow_ups: true, status: "suspended", current_step: "suspended: provider unavailable, retrying", suspension_reason: "provider_unavailable",
    retry_state: "retrying", retry_started_at: "2026-11-08T00:00:00+00:00", retry_deadline_at: "2026-11-08T01:00:00+00:00", next_retry_at: "2026-11-08T00:00:40+00:00" };
  // the attached root matches, so a running child with follow-ups would get the message box
  const client = { features: ["agent_run_catalog_v1", "child_runs", "child_recovery"], request: async (method: string) =>
    method === "status" ? { session: { session_id: "a" } } : { revision: "sample", data: { items: [suspended] } } } as unknown as ZetaClient;
  const store = { subscribe: () => () => {}, getItem: () => undefined } as never;
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const ui = render(<ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  try {
    for (let tick = 0; tick < 20; tick++) await act(async () => { await Promise.resolve(); });
    const row = ui.container.querySelector(".chat-agents-runs .agents-row")!;
    expect(row.querySelector(".agents-state")?.textContent).toBe("suspended");
    expect(row.textContent).toContain("provider unavailable · retries in 40s");
    expect(row.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-08T00:00:40.000Z");
    await act(async () => { clock += 5000; jest.advanceTimersByTime(5000); });
    expect(row.textContent).toContain("retries in 35s");
    await act(async () => { clock += 40_000; jest.advanceTimersByTime(40_000); });
    expect(row.textContent).toContain("retrying now…");
    expect(ui.container.querySelector('[data-write-surface="agents.cancel"]')).toBeTruthy();
    expect(ui.container.querySelector(".agents-composer")).toBeNull();
    expect(ui.container.querySelector(".agents-run-head")?.textContent).toContain("gives up at");
  } finally { ui.unmount(); time.mockRestore(); jest.useRealTimers(); }
});
