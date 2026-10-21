import { ObjectId, type Db, type Filter } from "mongodb";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import {
  collectionNames,
  type FriendshipDocument,
  type UserDocument,
} from "../db/documents";
import { HttpError } from "../errors/http-error";
import { orderedUserPair } from "../friends/are-friends";
import { requireClientOrigin } from "../middleware/require-client-origin";

const friendListQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

type FriendListCursor = { createdAt: Date; friendshipId: ObjectId };

export interface FriendsRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  getCloudinaryCloudName: () => string | undefined;
}

const defaultDependencies: FriendsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getAllowedOrigins: () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  getCloudinaryCloudName: () => process.env.CLOUDINARY_CLOUD_NAME,
};

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function toObjectId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "invalid_user_id", "User ID is invalid.");
  }
  return new ObjectId(value);
}

function encodeFriendListCursor(friendship: Pick<FriendshipDocument, "_id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({
    createdAt: friendship.createdAt.toISOString(),
    id: friendship._id.toHexString(),
  })).toString("base64url");
}

function decodeFriendListCursor(cursor: string): FriendListCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null ||
      !("createdAt" in value) || typeof value.createdAt !== "string" ||
      !("id" in value) || typeof value.id !== "string" ||
      !/^[a-f\d]{24}$/i.test(value.id)
    ) {
      throw new Error("Invalid cursor payload.");
    }
    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
      throw new Error("Invalid cursor date.");
    }
    return { createdAt, friendshipId: new ObjectId(value.id) };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Friend list cursor is invalid.");
  }
}

export function createFriendsRouter(overrides: Partial<FriendsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });

  router.get("/", authenticated, async (request, response) => {
    const parsedQuery = friendListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      throw new HttpError(400, "validation_error", "Friend list query is invalid.");
    }
    const { cursor: cursorToken, limit } = parsedQuery.data;
    const cursor = cursorToken ? decodeFriendListCursor(cursorToken) : undefined;
    const viewerId = getAuthenticatedSession(response).user._id;
    const filter: Filter<FriendshipDocument> = {
      $and: [
        { $or: [{ userIdLow: viewerId }, { userIdHigh: viewerId }] },
        ...(cursor ? [{
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, _id: { $lt: cursor.friendshipId } },
          ],
        }] : []),
      ],
    };
    const friendships = await dependencies.getDatabase()
      .collection<FriendshipDocument>(collectionNames.friendships)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = friendships.length > limit;
    const pageFriendships = friendships.slice(0, limit);
    const friendIds = pageFriendships.map((friendship) =>
      friendship.userIdLow.equals(viewerId) ? friendship.userIdHigh : friendship.userIdLow,
    );
    const users = friendIds.length
      ? await dependencies.getDatabase()
        .collection<UserDocument>(collectionNames.users)
        .find({ _id: { $in: friendIds } }, {
          projection: {
            _id: 1,
            displayName: 1,
            bio: 1,
            info: 1,
            avatarId: 1,
            coverId: 1,
            createdAt: 1,
          },
        })
        .toArray()
      : [];
    const usersById = new Map(users.map((user) => [user._id.toHexString(), user]));
    const lastFriendship = pageFriendships.at(-1);

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      items: friendIds.flatMap((friendId) => {
        const user = usersById.get(friendId.toHexString());
        return user ? [toPublicUserResponse(user, dependencies.getCloudinaryCloudName())] : [];
      }),
      nextCursor: hasMore && lastFriendship ? encodeFriendListCursor(lastFriendship) : null,
    });
  });

  router.delete(
    "/:userId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const targetId = toObjectId(String(request.params.userId));
      const viewerId = getAuthenticatedSession(response).user._id;
      if (targetId.equals(viewerId)) {
        throw new HttpError(400, "cannot_remove_self", "You cannot remove yourself as a friend.");
      }
      const [userIdLow, userIdHigh] = orderedUserPair(viewerId, targetId);
      await dependencies.getDatabase()
        .collection<FriendshipDocument>(collectionNames.friendships)
        .deleteOne({ userIdLow, userIdHigh });

      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  return router;
}

export const friendsRouter = createFriendsRouter();
