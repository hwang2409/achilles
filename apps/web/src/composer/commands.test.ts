import { expect, test } from "bun:test";
import { parseComposerInput, slashMatches } from "./commands";

test.each([
  ["/accounts", { kind: "command", name: "accounts", arg: "" }],
  ["/accounts anthropic:personal", { kind: "command", name: "accounts", arg: "anthropic:personal" }],
  ["/usr/bin", { kind: "send", text: "/usr/bin" }],
  ["/usr/bin is missing", { kind: "send", text: "/usr/bin is missing" }],
  ["/nope", { kind: "command", name: "nope", arg: "" }],
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

const rows = [{ name: "help" }, { name: "compact" }, { name: "accounts" }];
test.each([
  ["/", ["help", "compact", "accounts"]],
  ["/c", ["compact"]],
  ["/HE", ["help"]],
  ["/nope", null],
  ["/help now", null],
  ["//help", null],
  ["help", null],
  ["", null],
] as const)("slashMatches(%p)", (draft, expected) => {
  expect(slashMatches(draft, rows)?.map((row) => row.name) ?? null).toEqual(expected as string[] | null);
});

test("no list yet shows no menu", () => {
  expect(slashMatches("/", null)).toBeNull();
});
