import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, mock, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
// the reader asks the hello handshake which methods exist; this test has no handshake
const connection = await import("../zeta/connection");
mock.module("../zeta/connection", () => ({ ...connection, supportsRequest: () => true }));
const { ChatAgents } = await import("./ChatAgents");
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
    initialRun="a:1" opener={null} onClose={() => {}} />);
  try {
    for (let tick = 0; tick < 20; tick++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(methods).toEqual(["agent_run_catalog", "agent_run_catalog"]);
    expect(ui.getByText("zeta could not read agent runs right now")).toBeTruthy();
  } finally { ui.unmount(); }
});
