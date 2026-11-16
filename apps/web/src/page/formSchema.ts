type Limits = { minimum?: number; maximum?: number; multipleOf?: number; minLength?: number; maxLength?: number };
export type FormField =
  | { name: string; kind: "string" | "number" | "integer" | "boolean"; required: boolean; description?: string } & Limits
  | { name: string; kind: "enum"; required: boolean; description?: string; options: unknown[] };

export type FormValues = Record<string, string | boolean>;

const SCALARS = new Set(["string", "number", "integer", "boolean"]);
const LIMITS = ["minimum", "maximum", "multipleOf", "minLength", "maxLength"] as const;

// The schema is written by an agent, so anything other than a flat object of scalars or enums is refused, not guessed.
export function formFields(schema: unknown, order: string[] = []): { fields: FormField[] } | { unsupported: string } {
  if (!isObject(schema) || schema.type !== "object") return { unsupported: "input" };
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return { unsupported: "input" };
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : []);
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) return { unsupported: name };
    const description = typeof property.description === "string" ? property.description : undefined;
    const base = { name, required: required.has(name), ...(description ? { description } : {}) };
    const limits = Object.fromEntries(LIMITS.filter((key) => typeof property[key] === "number").map((key) => [key, property[key]])) as Limits;
    if (Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every((value) => value === null || typeof value !== "object")) fields.push({ ...base, kind: "enum", options: property.enum });
    else if (typeof property.type === "string" && SCALARS.has(property.type) && !("enum" in property)) fields.push({ ...base, kind: property.type as "string" | "number" | "integer" | "boolean", ...limits });
    else return { unsupported: name };
  }
  // Stored schemas come back with sorted keys, so the block's fields set the order; unlisted inputs follow, required first.
  const listed = order.flatMap((name) => fields.filter((field) => field.name === name));
  const rest = fields.filter((field) => !order.includes(field.name));
  return { fields: [...listed, ...rest.filter((field) => field.required), ...rest.filter((field) => !field.required)] };
}

// Values typed for an older schema carry over to fields that still exist with a value that still fits; the rest start empty.
export function keepValues(fields: FormField[], values: FormValues): FormValues {
  return Object.fromEntries(fields.map((field) => {
    const value = values[field.name];
    const fits = field.kind === "boolean" ? typeof value === "boolean"
      : typeof value === "string" && (field.kind !== "enum" || value === "" || field.options.some((option) => JSON.stringify(option) === value));
    return [field.name, fits ? value : field.kind === "boolean" ? false : ""];
  }));
}

// A selected row fills an update form: each stored value becomes what its input holds (enums are JSON, like their options).
export function recordValues(fields: FormField[], record: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const value = record[field.name];
    if (field.kind === "enum") { if (field.name in record) values[field.name] = JSON.stringify(value); }
    else if (field.kind === "boolean") values[field.name] = value === true;
    else if (value !== null && value !== undefined) values[field.name] = String(value);
  }
  return values;
}

// The client checks what the schema states before the POST, so one submit names every problem, in field order, in plain words.
export function formErrors(fields: FormField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean" || typeof value !== "string") continue;
    if (value === "") { if (field.required) errors[field.name] = field.kind === "enum" ? "pick one" : "required"; continue; }
    if (field.kind === "enum") continue;
    if (field.kind === "string") {
      const length = [...value].length;
      if (field.minLength !== undefined && length < field.minLength) errors[field.name] = `at least ${field.minLength} characters`;
      else if (field.maxLength !== undefined && length > field.maxLength) errors[field.name] = `at most ${field.maxLength} characters`;
      continue;
    }
    const number = value.trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(number)) errors[field.name] = field.kind === "integer" ? "enter a whole number" : "enter a number";
    else if (field.kind === "integer" && !Number.isInteger(number)) errors[field.name] = "enter a whole number";
    else if (field.minimum !== undefined && number < field.minimum) errors[field.name] = fieldError(field, "minimum");
    else if (field.maximum !== undefined && number > field.maximum) errors[field.name] = fieldError(field, "maximum");
  }
  return errors;
}

// The server names a failed schema keyword (expected: "multipleOf"); the user reads the limit in plain words.
// multipleOf is checked only by the server, which does exact decimal math.
export function fieldError(field: FormField, expected: string): string {
  if (field.kind === "enum" || field.kind === "boolean") return expected;
  if (expected === "multipleOf" && field.multipleOf !== undefined) return `use steps of ${field.multipleOf}`;
  if (expected === "minimum" && field.minimum !== undefined) return `must be at least ${field.minimum}`;
  if (expected === "maximum" && field.maximum !== undefined) return `must be at most ${field.maximum}`;
  return expected;
}

// Empty inputs are left out so the server names a missing required field; text that is not a number is sent as is so the server names the type.
export function formArguments(fields: FormField[], values: FormValues): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") { result[field.name] = value === true; continue; }
    const text = typeof value === "string" ? value : "";
    if (text === "") continue;
    if (field.kind === "enum") result[field.name] = JSON.parse(text) as unknown;
    else if (field.kind === "string") result[field.name] = text;
    else result[field.name] = text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
