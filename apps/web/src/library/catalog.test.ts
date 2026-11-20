import { expect, test } from "bun:test";
import { appendPage, projectCatalog, projectCatalogPage } from "./catalog";

const summary = { name: "index-cards", description: "Sorts sample index cards.", source: "home" };
const skill = { ...summary, keywords: ["cards"], path: "/fixture/index-cards/SKILL.md", skills_root: "/fixture/skills", extra: "synthetic unknown" };
const nullable = { model: null, tools: null, max_turns: null };
const profile = {
  ...summary, ...nullable, allow_delegation: false, accepts_follow_ups: true, explicit_finish: false,
  path: "/fixture/agents/index-cards.md", agents_root: "/fixture/agents", preamble: "Synthetic behavior.", prompt_suffix: "Synthetic suffix.",
};
const full = { state: "idle", telemetry: { extra: true }, session: {
  cwd: "/fixture/workspace", session_id: "fixture-session", system_prompt: "Synthetic instructions.", context_files: ["/fixture/context.md"],
  skill_catalog: [
    { ...skill, name: "sort", source: "packaged" }, skill, { ...skill, name: "count", source: "project" },
  ],
  agent_catalog: [profile, { ...profile, name: "review", source: "project", tools: ["read"], model: "sample-model", max_turns: 10 }],
} };
const snapshotFields = { scope: "home", editable: true, diagnostics: null };
const safeSkill = { ...summary, ...snapshotFields, keywords: ["cards"] };
const safeProfile = { ...summary, ...snapshotFields, model: null, tools: null, maxTurns: null, allowDelegation: false, acceptsFollowUps: true, explicitFinish: false };
const packaged = { scope: "effective", editable: false };
const rows = [
  { label: "full status envelope", input: full,
    skills: { state: "data", rows: [{ ...safeSkill, name: "count", source: "project", scope: "project" }, safeSkill, { ...safeSkill, name: "sort", source: "packaged", ...packaged }] },
    profiles: { state: "data", rows: [{ ...safeProfile, name: "review", source: "project", scope: "project", tools: ["read"], model: "sample-model", maxTurns: 10 }, safeProfile] } },
  { label: "no active session", input: { session: null }, skills: { state: "no-session" }, profiles: { state: "no-session" } },
  { label: "missing catalogs", input: { session: {} }, skills: { state: "empty" }, profiles: { state: "empty" } },
  { label: "null catalogs", input: { session: { skill_catalog: null, agent_catalog: null } }, skills: { state: "empty" }, profiles: { state: "empty" } },
  { label: "wrong envelope type", input: { session: [] }, skills: { state: "invalid" }, profiles: { state: "invalid" } },
  { label: "wrong catalog type", input: { session: { skill_catalog: {}, agent_catalog: false } }, skills: { state: "invalid" }, profiles: { state: "invalid" } },
  { label: "wrong metadata types", input: { session: { skill_catalog: [{ ...skill, keywords: [1] }], agent_catalog: [{ ...profile, explicit_finish: "yes" }] } }, skills: { state: "invalid" }, profiles: { state: "invalid" } },
  { label: "empty lists", input: { session: { skill_catalog: [], agent_catalog: [] } }, skills: { state: "empty" }, profiles: { state: "empty" } },
  { label: "unknown source tier", input: { session: { skill_catalog: [{ ...skill, source: "other" }], agent_catalog: [profile] } }, skills: { state: "invalid" }, profiles: { state: "data", rows: [safeProfile] } },
];

test.each(rows)("projects $label without retaining unlisted fields", ({ input, skills, profiles }) => {
  expect(projectCatalog(input, "skills")).toStrictEqual(skills);
  expect(projectCatalog(input, "agent-profiles")).toStrictEqual(profiles);
});

// library_read_v1 catalog pages (newer zeta).
const current = { scope: "home", editable: true, filename: "index-cards/SKILL.md", diagnostics: [] };
const page = (items: unknown[], next_offset?: number) => ({ revision: "r", data: { items, ...(next_offset === undefined ? {} : { next_offset }) } });
const currentSkill = { ...skill, ...current };
const currentProfile = { ...profile, ...current, filename: null };
const kept = { ...summary, scope: "home", editable: true, diagnostics: { items: [], more: 0 } };
const pageRows = [
  { label: "skill page with next offset", kind: "skills", input: page([currentSkill, { ...currentSkill, name: "sort", source: "packaged", scope: "effective", editable: true }], 2),
    expected: { state: "data", nextOffset: 2, rows: [{ ...kept, keywords: ["cards"] }, { ...kept, keywords: ["cards"], name: "sort", source: "packaged", scope: "effective", editable: false }] } },
  { label: "profile page at the end", kind: "agent-profiles", input: page([currentProfile]),
    expected: { state: "data", nextOffset: null, rows: [{ ...kept, model: null, tools: null, maxTurns: null, allowDelegation: false, acceptsFollowUps: true, explicitFinish: false }] } },
  { label: "diagnostics bounded to five plus a count", kind: "skills",
    input: page([{ ...currentSkill, diagnostics: ["a", { message: "b" }, "c", "d", "x".repeat(900), "f", "g"] }]),
    expected: { state: "data", nextOffset: null, rows: [{ ...kept, keywords: ["cards"], diagnostics: { items: ["a", "b", "c", "d", "x".repeat(500)], more: 2 } }] } },
  { label: "missing data", kind: "skills", input: { revision: "r" }, expected: { state: "invalid" } },
  { label: "bad next offset", kind: "skills", input: page([currentSkill], -1), expected: { state: "invalid" } },
  { label: "missing editable", kind: "skills", input: page([{ ...currentSkill, editable: undefined }]), expected: { state: "invalid" } },
  { label: "unknown scope", kind: "skills", input: page([{ ...currentSkill, scope: "global" }]), expected: { state: "invalid" } },
  { label: "malformed diagnostic", kind: "skills", input: page([{ ...currentSkill, diagnostics: [{ path: "/fixture" }] }]), expected: { state: "invalid" } },
  { label: "duplicate name", kind: "agent-profiles", input: page([currentProfile, currentProfile]), expected: { state: "invalid" } },
  { label: "malformed profile row", kind: "agent-profiles", input: page([{ ...currentProfile, max_turns: 0 }]), expected: { state: "invalid" } },
] as const;

test.each(pageRows)("projects catalog page: $label", ({ input, kind, expected }) => {
  expect(projectCatalogPage(input, kind)).toStrictEqual(expected);
});

test("load more appends the next page, keeps the first row per name, and groups by source", () => {
  const first = projectCatalogPage(page([{ ...currentSkill, name: "b" }], 1), "skills");
  const second = projectCatalogPage(page([{ ...currentSkill, name: "b", description: "moved" }, { ...currentSkill, name: "a", source: "project", scope: "project" }]), "skills");
  if (first.state !== "data" || second.state !== "data") throw new Error("fixture pages must project");
  expect(appendPage(appendPage([], first.rows), second.rows).map(({ name, description }) => [name, description]))
    .toStrictEqual([["a", summary.description], ["b", summary.description]]);
});
