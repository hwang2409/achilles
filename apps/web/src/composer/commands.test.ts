import { expect, test } from "bun:test";
import { parseComposerInput } from "./commands";

test.each([
  ["/accounts", { kind: "command", name: "accounts", arg: "" }],
  ["/accounts anthropic:personal", { kind: "command", name: "accounts", arg: "anthropic:personal" }],
  ["/Accounts", { kind: "command", name: "accounts", arg: "" }],
  ["/unknown do a thing", { kind: "command", name: "unknown", arg: "do a thing" }],
  // "//" escapes to a literal message with one slash dropped
  ["//accounts", { kind: "send", text: "/accounts" }],
  // a slash that is not a leading "/word" is plain text
  ["/ spaced", { kind: "send", text: "/ spaced" }],
  ["path/to/file", { kind: "send", text: "path/to/file" }],
  ["hello", { kind: "send", text: "hello" }],
  ["", { kind: "send", text: "" }],
] as const)("parseComposerInput(%p)", (draft, expected) => {
  expect(parseComposerInput(draft)).toEqual(expected);
});
