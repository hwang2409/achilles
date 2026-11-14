import { expect, test } from "bun:test";
import { confirmSteerDelivery } from "../useActiveChat";
import { createComposerDelivery, type ComposerDelivery } from "./useComposerDelivery";

type Scenario = {
  name: string;
  state: "idle" | "steerable";
  statuses?: Array<{ status: string; outcome?: string }>;
  echoes?: number;
  failResend?: boolean;
  timeout?: boolean;
  remount?: boolean;
  expectedDraft: string;
};

const scenarios: Scenario[] = [
  { name: "send ok", state: "idle", expectedDraft: "" },
  { name: "steer delivered", state: "steerable", statuses: [{ status: "delivered" }], expectedDraft: "" },
  { name: "steer queued echo then dropped then resend ok", state: "steerable", statuses: [{ status: "queued" }, { status: "dropped" }, { status: "delivered" }], echoes: 1, expectedDraft: "" },
  { name: "steer queued echo then dropped then resend fails", state: "steerable", statuses: [{ status: "queued" }, { status: "dropped" }], echoes: 1, failResend: true, expectedDraft: "keep this exact draft" },
  { name: "steer queued echo then timeout", state: "steerable", statuses: [{ status: "queued" }], echoes: 1, timeout: true, expectedDraft: "keep this exact draft" },
  { name: "steer evicted with delivered outcome", state: "steerable", statuses: [{ status: "evicted", outcome: "delivered" }], expectedDraft: "" },
  { name: "reload or remount during delivery", state: "idle", remount: true, expectedDraft: " plus new" },
  { name: "duplicate queued echo", state: "steerable", statuses: [{ status: "queued" }, { status: "delivered" }], echoes: 2, expectedDraft: "" },
];

test.each(scenarios)("delivery owner: $name", async (scenario) => {
  const originalNow = Date.now;
  let now = 1_000;
  let persisted = "keep this exact draft";
  let displayedEchoes = 0;
  let remounted: ComposerDelivery | undefined;
  let releaseSend: (() => void) | undefined;
  const heldSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  const statuses = [...(scenario.statuses ?? [])];

  const client = {
    request: async (method: string) => {
      if (method === "send") {
        if (scenario.failResend) throw new Error("resend failed");
        if (scenario.remount) await heldSend;
        return { accepted: true };
      }
      if (method !== "delivery_status") throw new Error(`unexpected ${method}`);
      const status = statuses.shift() ?? { status: "queued" };
      if (displayedEchoes < (scenario.echoes ?? 0)) displayedEchoes += scenario.echoes ?? 0;
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
    if (scenario.remount) expect(remounted?.getModel().draft).toBe(scenario.expectedDraft);
    if (scenario.echoes) expect(displayedEchoes).toBe(scenario.echoes);
  } finally {
    Date.now = originalNow;
    releaseSend?.();
  }
});
