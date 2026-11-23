import { chatHref, findChat } from "../surface/AgentNavAdapter";
import { continueChatIntent } from "../surface/routes";

export const mappingFailed = "could not add this session to chats. nothing changed; try again.";

export async function continuationHref(sessionId: string, signal: AbortSignal) {
  let chat = await findChat(sessionId, signal);
  if (!chat) {
    const saved = await fetch("/api/pages/home/chats", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }), signal,
    });
    if (saved.status === 409) chat = await findChat(sessionId, signal);
    if (!saved.ok && !chat) throw new Error(mappingFailed);
  }
  return chatHref(chat ?? { page_route: "/", session_id: sessionId }) + continueChatIntent;
}
