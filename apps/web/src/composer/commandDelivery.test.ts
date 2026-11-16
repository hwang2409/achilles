import { expect, test } from "bun:test";
import { createComposerDelivery } from "./useComposerDelivery";

type Command = { name: string; arg: string };

function harness(clearOn: (command: Command) => boolean) {
  const sent: string[] = [];
  const commands: Command[] = [];
  let draft = "";
  const owner = createComposerDelivery({
    state: "idle",
    defaultValue: "",
    onDraftChange: (text: string) => { draft = text; },
    onDraftSubmit: (text: string) => { draft = draft.startsWith(text) ? draft.slice(text.length) : draft; },
    onSubmit: async (text: string) => { sent.push(text); },
    onCommand: (command: Command) => { commands.push(command); return clearOn(command); },
  });
  owner.attach();
  return { owner, sent, commands, draft: () => draft };
}

// fail-first: on base 20666eb the composer has no command handling, so "/accounts" is delivered to the model
// (`sent` would be ["/accounts"]) and `onCommand` is never called.
test("a /accounts draft runs locally and is never sent to the model", async () => {
  const h = harness((command) => command.name === "accounts");
  h.owner.edit("/accounts");
  await h.owner.submit();
  expect(h.sent).toEqual([]);
  expect(h.commands).toEqual([{ name: "accounts", arg: "" }]);
  expect(h.owner.getModel().draft).toBe("");
});

test("an unknown command keeps the draft and is not sent", async () => {
  const h = harness(() => false);
  h.owner.edit("/nope");
  await h.owner.submit();
  expect(h.sent).toEqual([]);
  expect(h.commands).toEqual([{ name: "nope", arg: "" }]);
  expect(h.owner.getModel().draft).toBe("/nope");
});

test('a leading "//" sends the literal "/" text to the model', async () => {
  const h = harness(() => true);
  h.owner.edit("//accounts");
  await h.owner.submit();
  expect(h.sent).toEqual(["/accounts"]);
  expect(h.commands).toEqual([]);
});
