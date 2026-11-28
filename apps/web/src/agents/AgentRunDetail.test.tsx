import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { AgentRunDetail, RetryLine, retryText, RunHistory } from "./AgentRunDetail";
import { countText } from "./AgentsModule";
import { statusChoices, type Retry } from "./reads";
const { act, cleanup, render } = await import("@testing-library/react");

afterEach(() => { cleanup(); document.body.replaceChildren(); });

const now = Date.parse("2026-11-08T00:00:00Z");
const retrying = (seconds: number) => ({ state: "retrying" as const, startedAt: now, deadlineAt: now + 3_600_000, nextAt: now + seconds * 1000 });

test.each([
  [retrying(40), "retries in 40s"],
  [retrying(0.2), "retries in 1s"],
  [retrying(0), "retrying now…"],
  [retrying(-30), "retrying now…"],
  [retrying(130), "retries in 2m 10s"],
  [retrying(3780), "retries in 1h 3m"],
  [{ state: "stopped" as const, startedAt: now, deadlineAt: now + 3_600_000 }, "stopped retrying"],
])("retryText %p", (retry: Retry, words: string) => {
  expect(retryText(retry, now)).toBe(words);
});

test("200 retrying rows share one page clock, which stops with the last row", async () => {
  jest.useFakeTimers();
  // own the clock: fake timers move Date differently across bun versions
  let clock = now;
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const started = spyOn(globalThis, "setInterval");
  const stopped = spyOn(globalThis, "clearInterval");
  try {
    const ui = render(<ul>{Array.from({ length: 200 }, (_, index) => <li key={index}><RetryLine retry={retrying(40 + index)} /></li>)}</ul>);
    await act(async () => {});
    expect(started).toHaveBeenCalledTimes(1);
    await act(async () => { clock += 10_000; jest.advanceTimersByTime(10_000); });
    expect(ui.container.querySelector("li")?.textContent).toBe("provider unavailable · retries in 30s");
    expect(started).toHaveBeenCalledTimes(1);
    ui.unmount();
    expect(stopped).toHaveBeenCalledTimes(1);
    // a stopped retry has no countdown and starts no clock
    render(<RetryLine retry={{ state: "stopped", startedAt: now, deadlineAt: now }} />);
    await act(async () => {});
    expect(started).toHaveBeenCalledTimes(1);
  } finally { started.mockRestore(); stopped.mockRestore(); time.mockRestore(); jest.useRealTimers(); }
});

test("the state filter offers suspended only when zeta negotiated child recovery", () => {
  expect(statusChoices("catalog", false)).not.toContain("suspended");
  expect(statusChoices("attached", false)).not.toContain("suspended");
  expect(statusChoices("catalog", true)).toContain("suspended");
  expect(statusChoices("attached", true)).toContain("suspended");
  // stored agent state has no suspended status to filter by
  expect(statusChoices("state", true)).not.toContain("suspended");
});

// zeta's row for a child that was paused before its first turn (synthetic)
const waiting = { runId: "a:1", sessionId: "a", parentRunId: null, agentType: "run", status: "suspended" as const, description: "work", currentStep: "suspended",
  turnsUsed: 0, toolCount: 0, elapsedSeconds: 0, startedAt: now, retry: retrying(40) };

test("a run that never ran a turn shows no elapsed time; one that ran shows it", () => {
  const fields = (row: typeof waiting) => {
    const ui = render(<AgentRunDetail chosen={row} title="chat" id="a:1" client={null} reportedAt={now} refreshing={false} refresh={() => {}} />);
    const labels = [...ui.container.querySelectorAll(".agents-run-head dt")].map((node) => node.textContent);
    const value = [...ui.container.querySelectorAll(".agents-run-head div")].find((node) => node.querySelector("dt")?.textContent === "elapsed at last refresh")?.querySelector("dd")?.textContent;
    ui.unmount();
    return { labels, value };
  };
  expect(fields(waiting).labels).not.toContain("elapsed at last refresh");
  expect(fields({ ...waiting, turnsUsed: 1, elapsedSeconds: 5 }).value).toBe("5s");
});

test("child history shows loading only while the first read runs; an empty transcript says no activity yet", async () => {
  let answer!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { answer = resolve; });
  const client = { features: ["child_runs", "child_run_history"], request: (method: string) =>
    method === "status" ? Promise.resolve({ session: { session_id: "a" } }) : pending } as unknown as ZetaClient;
  const ui = render(<RunHistory client={client} row={waiting} />);
  try {
    await act(async () => {});
    expect(ui.container.textContent).toContain("reading child history");
    await act(async () => { answer({ messages: [], next_before: null, history_validator: { end: 0, entry_id: null } }); });
    for (let tick = 0; tick < 5; tick++) await act(async () => { await Promise.resolve(); });
    expect(ui.container.textContent).not.toContain("reading child history");
    expect(ui.container.textContent).toContain("no activity yet");
  } finally { ui.unmount(); }
});

test.each([[0, true, "0 runs in view"], [1, true, "1 run in view"], [2, true, "2 runs in view"], [1, false, "1 loaded result"], [2, false, "2 loaded results"]])(
  "countText %p %p", (count: number, complete: boolean, words: string) => { expect(countText(count, complete)).toBe(words); });
