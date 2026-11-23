import { expect, test } from "bun:test";
import { groupAgentRuns, type RunBranch } from "./groupAgentRuns";
import type { AgentRun } from "./reads";

const row = (runId: string, parentRunId: string | null, startedAt: number, sessionId = "alpha"): AgentRun => ({ runId, parentRunId, sessionId, startedAt, status: "running" });
const pack = (nodes: RunBranch[]) => nodes.map((node) => [node.run.runId, node.depth, node.missingParent]);
const view = (rows: AgentRun[]) => groupAgentRuns(rows).map((lane) => [lane.sessionId, pack(lane.direct), pack(lane.detached)]);

test.each([
  ["empty", [], []],
  ["direct and nested, stable sibling tie", [row("q", "r", 3), row("r", null, 2), row("p", "r", 3), row("z", null, 4)], [["alpha", [["r", 0, false], ["p", 1, false], ["q", 1, false], ["z", 0, false]], []]]],
  ["parent in another root stays absent", [row("same", null, 2, "beta"), row("child", "same", 2), row("leaf", "child", 1)], [["alpha", [], [["child", 0, true], ["leaf", 1, false]]], ["beta", [["same", 0, false]], []]]],
  ["newest group first; a bad cycle is never direct", [row("b", "a", 1), row("a", "b", 1), row("z", null, 3, "beta")], [["beta", [["z", 0, false]], []], ["alpha", [], [["a", 0, true], ["b", 1, false]]]]],
] as const)("%s independent of row permutation", (_name, rows, expected) => {
  const permutations = (input: AgentRun[]): AgentRun[][] => !input.length ? [[]] : input.flatMap((item, i) => permutations(input.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));
  for (const order of permutations([...rows])) expect(view(order)).toEqual(expected);
});
