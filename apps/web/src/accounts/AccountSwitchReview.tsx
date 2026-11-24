import { createContext, useContext, useState, type ReactNode } from "react";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import type { WriteSurfaceId } from "../writeSurfaces";
import type { Connection } from "../zeta";
import { createAccountSwitch, type SwitchTarget } from "./accountSwitch";

type OpenSwitch = (target: SwitchTarget, surface: WriteSurfaceId, opener: HTMLElement | null) => void;
const Activity = createContext<(node: HTMLDivElement | null) => void>(() => {});
export function AccountSwitchReceipt() {
  return <div ref={useContext(Activity)} className="not-has-[time]:hidden" />;
}

const SwitchReview = createContext<OpenSwitch>(() => {});
export const useAccountSwitch = () => useContext(SwitchReview);

export function AccountSwitchProvider({ connection, children }: { connection: Connection; children: ReactNode }) {
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const [createOperation] = useState(() => createAccountSwitch(connection));
  const [review, setReview] = useState<{ key: number; target: SwitchTarget; surface: WriteSurfaceId; opener: HTMLElement | null; operation: ReturnType<typeof createOperation> }>();
  const open: OpenSwitch = (target, surface, opener) => {
    const operation = createOperation(target);
    setReview(prior => ({ key: (prior?.key ?? 0) + 1, target, surface, opener, operation }));
  };
  const { chat, from, to } = review?.target ?? {};
  return <SwitchReview.Provider value={open}>
    <Activity.Provider value={setActivity}>{children}</Activity.Provider>
    {review && chat && to && <Confirmation key={review.key} level={2} surface={review.surface} activity={activity ?? undefined}
      external={{ opener: () => review.opener?.isConnected && !review.opener.matches(":disabled") ? review.opener : activity?.parentElement?.querySelector<HTMLElement>("textarea, h2[tabindex]") ?? null }}
      title={reviewText("review chat account switch")} action={reviewText("switch chat account")} keep={reviewText("keep current account")}
      scope={`chat: ${chat.title}` as ReviewText} current={(from ?? "no selected account for this provider") as ReviewText} after={to as ReviewText}
      fields={[{ label: reviewText("provider"), value: to.startsWith("anthropic:") ? reviewText("anthropic") : reviewText("codex") }]}
      effect={`future model calls to this provider in this chat use ${to}; the failed request is not retried.` as ReviewText}
      undo={reviewText("switch back with another review if the old account is available")}
      proof={{ kind: "name", name: to as ReviewText }} {...review.operation} />}
  </SwitchReview.Provider>;
}
