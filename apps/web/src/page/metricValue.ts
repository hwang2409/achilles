const METRIC_VALUE_BOUND = 5;
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export type MetricValue = {
  display: string;
  numeric: boolean;
  scientific: boolean;
  currency?: boolean;
};

export function formatMetricValue(source: string): MetricValue {
  const numeric = Number(source.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) {
    const money = source.trim().match(/^(?<prefix>[+−-]?\p{Sc}\s*|[+−-]?)(?<amount>[+−-]?\d[\d,.]*)(?<suffix>\s*\p{Sc})?$/u)?.groups;
    if (!money || (!/\p{Sc}/u.test(money.prefix) && !money.suffix)) return { display: source, numeric: false, scientific: false };
    const amount = Number(money.amount.replaceAll(",", "").replace("−", "-"));
    const exact = source.trim();
    const display = exact.length <= 12 || !Number.isFinite(amount) ? exact : `${money.prefix.trimEnd()}${compactMetric(amount).display}${money.suffix?.trimStart() ?? ""}`;
    return { display, numeric: false, scientific: false, currency: true };
  }
  if (source.length <= METRIC_VALUE_BOUND) return { display: source, numeric: true, scientific: false };
  return compactMetric(numeric);
}

function compactMetric(numeric: number): MetricValue {
  const compact = compactNumber.format(numeric);
  const compactNumberMeaning = Number(compact.replaceAll(",", ""));
  if (compact.length <= METRIC_VALUE_BOUND && (numeric === 0 || compactNumberMeaning !== 0)) return { display: compact, numeric: true, scientific: false };
  return { display: numeric.toExponential(0).replace("e+", "e"), numeric: true, scientific: true };
}
