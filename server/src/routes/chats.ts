import { ObjectId, type Db, type Filter } from "mongodb";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type MessageDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { areFriends } from "../friends/are-friends";

const messageHistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

interface MessageHistoryCursor {
  createdAt: Date;
  messageId: ObjectId;
  friendId: ObjectId;
}

export interface ChatsRouterDependencies {
  getDatabase: () => Db;
  now: () => Date;
}

const defaultDependencies: ChatsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  now: () => new Date(),
};

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function toFriendObjectId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "invalid_friend_id", "Friend ID is invalid.");
  }
  return new ObjectId(value);
}

function encodeCursor(message: MessageDocument, friendId: ObjectId): string {
  return Buffer.from(JSON.stringify({
    createdAt: message.createdAt.toISOString(),
    id: message._id.toHexString(),
    friendId: friendId.toHexString(),
  })).toString("base64url");
}

function decodeCursor(token: string, expectedFriendId: ObjectId): MessageHistoryCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null ||
      !("createdAt" in value) || typeof value.createdAt !== "string" ||
      !("id" in value) || typeof value.id !== "string" || !/^[a-f\d]{24}$/i.test(value.id) ||
      !("friendId" in value) || typeof value.friendId !== "string" ||
      !/^[a-f\d]{24}$/i.test(value.friendId) ||
      !new ObjectId(value.friendId).equals(expectedFriendId)
    ) {
      throw new Error("Invalid message cursor payload.");
    }

    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
      throw new Error("Invalid message cursor date.");
    }

    return {
      createdAt,
      messageId: new ObjectId(value.id),
      friendId: new ObjectId(value.friendId),
    };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Message history cursor is invalid.");
  }
}

function toMessageResponse(message: MessageDocument) {
  return {
    id: message._id.toHexString(),
    senderId: message.senderId.toHexString(),
    recipientId: message.recipientId.toHexString(),
    text: message.text,
    createdAt: message.createdAt.toISOString(),
  };
}

export function createChatsRouter(overrides: Partial<ChatsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({
    getDatabase: dependencies.getDatabase,
    now: dependencies.now,
  });

  router.get("/:friendId/messages", authenticated, async (request, response) => {
    const parsedQuery = messageHistoryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      throw new HttpError(400, "validation_error", "Message history query is invalid.");
    }

    const friendId = toFriendObjectId(String(request.params.friendId));
    const viewerId = getAuthenticatedSession(response).user._id;
    const database = dependencies.getDatabase();

    if (!(await areFriends(database, viewerId, friendId))) {
      throw new HttpError(404, "conversation_not_found", "Conversation was not found.");
    }

    const cursor = parsedQuery.data.cursor
      ? decodeCursor(parsedQuery.data.cursor, friendId)
      : undefined;
    const conversationFilter: Filter<MessageDocument> = {
      $or: [
        { senderId: viewerId, recipientId: friendId },
        { senderId: friendId, recipientId: viewerId },
      ],
    };
    const cursorFilter: Filter<MessageDocument> | undefined = cursor
      ? {
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, _id: { $lt: cursor.messageId } },
          ],
        }
      : undefined;
    const filter: Filter<MessageDocument> = cursorFilter
      ? { $and: [conversationFilter, cursorFilter] }
      : conversationFilter;
    const { limit } = parsedQuery.data;
    const messages = await database
      .collection<MessageDocument>(collectionNames.messages)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = messages.length > limit;
    const pageMessages = messages.slice(0, limit);
    const lastMessage = pageMessages.at(-1);

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      items: pageMessages.map(toMessageResponse),
      nextCursor: hasMore && lastMessage ? encodeCursor(lastMessage, friendId) : null,
    });
  });

  return router;
}

export const chatsRouter = createChatsRouter();
