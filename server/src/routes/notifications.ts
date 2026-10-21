import { ObjectId, type Db } from "mongodb";
import { Router, type Response } from "express";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type NotificationDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { requireClientOrigin } from "../middleware/require-client-origin";

const PAGE_SIZE = 30;

export interface NotificationsRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  getCloudinaryCloudName: () => string | undefined;
}

const defaultDependencies: NotificationsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getAllowedOrigins: () => (process.env.CLIENT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  getCloudinaryCloudName: () => process.env.CLOUDINARY_CLOUD_NAME,
};

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function parseNotificationId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, "invalid_notification_id", "Notification ID is invalid.");
  }
  return new ObjectId(value);
}

export function createNotificationsRouter(overrides: Partial<NotificationsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });

  router.get("/", authenticated, async (_request, response) => {
    const database = dependencies.getDatabase();
    const recipientId = getAuthenticatedSession(response).user._id;
    const notificationsCollection = database.collection<NotificationDocument>(collectionNames.notifications);
    const [notifications, unreadCount] = await Promise.all([
      notificationsCollection.find({ recipientId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(PAGE_SIZE)
        .toArray(),
      notificationsCollection.countDocuments({ recipientId, readAt: { $exists: false } }),
    ]);
    const actorIds = [...new Map(notifications.map((item) => [item.actorId.toHexString(), item.actorId])).values()];
    const actors = actorIds.length
      ? await database.collection<UserDocument>(collectionNames.users).find({ _id: { $in: actorIds } }, {
        projection: { _id: 1, displayName: 1, bio: 1, info: 1, avatarId: 1, coverId: 1, createdAt: 1 },
      }).toArray()
      : [];
    const actorsById = new Map(actors.map((actor) => [actor._id.toHexString(), actor]));

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      unreadCount,
      items: notifications.flatMap((item) => {
        const actor = actorsById.get(item.actorId.toHexString());
        if (!actor) return [];
        return [{
          id: item._id.toHexString(),
          type: item.type,
          actor: toPublicUserResponse(actor, dependencies.getCloudinaryCloudName()),
          createdAt: item.createdAt.toISOString(),
          isRead: Boolean(item.readAt),
          ...(item.postId ? { postId: item.postId.toHexString() } : {}),
          ...(item.shareId ? { shareId: item.shareId.toHexString() } : {}),
          ...(item.friendRequestId ? { friendRequestId: item.friendRequestId.toHexString() } : {}),
        }];
      }),
    });
  });

  router.patch(
    "/read-all",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (_request, response) => {
      const recipientId = getAuthenticatedSession(response).user._id;
      await dependencies.getDatabase().collection<NotificationDocument>(collectionNames.notifications).updateMany(
        { recipientId, readAt: { $exists: false } },
        { $set: { readAt: new Date() } },
      );
      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  router.patch(
    "/:notificationId/read",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const notificationId = parseNotificationId(String(request.params.notificationId));
      const recipientId = getAuthenticatedSession(response).user._id;
      await dependencies.getDatabase().collection<NotificationDocument>(collectionNames.notifications).updateOne(
        { _id: notificationId, recipientId, readAt: { $exists: false } },
        { $set: { readAt: new Date() } },
      );
      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  return router;
}

export const notificationsRouter = createNotificationsRouter();
