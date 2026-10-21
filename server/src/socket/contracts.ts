/** Socket event types mirror the public shared contracts without crossing the server build root. */
export interface SocketMessage {
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
}

export interface MessageSendRequest {
  friendId: string;
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
