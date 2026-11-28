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
  // real zeta reports a fraction of a second
  expect(fields({ ...waiting, elapsedSeconds: 0.4 }).labels).not.toContain("elapsed at last refresh");
  expect(fields({ ...waiting, elapsedSeconds: 3.2 }).value).toBe("3s");
  expect(fields({ ...waiting, turnsUsed: 1, elapsedSeconds: 5 }).value).toBe("5s");
  // a finished one-turn child under 1 s did work: "<1s", not "0s"
  expect(fields({ ...waiting, status: "completed", retry: undefined, finishedAt: now + 400, turnsUsed: 1, elapsedSeconds: 0.4 } as unknown as typeof waiting).value).toBe("<1s");
});

// a zeta whose stored child transcript reads as the given pages in turn, the last one repeating (synthetic)
const historyClient = (pages: unknown[][], reads: number[] = []) => ({ features: ["child_runs", "child_run_history"], request: (method: string) => {
  if (method === "status") return Promise.resolve({ session: { session_id: "a" } });
  reads.push(reads.length);
  return Promise.resolve({ messages: pages[Math.min(reads.length - 1, pages.length - 1)], next_before: null, history_validator: { end: reads.length - 1, entry_id: null } });
} } as unknown as ZetaClient);
const settle = async () => { for (let tick = 0; tick < 8; tick++) await act(async () => { await Promise.resolve(); }); };
const live = { ...waiting, status: "running" as const, retry: undefined, currentStep: "turn 1: admitting request" };

test("an empty first read of a running run stays loading and rereads on the next row change", async () => {
  // real zeta stores the task at spawn; a read in the first ~100 ms sees nothing yet (synthetic task text)
  const reads: number[] = [];
  const client = historyClient([[], [{ role: "user", content: "synthetic task" }]], reads);
  const ui = render(<RunHistory client={client} row={live} />);
  try {
    await settle();
    expect(reads).toHaveLength(1);
    expect(ui.container.textContent).toContain("reading child history");
    expect(ui.container.textContent).not.toContain("run changed");
    ui.rerender(<RunHistory client={client} row={{ ...live, currentStep: "turn 1: thinking" }} />);
    await settle();
    expect(reads).toHaveLength(2);
    expect(ui.container.textContent).not.toContain("reading child history");
    expect(ui.container.textContent).not.toContain("run changed");
  } finally { ui.unmount(); }
});

test("a running run that is still empty after one reread says no activity yet", async () => {
  const client = historyClient([[]]);
  const ui = render(<RunHistory client={client} row={live} />);
  try {
    await settle();
    ui.rerender(<RunHistory client={client} row={{ ...live, currentStep: "turn 1: thinking" }} />);
    await settle();
    expect(ui.container.textContent).not.toContain("reading child history");
    expect(ui.container.textContent).toContain("no activity yet");
  } finally { ui.unmount(); }
});

test("a running run whose history read fails after open shows the warning, not the skeleton", async () => {
  let reads = 0;
  const client = { features: ["child_runs", "child_run_history"], request: (method: string) => {
    if (method === "status") return Promise.resolve({ session: { session_id: "a" } });
    // the first page opens the read with nothing and an older page to fetch; that fetch fails
    return ++reads === 1 ? Promise.resolve({ messages: [], next_before: 5, history_validator: { end: 5, entry_id: null } }) : Promise.reject(new Error("synthetic"));
  } } as unknown as ZetaClient;
  const ui = render(<RunHistory client={client} row={live} />);
  try {
    await settle();
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(reads).toBe(2);
    expect(ui.container.textContent).toContain("could not read child history from zeta.");
    expect(ui.container.textContent).not.toContain("reading child history");
  } finally { ui.unmount(); }
});

// the original bug: a paused child with 0 turns and an empty transcript kept the skeleton forever
test.each([
  ["suspended", "no activity yet"], ["idle", "no activity yet"], ["waiting", "no activity yet"], ["unknown", "no activity yet"],
  ["completed", "no stored messages"], ["canceled", "no stored messages"],
])("a %s run with an empty transcript shows its final text, never the skeleton", async (status: string, words: string) => {
  const reads: number[] = [];
  const client = historyClient([[]], reads);
  const row = { ...waiting, status, retry: undefined } as unknown as typeof waiting;
  const ui = render(<RunHistory client={client} row={row} />);
  try {
    await settle();
    expect(ui.container.textContent).not.toContain("reading child history");
    expect(ui.container.textContent).toContain(words);
    // and a row change rereads to the same final text
    ui.rerender(<RunHistory client={client} row={{ ...row, currentStep: "later" }} />);
    await settle();
    expect(reads).toHaveLength(2);
    expect(ui.container.textContent).not.toContain("reading child history");
    expect(ui.container.textContent).toContain(words);
  } finally { ui.unmount(); }
});

test.each([[0, true, "0 runs in view"], [1, true, "1 run in view"], [2, true, "2 runs in view"], [1, false, "1 loaded result"], [2, false, "2 loaded results"]])(
  "countText %p %p", (count: number, complete: boolean, words: string) => { expect(countText(count, complete)).toBe(words); });
