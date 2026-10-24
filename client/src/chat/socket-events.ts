import type { Socket } from "socket.io-client";
import type {
  GroupConversation,
  MessageAckEvent,
  MessageDeletedEvent,
  MessageErrorEvent,
  MessageNewEvent,
  MessageReadEvent,
  MessageSendRequest,
  MessageUpdatedEvent,
} from "../../../shared";

interface ClientToServerEvents {
  "message:send": (payload: MessageSendRequest) => void;
  "group-message:send": (payload: { groupId: string; clientId: string; text: string }) => void;
}

interface ServerToClientEvents {
  "group:created": (payload: { group: GroupConversation }) => void;
  "group:updated": (payload: { group: GroupConversation }) => void;
  "group:removed": (payload: { groupId: string }) => void;
  "message:ack": (payload: MessageAckEvent) => void;
  "message:new": (payload: MessageNewEvent) => void;
  "message:updated": (payload: MessageUpdatedEvent) => void;
  "message:deleted": (payload: MessageDeletedEvent) => void;
  "message:read": (payload: MessageReadEvent) => void;
  "message:error": (payload: MessageErrorEvent) => void;
}

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
