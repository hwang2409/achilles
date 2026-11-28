import { expect, test } from "bun:test";
import { orderBranches, type Branch } from "./branches";

const b = (id: string, current = false): Branch => ({ id, label: id, current });
test.each([
  ["first read keeps zeta's order", [], [b("a"), b("b", true)], ["a", "b"]],
  ["a fork goes last", ["a"], [b("a"), b("f", true)], ["a", "f"]],
  ["a switch's new leaf takes the switched-to branch's place", ["a", "f"], [b("f"), b("a2", true)], ["a2", "f"]],
  ["a turn's new leaf keeps its place", ["a", "f"], [b("a"), b("f2", true)], ["a", "f2"]],
  ["a gone branch with no new leaf drops out", ["a", "f", "g"], [b("a"), b("g", true)], ["a", "g"]],
] as const)("%s", (_name, previous, tree, ids) => {
  expect(orderBranches(previous, tree).map((branch) => branch.id)).toEqual([...ids]);
});
