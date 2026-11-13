import { describe, expect, test } from "bun:test";
import { defaultSettings, parseSettings } from "./settings";

describe("parseSettings", () => {
  test("falls back per field for malformed browser storage", () => {
    expect(parseSettings("not json")).toEqual(defaultSettings);
    expect(parseSettings(JSON.stringify({
      v: 99,
      theme: "not-a-theme",
      uiFont: "inter",
      codeFont: 42,
      size: 99,
      density: "compact",
      vim: "yes",
      autoApproveDefault: false,
      unknown: "ignored",
    }))).toEqual({
      ...defaultSettings,
      uiFont: "inter",
      density: "compact",
      autoApproveDefault: false,
    });
    expect(parseSettings(JSON.stringify({ uiFont: "constructor", codeFont: "__proto__" }))).toEqual(defaultSettings);
    expect(parseSettings(JSON.stringify(["gruvbox-light"]))).toEqual(defaultSettings);
  });
});
