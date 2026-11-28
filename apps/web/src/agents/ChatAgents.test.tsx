import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { fromZetaEvent, type ZetaClient } from "@fulcrum/zeta";
import { ChatAgents } from "./ChatAgents";
import { createAgentRunsReader } from "./reads";
import { createChildSendOwner } from "./childSend";
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

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
  const store = { subscribe: () => () => {}, subscribeOutline: () => () => {}, getItem: (id: string) => id === done.id ? done : undefined } as never;
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
  const store = { subscribe: () => () => {}, subscribeOutline: () => () => {}, getItem: () => undefined } as never;
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

// a provider-suspended child of this chat, read from the run catalog (synthetic); child_run_list carries accepts_send
const paused = { ...running, accepts_follow_ups: false, status: "suspended", current_step: "suspended: provider unavailable, retrying", suspension_reason: "provider_unavailable",
  retry_state: "retrying", retry_started_at: "2026-11-08T00:00:00+00:00", retry_deadline_at: "2026-11-08T01:00:00+00:00", next_retry_at: "2099-01-01T00:00:00+00:00" };
function pausedChat(accepts: boolean | undefined, sent: (text: string) => unknown = () => ({ accepted: true, run_id: "a:1" })) {
  const reads: string[] = [];
  const row = { ...paused, ...(accepts === undefined ? {} : { accepts_send: accepts }) };
  const client = { features: ["agent_run_catalog_v1", "child_runs", "child_recovery"], request: async (method: string, params: { text?: string }) => {
    reads.push(method);
    if (method === "status") return { session: { session_id: "a" } };
    if (method === "child_run_list") return { runs: [row] };
    if (method === "child_run_send") return sent(params.text!);
    return { revision: "sample", data: { items: [paused] } };
  } } as unknown as ZetaClient;
  const send = createChildSendOwner({ withControl: async (run) => ({ value: await run(client) }) },
    async (zeta, key, text) => { await zeta.request("child_run_send", { session_id: key.sessionId, run_id: key.runId, text }); return { kind: "accepted", runId: key.runId }; });
  const store = { subscribe: () => () => {}, subscribeOutline: () => () => {}, getItem: () => undefined } as never;
  const ui = render(<ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  return { ui, reads };
}
const settle = async () => { for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0))); };

test.each([[true, true], [false, false], [undefined, false]])("a suspended child with accepts_send %p shows a message box: %p", async (accepts: boolean | undefined, shown: boolean) => {
  const { ui } = pausedChat(accepts);
  try {
    await settle();
    const composer = ui.container.querySelector(".agents-composer");
    expect(!!composer).toBe(shown);
    if (composer) expect(composer.textContent).toContain("sending wakes it now.");
  } finally { ui.unmount(); }
});

test("a send refused with -32005 says not now, keeps the draft, and rereads the list once", async () => {
  const { ui, reads } = pausedChat(true, () => { throw Object.assign(new Error("synthetic refusal"), { code: -32005 }); });
  try {
    await settle();
    const box = ui.getByRole("textbox", { name: "message worker" }) as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(box, { target: { value: "synthetic follow-up" } }); });
    const catalogReads = () => reads.filter((method) => method === "agent_run_catalog").length;
    const before = catalogReads();
    await act(async () => { (ui.getByRole("button", { name: "send to worker" }) as HTMLButtonElement).click(); });
    await settle();
    expect(ui.container.querySelector(".agents-composer [role=status]")?.textContent).toBe("this agent cannot take a message now.");
    expect(ui.container.textContent).not.toContain("32005");
    expect((ui.getByRole("textbox", { name: "message worker" }) as HTMLTextAreaElement).value).toBe("synthetic follow-up");
    expect(catalogReads() - before).toBe(1);
  } finally { ui.unmount(); }
});

test("a resumed notice in this chat rereads the list once, so the row leaves suspended without a refresh", async () => {
  const suspended = { ...running, status: "suspended", current_step: "suspended: provider unavailable, retrying", suspension_reason: "provider_unavailable",
    retry_state: "retrying", retry_started_at: "2026-11-08T00:00:00+00:00", retry_deadline_at: "2026-11-08T01:00:00+00:00", next_retry_at: "2099-01-01T00:00:00+00:00" };
  const replies = [suspended, running];
  const reads: string[] = [];
  const client = { features: ["agent_run_catalog_v1", "child_recovery"], request: async (method: string) => {
    reads.push(method);
    return { revision: "sample", data: { items: [replies.shift() ?? running] } };
  } } as unknown as ZetaClient;
  const store = createRunStore((flush) => flush());
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const ui = render(<ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  const settle = async () => { for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0))); };
  try {
    await settle();
    const status = () => ui.container.querySelector(".chat-agents-runs .agents-state")?.getAttribute("data-status");
    expect(status()).toBe("suspended");
    // other transcript rows do not reread
    for (const event of fromZetaEvent({ event: "synthetic_future_event", session_id: "a", data: {} })) store.dispatch(event);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(reads).toHaveLength(1);
    const resumed = { notification_id: "n-2", origin: "agent", child_instance_id: "c-1", child_session_path: "/synthetic/c-1", description: "check sample", episode: 1,
      display_only: true, kind: "child_recovered", logical_id: "child-recovered:a:1:1", text: "child recovered" };
    for (const event of fromZetaEvent({ event: "child_recovered", session_id: "a", data: resumed })) store.dispatch(event);
    for (const event of fromZetaEvent({ event: "child_recovered", session_id: "a", data: { ...resumed, notification_id: "n-3" } })) store.dispatch(event);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    await settle();
    expect(reads).toHaveLength(2);
    expect(status()).toBe("running");
  } finally { ui.unmount(); store.dispose(); }
});
