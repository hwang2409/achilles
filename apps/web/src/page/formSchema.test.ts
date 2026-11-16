import { expect, test } from "bun:test";
import { fieldError, formArguments, formErrors, formFields, keepValues, type FormField, type FormValues } from "./formSchema";

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
  ["numeric and length limits are kept for the client check", { type: "object", properties: { pages: { type: "integer", minimum: 1 }, rating: { type: "number", minimum: 0, maximum: 5 }, title: { type: "string", minLength: 1, maxLength: 80 } } }, { fields: [
    { name: "pages", kind: "integer", required: false, minimum: 1 },
    { name: "rating", kind: "number", required: false, minimum: 0, maximum: 5 },
    { name: "title", kind: "string", required: false, minLength: 1, maxLength: 80 },
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

test("formFields: block fields set the input order; unlisted inputs follow, required first; unknown names are skipped", () => {
  const schema = { type: "object", properties: { author: { type: "string" }, pages: { type: "integer" }, status: { type: "string" }, title: { type: "string" } }, required: ["title"] };
  const result = formFields(schema, ["status", "gone", "author"]);
  expect("fields" in result && result.fields.map((field) => field.name)).toEqual(["status", "author", "title", "pages"]);
});

const argumentRows: [string, FormField[], FormValues, Record<string, unknown>][] = [
  ["enum sends the selected value, not its index", [{ name: "status", kind: "enum", required: true, options: ["to read", "done"] }], { status: JSON.stringify("done") }, { status: "done" }],
  ["empty string and empty enum selection are omitted", [{ name: "title", kind: "string", required: true }, { name: "stars", kind: "enum", required: false, options: [1, 2, 3] }], { title: "", stars: "" }, {}],
];

test.each(argumentRows)("formArguments: %s", (_name, fields, values, expected) => {
  expect(formArguments(fields, values)).toEqual(expected);
});

const books: FormField[] = [
  { name: "title", kind: "string", required: true, minLength: 1, maxLength: 5 },
  { name: "status", kind: "enum", required: true, options: ["reading", "done"] },
  { name: "pages", kind: "integer", required: true, minimum: 1 },
  { name: "rating", kind: "number", required: false, minimum: 0, maximum: 5 },
  { name: "favorite", kind: "boolean", required: false },
];
const filled: FormValues = { title: "dune", status: JSON.stringify("done"), pages: "200", rating: "4.5", favorite: true };

const errorRows: [string, FormValues, Record<string, string>][] = [
  ["empty form names every required field at once, in field order", {}, { title: "required", status: "pick one", pages: "required" }],
  ["valid values pass", filled, {}],
  ["a fraction for an integer", { ...filled, pages: "1.5" }, { pages: "enter a whole number" }],
  ["text for an integer", { ...filled, pages: "abc" }, { pages: "enter a whole number" }],
  ["spaces for a number", { ...filled, rating: "  " }, { rating: "enter a number" }],
  ["below the minimum names the limit", { ...filled, pages: "0" }, { pages: "must be at least 1" }],
  ["above the maximum names the limit", { ...filled, rating: "9" }, { rating: "must be at most 5" }],
  ["too long a text", { ...filled, title: "a longer title" }, { title: "at most 5 characters" }],
  ["an empty optional number is fine", { ...filled, rating: "" }, {}],
  ["several problems keep field order", { title: "", status: "", pages: "0", rating: "9" }, { title: "required", status: "pick one", pages: "must be at least 1", rating: "must be at most 5" }],
];

test.each(errorRows)("formErrors: %s", (_name, values, expected) => {
  const errors = formErrors(books, keepValues(books, values));
  expect(errors).toEqual(expected);
  expect(Object.keys(errors)).toEqual(Object.keys(expected));
});

const keepRows: [string, FormValues, FormValues][] = [
  ["values of fields that still exist stay; new fields start empty", { title: "dune", pages: "200", gone: "x" }, { title: "dune", status: "", pages: "200", rating: "", favorite: false }],
  ["an enum value that is no longer an option is dropped", { status: JSON.stringify("abandoned") }, { title: "", status: "", pages: "", rating: "", favorite: false }],
  ["a value of the wrong kind is dropped", { title: true, favorite: "yes" }, { title: "", status: "", pages: "", rating: "", favorite: false }],
];

test.each(keepRows)("keepValues: %s", (_name, values, expected) => {
  expect(keepValues(books, values)).toEqual(expected);
});

const cents: FormField = { name: "amount", kind: "number", required: true, minimum: 0, multipleOf: 0.01 };
const serverErrorRows: [string, FormField, string, string][] = [
  ["multipleOf names the step", cents, "multipleOf", "use steps of 0.01"],
  ["minimum names the limit", cents, "minimum", "must be at least 0"],
  ["a keyword the schema does not state stays as the server said it", { name: "amount", kind: "number", required: true }, "multipleOf", "multipleOf"],
  ["other server words pass through", cents, "number", "number"],
];

test.each(serverErrorRows)("fieldError: %s", (_name, field, expected, text) => {
  expect(fieldError(field, expected)).toBe(text);
});
