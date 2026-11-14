import { describe, expect, test } from "bun:test";
import { defaultSettings, parseSettings } from "./settings";

async function moduleMockCalls() {
  const calls: string[] = [];
  for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: import.meta.dir, absolute: true })) {
      if (/mock\s*\.\s*module\s*\(/.test(await Bun.file(path).text())) calls.push(path.replace(`${import.meta.dir}/`, "apps/web/src/"));
    }
  }
  return calls;
}

describe("web test isolation", () => {
  test("injects dependencies instead of replacing shared modules", async () => {
    expect(await moduleMockCalls(), "mock.module leaks across test files; inject the dependency instead").toEqual([]);
  });
});

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
