import { expect, test } from "bun:test";
import { formatMetricValue } from "./metricValue";

test.each([
  ["€1,234,567", "€1,234,567", true],
  ["$12345678901", "$12345678901", true],
  ["$123456789012", "$1e11", true],
  ["123456789012 €", "1e11€", true],
  ["-$123456789012", "-$1e11", true],
  ["$-123456789012", "$-1e11", true],
  ["-123456789012 €", "-1e11€", true],
  ["€123.456.789.0", "€123.456.789.0", true],
  ["€not-a-number", "€not-a-number", false],
])("formats currency %s as %s", (source, display, currency) => {
  const formatted = formatMetricValue(source);
  expect(formatted.display).toBe(display);
  expect(formatted.currency === true).toBe(currency);
});
