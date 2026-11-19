const METRIC_VALUE_BOUND = 5;
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export type MetricValue = {
  display: string;
  numeric: boolean;
};

export function formatMetricValue(source: string): MetricValue {
  const numeric = Number(source.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) {
    const money = source.trim().match(/^(?<prefix>[+−-]?\p{Sc}\s*|[+−-]?)(?<amount>[+−-]?\d[\d,.]*)(?<suffix>\s*\p{Sc})?$/u)?.groups;
    if (!money || (!/\p{Sc}/u.test(money.prefix) && !money.suffix)) return { display: source, numeric: /^[+−-]?(?:\d[\d,.]*|\.\d+)[%KMBT]$/iu.test(source.trim()) };
    const amount = Number(money.amount.replaceAll(",", "").replace("−", "-"));
    const exact = source.trim();
    const display = exact.length <= 12 || !Number.isFinite(amount) ? exact : `${money.prefix.trimEnd()}${compactMetric(amount)}${money.suffix?.trimStart() ?? ""}`;
    return { display, numeric: true };
  }
  return { display: source.length <= METRIC_VALUE_BOUND ? source : compactMetric(numeric), numeric: true };
}

function compactMetric(numeric: number): string {
  const compact = compactNumber.format(numeric);
  const compactNumberMeaning = Number(compact.replaceAll(",", ""));
  if (compact.length <= METRIC_VALUE_BOUND && (numeric === 0 || compactNumberMeaning !== 0)) return compact;
  return numeric.toExponential(0).replace("e+", "e");
}
