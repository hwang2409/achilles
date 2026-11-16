import { describe, expect, test } from "bun:test";
import { layoutSummary } from "./layoutSummary";

describe("layoutSummary", () => {
  test.each([
    [1, "long v2", "long v2 · 1 block"],
    [3, "L3 full page", "L3 full page · 3 blocks"],
    [2, null, "2 blocks"],
    [0, null, "0 blocks"],
    [1, null, "1 block"],
  ])("count %p label %p", (count, label, expected) => {
    expect(layoutSummary(count, label as string | null)).toBe(expected);
  });
});
