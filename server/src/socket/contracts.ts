/** Socket event types mirror the public shared contracts without crossing the server build root. */
export interface SocketMessage {
  id: string;
  senderId: string;
  recipientId: string;
  groupId?: string;
  text: string;
  createdAt: string;
  photoUrl?: string;
  editedAt?: string;
  isRead?: boolean;
}

export interface MessageUpdatedEvent {
  message: SocketMessage;
}

export interface MessageDeletedEvent {
  messageId: string;
  senderId: string;
  recipientId: string;
  groupId?: string;
}

export interface MessageReadEvent {
  conversationId: string;
  readAt: string;
  /** Direct chats can provide exact unread message IDs; group chats use readAt. */
  messageIds?: string[];
}

export interface MessageSendRequest {
  friendId: string;
  clientId: string;
  text: string;
}

export interface GroupMessageSendRequest {
  groupId: string;
  clientId: string;
  text: string;
}

export interface MessageAckEvent {
  clientId: string;
  message: SocketMessage;
}

export interface MessageNewEvent {
  message: SocketMessage;
}

export interface MessageErrorEvent {
  clientId?: string;
  code: string;
  message: string;
}
