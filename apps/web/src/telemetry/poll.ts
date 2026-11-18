import { useEffect, useRef, useState } from "react";

export const POLL_MS = 5_000;

/** The newest read. `data` (read at `updatedAt`, epoch ms) stays after a failed or running refresh, so the page keeps showing it. */
export type PollState<T> = { data?: T; updatedAt?: number; error?: unknown; refreshing: boolean };

export type PollEnv = {
  visible(): boolean;
  /** Calls `listener` when the page becomes visible or hidden, or gains focus; returns the unsubscribe. */
  watch(listener: (event: "visible" | "hidden" | "focus") => void): () => void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

export const browserEnv: PollEnv = {
  visible: () => document.visibilityState === "visible",
  watch(listener) {
    const visibility = () => listener(document.visibilityState === "visible" ? "visible" : "hidden");
    const focus = () => listener("focus");
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", focus); };
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Reads now, then every `POLL_MS` while the page is visible, and again on focus or `refresh()`. A hidden page or
 * `stop()` schedules nothing. One read runs at a time: a refresh asked for during a read waits, and all such asks
 * become one follow-up read when it ends.
 */
export function createPoller<T>(load: () => Promise<T>, onChange: (state: PollState<T>) => void, env: PollEnv = browserEnv, initial: PollState<T> = { refreshing: false }) {
  let state = initial;
  let reading = false;
  let again = false;
  let timer: unknown = null;
  let stopped = false;
  const set = (patch: Partial<PollState<T>>) => { state = { ...state, ...patch }; onChange(state); };
  const clear = () => { if (timer !== null) { env.clearTimer(timer); timer = null; } };
  const refresh = async () => {
    if (stopped) return;
    clear();
    if (reading) { again = true; return; }
    reading = true;
    set({ refreshing: true });
    let result: Partial<PollState<T>>;
    try { result = { data: await load(), updatedAt: Date.now(), error: undefined }; }
    catch (error) { result = { error }; }
    reading = false;
    if (stopped) return;
    if (again) { again = false; set(result); void refresh(); return; }
    set({ ...result, refreshing: false });
    if (env.visible()) timer = env.setTimer(() => { timer = null; void refresh(); }, POLL_MS);
  };
  const unwatch = env.watch((event) => {
    if (event === "hidden") clear();
    else void refresh();
  });
  if (env.visible()) void refresh();
  return {
    refresh: () => void refresh(),
    stop() { stopped = true; clear(); unwatch(); },
  };
}

/**
 * Polls `load` while mounted. A change in `key` (query, client) starts a new poller that keeps the old data on screen,
 * marked refreshing, until the new read answers.
 */
export function usePoll<T>(load: () => Promise<T>, key: unknown[], env?: PollEnv) {
  const [state, setState] = useState<PollState<T>>({ refreshing: false });
  const latest = useRef(state);
  latest.current = state;
  const poller = useRef<{ refresh(): void } | null>(null);
  useEffect(() => {
    const current = createPoller(load, setState, env, latest.current);
    poller.current = current;
    return () => current.stop();
  }, key); // `key` names everything `load` reads
  return { ...state, refresh: () => poller.current?.refresh() };
}
