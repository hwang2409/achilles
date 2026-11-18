import { describe, expect, test } from "bun:test";
import { canWriteForState } from "./App";
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

const writeSurfaces = ["composer", "settings", "local storage", "page forms", "approvals", "actions", "retries", "passive writes"];

describe("public write authority", () => {
  for (const state of states) {
    test(`${state.phase}${state.phase === "connected" ? `/${state.authority}` : ""} gates every write surface`, () => {
      const expected = state.phase === "connected" && state.authority === "controller";
      for (const surface of writeSurfaces) expect(canWriteForState(state), surface).toBe(expected);
    });
  }
});
