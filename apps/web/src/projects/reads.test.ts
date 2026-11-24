import { expect, test } from "bun:test";
import { canAcceptMemory, projectInbox, projectKindText, projectMemory, projectMemoryEntry, projectMemoryRevision, projectMessage, projectProjects } from "./reads";

// Synthetic zeta replies with extra fields the projection must drop.
const project = { project_id: "p_fixture", name: "cards", path: "/fixture/cards", session_count: 2, memory_count: 3, inbox: { new: 1, claimed: 0, done: 4, extra: 1 }, updated_ns: 1, extra: "x" };
const safeProject = { id: "p_fixture", name: "cards", path: "/fixture/cards", sessions: 2, memory: 3, inbox: { new: 1, claimed: 0, done: 4 } };
const memory = { memory_id: "m_1", project_id: "p_fixture", kind: "decision", automatic: true, summary: "Use plain cards.", created_ns: 1, updated_ns: 2, source_session_id: "s", has_body: true, body: "leak" };
const safeMemory = { id: "m_1", kind: "decision", automatic: true, accepted: null, summary: "Use plain cards.", sourceSession: "s" };
const message = { message_id: "a1", project_id: "p_fixture", kind: "change_request", status: "new", sender: "p_other", summary: "Sort the cards", created_ns: 5, updated_ns: 5, trusted_assignment: true, has_body: true, body: "leak" };
const safeMessage = { id: "a1", kind: "change_request", status: "new", sender: "p_other", summary: "Sort the cards", createdNs: 5, trusted: true, hasBody: true };
const page = (items: unknown[], next_cursor: unknown = null) => ({ items, next_cursor, as_of_ns: 9 });

const revision = { digest: "a".repeat(64), version_id: "v", schema_version: 1,
  kinds: [{ key: "brief", rendered: "not retained", rendered_truncated: false }], extra: "not retained" };
const rows = [
  { label: "memory preserves null source", read: () => projectMemory(page([{ ...memory, source_session_id: null }])),
    expected: { rows: [{ ...safeMemory, sourceSession: null }], nextCursor: null, oldFormat: false } },
  { label: "memory rejects a non-string source", read: () => projectMemory(page([{ ...memory, source_session_id: {} }])), expected: null },
  { label: "revision drops rendered text", read: () => projectMemoryRevision({ memory: revision }), expected: { digest: revision.digest, versionId: "v" } },
  { label: "revision rejects format 1", read: () => projectMemoryRevision({ memory: { digest: revision.digest, files: [] } }), expected: null },
  { label: "revision rejects malformed kind", read: () => projectMemoryRevision({ memory: { ...revision, kinds: [{ key: "brief", rendered: {} }] } }), expected: null },
  { label: "revision rejects malformed digest", read: () => projectMemoryRevision({ memory: { ...revision, digest: revision.digest + "\n" } }), expected: null },
  { label: "project page", read: () => projectProjects(page([project], "c2")), expected: { rows: [safeProject], nextCursor: "c2" } },
  { label: "project without a folder", read: () => projectProjects(page([{ ...project, path: null }])), expected: { rows: [{ ...safeProject, path: null }], nextCursor: null } },
  { label: "project with a negative count", read: () => projectProjects(page([{ ...project, session_count: -1 }])), expected: null },
  { label: "page without items", read: () => projectProjects({ next_cursor: null }), expected: null },
  { label: "format 2 memory page", read: () => projectMemory(page([memory])), expected: { rows: [safeMemory], nextCursor: null, oldFormat: false } },
  { label: "format 1 memory page", read: () => projectMemory(page([{ ...memory, memory_id: "brief.md", kind: "legacy", automatic: false, has_body: true }])),
    expected: { rows: [{ ...safeMemory, id: "brief.md", kind: "legacy", automatic: false }], nextCursor: null, oldFormat: true } },
  { label: "memory of an unknown kind", read: () => projectMemory(page([{ ...memory, kind: "people" }])), expected: null },
  { label: "inbox page", read: () => projectInbox(page([message])), expected: { rows: [safeMessage], nextCursor: null } },
  { label: "inbox with a real nanosecond time", read: () => projectInbox(page([{ ...message, created_ns: 1795175233062711000 }])), expected: { rows: [{ ...safeMessage, createdNs: 1795175233062711000 }], nextCursor: null } },
  { label: "inbox of an unknown status", read: () => projectInbox(page([{ ...message, status: "read" }])), expected: null },
  { label: "inbox with a string trust flag", read: () => projectInbox(page([{ ...message, trusted_assignment: "yes" }])), expected: null },
  { label: "kind text keeps one kind", read: () => projectKindText({ project: { id: "p_fixture" }, memory: { digest: "d".repeat(64), version_id: "v", kinds: [
      { key: "brief", rendered: "# Brief", rendered_truncated: false }, { key: "decisions", rendered: "# Decisions\n", rendered_truncated: true, active_count: 1 }] } }, "decision"),
    expected: { text: "# Decisions\n", truncated: true, digest: "d".repeat(64) } },
  { label: "kind text missing from the reply", read: () => projectKindText({ memory: { digest: "d", kinds: [] } }, "brief"), expected: null },
  { label: "message body", read: () => projectMessage({ message, body: "Please sort.", truncated: false, extra: 1 }, "a1"), expected: { text: "Please sort.", truncated: false } },
  { label: "message body for another id", read: () => projectMessage({ message, body: "Please sort.", truncated: false }, "b2"), expected: null },
];

test.each(rows)("projects $label without retaining unlisted fields", ({ read, expected }) => {
  expect(read()).toStrictEqual(expected);
});

// Both the button and the write owner use the same eligibility rule on projected input.
test.each([
  { label: "absent", accepted: undefined, projected: null, eligible: false },
  { label: "already accepted", accepted: true, projected: true, eligible: false },
  { label: "unaccepted", accepted: false, projected: false, eligible: true },
])("memory accept eligibility: $label", ({ accepted, projected, eligible }) => {
  const [row] = projectMemory(page([{ ...memory, accepted }]))!.rows;
  expect(row?.accepted).toBe(projected);
  expect(canAcceptMemory(row!)).toBe(eligible);
});

test("full memory entry only accepts the requested entry", () => {
  const reply = { memory: { memory_id: "entry" }, body: "# Note\n\nUse `code`.", truncated: false };
  expect(projectMemoryEntry(reply, "entry")).toEqual({ text: reply.body, truncated: false });
  expect(projectMemoryEntry(reply, "other")).toBeNull();
});
