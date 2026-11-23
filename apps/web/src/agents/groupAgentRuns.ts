import type { AgentRun } from "./reads";

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const time = (row: AgentRun) => row.startedAt ?? -Infinity;
export type RunBranch = { run: AgentRun; depth: number; missingParent: boolean };

/** A flat tree projection avoids recursive rendering of untrusted parent chains. */
export function groupAgentRuns(rows: readonly AgentRun[]) {
  const roots = new Map<string, AgentRun[]>();
  for (const row of rows) {
    const group = roots.get(row.sessionId);
    if (group) group.push(row); else roots.set(row.sessionId, [row]);
  }
  return [...roots].map(([sessionId, group]) => {
    group.sort((a, b) => time(a) - time(b) || compareId(a.runId, b.runId));
    const known = new Set(group.map((row) => row.runId));
    const children = new Map<string | null, AgentRun[]>();
    for (const row of group) {
      const list = children.get(row.parentRunId);
      if (list) list.push(row); else children.set(row.parentRunId, [row]);
    }
    const visited = new Set<string>();
    const direct: RunBranch[] = [], detached: RunBranch[] = [];
    const append = (into: RunBranch[], start: AgentRun, missingParent: boolean) => {
      const pending: RunBranch[] = [{ run: start, depth: 0, missingParent }];
      while (pending.length) {
        const node = pending.pop()!;
        if (visited.has(node.run.runId)) continue;
        visited.add(node.run.runId);
        into.push(node);
        const nested = children.get(node.run.runId) ?? [];
        for (let i = nested.length - 1; i >= 0; i--) pending.push({ run: nested[i], depth: node.depth + 1, missingParent: false });
      }
    };
    for (const row of children.get(null) ?? []) append(direct, row, false);
    for (const row of group) if (row.parentRunId !== null && !known.has(row.parentRunId)) append(detached, row, true);
    // Invalid cycles are not direct runs either. Keep them visible under unresolved parent links.
    for (const row of group) if (!visited.has(row.runId)) append(detached, row, true);
    return { sessionId, direct, detached, newest: time(group[group.length - 1]), count: group.length };
  }).sort((a, b) => b.newest - a.newest || compareId(a.sessionId, b.sessionId));
}
