export type AiMessage = {
  role: "user" | "assistant" | "action";
  text: string;
  itemId?: string;
};

export function appendAgentDelta(messages: AiMessage[], itemId: string, delta: string): AiMessage[] {
  if (!delta) return messages;
  const last = messages.at(-1);
  if (last?.role === "assistant" && last.itemId === itemId)
    return [...messages.slice(0, -1), { ...last, text: last.text + delta }];
  return [...messages, { role: "assistant", itemId, text: delta }];
}

export function completeAgentMessage(messages: AiMessage[], itemId: string, text: string): AiMessage[] {
  if (!text.trim()) return messages;
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.itemId !== itemId)
    return [...messages, { role: "assistant", itemId, text }];
  if (text.startsWith(last.text))
    return [...messages.slice(0, -1), { ...last, text }];
  if (last.text.startsWith(text)) return messages;
  return [...messages.slice(0, -1), { ...last, text }];
}
