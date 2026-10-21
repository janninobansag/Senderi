import { ObjectId, type Db } from "mongodb";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { getDatabase as getConnectedDatabase } from "../db/client";
import {
  collectionNames,
  type FriendRequestDocument,
  type FriendshipDocument,
  type UserDocument,
} from "../db/documents";
import { HttpError } from "../errors/http-error";
import { areFriends, orderedUserPair } from "../friends/are-friends";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { validateBody } from "../middleware/validate-body";

const sendFriendRequestSchema = z.object({
  recipientId: z.string().trim().regex(/^[a-f\d]{24}$/i),
}).strict();
const respondToFriendRequestSchema = z.object({
  action: z.enum(["accept", "decline"]),
}).strict();

type SendFriendRequestInput = z.infer<typeof sendFriendRequestSchema>;

export interface FriendRequestsRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  now: () => Date;
}

const defaultDependencies: FriendRequestsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getAllowedOrigins: () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  now: () => new Date(),
};

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function toFriendRequestResponse(friendRequest: FriendRequestDocument) {
  return {
    id: friendRequest._id.toHexString(),
    senderId: friendRequest.senderId.toHexString(),
    recipientId: friendRequest.recipientId.toHexString(),
    status: friendRequest.status,
    createdAt: friendRequest.createdAt.toISOString(),
    ...(friendRequest.respondedAt
      ? { respondedAt: friendRequest.respondedAt.toISOString() }
      : {}),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export function createFriendRequestsRouter(
  overrides: Partial<FriendRequestsRouterDependencies> = {},
): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });

  router.post(
    "/",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    validateBody(sendFriendRequestSchema),
    async (request, response) => {
      const { recipientId } = request.body as SendFriendRequestInput;
      const sender = getAuthenticatedSession(response).user;
      const recipientObjectId = new ObjectId(recipientId);

      if (sender._id.equals(recipientObjectId)) {
        throw new HttpError(400, "cannot_request_self", "You cannot send a friend request to yourself.");
      }

      const database = dependencies.getDatabase();
      const recipient = await database
        .collection<UserDocument>(collectionNames.users)
        .findOne({ _id: recipientObjectId }, { projection: { _id: 1 } });
      if (!recipient) {
        throw new HttpError(404, "not_found", "Requested user was not found.");
      }

      const [userIdLow, userIdHigh] = orderedUserPair(sender._id, recipientObjectId);
      if (await areFriends(database, sender._id, recipientObjectId)) {
        throw new HttpError(409, "already_friends", "You are already friends with this user.");
      }

      const requests = database.collection<FriendRequestDocument>(collectionNames.friendRequests);
      const existingPending = await requests.findOne(
        { userIdLow, userIdHigh, status: "pending" },
        { projection: { _id: 1 } },
      );
      if (existingPending) {
        throw new HttpError(409, "friend_request_exists", "A pending friend request already exists for this user pair.");
      }

      const friendRequest: FriendRequestDocument = {
        _id: new ObjectId(),
        senderId: sender._id,
        recipientId: recipientObjectId,
        userIdLow,
        userIdHigh,
        status: "pending",
        createdAt: dependencies.now(),
      };

      try {
        await requests.insertOne(friendRequest);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new HttpError(409, "friend_request_exists", "A pending friend request already exists for this user pair.");
        }
        throw error;
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({ request: toFriendRequestResponse(friendRequest) });
    },
  );

  router.get("/", authenticated, async (_request, response) => {
    const userId = getAuthenticatedSession(response).user._id;
    const requests = dependencies.getDatabase().collection<FriendRequestDocument>(
      collectionNames.friendRequests,
    );
    const [incoming, outgoing] = await Promise.all([
      requests
        .find({ recipientId: userId, status: "pending" })
        .sort({ createdAt: -1, _id: -1 })
        .toArray(),
      requests
        .find({ senderId: userId, status: "pending" })
        .sort({ createdAt: -1, _id: -1 })
        .toArray(),
    ]);

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      incoming: incoming.map(toFriendRequestResponse),
      outgoing: outgoing.map(toFriendRequestResponse),
    });
  });

  router.patch(
    "/:requestId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    validateBody(respondToFriendRequestSchema),
    async (request, response) => {
      const requestIdValue = String(request.params.requestId);
      if (!/^[a-f\d]{24}$/i.test(requestIdValue)) {
        throw new HttpError(400, "invalid_request_id", "Friend request ID is invalid.");
      }

      const requestId = new ObjectId(requestIdValue);
      const viewerId = getAuthenticatedSession(response).user._id;
      const database = dependencies.getDatabase();
      const requests = database.collection<FriendRequestDocument>(collectionNames.friendRequests);
      const existing = await requests.findOne({ _id: requestId });
      if (!existing) {
        throw new HttpError(404, "friend_request_not_found", "Friend request was not found.");
      }
      if (!existing.recipientId.equals(viewerId)) {
        throw new HttpError(403, "not_friend_request_recipient", "Only the recipient can respond to this friend request.");
      }
      if (existing.status !== "pending") {
        throw new HttpError(409, "friend_request_already_resolved", "Friend request is no longer pending.");
      }

      const { action } = request.body as z.infer<typeof respondToFriendRequestSchema>;
      const respondedAt = dependencies.now();
      const transition = await requests.updateOne(
        { _id: requestId, recipientId: viewerId, status: "pending" },
        { $set: { status: action === "accept" ? "accepted" : "declined", respondedAt } },
      );

      if (transition.matchedCount !== 1) {
        const current = await requests.findOne({ _id: requestId });
        if (!current) {
          throw new HttpError(404, "friend_request_not_found", "Friend request was not found.");
        }
        if (!current.recipientId.equals(viewerId)) {
          throw new HttpError(403, "not_friend_request_recipient", "Only the recipient can respond to this friend request.");
        }
        throw new HttpError(409, "friend_request_already_resolved", "Friend request is no longer pending.");
      }

      const resolved: FriendRequestDocument = {
        ...existing,
        status: action === "accept" ? "accepted" : "declined",
        respondedAt,
      };

      if (action === "accept") {
        const [userIdLow, userIdHigh] = orderedUserPair(existing.senderId, existing.recipientId);
        const friendship: FriendshipDocument = {
          _id: new ObjectId(),
          userIdLow,
          userIdHigh,
          createdAt: respondedAt,
        };
        try {
          await database.collection<FriendshipDocument>(collectionNames.friendships).updateOne(
            { userIdLow, userIdHigh },
            { $setOnInsert: friendship },
            { upsert: true },
          );
        } catch (error) {
          let friendshipExists = false;
          try {
            friendshipExists = (await database
              .collection<FriendshipDocument>(collectionNames.friendships)
              .findOne({ userIdLow, userIdHigh }, { projection: { _id: 1 } })) !== null;
          } catch {
            // Keep the original write error; request logs retain the failure context.
          }
          if (!friendshipExists) {
            try {
              await requests.updateOne(
                { _id: requestId, recipientId: viewerId, status: "accepted", respondedAt },
                { $set: { status: "pending" }, $unset: { respondedAt: "" } },
              );
            } catch {
              // Preserve the original storage error.
            }
            throw error;
          }
        }
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.json({ request: toFriendRequestResponse(resolved) });
    },
  );

  return router;
}

export const friendRequestsRouter = createFriendRequestsRouter();
