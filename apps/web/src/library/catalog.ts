export const sourceTiers = ["project", "home", "packaged"] as const;
type Source = typeof sourceTiers[number];

type Summary = { name: string; description: string; source: Source };
type Skill = Summary & { keywords: string[] };
type Profile = Summary & {
  tools: string[] | null;
  model: string | null;
  allowDelegation: boolean;
  acceptsFollowUps: boolean;
  explicitFinish: boolean;
  maxTurns: number | null;
};
export type CatalogRow = Skill | Profile;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const adapters = {
  skills: {
    key: "skill_catalog",
    fields: (row: Record<string, unknown>, summary: Summary): Skill | null =>
      strings(row.keywords) ? { ...summary, keywords: [...row.keywords] } : null,
  },
  "agent-profiles": {
    key: "agent_catalog",
    fields: (row: Record<string, unknown>, summary: Summary): Profile | null => {
      const { tools, model, allow_delegation, accepts_follow_ups, explicit_finish, max_turns } = row;
      if (!(tools === null || strings(tools)) || !(model === null || typeof model === "string") ||
          typeof allow_delegation !== "boolean" || typeof accepts_follow_ups !== "boolean" ||
          typeof explicit_finish !== "boolean" ||
          !(max_turns === null || (typeof max_turns === "number" && Number.isSafeInteger(max_turns) && max_turns > 0))) return null;
      return { ...summary, tools: tools === null ? null : [...tools], model, allowDelegation: allow_delegation,
        acceptsFollowUps: accepts_follow_ups, explicitFinish: explicit_finish, maxTurns: max_turns };
    },
  },
};
export type LibraryKind = keyof typeof adapters;
export type Catalog = { state: "data"; rows: CatalogRow[] } | { state: "empty" | "no-session" | "invalid" };

// Keep only display metadata; never retain the status envelope or raw rows.
export function projectCatalog(status: unknown, kind: LibraryKind): Catalog {
  if (!record(status)) return { state: "invalid" };
  if (status.session === null) return { state: "no-session" };
  if (!record(status.session)) return { state: "invalid" };
  const adapter = adapters[kind];
  const catalog = status.session[adapter.key];
  if (catalog === null || catalog === undefined) return { state: "empty" };
  if (!Array.isArray(catalog)) return { state: "invalid" };
  if (!catalog.length) return { state: "empty" };

  const rows: CatalogRow[] = [];
  const names = new Set<string>();
  for (const row of catalog) {
    if (!record(row)) return { state: "invalid" };
    const { name, description } = row;
    const source = sourceTiers.find((tier) => tier === row.source);
    if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !source || names.has(name)) {
      return { state: "invalid" };
    }
    const item = adapter.fields(row, { name, description, source });
    if (!item) return { state: "invalid" };
    rows.push(item);
    names.add(name);
  }
  return { state: "data", rows: rows.sort((a, b) => sourceTiers.indexOf(a.source) - sourceTiers.indexOf(b.source)) };
}
