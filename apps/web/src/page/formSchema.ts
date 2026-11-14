export type FormField =
  | { name: string; kind: "string" | "number" | "integer" | "boolean"; required: boolean; description?: string }
  | { name: string; kind: "enum"; required: boolean; description?: string; options: unknown[] };

export type FormValues = Record<string, string | boolean>;

const SCALARS = new Set(["string", "number", "integer", "boolean"]);

// The schema is written by an agent, so anything other than a flat object of scalars or enums is refused, not guessed.
export function formFields(schema: unknown): { fields: FormField[] } | { unsupported: string } {
  if (!isObject(schema) || schema.type !== "object") return { unsupported: "input" };
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return { unsupported: "input" };
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : []);
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isObject(property)) return { unsupported: name };
    const description = typeof property.description === "string" ? property.description : undefined;
    const base = { name, required: required.has(name), ...(description ? { description } : {}) };
    if (Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every((value) => value === null || typeof value !== "object")) fields.push({ ...base, kind: "enum", options: property.enum });
    else if (typeof property.type === "string" && SCALARS.has(property.type) && !("enum" in property)) fields.push({ ...base, kind: property.type as "string" | "number" | "integer" | "boolean" });
    else return { unsupported: name };
  }
  // Stored schemas come back with sorted keys, so the agent's order is lost; required fields lead instead.
  return { fields: [...fields.filter((field) => field.required), ...fields.filter((field) => !field.required)] };
}

export function emptyValues(fields: FormField[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.name, field.kind === "boolean" ? false : ""]));
}

// Empty inputs are left out so the server names a missing required field; text that is not a number is sent as is so the server names the type.
export function formArguments(fields: FormField[], values: FormValues): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") { result[field.name] = value === true; continue; }
    const text = typeof value === "string" ? value : "";
    if (text === "") continue;
    if (field.kind === "enum") result[field.name] = field.options[Number(text)];
    else if (field.kind === "string") result[field.name] = text;
    else result[field.name] = text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
