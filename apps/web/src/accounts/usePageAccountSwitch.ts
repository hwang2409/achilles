import { useEffect, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { WRITE_SURFACE } from "../writeSurfaces";
import type { Account } from "../zeta";
import { useAccountSwitch } from "./AccountSwitchReview";
import { activeAccountChat, currentAccount, type ChatDestination } from "./accountSwitch";

export type SwitchAction = { reason: string | null; open(to: string, opener: HTMLButtonElement): void };

async function read(client: ZetaClient) {
  const chat = await activeAccountChat(client).catch(() => undefined);
  if (!chat) return chat;
  try {
    const response = await fetch(`/api/chats?include=${encodeURIComponent(chat.id)}`, { signal: AbortSignal.timeout(3_000) });
    const { chats } = await response.json() as { chats: { session_id: string; title?: string | null; first_title?: string | null }[] };
    const row = chats.find(row => row.session_id === chat.id);
    return { ...chat, title: row?.title || row?.first_title || chat.title };
  } catch { return chat; }
}

export function usePageAccountSwitch(client: ZetaClient | null, rows: Account[], fresh: boolean, onCatalog: (accounts: Account[]) => void) {
  const [chat, setChat] = useState<ChatDestination | null>();
  const [refusal, refuse] = useState<string | null>(null);
  const openSwitch = useAccountSwitch();

  useEffect(() => {
    if (!client) return;
    let current = true;
    void read(client).then(value => { if (current) setChat(value); });
    return () => { current = false; };
  }, [client]);
  const reason = refusal ?? (chat === null ? "no chat is active." : !chat ? "could not check which chat is active."
    : !fresh ? "load the account catalog before switching." : null);
  return { reason, refusal, refuse, reset: () => refuse(null), refresh: async (controller: ZetaClient) => setChat(await read(controller)),
    open(to: string, opener: HTMLButtonElement) {
      if (!chat || reason) return;
      // Observer hello does not advertise writes. Check the method after taking control.
      openSwitch({ chat, to, from: currentAccount(rows, to), borrow: true, onRefused: refuse, onCatalog }, WRITE_SURFACE.accountPageSwitch, opener);
    },
  };
}
