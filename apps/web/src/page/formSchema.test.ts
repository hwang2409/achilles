import { expect, test } from "bun:test";
import { formArguments, formFields, type FormField, type FormValues } from "./formSchema";

const rows: [string, unknown, ReturnType<typeof formFields>][] = [
  ["flat scalars with required marks", { type: "object", properties: { title: { type: "string", description: "book title" }, pages: { type: "integer" }, rating: { type: "number" }, done: { type: "boolean" } }, required: ["title", "pages"] }, { fields: [
    { name: "title", kind: "string", required: true, description: "book title" },
    { name: "pages", kind: "integer", required: true },
    { name: "rating", kind: "number", required: false },
    { name: "done", kind: "boolean", required: false },
  ] }],
  ["enum with or without a type", { type: "object", properties: { status: { type: "string", enum: ["to read", "done"] }, stars: { enum: [1, 2, 3] } }, required: ["status"] }, { fields: [
    { name: "status", kind: "enum", required: true, options: ["to read", "done"] },
    { name: "stars", kind: "enum", required: false, options: [1, 2, 3] },
  ] }],
  ["required fields lead, the rest keep their order", { type: "object", properties: { author: { type: "string" }, favorite: { type: "boolean" }, title: { type: "string" } }, required: ["title"] }, { fields: [
    { name: "title", kind: "string", required: true },
    { name: "author", kind: "string", required: false },
    { name: "favorite", kind: "boolean", required: false },
  ] }],
  ["no properties", { type: "object" }, { fields: [] }],
  ["nested object", { type: "object", properties: { title: { type: "string" }, meta: { type: "object", properties: {} } } }, { unsupported: "meta" }],
  ["array", { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }, { unsupported: "tags" }],
  ["type list", { type: "object", properties: { note: { type: ["string", "null"] } } }, { unsupported: "note" }],
  ["empty enum", { type: "object", properties: { mode: { type: "string", enum: [] } } }, { unsupported: "mode" }],
  ["object enum values", { type: "object", properties: { mode: { enum: [{ a: 1 }] } } }, { unsupported: "mode" }],
  ["untyped property", { type: "object", properties: { anything: {} } }, { unsupported: "anything" }],
  ["top level not an object", { type: "array" }, { unsupported: "input" }],
  ["top level oneOf", { oneOf: [{ type: "object" }] }, { unsupported: "input" }],
];

test.each(rows)("formFields: %s", (_name, schema, expected) => {
  expect(formFields(schema)).toEqual(expected);
});

const argumentRows: [string, FormField[], FormValues, Record<string, unknown>][] = [
  ["enum sends the selected value, not its index", [{ name: "status", kind: "enum", required: true, options: ["to read", "done"] }], { status: JSON.stringify("done") }, { status: "done" }],
  ["empty string and empty enum selection are omitted", [{ name: "title", kind: "string", required: true }, { name: "stars", kind: "enum", required: false, options: [1, 2, 3] }], { title: "", stars: "" }, {}],
];

test.each(argumentRows)("formArguments: %s", (_name, fields, values, expected) => {
  expect(formArguments(fields, values)).toEqual(expected);
});
