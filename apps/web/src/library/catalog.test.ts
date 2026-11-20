import { expect, test } from "bun:test";
import { projectCatalog } from "./catalog";

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
const safeSkill = { ...summary, keywords: ["cards"] };
const safeProfile = { ...summary, model: null, tools: null, maxTurns: null, allowDelegation: false, acceptsFollowUps: true, explicitFinish: false };
const rows = [
  { label: "full status envelope", input: full,
    skills: { state: "data", rows: [{ ...safeSkill, name: "count", source: "project" }, safeSkill, { ...safeSkill, name: "sort", source: "packaged" }] },
    profiles: { state: "data", rows: [{ ...safeProfile, name: "review", source: "project", tools: ["read"], model: "sample-model", maxTurns: 10 }, safeProfile] } },
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
