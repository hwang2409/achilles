import { expect, test } from "bun:test";
import { confirmSteerDelivery } from "../useActiveChat";
import { createComposerDelivery, type ComposerDelivery } from "./useComposerDelivery";

type Scenario = {
  name: string;
  state: "idle" | "steerable";
  statuses?: Array<{ status: string; outcome?: string }>;
  statusReads?: number;
  timeout?: boolean;
  remount?: boolean;
  expectedDraft: string;
  expectedError?: string;
};

const scenarios: Scenario[] = [
  { name: "send ok", state: "idle", expectedDraft: "" },
  { name: "steer consumed", state: "steerable", statuses: [{ status: "delivered" }], statusReads: 1, expectedDraft: "" },
  {
    name: "steer dropped",
    state: "steerable",
    statuses: [{ status: "queued" }, { status: "dropped" }],
    statusReads: 2,
    expectedDraft: "keep this exact draft",
    expectedError: "could not steer: message was not sent",
  },
  {
    name: "steer remains queued after bounded wait",
    state: "steerable",
    statuses: [{ status: "queued" }],
    statusReads: 1,
    timeout: true,
    expectedDraft: "keep this exact draft",
    expectedError: "could not steer: this message may not have been sent yet. it may still arrive with your next message.",
  },
  { name: "steer evicted after consumption", state: "steerable", statuses: [{ status: "evicted", outcome: "delivered" }], statusReads: 1, expectedDraft: "" },
  { name: "reload or remount during delivery", state: "idle", remount: true, expectedDraft: " plus new" },
  { name: "duplicate queued echo", state: "steerable", statuses: [{ status: "queued" }, { status: "delivered" }], statusReads: 2, expectedDraft: "" },
];

test.each(scenarios)("delivery owner: $name", async (scenario) => {
  const originalNow = Date.now;
  let now = 1_000;
  let persisted = "keep this exact draft";
  let remounted: ComposerDelivery | undefined;
  let releaseSend: (() => void) | undefined;
  const heldSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  const statuses = [...(scenario.statuses ?? [])];
  let statusReads = 0;

  const client = {
    request: async (method: string) => {
      if (method === "send") {
        if (scenario.remount) await heldSend;
        return { accepted: true };
      }
      if (method !== "delivery_status") throw new Error(`unexpected ${method}`);
      statusReads += 1;
      const status = statuses.shift() ?? { status: "queued" };
      if (scenario.timeout) now += 2_000;
      return status;
    },
  };

  const options = {
    state: scenario.state,
    defaultValue: persisted,
    onDraftChange: (text: string) => { persisted = text; },
    onDeliveryConfirm: (sent: string) => {
      persisted = persisted.startsWith(sent) ? persisted.slice(sent.length) : persisted;
      remounted?.sync(scenario.state, persisted);
    },
    onSubmit: async (text: string, intent: { steer: boolean }, track: (id: string) => void) => {
      const id = "delivery-1";
      track(id);
      if (intent.steer) await confirmSteerDelivery(client as never, "session", text, id, track, 1_000);
      else await client.request("send");
    },
  };
  const owner = createComposerDelivery(options);

  try {
    if (scenario.timeout) Date.now = () => now;
    const pending = owner.submit();
    if (scenario.remount) {
      remounted = createComposerDelivery({ ...options, defaultValue: persisted });
      remounted.edit("keep this exact draft plus new");
      releaseSend?.();
    }
    await pending;

    expect(owner.getModel().draft).toBe(scenario.remount ? "" : scenario.expectedDraft);
    expect(persisted).toBe(scenario.expectedDraft);
    expect(owner.getModel().error?.text).toBe(scenario.expectedError);
    if (scenario.remount) expect(remounted?.getModel().draft).toBe(scenario.expectedDraft);
    if (scenario.statusReads) expect(statusReads).toBe(scenario.statusReads);
  } finally {
    Date.now = originalNow;
    releaseSend?.();
  }
});
