import { expect, test } from "bun:test";
import { formValuesToArguments, mapToolError, recordForm } from "./recordForm";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

test.each([
  ["string", () => recordForm(objectSchema({ title: { type: "string", default: "draft" } })), { fields: [{ name: "title", type: "string", required: false, defaultValue: "draft" }], fallback: null }],
  ["number", () => recordForm(objectSchema({ score: { type: "number", default: 1.5 } })), { fields: [{ name: "score", type: "number", required: false, defaultValue: "1.5" }], fallback: null }],
  ["integer and required", () => recordForm(objectSchema({ count: { type: "integer" } }, ["count"])), { fields: [{ name: "count", type: "integer", required: true }], fallback: null }],
  ["boolean", () => recordForm(objectSchema({ done: { type: "boolean", default: true } })), { fields: [{ name: "done", type: "boolean", required: false, defaultValue: true }], fallback: null }],
  ["enum", () => recordForm(objectSchema({ state: { enum: ["new", "done"], default: "new" } })), { fields: [{ name: "state", type: "enum", required: false, defaultValue: "\"new\"", options: [{ label: "new", value: "\"new\"", argument: "new" }, { label: "done", value: "\"done\"", argument: "done" }] }], fallback: null }],
  ["uri", () => recordForm(objectSchema({ link: { type: "string", format: "uri" } })), { fields: [{ name: "link", type: "string", format: "uri", required: false }], fallback: null }],
  ["date", () => recordForm(objectSchema({ due: { type: "string", format: "date" } })), { fields: [{ name: "due", type: "string", format: "date", required: false }], fallback: null }],
  ["number parsing and empty optional omission", () => formValuesToArguments(recordForm(objectSchema({ score: { type: "number" }, note: { type: "string" } })).fields, { score: "2.5", note: "" }), { arguments: { score: 2.5 }, errors: {} }],
  ["invalid number", () => formValuesToArguments(recordForm(objectSchema({ score: { type: "number" } })).fields, { score: "secret-not-a-number" }), { arguments: {}, errors: { score: "enter a number" } }],
  ["nested object fallback", () => recordForm(objectSchema({ address: { type: "object", properties: { city: { type: "string" } } } })), { fields: [], fallback: "this form needs the chat: unsupported field address" }],
  ["array fallback", () => recordForm(objectSchema({ tags: { type: "array", items: { type: "string" } } })), { fields: [], fallback: "this form needs the chat: unsupported field tags" }],
  ["oneOf fallback", () => recordForm(objectSchema({ choice: { oneOf: [{ type: "string" }, { type: "number" }] } })), { fields: [], fallback: "this form needs the chat: unsupported field choice" }],
  ["anyOf fallback", () => recordForm(objectSchema({ choice: { anyOf: [{ type: "string" }] } })), { fields: [], fallback: "this form needs the chat: unsupported field choice" }],
  ["allOf fallback", () => recordForm(objectSchema({ choice: { allOf: [{ type: "string" }] } })), { fields: [], fallback: "this form needs the chat: unsupported field choice" }],
  ["ref fallback", () => recordForm(objectSchema({ choice: { $ref: "#/$defs/choice" } })), { fields: [], fallback: "this form needs the chat: unsupported field choice" }],
  ["hidden record metadata", () => recordForm(objectSchema({ record_id: { type: "string" }, revision: { type: "integer" }, title: { type: "string" } }, ["record_id", "revision", "title"])), { fields: [{ name: "title", type: "string", required: true }], fallback: null }],
  ["hidden arguments", () => formValuesToArguments(recordForm(objectSchema({ title: { type: "string" } })).fields, { title: "changed" }, { record_id: "row-1", revision: 3 }), { arguments: { record_id: "row-1", revision: 3, title: "changed" }, errors: {} }],
  ["field error", () => mapToolError({ code: "invalid", path: "/score", expected: "type: number", value: "must-not-echo" } as never), { field: "score", message: "expected type: number" }],
  ["hidden error", () => mapToolError({ code: "conflict", path: "/revision", expected: "current record revision" }), null],
] as const)("record form: %s", (_name, run, expected) => {
  expect(run()).toEqual(expected);
});
