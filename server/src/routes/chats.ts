import { ObjectId, type Db, type Filter } from "mongodb";
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type GroupConversationDocument, type MessageDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { areFriends } from "../friends/are-friends";
import { cloudinaryPostPhotoStorage, optimizePostPhoto, type PostPhotoStorage } from "../media/post-photo";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { sendPushToUser } from "../notifications/push";
import { toPublicUserResponse } from "../auth/user-response";

const messageHistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const photoMessageSchema = z.object({
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  text: z.string().trim().max(2_000).optional().default(""),
}).strict();
const editMessageSchema = z.object({ text: z.string().trim().max(2_000) }).strict();
const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(48),
  memberIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(2).max(29),
}).strict();
interface MessageHistoryCursor {
  createdAt: Date;
  messageId: ObjectId;
  friendId: ObjectId;
}

export interface ChatsRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  now: () => Date;
  photoStorage: PostPhotoStorage;
}

const defaultDependencies: ChatsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getAllowedOrigins: () => (process.env.CLIENT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  now: () => new Date(),
  photoStorage: cloudinaryPostPhotoStorage,
};

interface ChatRealtimeServer {
  to(room: string): { emit(event: "message:new" | "message:updated" | "message:deleted" | "group:created", payload: unknown): unknown };
}

interface ChatPhotoRequest extends Request {
  file?: Express.Multer.File;
}

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function toFriendObjectId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "invalid_friend_id", "Friend ID is invalid.");
  }
  return new ObjectId(value);
}

function toMessageObjectId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(404, "not_found", "Message was not found.");
  }
  return new ObjectId(value);
}

function toGroupObjectId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(404, "not_found", "Group conversation was not found.");
  }
  return new ObjectId(value);
}

async function findGroupForMember(database: Db, groupId: ObjectId, userId: ObjectId): Promise<GroupConversationDocument> {
  const group = await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
    .findOne({ _id: groupId, participantIds: userId });
  if (!group) throw new HttpError(404, "conversation_not_found", "Group conversation was not found.");
  return group;
}

async function canAccessMessage(database: Db, message: MessageDocument, userId: ObjectId): Promise<boolean> {
  if (message.groupId) {
    return Boolean(await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
      .findOne({ _id: message.groupId, participantIds: userId }));
  }
  if (!message.senderId.equals(userId) && !message.recipientId.equals(userId)) return false;
  const otherId = message.senderId.equals(userId) ? message.recipientId : message.senderId;
  return areFriends(database, userId, otherId);
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

function toMessageResponse(message: MessageDocument, viewerId: ObjectId) {
  return {
    id: message._id.toHexString(),
    senderId: message.senderId.toHexString(),
    recipientId: message.recipientId.toHexString(),
    ...(message.groupId ? { groupId: message.groupId.toHexString() } : {}),
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    ...(message.photoAssetId ? { photoUrl: `/api/chats/messages/${message._id.toHexString()}/photo` } : {}),
    ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
    ...(message.senderId.equals(viewerId) ? { clientId: message.clientId } : {}),
  };
}

function samePhotoMessage(message: MessageDocument, recipientId: ObjectId, text: string): boolean {
  return message.recipientId.equals(recipientId) && message.text === text && Boolean(message.photoAssetId);
}

function emitNewPhotoMessage(request: Request, message: MessageDocument, recipientId: ObjectId): void {
  const realtimeServer = request.app.get("realtimeServer") as ChatRealtimeServer | undefined;
  realtimeServer?.to(`user:${recipientId.toHexString()}`).emit("message:new", {
    message: toMessageResponse(message, recipientId),
  });
}

function emitNewGroupMessage(request: Request, message: MessageDocument, participantIds: ObjectId[]): void {
  const realtimeServer = request.app.get("realtimeServer") as ChatRealtimeServer | undefined;
  for (const participantId of participantIds) {
    realtimeServer?.to(`user:${participantId.toHexString()}`).emit("message:new", {
      message: toMessageResponse(message, participantId),
    });
  }
}

function emitUpdatedMessage(request: Request, message: MessageDocument, participantIds?: ObjectId[]): void {
  const realtimeServer = request.app.get("realtimeServer") as ChatRealtimeServer | undefined;
  for (const viewerId of participantIds ?? [message.senderId, message.recipientId]) {
    realtimeServer?.to(`user:${viewerId.toHexString()}`).emit("message:updated", {
      message: toMessageResponse(message, viewerId),
    });
  }
}

function emitDeletedMessage(request: Request, message: MessageDocument, participantIds?: ObjectId[]): void {
  const realtimeServer = request.app.get("realtimeServer") as ChatRealtimeServer | undefined;
  const event = {
    messageId: message._id.toHexString(),
    senderId: message.senderId.toHexString(),
    recipientId: message.recipientId.toHexString(),
    ...(message.groupId ? { groupId: message.groupId.toHexString() } : {}),
  };
  for (const participantId of participantIds ?? [message.senderId, message.recipientId]) {
    realtimeServer?.to(`user:${participantId.toHexString()}`).emit("message:deleted", event);
  }
}

function uploadMessagePhoto(request: ChatPhotoRequest, response: Response, next: (error?: unknown) => void): void {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 },
  }).single("file")(request, response, next);
}

