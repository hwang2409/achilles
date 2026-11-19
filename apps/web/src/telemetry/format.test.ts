import { expect, test } from "bun:test";
import { formatAgo, formatBytes, formatDuration, formatLatency, formatPercent, formatTokens } from "./format";

test("durations read as the mockups write them", () => {
  expect([500, 2_500_000, 18_400_000_000, 22 * 60e9 + 5e9, (6 * 60 + 41) * 60e9].map(formatDuration)).toEqual(["500 ns", "2.5 ms", "18.4 s", "22m", "6h 41m"]);
});

test("token counts stay exact below 10K, then shorten", () => {
  expect([0, 9_999, 41_200, 1_150_000, 203_500_000].map(formatTokens)).toEqual(["0", "9,999", "41K", "1.1M", "203.5M"]);
});

test("storage uses binary units", () => {
  expect([0, 1536, 214 * 1024 ** 2, 1024 ** 3].map(formatBytes)).toEqual(["0 B", "1.5 KiB", "214 MiB", "1 GiB"]);
});

test("ago counts from the page clock and never goes negative", () => {
  const now = 1_700_000_000_000;
  expect([now - 2_000, now - 4 * 60_000, now - 3_700_000, now + 5_000].map((ms) => formatAgo(ms * 1e6, now))).toEqual(["2s ago", "4m ago", "1h ago", "0s ago"]);
});

test("a rate needs a denominator", () => {
  expect(formatPercent(37, 2932)).toBe("1.3%");
  expect(formatPercent(0, 10)).toBe("0.0%");
  expect(formatPercent(1, 0)).toBeNull();
});

test("unknown model metrics stay distinct from measured zero", () => {
  expect([undefined, null, 0, 32_000_000].map(formatLatency)).toEqual(["—", "—", "0 ns", "32 ms"]);
  expect([undefined, 0].map(formatTokens)).toEqual(["—", "0"]);
});
