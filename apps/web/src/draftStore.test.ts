import { describe, expect, test } from "bun:test";
import { draftStore } from "./draftStore";

describe("draft store", () => {
  test.each([
    ["vim operator edit survives a composer switch", "operator", ["remove\nkeep", "keep"], "keep"],
    ["confirmed send clears before a composer switch", "sent", ["message", ""], ""],
    ["multiline text survives a composer switch exactly", "multiline", ["first\n\n  third"], "first\n\n  third"],
    ["reconnect reads the session draft", "reconnect", ["kept draft"], "kept draft"],
  ])("%s", (_name, sessionId, writes, expected) => {
    for (const text of writes) draftStore.set(sessionId, text);
    expect(draftStore.get(sessionId)).toBe(expected);
    draftStore.clear(sessionId);
  });

  test("keeps sessions separate and publishes changes", () => {
    const values: string[] = [];
    const unsubscribe = draftStore.subscribe("one", () => values.push(draftStore.get("one")));
    draftStore.set("one", "alpha");
    draftStore.set("two", "beta");
    draftStore.clear("one");
    unsubscribe();
    expect(draftStore.get("two")).toBe("beta");
    expect(values).toEqual(["alpha", ""]);
    draftStore.clear("two");
  });
});
