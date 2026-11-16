import { describe, expect, test } from "bun:test";
import { composerHintSegments, fitHintSegments } from "./hint";

describe("composer hint", () => {
  test.each([
    ["idle", "enter send"],
    ["steerable", "enter steer"],
    ["idle", "enter answer", true],
  ] as const)("names the current enter action for %s", (state, first, questionWaiting = false) => {
    expect(composerHintSegments({ state, mode: "plain", questionWaiting })[0]).toBe(first);
  });

  test.each([
    [300, ["enter send", "shift+enter new line"]],
    [100, ["enter send"]],
  ])("keeps whole segments at %spx", (width, expected) => {
    expect(fitHintSegments(["enter send", "shift+enter new line", "esc normal"], width)).toEqual(expected);
  });
});
