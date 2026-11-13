import { describe, expect, test } from "bun:test";
import type { SessionLease } from "@fulcrum/zeta";
import { createAttachmentOwner } from "./useActiveChat";

const lease = (name: string) => ({ name }) as unknown as SessionLease;

describe("attachment ownership", () => {
  test.each([
    { name: "success", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const token = owner.begin("chat-a"); owner.accept(token, lease("a")); owner.clear(); }, releases: 1 },
    { name: "switch during load", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const old = owner.begin("chat-a"); const next = owner.begin("chat-b"); owner.accept(old, lease("a")); owner.accept(next, lease("b")); owner.clear(); }, releases: 2 },
    { name: "reconnect during load", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const old = owner.begin("chat-a"); const next = owner.begin("chat-a", true); owner.accept(old, lease("old")); owner.accept(next, lease("new")); owner.clear(); }, releases: 2 },
    { name: "failure", run: (owner: ReturnType<typeof createAttachmentOwner>) => { owner.begin("chat-a"); owner.clear(); }, releases: 0 },
    { name: "duplicate select", run: (owner: ReturnType<typeof createAttachmentOwner>) => { const first = owner.begin("chat-a"); owner.accept(first, lease("a")); expect(owner.begin("chat-a")).toBe(first); owner.clear(); }, releases: 1 },
  ])("releases the owned lease exactly once after $name", ({ run, releases }) => {
    const released: SessionLease[] = [];
    const owner = createAttachmentOwner((value) => released.push(value));
    run(owner);
    expect(released).toHaveLength(releases);
    expect(new Set(released).size).toBe(releases);
  });
});
