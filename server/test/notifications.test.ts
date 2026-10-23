import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type NotificationDocument, type PushSubscriptionDocument, type SessionDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { createNotificationsRouter } from "../src/routes/notifications";

const ownerId = new ObjectId("000000000000000000000001");
const actorId = new ObjectId("000000000000000000000002");
const otherId = new ObjectId("000000000000000000000003");
const ownerToken = "notification-owner-token";

function makeUser(id: ObjectId, displayName: string): UserDocument {
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  return {
    _id: id,
    email: `${displayName.toLowerCase()}@example.test`,
    passwordHash: "must-not-be-returned",
    displayName,
    bio: "Public bio",
    info: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function makeNotification(
  recipientId: ObjectId,
  actorId: ObjectId,
  createdAt: Date,
  read = false,
): NotificationDocument {
  return {
    _id: new ObjectId(),
    recipientId,
    actorId,
    type: "post_like",
    postId: new ObjectId("000000000000000000000011"),
    createdAt,
    ...(read ? { readAt: new Date(createdAt.getTime() + 1_000) } : {}),
  };
}

function createApp() {
  const owner = makeUser(ownerId, "Owner");
  const actor = makeUser(actorId, "Actor");
  const other = makeUser(otherId, "Other");
  const createdAt = new Date("2026-10-21T00:00:00.000Z");
  const session: SessionDocument = {
    _id: new ObjectId(),
    userId: ownerId,
    tokenHash: hashSessionToken(ownerToken),
    createdAt,
    expiresAt: new Date("2026-10-29T00:00:00.000Z"),
  };
  const notifications = [
    makeNotification(ownerId, actorId, new Date("2026-10-22T00:00:00.000Z")),
    makeNotification(ownerId, actorId, new Date("2026-10-21T00:00:00.000Z"), true),
    makeNotification(otherId, actorId, new Date("2026-10-23T00:00:00.000Z")),
  ];
  const pushSubscriptions: PushSubscriptionDocument[] = [{
    _id: new ObjectId(),
    userId: otherId,
    endpoint: "https://push.example/other-device",
    expirationTime: null,
    keys: { p256dh: "other-p256dh", auth: "other-auth" },
    createdAt,
    updatedAt: createdAt,
  }];
  const users = [owner, actor, other];
  const database = {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return { findOne: async (filter: { tokenHash: string }) => session.tokenHash === filter.tokenHash ? session : null };
      }
      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id: ObjectId }) => users.find((user) => user._id.equals(filter._id)) ?? null,
          find: (filter: { _id: { $in: ObjectId[] } }) => ({
            toArray: async () => users.filter((user) => filter._id.$in.some((id) => user._id.equals(id))),
          }),
        };
      }
      if (name === collectionNames.notifications) {
        return {
          find: (filter: { recipientId: ObjectId }) => {
            let result = notifications.filter((item) => item.recipientId.equals(filter.recipientId));
            let limit = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
                return cursor;
              },
              limit: (value: number) => { limit = value; return cursor; },
              toArray: async () => result.slice(0, limit),
            };
            return cursor;
          },
          countDocuments: async (filter: { recipientId: ObjectId; readAt: { $exists: boolean } }) =>
            notifications.filter((item) => item.recipientId.equals(filter.recipientId) && !item.readAt).length,
          updateOne: async (filter: { _id: ObjectId; recipientId: ObjectId; readAt: { $exists: boolean } }, update: { $set: { readAt: Date } }) => {
            const target = notifications.find((item) => item._id.equals(filter._id) && item.recipientId.equals(filter.recipientId) && !item.readAt);
            if (target) target.readAt = update.$set.readAt;
            return { acknowledged: true, modifiedCount: target ? 1 : 0 };
          },
          updateMany: async (filter: { recipientId: ObjectId; readAt: { $exists: boolean } }, update: { $set: { readAt: Date } }) => {
            const unread = notifications.filter((item) => item.recipientId.equals(filter.recipientId) && !item.readAt);
            unread.forEach((item) => { item.readAt = update.$set.readAt; });
            return { acknowledged: true, modifiedCount: unread.length };
          },
        };
      }
      if (name === collectionNames.pushSubscriptions) {
        return {
          updateOne: async (
            filter: { endpoint: string; userId: ObjectId },
            update: {
              $set: Pick<PushSubscriptionDocument, "endpoint" | "expirationTime" | "keys" | "updatedAt">;
              $setOnInsert: Pick<PushSubscriptionDocument, "_id" | "userId" | "createdAt">;
            },
          ) => {
            if (pushSubscriptions.some((item) => item.endpoint === filter.endpoint && !item.userId.equals(filter.userId))) {
              throw Object.assign(new Error("Duplicate push endpoint"), { code: 11000 });
            }
            const existing = pushSubscriptions.find((item) => item.endpoint === filter.endpoint && item.userId.equals(filter.userId));
            if (existing) Object.assign(existing, update.$set);
            else pushSubscriptions.push({ ...update.$set, ...update.$setOnInsert });
            return { acknowledged: true, matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
          },
          deleteOne: async (filter: { endpoint: string; userId: ObjectId }) => {
            const index = pushSubscriptions.findIndex((item) => item.endpoint === filter.endpoint && item.userId.equals(filter.userId));
            if (index !== -1) pushSubscriptions.splice(index, 1);
            return { acknowledged: true, deletedCount: index === -1 ? 0 : 1 };
          },
        };
      }
      return {};
    },
  } as unknown as Db;
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", createNotificationsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    getCloudinaryCloudName: () => undefined,
    getPushPublicKey: () => "test-public-key",
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, notifications, pushSubscriptions };
}

