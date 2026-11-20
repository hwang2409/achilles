export const sourceTiers = ["project", "home", "packaged"] as const;
type Source = typeof sourceTiers[number];

const scopes = ["effective", "home", "project"] as const;
type Scope = typeof scopes[number];
// Diagnostics are untrusted text: keep the first few, cut each one, and count the rest.
type Bounded<T> = { items: T[]; more: number };
// The status snapshot reports no diagnostics (null); a library_read_v1 row keeps its reasons.
type Diagnostics = Bounded<string> | null;
export type FileProblem = { source: Source; file: string; reason: string };
const ROW_DIAGNOSTICS = 5;
const PAGE_DIAGNOSTICS = 20;
const DIAGNOSTIC_CHARS = 500;

type Summary = { name: string; description: string; source: Source; scope: Scope; editable: boolean; diagnostics: Diagnostics };
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
    catalog: "skill_catalog",
    read: "skill_read",
    write: "skill_write",
    fields: (row: Record<string, unknown>, summary: Summary): Skill | null =>
      strings(row.keywords) ? { ...summary, keywords: [...row.keywords] } : null,
  },
  "agent-profiles": {
    key: "agent_catalog",
    catalog: "agent_profile_catalog",
    read: "agent_profile_read",
    write: "agent_profile_write",
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
// `skipped`: files the loader skipped or a higher tier shadowed (zeta repeats the full list on every page).
export type CatalogPage = { state: "data"; rows: CatalogRow[]; nextOffset: number | null; skipped: Bounded<FileProblem> } | { state: "invalid" };
export const libraryMethods = (kind: LibraryKind) => ({ catalog: adapters[kind].catalog, read: adapters[kind].read, write: adapters[kind].write });

const offset = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bySource = (rows: CatalogRow[]) => rows.sort((a, b) => sourceTiers.indexOf(a.source) - sourceTiers.indexOf(b.source));

function problem(entry: unknown): FileProblem | undefined {
  if (!record(entry) || typeof entry.file !== "string" || typeof entry.reason !== "string") return undefined;
  const source = sourceTiers.find((tier) => tier === entry.source);
  return source && { source, file: entry.file.slice(0, DIAGNOSTIC_CHARS), reason: entry.reason.slice(0, DIAGNOSTIC_CHARS) };
}

// Every entry must be a well-formed {source, file, reason}; one bad entry rejects the list.
function bounded<T>(value: unknown, cap: number, keep: (entry: FileProblem) => T): Bounded<T> | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: T[] = [];
  for (const entry of value) {
    const parsed = problem(entry);
    if (!parsed) return undefined;
    if (items.length < cap) items.push(keep(parsed));
  }
  return { items, more: value.length - items.length };
}

// One library_read_v1 catalog page: keep display metadata only; any malformed row rejects the page.
export function projectCatalogPage(result: unknown, kind: LibraryKind): CatalogPage {
  const data = record(result) ? result.data : undefined;
  // zeta before the page-level list (a6cc1bd8a) omits data.diagnostics: nothing was reported, so show nothing.
  const skipped = record(data) && data.diagnostics !== undefined ? bounded(data.diagnostics, PAGE_DIAGNOSTICS, (entry) => entry) : { items: [], more: 0 };
  if (!record(data) || !Array.isArray(data.items) || !(data.next_offset === undefined || offset(data.next_offset)) || !skipped) return { state: "invalid" };
  const rows: CatalogRow[] = [];
  const names = new Set<string>();
  for (const row of data.items) {
    if (!record(row)) return { state: "invalid" };
    const { name, description, editable } = row;
    const source = sourceTiers.find((tier) => tier === row.source);
    const scope = scopes.find((value) => value === row.scope);
    const found = bounded(row.diagnostics, ROW_DIAGNOSTICS, ({ reason }) => reason);
    if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !source || !scope ||
        typeof editable !== "boolean" || !found || names.has(name)) return { state: "invalid" };
    const item = adapters[kind].fields(row, { name, description, source, scope, editable: editable && source !== "packaged", diagnostics: found });
    if (!item) return { state: "invalid" };
    rows.push(item);
    names.add(name);
  }
  return { state: "data", rows, nextOffset: data.next_offset ?? null, skipped };
}

// Live pages can shift between requests: keep the first row seen for each name.
export const appendPage = (rows: CatalogRow[], page: CatalogRow[]) =>
  bySource([...rows, ...page.filter((row) => !rows.some(({ name }) => name === row.name))]);

// `editable`: zeta's raw file text and the sha256 revision of its bytes; zeta sends `document` only for an unredacted
// file of at most 128 KiB with no secret-like text (zeta adba2fae9), so null means "edit it outside achilles".
export type Body = { text: string; redacted: boolean; truncated: boolean; editable: { revision: string; document: string } | null };
// The body is untrusted user text: keep only the text, its two flags and the editable copy, never the frontmatter.
export function projectBody(result: unknown, name: string): Body | null {
  const data = record(result) ? result.data : undefined;
  if (!record(data) || data.name !== name || typeof data.body !== "string" || typeof data.redacted !== "boolean" ||
      !(data.truncated === undefined || typeof data.truncated === "boolean") || !(data.document === undefined || typeof data.document === "string")) return null;
  const revision = record(result) ? result.revision : undefined;
  const editable = typeof data.document === "string" && typeof revision === "string" && /^[0-9a-f]{64}$/.test(revision)
    ? { revision, document: data.document } : null;
  return { text: data.body, redacted: data.redacted, truncated: data.truncated === true, editable };
}

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
    const item = adapter.fields(row, { name, description, source, scope: source === "packaged" ? "effective" : source,
      editable: source !== "packaged", diagnostics: null });
    if (!item) return { state: "invalid" };
    rows.push(item);
    names.add(name);
  }
  return { state: "data", rows: bySource(rows) };
}
