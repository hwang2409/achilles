import type { PageTool } from "./usePageTools";

type DataSchema = { properties?: unknown; required?: unknown };

function dataSchemaOf(tool: PageTool): DataSchema | undefined {
  const schema = tool.data_schema;
  return schema && typeof schema === "object" ? (schema as DataSchema) : undefined;
}

// A list block without fields shows the collection's data schema: required fields first, then the rest sorted.
// The newest record never decides the order, and record_id/revision are storage, not columns.
export function schemaColumns(tools: PageTool[], collection: string): string[] {
  const schemas = tools.filter((tool) => tool.collection === collection).map(dataSchemaOf).filter((schema): schema is DataSchema => schema !== undefined);
  const required = [...new Set(schemas.flatMap((schema) => (Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [])))];
  const rest = new Set(schemas.flatMap((schema) => (schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [])));
  return [...required, ...[...rest].filter((name) => !required.includes(name)).sort()];
}

// Records with no schema to go by (no tool for the collection) still read the same on every load.
export function recordColumns(records: Record<string, unknown>[]): string[] {
  return [...new Set(records.flatMap(Object.keys))].filter((key) => key !== "record_id" && key !== "revision").sort();
}

// A data schema never forbids extra keys, so a stored record can carry fields the schema does not
// name (a partial data_schema, or an input added after the schema was written). Those still show,
// after the schema's own columns, sorted, so a table never hides data the record actually has.
export function extendWithRecordKeys(schema: string[], records: Record<string, unknown>[]): string[] {
  if (schema.length === 0) return recordColumns(records);
  return [...schema, ...recordColumns(records).filter((key) => !schema.includes(key))];
}
