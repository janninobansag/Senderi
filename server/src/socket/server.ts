import type { Server as HttpServer } from "node:http";
import { ObjectId, type Db } from "mongodb";
import { Server as SocketServer, type Socket } from "socket.io";
import type {
  MessageAckEvent,
  MessageErrorEvent,
  MessageNewEvent,
  MessageSendRequest,
} from "./contracts";
import { consumeSocketTicket } from "../auth/socket-ticket";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type MessageDocument, type SessionDocument } from "../db/documents";
import { areFriends } from "../friends/are-friends";
import { z } from "zod";

interface ClientToServerEvents {
  "message:send": (payload: MessageSendRequest) => void;
}

interface ServerToClientEvents {
  "message:ack": (payload: MessageAckEvent) => void;
  "message:new": (payload: MessageNewEvent) => void;
  "message:error": (payload: MessageErrorEvent) => void;
}

type InterServerEvents = Record<string, (...args: never[]) => void>;

interface SocketData {
  userId: ObjectId;
  sessionId: ObjectId;
}

export interface SocketServerDependencies {
  getDatabase: () => Db;
  now: () => Date;
  getAllowedOrigins: () => readonly string[];
}

type SenderSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type RealtimeServer = SocketServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const messageSendSchema = z.object({
  friendId: z.string().regex(/^[a-f\d]{24}$/i),
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  text: z.string().trim().min(1).max(2_000),
}).strict();

const defaultDependencies: SocketServerDependencies = {
  getDatabase: getConnectedDatabase,
  now: () => new Date(),
  getAllowedOrigins: () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
};

function userRoom(userId: ObjectId): string {
  return `user:${userId.toHexString()}`;
}

function toMessageResponse(message: MessageDocument): MessageAckEvent["message"] {
  return {
    id: message._id.toHexString(),
    senderId: message.senderId.toHexString(),
    recipientId: message.recipientId.toHexString(),
    text: message.text,
    createdAt: message.createdAt.toISOString(),
  };
}

function extractClientId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("clientId" in payload)) return undefined;
  return typeof payload.clientId === "string" && payload.clientId.length <= 128
    ? payload.clientId
    : undefined;
}

function emitError(socket: SenderSocket, code: string, message: string, clientId?: string): void {
  const payload: MessageErrorEvent = { code, message, ...(clientId ? { clientId } : {}) };
  socket.emit("message:error", payload);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === 11000
  );
}

function matchesExistingMessage(
  message: MessageDocument,
  recipientId: ObjectId,
  text: string,
): boolean {
  return message.recipientId.equals(recipientId) && message.text === text;
}

async function sendMessage(
  socket: SenderSocket,
  io: RealtimeServer,
  dependencies: SocketServerDependencies,
  payload: unknown,
): Promise<void> {
  const clientId = extractClientId(payload);
  const parsed = messageSendSchema.safeParse(payload);
  if (!parsed.success) {
    emitError(socket, "invalid_message", "Message payload is invalid.", clientId);
    return;
  }

  const { friendId, clientId: validatedClientId, text } = parsed.data;
  const senderId = socket.data.userId;
  const recipientId = new ObjectId(friendId);

  try {
    const database = dependencies.getDatabase();
    const now = dependencies.now();
    const activeSession = await database.collection<SessionDocument>(collectionNames.sessions).findOne({
      _id: socket.data.sessionId,
      userId: senderId,
      expiresAt: { $gt: now },
    });
    if (!activeSession) {
      emitError(socket, "unauthorized", "Authentication is required.", validatedClientId);
      socket.disconnect(true);
      return;
    }

    if (!(await areFriends(database, senderId, recipientId))) {
      emitError(socket, "not_friends", "An active friendship is required to send messages.", validatedClientId);
      return;
    }

    const messages = database.collection<MessageDocument>(collectionNames.messages);
    const existing = await messages.findOne({ senderId, clientId: validatedClientId });
    if (existing) {
      if (!matchesExistingMessage(existing, recipientId, text)) {
        emitError(socket, "client_id_conflict", "This client ID was already used for a different message.", validatedClientId);
        return;
      }
      const ack: MessageAckEvent = { clientId: validatedClientId, message: toMessageResponse(existing) };
      socket.emit("message:ack", ack);
      return;
    }

    const messageDocument: MessageDocument = {
      _id: new ObjectId(),
      senderId,
      recipientId,
      clientId: validatedClientId,
      text,
      createdAt: now,
      isRead: false,
    };
    let storedMessage: MessageDocument;
    let wasInserted = false;

    try {
      await messages.insertOne(messageDocument);
      storedMessage = messageDocument;
      wasInserted = true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const duplicate = await messages.findOne({ senderId, clientId: validatedClientId });
      if (!duplicate) throw error;
      if (!matchesExistingMessage(duplicate, recipientId, text)) {
        emitError(socket, "client_id_conflict", "This client ID was already used for a different message.", validatedClientId);
        return;
      }
      storedMessage = duplicate;
    }

    const message = toMessageResponse(storedMessage);
    const ack: MessageAckEvent = { clientId: validatedClientId, message };
    socket.emit("message:ack", ack);

    if (wasInserted) {
      const event: MessageNewEvent = { message };
      io.to(userRoom(recipientId)).emit("message:new", event);
    }
  } catch {
    emitError(socket, "message_failed", "Message could not be sent. Please retry.", validatedClientId);
  }
}

export function createSocketServer(
  httpServer: HttpServer,
  overrides: Partial<SocketServerDependencies> = {},
): RealtimeServer {
  const dependencies = { ...defaultDependencies, ...overrides };
  const allowedOrigins = dependencies.getAllowedOrigins();
  const io: RealtimeServer = new SocketServer(httpServer, {
    cors: { origin: [...allowedOrigins], credentials: true, methods: ["GET", "POST"] },
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, typeof origin === "string" && allowedOrigins.includes(origin));
    },
  });

  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    const ticket = socket.handshake.auth?.ticket;
    if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
      next(new Error("origin_not_allowed"));
      return;
    }
    if (typeof ticket !== "string") {
      next(new Error("invalid_ticket"));
      return;
    }

    void consumeSocketTicket(dependencies.getDatabase(), ticket, dependencies.now())
      .then((ticketDocument) => {
        if (!ticketDocument) {
          next(new Error("invalid_ticket"));
          return;
        }
        socket.data.userId = ticketDocument.userId;
        socket.data.sessionId = ticketDocument.sessionId;
        next();
      })
      .catch(() => next(new Error("invalid_ticket")));
  });

  io.on("connection", (socket) => {
    socket.join(userRoom(socket.data.userId));
    socket.on("message:send", (payload) => {
      void sendMessage(socket, io, dependencies, payload);
    });
  });

  return io;
}
