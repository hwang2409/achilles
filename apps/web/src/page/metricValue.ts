const METRIC_VALUE_BOUND = 5;
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export type MetricValue = {
  display: string;
  numeric: boolean;
  scientific: boolean;
};

export function formatMetricValue(source: string): MetricValue {
  const numeric = Number(source.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return { display: source, numeric: false, scientific: false };
  if (source.length <= METRIC_VALUE_BOUND) return { display: source, numeric: true, scientific: false };
  const compact = compactNumber.format(numeric);
  const compactNumberMeaning = Number(compact.replaceAll(",", ""));
  if (compact.length <= METRIC_VALUE_BOUND && (numeric === 0 || compactNumberMeaning !== 0)) return { display: compact, numeric: true, scientific: false };
  return { display: numeric.toExponential(0).replace("e+", "e"), numeric: true, scientific: true };
}
