import { expect, test } from "bun:test";
import { answerProbe, stepFinished } from "./eval-browser";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const end = { event: "served_turn_end" };

test("a browser step ends only after a turn end that follows every text it sent", () => {
  expect(stepFinished([user("add five"), end], 0, ["add five"])).toBe(true);
  // the follow-up was steered in after the first turn ended: its own turn has not ended yet
  expect(stepFinished([user("add five"), end, user("and a sixth")], 0, ["add five", "and a sixth"])).toBe(false);
  expect(stepFinished([user("add five"), user("and a sixth"), end], 0, ["add five", "and a sixth"])).toBe(true);
  // an earlier step's turn end does not count
  expect(stepFinished([user("old"), end, user("add five")], 1, ["add five"])).toBe(false);
});

test("the answer probe drops markdown marks so the rendered page text can match it", () => {
  expect(answerProbe("Done.\n\n**Added 5 contacts:** Ada, Grace")).toBe("added 5 contacts: ada, grace");
});

test("the answer probe matches rendered text where a mark sat next to punctuation", () => {
  // the rendered list item of `- **list_expenses**: lists ...`; a probe with "list expenses : lists" never matched it
  const rendered = "list_expenses: lists the expenses collection. When I created it, the connection dropped";
  expect(rendered.replace(/[*_#`>|[\]()~-]/g, "").replace(/\s+/g, " ").toLowerCase()).toContain(answerProbe("- **list_expenses**: lists the `expenses` collection. When I created it, the connection dropped"));
});
