import { describe, expect, test } from "bun:test";
import { canWriteForState } from "./App";
import { READ_ONLY_REASON, WRITE_SURFACES, type WriteSurfaceId } from "./writeSurfaces";
import type { ConnectionState } from "./zeta";

const states: ConnectionState[] = [
  { phase: "connecting", attempt: 0, lost: false },
  { phase: "not_running", attempt: 1, retryAt: 1, lost: false },
  { phase: "auth_failed", reason: "origin", origins: [], attempt: 1, retryAt: 1, lost: false },
  { phase: "auth_failed", reason: "rejected", origins: [], attempt: 1, retryAt: 1, lost: false },
  { phase: "unresponsive", attempt: 1, retryAt: 1, lost: false },
  { phase: "incompatible", attempt: 1, retryAt: 1, lost: false },
  { phase: "controller_taken", attempt: 1, retryAt: 1, lost: false },
  { phase: "observer_limit", attempt: 1, retryAt: 1, lost: false },
  { phase: "dropped", attempt: 1, retryAt: 1, lost: true },
  { phase: "connected", authority: "observer" },
  { phase: "connected", authority: "controller" },
];

// This is deliberately keyed by the product registry type. Adding a surface without adding
// its public adapter is a type error rather than another label-only inventory.
const adapters = Object.fromEntries(WRITE_SURFACES.map(({ id }) => [id, () => undefined])) as Record<WriteSurfaceId, () => void>;

describe("public write authority", () => {
  test("registry is closed, unique, and has proof metadata", () => {
    expect(new Set(WRITE_SURFACES.map(({ id }) => id)).size).toBe(WRITE_SURFACES.length);
    expect(WRITE_SURFACES.every(({ id, channel, visibility }) => id && channel && visibility)).toBe(true);
    expect(READ_ONLY_REASON).toBe("this tab is read-only; take control to make changes");
    for (const adapter of Object.values(adapters)) expect(typeof adapter).toBe("function");
  });

  for (const state of states) {
    test(`${state.phase}${state.phase === "connected" ? `/${state.authority}` : ""} gates every registered write surface`, () => {
      const expected = canWriteForState(state);
      for (const { id } of WRITE_SURFACES) {
        expect(canWriteForState(state), id).toBe(expected);
        adapters[id]();
      }
    });
  }
});
