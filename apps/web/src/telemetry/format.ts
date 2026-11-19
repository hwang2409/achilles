// Display text for telemetry numbers. Inputs are unix nanoseconds, nanosecond durations, and nonnegative counts.

const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

/** Short durations keep sub-second detail; long ones read like the mockups: `18.4 s`, `22m`, `6h 41m`. */
export function formatDuration(ns: number) {
  if (ns < 1e3) return `${ns} ns`;
  if (ns < NS_PER_MS) return `${Math.round(ns / 1e3)} µs`;
  if (ns < NS_PER_S) {
    const ms = ns / NS_PER_MS;
    return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  }
  const seconds = ns / NS_PER_S;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Percentile cells keep seconds through the sub-two-minute range and seconds in minute-scale values. */
export function formatLatency(ns: number | null | undefined) {
  if (ns == null) return "—";
  const seconds = ns / NS_PER_S;
  if (seconds < 0.1 || seconds >= 3600) return formatDuration(ns);
  if (seconds <= 120) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** Today's times show the clock only; older ones add the date. */
export function formatTime(ns: number, now = new Date()) {
  const date = new Date(ns / NS_PER_MS);
  const clock = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return clock;
  return `${formatDay(ns)} ${clock}`;
}

/** `nov 4`: lowercase, like the rest of the telemetry pages. */
export const formatDay = (ns: number) => new Date(ns / NS_PER_MS).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();

export const formatHour = (ns: number) => new Date(ns / NS_PER_MS).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

export const formatFullTime = (ns: number) => new Date(ns / NS_PER_MS).toLocaleString("en-GB", { hour12: false });

export const formatCount = (value: number) => value.toLocaleString("en-US");

export function formatTokens(value: number | undefined) {
  if (value === undefined) return "—";
  if (value < 10_000) return formatCount(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Binary units, as the 1 GiB storage limit is stated. */
export function formatBytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 || value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `2s ago`, `4m ago`, `1h ago`, `3d ago`; a clock ahead of the page counts as now. */
export function formatAgo(ns: number, nowMs = Date.now()) {
  const seconds = Math.max(0, Math.floor((nowMs - ns / NS_PER_MS) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** One decimal under 10%, so 1.3% and 0% stay apart; no rate without a denominator. */
export function formatPercent(part: number, whole: number) {
  if (whole <= 0) return null;
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

export const shortId = (id: string) => id.slice(0, 8);