export function createChatsRouter(overrides: Partial<ChatsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({
    getDatabase: dependencies.getDatabase,
    now: dependencies.now,
  });
  router.get("/groups", authenticated, async (_request, response) => {
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const groups = await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
      .find({ participantIds: viewerId })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    const usersById = new Map((await database.collection<UserDocument>(collectionNames.users)
      .find({ _id: { $in: [...new Set(groups.flatMap((group) => group.participantIds.map((id) => id.toHexString())))].map((id) => new ObjectId(id)) } })
      .toArray()).map((user) => [user._id.toHexString(), user]));
    const messages = database.collection<MessageDocument>(collectionNames.messages);
    const items = await Promise.all(groups.map(async (group) => {
      const readAt = group.readAtByUser?.[viewerId.toHexString()] ?? group.createdAt;
      const [latestMessage, unreadCount] = await Promise.all([
        messages.findOne({ groupId: group._id, moderationHiddenAt: { $exists: false } }, { sort: { createdAt: -1, _id: -1 } }),
        messages.countDocuments({
          groupId: group._id,
          senderId: { $ne: viewerId },
          createdAt: { $gt: readAt },
          moderationHiddenAt: { $exists: false },
        }),
      ]);
      return {
        id: group._id.toHexString(),
        name: group.name,
        participants: group.participantIds.flatMap((participantId) => {
          const participant = usersById.get(participantId.toHexString());
          return participant ? [toPublicUserResponse(participant)] : [];
        }),
        createdAt: group.createdAt.toISOString(),
        unreadCount,
        ...(latestMessage ? { latestMessage: toMessageResponse(latestMessage, viewerId) } : {}),
      };
    }));
    response.setHeader("Cache-Control", "private, no-store");
    response.json({ items });
  });

  router.post("/groups", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Group name and at least two friends are required.");
    const database = dependencies.getDatabase();
    const creatorId = getAuthenticatedSession(response).user._id;
    const memberIds = parsed.data.memberIds.map((id) => new ObjectId(id));
    const distinctIds = new Set(memberIds.map((id) => id.toHexString()));
    if (distinctIds.size !== memberIds.length || distinctIds.has(creatorId.toHexString())) {
      throw new HttpError(400, "validation_error", "Choose each friend once.");
    }
    for (const memberId of memberIds) {
      if (!(await areFriends(database, creatorId, memberId))) {
        throw new HttpError(400, "group_members_must_be_friends", "Every group member must be one of your friends.");
      }
    }
    const group: GroupConversationDocument = {
      _id: new ObjectId(),
      name: parsed.data.name,
      createdBy: creatorId,
      participantIds: [creatorId, ...memberIds],
      createdAt: dependencies.now(),
      updatedAt: dependencies.now(),
      readAtByUser: { [creatorId.toHexString()]: dependencies.now() },
    };
    await database.collection<GroupConversationDocument>(collectionNames.groupConversations).insertOne(group);
    const participants = await database.collection<UserDocument>(collectionNames.users)
      .find({ _id: { $in: group.participantIds } }).toArray();
    const groupResponse = {
      id: group._id.toHexString(),
      name: group.name,
      participants: group.participantIds.flatMap((id) => {
        const participant = participants.find((user) => user._id.equals(id));
        return participant ? [toPublicUserResponse(participant)] : [];
      }),
      createdAt: group.createdAt.toISOString(),
      unreadCount: 0,
    };
    const realtimeServer = request.app.get("realtimeServer") as ChatRealtimeServer | undefined;
    for (const participantId of group.participantIds.filter((id) => !id.equals(creatorId))) {
      realtimeServer?.to(`user:${participantId.toHexString()}`).emit("group:created", { group: groupResponse });
    }
    response.setHeader("Cache-Control", "private, no-store");
    response.status(201).json({ group: groupResponse });
  });

  router.patch("/groups/:groupId/read", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const groupId = toGroupObjectId(String(request.params.groupId));
    const viewerId = getAuthenticatedSession(response).user._id;
    const database = dependencies.getDatabase();
    await findGroupForMember(database, groupId, viewerId);
    await database.collection<GroupConversationDocument>(collectionNames.groupConversations).updateOne(
      { _id: groupId, participantIds: viewerId },
      { $set: { [`readAtByUser.${viewerId.toHexString()}`]: dependencies.now() } },
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.status(204).end();
  });

  router.get("/groups/:groupId/messages", authenticated, async (request, response) => {
    const parsedQuery = messageHistoryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) throw new HttpError(400, "validation_error", "Message history query is invalid.");
    const groupId = toGroupObjectId(String(request.params.groupId));
    const viewerId = getAuthenticatedSession(response).user._id;
    const database = dependencies.getDatabase();
    await findGroupForMember(database, groupId, viewerId);
    const cursor = parsedQuery.data.cursor ? decodeCursor(parsedQuery.data.cursor, groupId) : undefined;
    const cursorFilter: Filter<MessageDocument> | undefined = cursor ? {
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.messageId } },
      ],
    } : undefined;
    const filter: Filter<MessageDocument> = {
      $and: [
        { groupId, moderationHiddenAt: { $exists: false } },
        ...(cursorFilter ? [cursorFilter] : []),
      ],
    };
    const { limit } = parsedQuery.data;
    const messages = await database.collection<MessageDocument>(collectionNames.messages)
      .find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray();
    const hasMore = messages.length > limit;
    const pageMessages = messages.slice(0, limit);
    const lastMessage = pageMessages.at(-1);
    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      items: pageMessages.map((message) => toMessageResponse(message, viewerId)),
      nextCursor: hasMore && lastMessage ? encodeCursor(lastMessage, groupId) : null,
    });
  });

  router.post(
    "/groups/:groupId/messages",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response, next) => {
      const groupId = toGroupObjectId(String(request.params.groupId));
      await findGroupForMember(dependencies.getDatabase(), groupId, getAuthenticatedSession(response).user._id);
      next();
    },
    uploadMessagePhoto,
    async (request: ChatPhotoRequest, response) => {
      const parsed = photoMessageSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "validation_error", "Photo message details are invalid.");
      const file = request.file;
      if (!file) throw new HttpError(400, "missing_file", "Choose one image to send.");
      const groupId = toGroupObjectId(String(request.params.groupId));
      const session = getAuthenticatedSession(response);
      const senderId = session.user._id;
      const database = dependencies.getDatabase();
      const group = await findGroupForMember(database, groupId, senderId);
      const messages = database.collection<MessageDocument>(collectionNames.messages);
      const existing = await messages.findOne({ senderId, clientId: parsed.data.clientId });
      if (existing) {
        if (!existing.groupId?.equals(groupId) || existing.text !== parsed.data.text || !existing.photoAssetId) {
          throw new HttpError(409, "client_id_conflict", "This client ID was already used for a different message.");
        }
        response.setHeader("Cache-Control", "private, no-store");
        response.json({ message: toMessageResponse(existing, senderId) });
        return;
      }
      const optimizedPhoto = await optimizePostPhoto(file);
      const uploaded = await dependencies.photoStorage.upload(
        optimizedPhoto,
        `chat-${senderId.toHexString()}-${randomUUID()}`,
        "senderi/chat-photos",
      );
      const message: MessageDocument = {
        _id: new ObjectId(), senderId, recipientId: senderId, groupId,
        clientId: parsed.data.clientId, text: parsed.data.text,
        photoAssetId: uploaded.assetId, createdAt: dependencies.now(), isRead: true,
      };
      try {
        await messages.insertOne(message);
      } catch (error) {
        await dependencies.photoStorage.destroy(uploaded.assetId).catch(() => {
          console.error("Failed to clean up an abandoned group chat photo.");
        });
        if (isDuplicateKeyError(error)) {
          const duplicate = await messages.findOne({ senderId, clientId: parsed.data.clientId });
          if (duplicate?.groupId?.equals(groupId) && duplicate.text === parsed.data.text && duplicate.photoAssetId) {
            response.setHeader("Cache-Control", "private, no-store");
            response.json({ message: toMessageResponse(duplicate, senderId) });
            return;
          }
          throw new HttpError(409, "client_id_conflict", "This client ID was already used for a different message.");
        }
        throw error;
      }
      await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
        .updateOne({ _id: groupId }, { $set: { updatedAt: message.createdAt } });
      emitNewGroupMessage(request, message, group.participantIds);
      const sender = await database.collection<UserDocument>(collectionNames.users).findOne({ _id: senderId }).catch(() => null);
      for (const participantId of group.participantIds.filter((id) => !id.equals(senderId))) {
        void sendPushToUser(database, participantId, {
          title: `New message in ${group.name}`,
          body: `From: ${sender?.displayName.trim() || "Someone"}`,
          url: `/messages?group=${groupId.toHexString()}`,
          tag: `group-message-${groupId.toHexString()}`,
        });
      }
      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({ message: toMessageResponse(message, senderId) });
    },
  );

  router.post(
    "/:friendId/messages",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response, next) => {
      const friendId = toFriendObjectId(String(request.params.friendId));
      if (!(await areFriends(dependencies.getDatabase(), getAuthenticatedSession(response).user._id, friendId))) {
        throw new HttpError(404, "conversation_not_found", "Conversation was not found.");
      }
      next();
    },
    uploadMessagePhoto,
    async (request: ChatPhotoRequest, response) => {
      const parsed = photoMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Photo message details are invalid.");
      }
      const file = request.file;
      if (!file) throw new HttpError(400, "missing_file", "Choose one image to send.");

      const friendId = toFriendObjectId(String(request.params.friendId));
      const session = getAuthenticatedSession(response);
      const senderId = session.user._id;
      const database = dependencies.getDatabase();
      if (!(await areFriends(database, senderId, friendId))) {
        throw new HttpError(404, "conversation_not_found", "Conversation was not found.");
      }

      const messages = database.collection<MessageDocument>(collectionNames.messages);
      const existing = await messages.findOne({ senderId, clientId: parsed.data.clientId });
      if (existing) {
        if (!samePhotoMessage(existing, friendId, parsed.data.text)) {
          throw new HttpError(409, "client_id_conflict", "This client ID was already used for a different message.");
        }
        response.setHeader("Cache-Control", "private, no-store");
        response.json({ message: toMessageResponse(existing, senderId) });
        return;
      }

      const optimizedPhoto = await optimizePostPhoto(file);
      const uploaded = await dependencies.photoStorage.upload(
        optimizedPhoto,
        `chat-${senderId.toHexString()}-${randomUUID()}`,
        "senderi/chat-photos",
      );
      const message: MessageDocument = {
        _id: new ObjectId(),
        senderId,
        recipientId: friendId,
        clientId: parsed.data.clientId,
        text: parsed.data.text,
        photoAssetId: uploaded.assetId,
        createdAt: dependencies.now(),
        isRead: false,
      };

      try {
        await messages.insertOne(message);
      } catch (error) {
        await dependencies.photoStorage.destroy(uploaded.assetId).catch(() => {
          console.error("Failed to clean up an abandoned chat photo.");
        });
        if (isDuplicateKeyError(error)) {
          const duplicate = await messages.findOne({ senderId, clientId: parsed.data.clientId });
          if (duplicate && samePhotoMessage(duplicate, friendId, parsed.data.text)) {
            response.setHeader("Cache-Control", "private, no-store");
            response.json({ message: toMessageResponse(duplicate, senderId) });
            return;
          }
          throw new HttpError(409, "client_id_conflict", "This client ID was already used for a different message.");
        }
        throw error;
      }

      emitNewPhotoMessage(request, message, friendId);
      const sender = await database.collection<UserDocument>(collectionNames.users)
        .findOne({ _id: senderId })
        .catch(() => null);
      void sendPushToUser(database, friendId, {
        title: "New Senderi message",
        body: `From: ${sender?.displayName.trim() || "Someone"}`,
        url: `/messages?friend=${senderId.toHexString()}`,
        tag: `message-${senderId.toHexString()}`,
      });

      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({ message: toMessageResponse(message, senderId) });
    },
  );

  router.get("/messages/:messageId/photo", authenticated, async (request, response) => {
    const messageId = toMessageObjectId(String(request.params.messageId));
    const viewerId = getAuthenticatedSession(response).user._id;
    const database = dependencies.getDatabase();
    const message = await database.collection<MessageDocument>(collectionNames.messages).findOne({ _id: messageId });
    if (!message?.photoAssetId || message.moderationHiddenAt) throw new HttpError(404, "not_found", "Chat photo was not found.");
    if (!(await canAccessMessage(database, message, viewerId))) {
      throw new HttpError(404, "not_found", "Chat photo was not found.");
    }

    let photo;
    try {
      photo = await dependencies.photoStorage.download(message.photoAssetId);
    } catch {
      throw new HttpError(502, "media_unavailable", "Chat photo is temporarily unavailable.");
    }

    response.status(200);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Content-Type", photo.contentType);
    if (photo.contentLength !== undefined) response.setHeader("Content-Length", String(photo.contentLength));
    await pipeline(photo.stream, response);
  });

  router.patch(
    "/messages/:messageId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const parsed = editMessageSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, "validation_error", "Message text is invalid.");

      const messageId = toMessageObjectId(String(request.params.messageId));
      const viewerId = getAuthenticatedSession(response).user._id;
      const database = dependencies.getDatabase();
      const messages = database.collection<MessageDocument>(collectionNames.messages);
      const message = await messages.findOne({ _id: messageId });
      if (!message || message.moderationHiddenAt || !message.senderId.equals(viewerId) || !(await canAccessMessage(database, message, viewerId))) {
        throw new HttpError(404, "not_found", "Message was not found.");
      }
      if (!message.photoAssetId && parsed.data.text.length === 0) {
        throw new HttpError(400, "validation_error", "A text message cannot be empty.");
      }

      if (message.text !== parsed.data.text) {
        const editedAt = dependencies.now();
        const result = await messages.updateOne(
          { _id: messageId, senderId: viewerId },
          { $set: { text: parsed.data.text, editedAt } },
        );
        if (!result.matchedCount) throw new HttpError(409, "message_changed", "This message changed. Refresh and try again.");
        message.text = parsed.data.text;
        message.editedAt = editedAt;
        const group = message.groupId
          ? await database.collection<GroupConversationDocument>(collectionNames.groupConversations).findOne({ _id: message.groupId })
          : null;
        emitUpdatedMessage(request, message, group?.participantIds);
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.json({ message: toMessageResponse(message, viewerId) });
    },
  );

  router.delete(
    "/messages/:messageId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const messageId = toMessageObjectId(String(request.params.messageId));
      const viewerId = getAuthenticatedSession(response).user._id;
      const database = dependencies.getDatabase();
      const messages = database.collection<MessageDocument>(collectionNames.messages);
      const message = await messages.findOne({ _id: messageId });
      if (!message || message.moderationHiddenAt || !message.senderId.equals(viewerId) || !(await canAccessMessage(database, message, viewerId))) {
        throw new HttpError(404, "not_found", "Message was not found.");
      }

      if (message.photoAssetId) {
        try {
          await dependencies.photoStorage.destroy(message.photoAssetId);
        } catch {
          throw new HttpError(502, "media_unavailable", "The photo could not be permanently deleted. Please try again.");
        }
      }

      const result = await messages.deleteOne({
        _id: messageId,
        senderId: viewerId,
        ...(message.photoAssetId ? { photoAssetId: message.photoAssetId } : {}),
      });
      if (!result.deletedCount) throw new HttpError(409, "message_changed", "This message changed. Refresh and try again.");
      const group = message.groupId
        ? await database.collection<GroupConversationDocument>(collectionNames.groupConversations).findOne({ _id: message.groupId })
        : null;
      emitDeletedMessage(request, message, group?.participantIds);
      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );
  router.get("/unread", authenticated, async (_request, response) => {
    const database = dependencies.getDatabase();
    const recipientId = getAuthenticatedSession(response).user._id;
    const items = await database
      .collection<MessageDocument>(collectionNames.messages)
      .aggregate<{ _id: ObjectId; unreadCount: number }>([
        { $match: { recipientId, groupId: { $exists: false }, isRead: false, moderationHiddenAt: { $exists: false } } },
        { $group: { _id: "$senderId", unreadCount: { $sum: 1 } } },
      ])
      .toArray();
    const groups = await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
      .find({ participantIds: recipientId }).toArray();
    const groupItems = await Promise.all(groups.map(async (group) => {
      const readAt = group.readAtByUser?.[recipientId.toHexString()] ?? group.createdAt;
      const unreadCount = await database.collection<MessageDocument>(collectionNames.messages).countDocuments({
        groupId: group._id,
        senderId: { $ne: recipientId },
        createdAt: { $gt: readAt },
        moderationHiddenAt: { $exists: false },
      });
      return unreadCount ? { groupId: group._id.toHexString(), unreadCount } : null;
    }));

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      items: [
        ...items.map((item) => ({ friendId: item._id.toHexString(), unreadCount: item.unreadCount })),
        ...groupItems.filter((item): item is NonNullable<typeof item> => item !== null),
      ],
    });
  });

  router.patch(
    "/:friendId/read",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const friendId = toFriendObjectId(String(request.params.friendId));
      const viewerId = getAuthenticatedSession(response).user._id;
      if (!(await areFriends(dependencies.getDatabase(), viewerId, friendId))) {
        throw new HttpError(404, "conversation_not_found", "Conversation was not found.");
      }

      await dependencies.getDatabase().collection<MessageDocument>(collectionNames.messages).updateMany(
        { senderId: friendId, recipientId: viewerId, isRead: false, moderationHiddenAt: { $exists: false } },
        { $set: { isRead: true, readAt: dependencies.now() } },
      );
      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

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
      $and: [
        { $or: [
          { senderId: viewerId, recipientId: friendId },
          { senderId: friendId, recipientId: viewerId },
        ] },
        { moderationHiddenAt: { $exists: false } },
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
      items: pageMessages.map((message) => toMessageResponse(message, viewerId)),
      nextCursor: hasMore && lastMessage ? encodeCursor(lastMessage, friendId) : null,
    });
  });

  return router;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export const chatsRouter = createChatsRouter();
