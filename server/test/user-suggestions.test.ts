import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { type FriendRequestDocument, type FriendshipDocument, type SessionDocument, type UserDocument, collectionNames } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { createUsersRouter } from "../src/routes/users";

function makeUser(displayName: string): UserDocument {
  const now = new Date("2026-10-01T00:00:00.000Z");
  return {
    _id: new ObjectId(),
    email: `${displayName.toLowerCase().replaceAll(" ", ".")}@example.com`,
    passwordHash: "$argon2id$not-used-in-this-test",
    displayName,
    bio: "",
    info: {},
    createdAt: now,
    updatedAt: now,
  };
}

function createDatabase(
  users: UserDocument[],
  session: SessionDocument,
  friendships: FriendshipDocument[],
  friendRequests: FriendRequestDocument[],
): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return { findOne: async () => session };
      }
      if (name === collectionNames.friendships) {
        return {
          find: (filter: { $or: Array<Record<string, ObjectId>> }) => ({
            toArray: async () => friendships.filter((friendship) =>
              filter.$or.some((condition) =>
                (condition.userIdLow && friendship.userIdLow.equals(condition.userIdLow)) ||
                (condition.userIdHigh && friendship.userIdHigh.equals(condition.userIdHigh)),
              ),
            ),
          }),
        };
      }
      if (name === collectionNames.friendRequests) {
        return {
          find: (filter: { status: string; $or: Array<Record<string, ObjectId>> }) => ({
            toArray: async () => friendRequests.filter((friendRequest) =>
              friendRequest.status === filter.status && filter.$or.some((condition) =>
                (condition.senderId && friendRequest.senderId.equals(condition.senderId)) ||
                (condition.recipientId && friendRequest.recipientId.equals(condition.recipientId)),
              ),
            ),
          }),
        };
      }
      if (name === collectionNames.users) {
        return {
          findOne: async ({ _id }: { _id: ObjectId }) => users.find((user) => user._id.equals(_id)) ?? null,
          find: (filter: { _id: { $nin: ObjectId[] } }) => {
            let limit = Number.POSITIVE_INFINITY;
            const results = users.filter((user) => !filter._id.$nin.some((id) => id.equals(user._id)));
            const cursor = {
              sort: () => cursor,
              limit: (value: number) => { limit = value; return cursor; },
              toArray: async () => results.slice(0, limit),
            };
            return cursor;
          },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  } as unknown as Db;
}

test("friend suggestions exclude the viewer, accepted friends, and pending request targets", async () => {
  const viewer = makeUser("Viewer Example");
  const friend = makeUser("Current Friend");
  const incoming = makeUser("Incoming Request");
  const outgoing = makeUser("Outgoing Request");
  const suggestion = makeUser("Suggested Person");
  const [userIdLow, userIdHigh] = [viewer._id, friend._id].sort((left, right) =>
    left.toHexString().localeCompare(right.toHexString()),
  );
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  const friendships: FriendshipDocument[] = [{ _id: new ObjectId(), userIdLow, userIdHigh, createdAt }];
  const friendRequests: FriendRequestDocument[] = [
    { _id: new ObjectId(), senderId: incoming._id, recipientId: viewer._id, userIdLow: incoming._id, userIdHigh: viewer._id, status: "pending", createdAt },
    { _id: new ObjectId(), senderId: viewer._id, recipientId: outgoing._id, userIdLow: viewer._id, userIdHigh: outgoing._id, status: "pending", createdAt },
  ];
  const token = "suggestions-session-token";
  const session: SessionDocument = {
    _id: new ObjectId(),
    userId: viewer._id,
    tokenHash: hashSessionToken(token),
    createdAt,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const database = createDatabase([viewer, friend, incoming, outgoing, suggestion], session, friendships, friendRequests);
  const app = express();
  app.use("/api/users", createUsersRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    getCloudinaryCloudName: () => undefined,
    now: () => createdAt,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const response = await request(app)
    .get("/api/users/suggestions?limit=20")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map((user: { id: string }) => user.id), [suggestion._id.toHexString()]);
  assert.equal(response.body.items[0].email, undefined);
  assert.equal(response.body.nextCursor, null);
  assert.equal(response.headers["cache-control"], "private, no-store");
});
