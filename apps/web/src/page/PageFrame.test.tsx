// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import { acceptsBridgeMessage } from "./PageFrame";

const source = {} as Window;
const event = (data: object, origin = "null", eventSource: MessageEventSource | null = source) =>
  ({ data, origin, source: eventSource }) as MessageEvent;
const valid = { pageId: "home", revision: 3, requestId: "1", method: "list", collection: "notes" };

test("accepts only this opaque frame and declared record methods", () => {
  expect(acceptsBridgeMessage(event(valid), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event({ ...valid, method: "insert" }), source, "home", 3)).toBeTrue();
  expect(acceptsBridgeMessage(event(valid, location.origin), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event(valid, "null", {} as Window), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, pageId: "other" }), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, revision: 2 }), source, "home", 3)).toBeFalse();
  expect(acceptsBridgeMessage(event({ ...valid, method: "delete" }), source, "home", 3)).toBeFalse();
});
