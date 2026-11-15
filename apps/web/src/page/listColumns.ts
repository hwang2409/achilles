import type { PageTool } from "./usePageTools";

// A list block without fields shows the collection's data schema: required fields first, then the rest sorted.
// The newest record never decides the order, and record_id/revision are storage, not columns.
export function schemaColumns(tools: PageTool[], collection: string): string[] {
  const required: string[] = [];
  const rest = new Set<string>();
  for (const tool of tools) {
    const schema = tool.data_schema as { properties?: unknown; required?: unknown } | undefined;
    if (tool.collection !== collection || !schema || typeof schema !== "object") continue;
    if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === "string" && !required.includes(name)) required.push(name);
    if (schema.properties && typeof schema.properties === "object") for (const name of Object.keys(schema.properties)) rest.add(name);
  }
  return [...required, ...[...rest].filter((name) => !required.includes(name)).sort()];
}

// Records with no schema to go by (no tool for the collection) still read the same on every load.
export function recordColumns(records: Record<string, unknown>[]): string[] {
  return [...new Set(records.flatMap(Object.keys))].filter((key) => key !== "record_id" && key !== "revision").sort();
}
