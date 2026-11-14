import { expect, test } from "bun:test";
import { deliverChatMessage } from "../useActiveChat";
import { createComposerDelivery, type ComposerDelivery } from "./useComposerDelivery";

type Scenario = {
  name: string;
  state: "idle" | "steerable";
  statuses?: Array<{ status: string; outcome?: string }>;
  statusReads?: number;
  timeout?: boolean;
  remount?: boolean;
  race?: "send-to-steer" | "steer-to-send" | "double-rejection";
  expectedMethods?: Array<"send" | "steer">;
  expectedDraft: string;
  expectedError?: string;
};

const scenarios: Scenario[] = [
  { name: "send ok", state: "idle", expectedDraft: "" },
  { name: "send rejected after turn starts", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "delivered" }], statusReads: 1, expectedDraft: "" },
  { name: "steer rejected after turn ends", state: "steerable", race: "steer-to-send", expectedMethods: ["steer", "send"], expectedDraft: "" },
  { name: "fallback is not retried", state: "idle", race: "double-rejection", expectedMethods: ["send", "steer"], expectedDraft: "keep this exact draft", expectedError: "could not send: no turn is running" },
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
  const methods: Array<{ method: "send" | "steer"; deliveryId: string }> = [];

  const client = {
    request: async (method: string, params?: { delivery_id?: string }) => {
      if (method === "send" || method === "steer") {
        methods.push({ method, deliveryId: params?.delivery_id ?? "" });
        if (scenario.remount && method === "send") await heldSend;
        const firstRace = methods.length === 1 && (
          (scenario.race === "send-to-steer" && method === "send") ||
          ((scenario.race === "steer-to-send" || scenario.race === "double-rejection") && method === "steer") ||
          (scenario.race === "double-rejection" && method === "send")
        );
        if (firstRace || (scenario.race === "double-rejection" && methods.length === 2)) {
          const error = new Error(method === "send" ? "a turn is already running" : "no turn is running") as Error & { code: number };
          error.code = method === "send" ? -32004 : -32005;
          throw error;
        }
        return { accepted: true };
      }
      if (method !== "delivery_status") throw new Error(`unexpected ${method}`);
      statusReads += 1;
      const status = statuses.shift() ?? { status: "queued" };
      if (scenario.timeout) now += 20_000;
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
      await deliverChatMessage(client as never, "session", text, "delivery-1", intent.steer, track);
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
    if (scenario.expectedMethods) {
      expect(methods.map(({ method }) => method)).toEqual(scenario.expectedMethods);
      expect(new Set(methods.map(({ deliveryId }) => deliveryId)).size).toBe(1);
    }
  } finally {
    Date.now = originalNow;
    releaseSend?.();
  }
});
