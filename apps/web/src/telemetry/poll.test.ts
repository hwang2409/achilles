import { expect, test } from "bun:test";
import { createPoller, POLL_MS, type PollEnv, type PollState } from "./poll";

function fakeEnv(visible = true) {
  let listener: ((event: "visible" | "hidden" | "focus") => void) | null = null;
  const timers = new Map<number, () => void>();
  let next = 0;
  const env: PollEnv = {
    visible: () => visible,
    watch: (callback) => { listener = callback; return () => { listener = null; }; },
    setTimer: (callback, ms) => { expect(ms).toBe(POLL_MS); timers.set(++next, callback); return next; },
    clearTimer: (timer) => { timers.delete(timer as number); },
  };
  const fire = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); };
  const emit = (event: "visible" | "hidden" | "focus") => { if (event !== "focus") visible = event === "visible"; listener?.(event); };
  return { env, timers, fire, emit, watching: () => listener !== null };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("polls every 5 s while visible and keeps data, marked refreshing, during a refresh", async () => {
  const { env, timers, fire } = fakeEnv();
  let reads = 0;
  const states: PollState<number>[] = [];
  const poller = createPoller(async () => ++reads, (state) => states.push(state), env);
  await flush();
  expect(states.at(-1)).toEqual({ data: 1, error: undefined, refreshing: false });
  expect(timers.size).toBe(1);
  fire();
  expect(states.at(-1)).toEqual({ data: 1, error: undefined, refreshing: true });
  await flush();
  expect(states.at(-1)?.data).toBe(2);
  poller.stop();
});

test("a hidden page schedules nothing; showing it again reads at once", async () => {
  const { env, timers, emit } = fakeEnv();
  let reads = 0;
  const poller = createPoller(async () => ++reads, () => {}, env);
  await flush();
  emit("hidden");
  expect(timers.size).toBe(0);
  emit("visible");
  await flush();
  expect(reads).toBe(2);
  expect(timers.size).toBe(1);
  poller.stop();
});

test("a read that ends while hidden does not schedule the next one", async () => {
  const { env, timers, emit } = fakeEnv();
  let release = () => {};
  const poller = createPoller(() => new Promise<number>((resolve) => { release = () => resolve(1); }), () => {}, env);
  emit("hidden");
  release();
  await flush();
  expect(timers.size).toBe(0);
  poller.stop();
});

test("stop (unmount) cancels the timer, unsubscribes, and drops a reply in flight", async () => {
  const { env, timers, watching } = fakeEnv();
  let release = (_value: number) => {};
  const states: PollState<number>[] = [];
  const poller = createPoller(() => new Promise<number>((resolve) => { release = resolve; }), (state) => states.push(state), env);
  poller.stop();
  release(7);
  await flush();
  expect(states.some((state) => state.data === 7)).toBe(false);
  expect(timers.size).toBe(0);
  expect(watching()).toBe(false);
});

test("only the newest read changes the state, and a failure keeps the last data", async () => {
  const { env } = fakeEnv();
  const pending: ((value: number) => void)[] = [];
  let fail = false;
  const states: PollState<number>[] = [];
  const poller = createPoller(() => fail ? Promise.reject(new Error("down")) : new Promise<number>((resolve) => { pending.push(resolve); }), (state) => states.push(state), env);
  poller.refresh(); // focus or the refresh button while the first read is in flight
  pending[1](2);
  pending[0](1);
  await flush();
  expect(states.at(-1)).toEqual({ data: 2, error: undefined, refreshing: false });
  fail = true;
  poller.refresh();
  await flush();
  expect(states.at(-1)?.data).toBe(2);
  expect((states.at(-1)?.error as Error).message).toBe("down");
  poller.stop();
});