test("push subscriptions are opt-in, authenticated, and scoped to the signed-in user", async () => {
  const { app, pushSubscriptions } = createApp();
  const cookie = `${SESSION_COOKIE_NAME}=${ownerToken}`;
  const endpoint = "https://push.example/owner-device";

  const publicKey = await request(app).get("/api/notifications/push/public-key").expect(200);
  assert.equal(publicKey.body.publicKey, "test-public-key");
  assert.equal(publicKey.headers["cache-control"], "private, no-store");

  await request(app)
    .put("/api/notifications/push-subscription")
    .set("Origin", "http://localhost:5173")
    .send({ endpoint, expirationTime: null, keys: { p256dh: "owner-p256dh", auth: "owner-auth" } })
    .expect(401);
  await request(app)
    .put("/api/notifications/push-subscription")
    .set("Cookie", cookie)
    .send({ endpoint, expirationTime: null, keys: { p256dh: "owner-p256dh", auth: "owner-auth" } })
    .expect(403);
  await request(app)
    .put("/api/notifications/push-subscription")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .send({ endpoint, expirationTime: null, keys: { p256dh: "owner-p256dh", auth: "owner-auth" } })
    .expect(204);
  assert.equal(pushSubscriptions.find((item) => item.endpoint === endpoint)?.userId.toHexString(), ownerId.toHexString());

  await request(app)
    .put("/api/notifications/push-subscription")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .send({ endpoint: "http://insecure.example/push", keys: { p256dh: "key", auth: "key" } })
    .expect(400);

  await request(app)
    .delete("/api/notifications/push-subscription")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .send({ endpoint: "https://push.example/other-device" })
    .expect(204);
  assert.ok(pushSubscriptions.some((item) => item.endpoint === "https://push.example/other-device"));

  await request(app)
    .delete("/api/notifications/push-subscription")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .send({ endpoint })
    .expect(204);
  assert.ok(pushSubscriptions.every((item) => item.endpoint !== endpoint));
});

test("notifications list only the viewer's newest activity and mark read safely", async () => {
  const { app, notifications } = createApp();
  const cookie = `${SESSION_COOKIE_NAME}=${ownerToken}`;

  await request(app).get("/api/notifications").expect(401);

  const response = await request(app).get("/api/notifications").set("Cookie", cookie).expect(200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.body.unreadCount, 1);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.items[0].actor.displayName, "Actor");
  assert.equal(response.body.items[0].isRead, false);
  assert.equal("email" in response.body.items[0].actor, false);
  assert.equal("passwordHash" in response.body.items[0].actor, false);
  assert.equal("postText" in response.body.items[0], false);

  const foreignNotification = notifications[2]!;
  await request(app)
    .patch(`/api/notifications/${foreignNotification._id.toHexString()}/read`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .expect(204);
  assert.equal(foreignNotification.readAt, undefined, "a viewer cannot mark another user's notification as read");

  const ownNotification = notifications[0]!;
  await request(app)
    .patch(`/api/notifications/${ownNotification._id.toHexString()}/read`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .expect(204);
  const afterOneRead = await request(app).get("/api/notifications").set("Cookie", cookie).expect(200);
  assert.equal(afterOneRead.body.unreadCount, 0);
  assert.equal(afterOneRead.body.items.find((item: { id: string }) => item.id === ownNotification._id.toHexString()).isRead, true);

  const unread = makeNotification(ownerId, actorId, new Date("2026-10-24T00:00:00.000Z"));
  notifications.push(unread);
  await request(app)
    .patch("/api/notifications/read-all")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .expect(204);
  assert.ok(notifications.filter((item) => item.recipientId.equals(ownerId)).every((item) => item.readAt));
});

test("notification read routes validate identifiers and require the allowed origin", async () => {
  const { app } = createApp();
  const cookie = `${SESSION_COOKIE_NAME}=${ownerToken}`;

  await request(app)
    .patch("/api/notifications/not-an-id/read")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie)
    .expect(400);
  await request(app)
    .patch(`/api/notifications/${new ObjectId().toHexString()}/read`)
    .set("Cookie", cookie)
    .expect(403);
});
