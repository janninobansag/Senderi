import type { Message } from "../../../shared";

export type MessageDeliveryState = "pending" | "acknowledged" | "failed";

export interface ChatMessage extends Message {
  clientId?: string;
  deliveryState: MessageDeliveryState;
  failureMessage?: string;
  retryable?: boolean;
}

export function sortFriendsByLatestMessage<T extends { id: string }>(
  friends: T[],
  conversations: Readonly<Record<string, readonly Pick<Message, "createdAt" | "id">[] | undefined>>,
): T[] {
  return [...friends].sort((left, right) => {
    const leftLatest = conversations[left.id]?.at(-1);
    const rightLatest = conversations[right.id]?.at(-1);
    const leftTime = leftLatest ? Date.parse(leftLatest.createdAt) : 0;
    const rightTime = rightLatest ? Date.parse(rightLatest.createdAt) : 0;
    const timeDifference = rightTime - leftTime;
    if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
    return (rightLatest?.id ?? "").localeCompare(leftLatest?.id ?? "");
  });
}

export function createClientMessageId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("This browser cannot create a secure message ID.");
  }
  return globalThis.crypto.randomUUID();
}

export function createPendingMessage(
  senderId: string,
  recipientId: string,
  text: string,
  clientId = createClientMessageId(),
  createdAt = new Date().toISOString(),
): ChatMessage {
  return {
    id: `local:${clientId}`,
    clientId,
    senderId,
    recipientId,
    text,
    createdAt,
    deliveryState: "pending",
    retryable: true,
  };
}

export function mergeChatMessage(current: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const matches = current.filter((message) =>
    message.id === incoming.id ||
    (incoming.clientId !== undefined && message.clientId === incoming.clientId),
  );
  const merged: ChatMessage = {
    ...(matches[0] ?? {} as ChatMessage),
    ...incoming,
    clientId: incoming.clientId ?? matches.find((message) => message.clientId)?.clientId,
    deliveryState: incoming.deliveryState ?? matches[0]?.deliveryState ?? "acknowledged",
  };
  const matchingIds = new Set(matches.map((message) => message.id));
  return [...current.filter((message) => !matchingIds.has(message.id)), merged]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  return incoming.reduce(mergeChatMessage, current);
}

export function failChatMessage(
  current: ChatMessage[],
  clientId: string,
  failureMessage: string,
  retryable: boolean,
): ChatMessage[] {
  return current.map((message) => message.clientId === clientId
    ? { ...message, deliveryState: "failed", failureMessage, retryable }
    : message);
}

export function retryChatMessage(current: ChatMessage[], clientId: string): ChatMessage[] {
  return current.map((message) => message.clientId === clientId
    ? { ...message, deliveryState: "pending", failureMessage: undefined, retryable: true }
    : message);
}
