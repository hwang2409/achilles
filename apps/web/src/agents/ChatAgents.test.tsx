import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { createRunStore } from "@fulcrum/core";
import { fromZetaEvent, type ZetaClient } from "@fulcrum/zeta";
import { AgentsModule } from "./AgentsModule";
import { ChatAgents } from "./ChatAgents";
import { createAgentRunsReader } from "./reads";
import { createChildSendOwner } from "./childSend";
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

const running = { run_id: "a:1", session_id: "a", parent_run_id: null, status: "running", agent_type: "worker", description: "check sample", accepts_follow_ups: false, turns_used: 1, tool_count: 0, current_step: "thinking", started_at: "2026-01-02T00:00:00Z", finished_at: null, elapsed_seconds: 5 };

test("a run that ends after the report rereads once; a failed reread does not retry", async () => {
  const methods: string[] = [];
  const done = { id: "sub-agent:a:1", type: "sub_agent", status: "done", childRunId: "a:1" };
  const store = { subscribe: () => () => {}, subscribeOutline: () => () => {}, getItem: (id: string) => id === done.id ? done : undefined } as never;
  const client = { features: ["agent_run_catalog_v1"], stores: new Map([["a", store]]), request: async (method: string) => {
    methods.push(method);
    if (methods.length === 1) return { revision: "sample", data: { items: [running] } };
    // the old loop rereads forever; park the sixth read so the test ends and the count shows it
    if (methods.length > 5) return new Promise(() => {});
    throw Object.assign(new Error("test rpc error"), { code: -32005 });
  } } as unknown as ZetaClient;
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
function pausedChat(accepts: boolean | undefined, sent: (text: string, row: Record<string, unknown>) => unknown = () => ({ accepted: true, run_id: "a:1" }), base: Record<string, unknown> = paused) {
  const reads: string[] = [];
  const row: Record<string, unknown> = { ...base, ...(accepts === undefined ? {} : { accepts_send: accepts }) };
  const client = { features: ["agent_run_catalog_v1", "child_runs", "child_recovery"], request: async (method: string, params: { text?: string }) => {
    reads.push(method);
    if (method === "status") return { session: { session_id: "a" } };
    if (method === "child_run_list") return { runs: [row] };
    if (method === "child_run_send") return sent(params.text!, row);
    return { revision: "sample", data: { items: [base] } };
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

test("a send refused with -32005 whose reread says accepts_send false keeps the reason and drops the box", async () => {
  const { ui } = pausedChat(true, (_, row) => { row.accepts_send = false; throw Object.assign(new Error("synthetic refusal"), { code: -32005 }); });
  try {
    await settle();
    await act(async () => { fireEvent.change(ui.getByRole("textbox", { name: "message worker" }), { target: { value: "synthetic follow-up" } }); });
    await act(async () => { (ui.getByRole("button", { name: "send to worker" }) as HTMLButtonElement).click(); });
    await settle();
    expect(ui.queryByRole("textbox", { name: "message worker" })).toBeNull();
    expect(ui.container.querySelector(".agents-composer[role=status]")?.textContent).toBe("this agent cannot take a message now.");
  } finally { ui.unmount(); }
});

// zeta's accepts_send outranks the status rule for a running row too: a foreground child refuses every message
test.each([[false, true, false], [true, false, true]])("a running child with accepts_send %p (follow-ups %p) shows a message box: %p", async (accepts: boolean, followUps: boolean, shown: boolean) => {
  const { ui, reads } = pausedChat(accepts, undefined, { ...running, accepts_follow_ups: followUps });
  try {
    await settle();
    expect(!!ui.queryByRole("textbox", { name: "message worker" })).toBe(shown);
    expect(reads.filter((method) => method === "child_run_list")).toHaveLength(1);
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

test("the agents place and the chat dialog show the same step and elapsed after a child_run_events update", async () => {
  let clock = Date.parse("2026-11-08T00:00:00Z");
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const admitting = { ...running, turns_used: 0, current_step: "turn 1: admitting request", started_at: "2026-11-08T00:00:00Z", elapsed_seconds: 0.2 };
  const store = createRunStore((flush) => flush());
  const client = { features: ["agent_run_catalog_v1", "child_run_events"], stores: new Map([["a", store]]), request: async (method: string) => {
    if (method === "agent_run_catalog") return { revision: "sample", data: { items: [admitting] } };
    throw Object.assign(new Error("test rpc error"), { code: -32601 });
  } } as unknown as ZetaClient;
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const place = render(<AgentsModule client={client} connecting={false} retry={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  const chat = render(<ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  const settle = async () => { for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0))); };
  const field = (label: string) => [...chat.container.querySelectorAll(".agents-run-head dl div")].find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
  try {
    await settle();
    expect([field("current step"), field("elapsed")]).toEqual(["turn 1: admitting request", undefined]);
    clock += 9000;
    const progress = { ...admitting, turns_used: 0, tool_count: 1, current_step: "turn 1: thinking", elapsed_seconds: 9.2 };
    await act(async () => { for (const event of fromZetaEvent({ event: "child_progress", session_id: "a", run_id: "a:1", sequence: 2, child: progress })) store.dispatch(event); });
    await settle();
    expect([field("current step"), field("elapsed"), field("tool calls")]).toEqual(["turn 1: thinking", "9s", "1"]);
    const row = place.container.querySelector(".agents-catalog .agents-row");
    expect([row?.querySelector("small")?.textContent, row?.querySelector(".agents-elapsed")?.textContent]).toEqual(["running · turn 1: thinking", "9s"]);
  } finally { chat.unmount(); place.unmount(); store.dispose(); time.mockRestore(); }
});

test("the chat dialog and the agents place read at different times show the same elapsed at the same moment", async () => {
  jest.useFakeTimers();
  // own the clock: fake timers move Date differently across bun versions
  const start = Date.parse("2026-11-08T00:00:00Z");
  let clock = start + 500;
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  // zeta's elapsed is wall time since the start, as of each read
  const client = { features: ["agent_run_catalog_v1"], request: async (method: string) => {
    if (method === "agent_run_catalog") return { revision: "sample", data: { items: [{ ...running, turns_used: 0, current_step: "turn 1: thinking",
      started_at: "2026-11-08T00:00:00Z", elapsed_seconds: (clock - start) / 1000 }] } };
    throw Object.assign(new Error("test rpc error"), { code: -32601 });
  } } as unknown as ZetaClient;
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const settle = async () => { for (let tick = 0; tick < 20; tick++) await act(async () => { await Promise.resolve(); }); };
  const chat = render(<ChatAgents client={client} store={null} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  await settle();
  // the place opens 3 s after the dialog read
  clock += 3000;
  const place = render(<AgentsModule client={client} connecting={false} retry={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />);
  const shown = () => [[...chat.container.querySelectorAll(".agents-run-head dl div")].find((row) => row.querySelector("dt")?.textContent?.startsWith("elapsed"))?.querySelector("dd")?.textContent,
    place.container.querySelector(".agents-catalog .agents-row .agents-elapsed")?.textContent];
  try {
    await settle();
    await act(async () => { clock += 1000; jest.advanceTimersByTime(1000); });
    expect(shown()).toEqual(["4s", "4s"]);
    await act(async () => { clock += 15_000; jest.advanceTimersByTime(15_000); });
    expect(shown()).toEqual(["19s", "19s"]);
  } finally { chat.unmount(); place.unmount(); time.mockRestore(); jest.useRealTimers(); }
});

test("the open dialog follows the session store a replay rejoin installs", async () => {
  let clock = Date.parse("2026-11-08T00:00:00Z");
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const admitting = { ...running, turns_used: 0, current_step: "turn 1: admitting request", started_at: "2026-11-08T00:00:00Z", elapsed_seconds: 0.2 };
  const first = createRunStore((flush) => flush());
  const replaced = createRunStore((flush) => flush());
  const stores = new Map([["a", first]]);
  const client = { features: ["agent_run_catalog_v1", "child_run_events"], stores, request: async (method: string) => {
    if (method === "agent_run_catalog") return { revision: "sample", data: { items: [admitting] } };
    throw Object.assign(new Error("test rpc error"), { code: -32601 });
  } } as unknown as ZetaClient;
  const draft = { text: "", pending: false };
  const send = { subscribe: () => () => {}, snapshot: () => draft } as never;
  const dialog = (store: typeof first) => <ChatAgents client={client} store={store} sessionId="a" title="chat" controls={{} as never} send={send}
    initialRun="a:1" opener={null} onClose={() => {}} readRuns={(zeta) => createAgentRunsReader(zeta, () => true)} />;
  const chat = render(dialog(first));
  const settle = async () => { for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0))); };
  const field = (label: string) => [...chat.container.querySelectorAll(".agents-run-head dl div")].find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd")?.textContent;
  const state = () => chat.container.querySelector(".agents-run-head .agents-state")?.textContent;
  try {
    await settle();
    expect(field("current step")).toBe("turn 1: admitting request");
    // the rejoin installs a new store in the client's map, and the chat's lease hands the dialog the new store
    stores.set("a", replaced);
    chat.rerender(dialog(replaced));
    clock += 9000;
    const progress = { ...admitting, tool_count: 1, current_step: "turn 1: thinking", elapsed_seconds: 9.2 };
    await act(async () => { for (const event of fromZetaEvent({ event: "child_progress", session_id: "a", run_id: "a:1", sequence: 2, child: progress })) replaced.dispatch(event); });
    await settle();
    expect([field("current step"), field("tool calls")]).toEqual(["turn 1: thinking", "1"]);
    await act(async () => { for (const event of fromZetaEvent({ event: "child_question", session_id: "a", data: { child_instance_id: "a:1", notification_id: "n-q", question: "continue?" } })) replaced.dispatch(event); });
    await settle();
    expect(state()).toBe("needs input");
  } finally { chat.unmount(); first.dispose(); replaced.dispose(); time.mockRestore(); }
});
