import { expect, test } from "bun:test";
import { balancedMetricRows } from "./metricFit";

test.each([
  [3, 3, [3]],
  [4, 3, [2, 2]],
  [5, 3, [3, 2]],
  [6, 3, [3, 3]],
  [7, 3, [3, 2, 2]],
  [3, 4, [3]],
  [4, 4, [4]],
  [5, 4, [3, 2]],
  [6, 4, [3, 3]],
  [7, 4, [4, 3]],
] as const)("balances %i metrics when at most %i fit per row", (count, columns, rows) => {
  expect(balancedMetricRows(count, columns)).toEqual(rows);
});
