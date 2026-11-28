import "../test-dom";
// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { RetryLine, retryText } from "./AgentRunDetail";
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
