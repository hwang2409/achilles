import type { TelemetryAgent, TelemetrySpan, TelemetryTrace } from "./telemetry-types";

/** Parents first, siblings in recorded order, missing parents start a new branch. */
function treeOrder<T>(items: T[], id: (item: T) => string, parent: (item: T) => string | null, start: (item: T) => number) {
  const sorted = [...items].sort((a, b) => start(a) - start(b) || id(a).localeCompare(id(b)));
  const ids = new Set(sorted.map(id));
  const children = new Map<string | null, T[]>();
  for (const item of sorted) {
    const p = parent(item);
    const key = p && ids.has(p) ? p : null;
    const siblings = children.get(key);
    if (siblings) siblings.push(item);
    else children.set(key, [item]);
  }
  const ordered: { item: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (root: T) => {
    const stack = [{ item: root, depth: 0 }];
    while (stack.length) {
      const row = stack.pop()!;
      const key = id(row.item);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(row);
      const branch = children.get(key) ?? [];
      for (let i = branch.length - 1; i >= 0; i--) stack.push({ item: branch[i], depth: row.depth + 1 });
    }
  };
  for (const root of children.get(null) ?? []) walk(root);
  // A malformed cycle should not hide the recorded rows.
  for (const item of sorted) if (!seen.has(id(item))) walk(item);
  return ordered;
}

export const agentRows = (agents: TelemetryAgent[]) => treeOrder(agents, (a) => a.session_id, (a) => a.parent_session_id, (a) => a.first_ns);

export function traceBar(first: number, last: number, start: number, end: number) {
  const window = Math.max(1, last - first);
  const percent = (time: number) => Math.min(100, Math.max(0, (time - first) / window * 100));
  const left = percent(start);
  // Keep even a zero-duration span visible, including one at the right edge.
  const width = Math.max(0.4, percent(end) - left);
  return { left: Math.min(left, 100 - width), width };
}

export function waterfallRows(spans: TelemetrySpan[], trace: TelemetryTrace) {
  const ancestors: (TelemetrySpan | undefined)[] = [];
  return treeOrder(spans, (s) => s.span_id, (s) => s.parent_span_id, (s) => s.start_ns).map(({ item, depth }) => {
    const turn = item.operation === "turn" ? item : ancestors[depth - 1];
    ancestors[depth] = turn;
    return { item, depth, turn, ...traceBar(trace.first_ns, trace.last_ns, item.start_ns, item.end_ns) };
  });
}
