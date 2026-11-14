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
  editAndRestore?: boolean;
  expectedDraft: string;
  expectedError?: string;
  resendDropped?: boolean;
};

const scenarios: Scenario[] = [
  { name: "send ok", state: "idle", expectedDraft: "" },
  { name: "send rejected after turn starts", state: "idle", race: "send-to-steer", expectedMethods: ["send", "steer"], statuses: [{ status: "delivered" }], statusReads: 1, expectedDraft: "" },
  { name: "steer rejected after turn ends", state: "steerable", race: "steer-to-send", expectedMethods: ["steer", "send"], expectedDraft: "" },
  { name: "fallback is not retried", state: "idle", race: "double-rejection", expectedMethods: ["send", "steer"], expectedDraft: "keep this exact draft", expectedError: "no turn is running" },
  { name: "steer consumed", state: "steerable", statuses: [{ status: "delivered" }], statusReads: 1, expectedDraft: "" },
  {
    name: "steer dropped",
    state: "steerable",
    statuses: [{ status: "queued" }, { status: "dropped" }, { status: "delivered" }, { status: "dropped" }],
    statusReads: 4,
    expectedDraft: "keep this exact draft",
    expectedError: "this message was not sent. your text is still here; press send to try again.",
    resendDropped: true,
  },
  {
    name: "steer remains queued after bounded wait",
    state: "steerable",
    statuses: [{ status: "queued" }],
    statusReads: 1,
    timeout: true,
    editAndRestore: true,
    expectedDraft: "keep this exact draft",
    expectedError: "this message may not have reached the assistant yet. it may still arrive with your next message, so sending it again could deliver it twice.",
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
  const deliveryIds: string[] = [];
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
      const id = `delivery-${deliveryIds.length + 1}`;
      deliveryIds.push(id);
      await deliverChatMessage(client as never, "session", text, id, intent.steer, track);
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
    if (scenario.editAndRestore) {
      owner.edit(`${scenario.expectedDraft}x`);
      expect(owner.getModel().error).toBeUndefined();
      owner.edit(scenario.expectedDraft);
    }
    expect(owner.getModel().error?.text).toBe(scenario.expectedError);
    if (scenario.resendDropped) {
      expect(owner.getModel().error?.kind).toBe("dropped");
      await owner.submit();
      expect(deliveryIds).toEqual(["delivery-1", "delivery-2"]);
      expect(owner.getModel().draft).toBe("");
      owner.edit("keep this exact draft");
      await owner.submit();
      expect(owner.getModel().draft).toBe("keep this exact draft");
      expect(owner.getModel().error?.kind).toBe("dropped");
    }
    if (scenario.editAndRestore) {
      owner.dismissError();
      expect(owner.getModel().error).toBeUndefined();
    }
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
