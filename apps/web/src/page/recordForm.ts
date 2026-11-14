export type FormValue = string | boolean;
export type FormField = {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  format?: "uri" | "date";
  required: boolean;
  defaultValue?: FormValue;
  options?: Array<{ label: string; value: string; argument: unknown }>;
};
export type RecordForm = { fields: FormField[]; fallback: string | null };
export type FieldErrors = Record<string, string>;
export type ToolError = { code?: unknown; path?: unknown; expected?: unknown };

const hiddenFields = new Set(["record_id", "revision"]);
const composites = ["oneOf", "anyOf", "allOf", "$ref"] as const;
const unsupported = (name: string): RecordForm => ({ fields: [], fallback: `this form needs the chat: unsupported field ${name}` });

function defaultValue(schema: Record<string, unknown>, type: FormField["type"]): FormValue | undefined {
  if (!("default" in schema)) return undefined;
  if (type === "boolean" && typeof schema.default === "boolean") return schema.default;
  if (typeof schema.default === "string" || typeof schema.default === "number") return String(schema.default);
  return undefined;
}

export function recordForm(schema: unknown): RecordForm {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return unsupported("form");
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" || composites.some((key) => key in root) || !root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) return unsupported("form");
  const required = new Set(Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === "string") : []);
  const fields: FormField[] = [];
  for (const [name, value] of Object.entries(root.properties)) {
    if (hiddenFields.has(name)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) return unsupported(name);
    const field = value as Record<string, unknown>;
    if (composites.some((key) => key in field) || field.type === "object" || field.type === "array") return unsupported(name);
    if (Array.isArray(field.enum)) {
      const options = field.enum.map((argument) => ({ label: String(argument), value: JSON.stringify(argument), argument }));
      if (options.some(({ argument }) => argument !== null && !["string", "number", "boolean"].includes(typeof argument))) return unsupported(name);
      fields.push({ name, type: "enum", required: required.has(name), defaultValue: "default" in field ? JSON.stringify(field.default) : undefined, options });
      continue;
    }
    if (!["string", "number", "integer", "boolean"].includes(String(field.type))) return unsupported(name);
    if (field.format !== undefined && (field.type !== "string" || !["uri", "date"].includes(String(field.format)))) return unsupported(name);
    const type = field.type as FormField["type"];
    fields.push({ name, type, format: field.format as FormField["format"], required: required.has(name), defaultValue: defaultValue(field, type) });
  }
  return { fields, fallback: null };
}

export function formValuesToArguments(fields: FormField[], values: Record<string, FormValue>, hidden: Record<string, unknown> = {}): { arguments: Record<string, unknown>; errors: FieldErrors } {
  const arguments_: Record<string, unknown> = { ...hidden };
  const errors: FieldErrors = {};
  for (const field of fields) {
    const value = values[field.name];
    if ((value === "" || value === undefined) && !field.required) continue;
    if (field.type === "number" || field.type === "integer") {
      const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isInteger(parsed))) {
        errors[field.name] = field.type === "integer" ? "enter a whole number" : "enter a number";
        continue;
      }
      arguments_[field.name] = parsed;
    } else if (field.type === "enum") {
      const option = field.options?.find((candidate) => candidate.value === value);
      if (!option) errors[field.name] = "choose an option";
      else arguments_[field.name] = option.argument;
    } else {
      arguments_[field.name] = value;
    }
  }
  return { arguments: arguments_, errors };
}

export function mapToolError(error: ToolError): { field: string; message: string } | null {
  if (typeof error.path !== "string" || !error.path.startsWith("/") || error.path.slice(1).includes("/")) return null;
  const field = error.path.slice(1);
  if (!field || hiddenFields.has(field)) return null;
  return { field, message: typeof error.expected === "string" ? `expected ${error.expected}` : "invalid value" };
}
