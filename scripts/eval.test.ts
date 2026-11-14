import { expect, test } from "bun:test";
import { assertTurnBudget, reserveTurns } from "./eval-protocol";
import { reportJson, reportMarkdown, scanSecrets } from "./eval";

test("turn reservation is command-wide", () => { expect(reserveTurns([{ agent_turns: 20 }, { agent_turns: 20, judge_turns: 2 }], 2)).toBe(84); expect(() => assertTurnBudget(241)).toThrow("command budget"); });
test("reports name the restrictive tool set", () => { const value = reportJson({ task: "x", pass: true, turns: 1, model: "m", provider: "p", tool_policy: "achilles__*,mcp_discover" }); expect(value).toContain('"tool_policy": "achilles__*,mcp_discover"'); expect(reportMarkdown(JSON.parse(value))).toContain("achilles__*"); });
test("secret scan fails closed", () => { expect(() => scanSecrets("Bearer abcdefghijklmnop", [])).toThrow(); expect(() => scanSecrets("safe", ["private"])).not.toThrow(); expect(() => scanSecrets("private", ["private"])).toThrow(); });
