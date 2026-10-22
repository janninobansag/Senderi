import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import {
  collectionNames,
  type FriendRequestDocument,
  type FriendshipDocument,
  type NotificationDocument,
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { createFriendRequestsRouter } from "../src/routes/friend-requests";
import { createFriendsRouter } from "../src/routes/friends";
import { addPresenceConnection, removePresenceConnection } from "../src/socket/presence";
import { areFriends } from "../src/friends/are-friends";
import { createUsersRouter } from "../src/routes/users";

interface FriendTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  requests: FriendRequestDocument[];
  notifications: NotificationDocument[];
}

function createDatabase(data: FriendTestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id?: ObjectId }) =>
            data.users.find((user) => filter._id && user._id.equals(filter._id)) ?? null,
          find: (filter: Record<string, unknown>) => {
            let result: UserDocument[];
            if ("displayName" in filter) {
              const displayName = filter.displayName as { $regex: string; $options: string };
              const idFilter = filter._id as { $ne: ObjectId };
              const expression = new RegExp(displayName.$regex, displayName.$options);
              const conditions = filter.$or as Array<{
                createdAt?: { $lt: Date } | Date;
                _id?: { $lt: ObjectId };
              }> | undefined;
              result = data.users.filter((user) => {
                const matchesCursor = !conditions || conditions.some((condition) => {
                  if (condition.createdAt instanceof Date) {
                    return user.createdAt.getTime() === condition.createdAt.getTime() &&
                      Boolean(condition._id?.$lt && user._id.toHexString() < condition._id.$lt.toHexString());
                  }
                  return Boolean(condition.createdAt?.$lt && user.createdAt < condition.createdAt.$lt);
                });
                return !user._id.equals(idFilter.$ne) && expression.test(user.displayName) && matchesCursor;
              });
            } else {
              const idFilter = filter._id as { $in: ObjectId[] };
              result = data.users.filter((user) => idFilter.$in.some((id) => user._id.equals(id)));
            }
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => {
                  const dateOrder = right.createdAt.getTime() - left.createdAt.getTime();
                  return dateOrder || right._id.toHexString().localeCompare(left._id.toHexString());
                });
                return cursor;
              },
              limit: (value: number) => {
                maximum = value;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
        };
      }

      if (name === collectionNames.sessions) {
        return {
          findOne: async (filter: { tokenHash: string }) =>
            data.sessions.find((session) => session.tokenHash === filter.tokenHash) ?? null,
        };
      }

      if (name === collectionNames.notifications) {
        return {
          insertOne: async (notification: NotificationDocument) => {
            data.notifications.push(notification);
            return { acknowledged: true, insertedId: notification._id };
          },
        };
      }

      if (name === collectionNames.friendships) {
        return {
          findOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) =>
            data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            ) ?? null,
          find: (filter: { $and?: Array<Record<string, unknown>>; $or?: Array<Record<string, unknown>> }) => {
            const membersFilter = filter.$and?.[0] ?? filter;
            const cursorFilter = filter.$and?.[1];
            const memberConditions = membersFilter.$or as Array<Record<string, unknown>>;
            const cursorConditions = cursorFilter?.$or as Array<{
              createdAt?: { $lt: Date } | Date;
              _id?: { $lt: ObjectId };
            }> | undefined;
            const matchesId = (actual: ObjectId, expected: unknown) => {
              if (expected === undefined) return true;
              if (expected instanceof ObjectId) return actual.equals(expected);
              if (typeof expected === "object" && expected !== null && "$in" in expected) {
                const values = (expected as { $in: unknown }).$in;
                return Array.isArray(values) && values.some((value) => value instanceof ObjectId && actual.equals(value));
              }
              return false;
            };
            let result = data.friendships.filter((friendship) => {
              const isMember = memberConditions.some((condition) =>
                matchesId(friendship.userIdLow, condition.userIdLow) &&
                matchesId(friendship.userIdHigh, condition.userIdHigh),
              );
              const afterCursor = !cursorConditions || cursorConditions.some((condition) => {
                if (condition.createdAt instanceof Date) {
                  return friendship.createdAt.getTime() === condition.createdAt.getTime() &&
                    Boolean(condition._id?.$lt &&
                      friendship._id.toHexString() < condition._id.$lt.toHexString());
                }
                return Boolean(condition.createdAt?.$lt && friendship.createdAt < condition.createdAt.$lt);
              });
              return isMember && afterCursor;
            });
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => {
                  const dateOrder = right.createdAt.getTime() - left.createdAt.getTime();
                  return dateOrder || right._id.toHexString().localeCompare(left._id.toHexString());
                });
                return cursor;
              },
              limit: (value: number) => {
                maximum = value;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
          updateOne: async (
            filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">,
            update: { $setOnInsert: FriendshipDocument },
          ) => {
            const existing = data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            );
            if (existing) return { acknowledged: true, matchedCount: 1, upsertedCount: 0 };
            data.friendships.push(update.$setOnInsert);
            return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
          },
          deleteOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) => {
            const index = data.friendships.findIndex((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            );
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.friendships.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
        };
      }

      if (name === collectionNames.friendRequests) {
        return {
          findOne: async (filter: Partial<FriendRequestDocument>) =>
            data.requests.find((friendRequest) =>
              Object.entries(filter).every(([key, value]) => {
                const actual = friendRequest[key as keyof FriendRequestDocument];
                if (actual instanceof ObjectId && value instanceof ObjectId) return actual.equals(value);
                return actual === value;
              }),
            ) ?? null,
          insertOne: async (friendRequest: FriendRequestDocument) => {
            const duplicatePending = data.requests.some((candidate) =>
              candidate.status === "pending" &&
              candidate.userIdLow.equals(friendRequest.userIdLow) &&
              candidate.userIdHigh.equals(friendRequest.userIdHigh),
            );
            if (duplicatePending) {
              throw Object.assign(new Error("Duplicate pending request."), { code: 11000 });
            }
            data.requests.push(friendRequest);
            return { acknowledged: true, insertedId: friendRequest._id };
          },
          updateOne: async (
            filter: Partial<FriendRequestDocument>,
            update: {
              $set: Partial<FriendRequestDocument>;
              $unset?: Record<string, string>;
            },
          ) => {
            const friendRequest = data.requests.find((candidate) =>
              Object.entries(filter).every(([key, value]) => {
                const actual = candidate[key as keyof FriendRequestDocument];
                if (actual instanceof ObjectId && value instanceof ObjectId) return actual.equals(value);
                if (actual instanceof Date && value instanceof Date) return actual.getTime() === value.getTime();
                return actual === value;
              }),
            );
            if (!friendRequest) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            Object.assign(friendRequest, update.$set);
            for (const field of Object.keys(update.$unset ?? {})) {
              delete friendRequest[field as keyof FriendRequestDocument];
            }
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
          },
          find: (filter: { senderId?: ObjectId; recipientId?: ObjectId; status: "pending" }) => {
            let result = data.requests.filter((friendRequest) =>
              friendRequest.status === filter.status &&
              (filter.senderId ? friendRequest.senderId.equals(filter.senderId) : true) &&
              (filter.recipientId ? friendRequest.recipientId.equals(filter.recipientId) : true),
            );
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => {
                  const dateOrder = right.createdAt.getTime() - left.createdAt.getTime();
                  return dateOrder || right._id.toHexString().localeCompare(left._id.toHexString());
                });
                return cursor;
              },
              toArray: async () => result,
            };
            return cursor;
          },
        };
      }

      return {};
    },
  } as unknown as Db;
}

function makeUser(id: string, email: string, displayName: string): UserDocument {
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  return {
    _id: new ObjectId(id),
    email,
    passwordHash: "$argon2id$test-secret",
    displayName,
    bio: "Public bio",
    info: { location: "Cebu" },
    createdAt,
    updatedAt: createdAt,
  };
}

function sessionFor(user: UserDocument, token: string): SessionDocument {
  const createdAt = new Date();
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
  };
}

function makeFriendship(first: UserDocument, second: UserDocument): FriendshipDocument {
  const [userIdLow, userIdHigh] = [first._id, second._id].sort((left, right) =>
    left.toHexString().localeCompare(right.toHexString()),
  );
  return { _id: new ObjectId(), userIdLow, userIdHigh, createdAt: new Date("2026-10-01T00:00:00.000Z") };
}

function createTestApp(data: FriendTestData) {
  const database = createDatabase(data);
  const app = express();
  app.use(express.json());
  app.use("/api/users", createUsersRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    getCloudinaryCloudName: () => "senderi-demo",
    now: () => new Date("2026-10-01T01:00:00.000Z"),
  }));
  app.use("/api/friend-requests", createFriendRequestsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    now: () => new Date("2026-10-01T01:00:00.000Z"),
  }));
  app.use("/api/friends", createFriendsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    getCloudinaryCloudName: () => "senderi-demo",
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function emptyData(users: UserDocument[], sessions: SessionDocument[]): FriendTestData {
  return { users, sessions, friendships: [], requests: [], notifications: [] };
}

const aliceToken = "alice-friend-token";
const bobToken = "bob-friend-token";
const origin = "http://localhost:5173";

test("signed-in user search paginates newest first and returns only public profile fields", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alex Searcher");
  const matches = [2, 3, 4, 5, 6].map((suffix) =>
    makeUser(`00000000000000000000000${suffix}`, `person${suffix}@example.com`, `Alex Person ${suffix}`),
  );
  const data = emptyData([alice, ...matches], [sessionFor(alice, aliceToken)]);
  const app = createTestApp(data);

  const firstPage = await request(app)
    .get("/api/users?query=Alex&limit=2")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);

  assert.equal(firstPage.status, 200);
  assert.deepEqual(firstPage.body.items.map((user: { id: string }) => user.id), [
    matches[4]._id.toHexString(),
    matches[3]._id.toHexString(),
  ]);
  assert.notEqual(firstPage.body.nextCursor, null);
  assert.deepEqual(Object.keys(firstPage.body.items[0]).sort(), [
    "bio", "createdAt", "displayName", "id", "info",
  ]);
  assert.equal("email" in firstPage.body.items[0], false);
  assert.equal("passwordHash" in firstPage.body.items[0], false);
  assert.equal(firstPage.headers["cache-control"], "private, no-store");

  const secondPage = await request(app)
    .get(`/api/users?query=Alex&limit=2&cursor=${firstPage.body.nextCursor}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(secondPage.status, 200);
  assert.notEqual(secondPage.body.nextCursor, null);

  const thirdPage = await request(app)
    .get(`/api/users?query=Alex&limit=2&cursor=${secondPage.body.nextCursor}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(thirdPage.status, 200);
  assert.equal(thirdPage.body.nextCursor, null);

  const returnedIds = [
    ...firstPage.body.items,
    ...secondPage.body.items,
    ...thirdPage.body.items,
  ].map((user: { id: string }) => user.id);
  assert.deepEqual(returnedIds, matches.slice().reverse().map((user) => user._id.toHexString()));
  assert.equal(new Set(returnedIds).size, matches.length);
});

test("user search requires a session and rejects invalid query and cursor values", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice");
  const app = createTestApp(emptyData([alice], [sessionFor(alice, aliceToken)]));

  const unauthenticated = await request(app).get("/api/users?query=Alice");
  assert.equal(unauthenticated.status, 401);

  const emptyQuery = await request(app)
    .get("/api/users?query=%20%20")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(emptyQuery.status, 400);
  assert.equal(emptyQuery.body.error.code, "validation_error");

  const oversizedPage = await request(app)
    .get("/api/users?query=Alice&limit=51")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(oversizedPage.status, 400);

  const malformedCursor = await request(app)
    .get("/api/users?query=Alice&cursor=YWJj")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(malformedCursor.status, 400);
  assert.equal(malformedCursor.body.error.code, "invalid_cursor");
});

test("two signed-in users can create a request and only see it in their own direction", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken), sessionFor(bob, bobToken)],
  );
  const app = createTestApp(data);

  const unauthenticatedList = await request(app).get("/api/friend-requests");
  assert.equal(unauthenticatedList.status, 401);

  const created = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });

  assert.equal(created.status, 201);
  assert.equal(created.body.request.senderId, alice._id.toHexString());
  assert.equal(created.body.request.recipientId, bob._id.toHexString());
  assert.equal(created.body.request.status, "pending");
  assert.equal(created.body.request.createdAt, "2026-10-01T01:00:00.000Z");
  assert.equal("email" in created.body.request, false);
  assert.equal(data.requests.length, 1);
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0]!.type, "friend_request");
  assert.equal(data.notifications[0]!.recipientId.toHexString(), bob._id.toHexString());
  assert.equal(data.notifications[0]!.actorId.toHexString(), alice._id.toHexString());

  const aliceList = await request(app)
    .get("/api/friend-requests")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(aliceList.status, 200);
  assert.deepEqual(aliceList.body.incoming, []);
  assert.deepEqual(aliceList.body.outgoing, [created.body.request]);

  const bobList = await request(app)
    .get("/api/friend-requests")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`);
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.body.incoming, [created.body.request]);
  assert.deepEqual(bobList.body.outgoing, []);
});

test("friend-request creation denies unauthenticated, self, invalid, unknown, and duplicate requests", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken), sessionFor(bob, bobToken)],
  );
  const app = createTestApp(data);

  const unauthenticated = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .send({ recipientId: bob._id.toHexString() });
  assert.equal(unauthenticated.status, 401);

  const selfRequest = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: alice._id.toHexString() });
  assert.equal(selfRequest.status, 400);
  assert.equal(selfRequest.body.error.code, "cannot_request_self");

  const invalidId = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: "not-an-object-id" });
  assert.equal(invalidId.status, 400);

  const unknownUser = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: "000000000000000000000099" });
  assert.equal(unknownUser.status, 404);

  const created = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  assert.equal(created.status, 201);

  const duplicate = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "friend_request_exists");

  const reverseDuplicate = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`)
    .send({ recipientId: alice._id.toHexString() });
  assert.equal(reverseDuplicate.status, 409);
  assert.equal(data.requests.length, 1);
});

test("friend-request creation denies users who are already friends", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken)],
  );
  data.friendships.push(makeFriendship(alice, bob));
  const app = createTestApp(data);

  const response = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "already_friends");
  assert.deepEqual(data.requests, []);
});

test("the pending-pair unique index rejects concurrent duplicate friend requests", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken)],
  );
  const app = createTestApp(data);

  const submit = () => request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  const responses = await Promise.all([submit(), submit()]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(data.requests.length, 1);
});

test("only the recipient can decline a pending request and declined requests do not create friendships", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken), sessionFor(bob, bobToken)],
  );
  const app = createTestApp(data);
  const created = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  const requestId = created.body.request.id as string;

  const senderCannotDecline = await request(app)
    .patch(`/api/friend-requests/${requestId}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ action: "decline" });
  assert.equal(senderCannotDecline.status, 403);
  assert.equal(data.requests[0].status, "pending");

  const senderCannotAccept = await request(app)
    .patch(`/api/friend-requests/${requestId}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ action: "accept" });
  assert.equal(senderCannotAccept.status, 403);
  assert.equal(data.requests[0].status, "pending");

  const declined = await request(app)
    .patch(`/api/friend-requests/${requestId}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`)
    .send({ action: "decline" });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.request.status, "declined");
  assert.equal(declined.body.request.respondedAt, "2026-10-01T01:00:00.000Z");
  assert.equal(data.requests[0].status, "declined");
  assert.equal(data.friendships.length, 0);
  assert.equal(await areFriends(createDatabase(data), alice._id, bob._id), false);

  const secondResponse = await request(app)
    .patch(`/api/friend-requests/${requestId}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`)
    .send({ action: "accept" });
  assert.equal(secondResponse.status, 409);
  assert.equal(secondResponse.body.error.code, "friend_request_already_resolved");

  const retriedRequest = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  assert.equal(retriedRequest.status, 201);
  assert.equal(data.requests.length, 2);
  assert.equal(data.requests[1].status, "pending");
});

test("concurrent acceptance resolves once and creates one mutual friendship", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const data = emptyData(
    [alice, bob],
    [sessionFor(alice, aliceToken), sessionFor(bob, bobToken)],
  );
  const app = createTestApp(data);
  const created = await request(app)
    .post("/api/friend-requests")
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`)
    .send({ recipientId: bob._id.toHexString() });
  const requestId = created.body.request.id as string;
  const accept = () => request(app)
    .patch(`/api/friend-requests/${requestId}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`)
    .send({ action: "accept" });
  const responses = await Promise.all([accept(), accept()]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(data.requests[0].status, "accepted");
  assert.equal(data.friendships.length, 1);
  assert.equal(data.notifications.length, 2);
  assert.equal(data.notifications[1]!.type, "friend_accepted");
  assert.equal(data.notifications[1]!.recipientId.toHexString(), alice._id.toHexString());
  assert.equal(data.notifications[1]!.actorId.toHexString(), bob._id.toHexString());
  assert.equal(data.notifications.length, 2);
  assert.equal(data.notifications[1]!.type, "friend_accepted");
  assert.equal(data.notifications[1]!.recipientId.toHexString(), alice._id.toHexString());
  assert.equal(data.notifications[1]!.actorId.toHexString(), bob._id.toHexString());
  assert.equal(await areFriends(createDatabase(data), alice._id, bob._id), true);
  assert.equal(await areFriends(createDatabase(data), alice._id, alice._id), false);

  const bobProfileOfAlice = await request(app)
    .get(`/api/users/${alice._id.toHexString()}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`);
  assert.equal(bobProfileOfAlice.status, 200);
  assert.equal(bobProfileOfAlice.body.friendshipStatus, "friends");
});

test("friends are paged as public profiles and either friend can remove the relationship", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000002", "bob@example.com", "Bob Example");
  const charlie = makeUser("000000000000000000000003", "charlie@example.com", "Charlie Example");
  const data = emptyData(
    [alice, bob, charlie],
    [sessionFor(alice, aliceToken), sessionFor(bob, bobToken)],
  );
  data.friendships.push(makeFriendship(alice, bob), makeFriendship(alice, charlie));
  const app = createTestApp(data);

  const firstPage = await request(app)
    .get("/api/friends?limit=1&includeMutualCounts=true")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.items.length, 1);
  assert.notEqual(firstPage.body.nextCursor, null);
  assert.equal(firstPage.body.items[0].mutualFriendCount, 0);
  assert.equal("email" in firstPage.body.items[0], false);
  assert.equal("passwordHash" in firstPage.body.items[0], false);

  const secondPage = await request(app)
    .get(`/api/friends?limit=1&includeMutualCounts=true&cursor=${firstPage.body.nextCursor}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.items.length, 1);
  assert.equal(secondPage.body.nextCursor, null);
  assert.equal(secondPage.body.items[0].mutualFriendCount, 0);
  assert.deepEqual(
    [firstPage.body.items[0].id, secondPage.body.items[0].id].sort(),
    [bob._id.toHexString(), charlie._id.toHexString()].sort(),
  );

  const removedByBob = await request(app)
    .delete(`/api/friends/${alice._id.toHexString()}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`);
  assert.equal(removedByBob.status, 204);
  assert.equal(await areFriends(createDatabase(data), alice._id, bob._id), false);

  const bobListAfterRemoval = await request(app)
    .get("/api/friends")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`);
  assert.deepEqual(bobListAfterRemoval.body, { items: [], nextCursor: null });

  const removedByAlice = await request(app)
    .delete(`/api/friends/${charlie._id.toHexString()}`)
    .set("Origin", origin)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(removedByAlice.status, 204);
  assert.equal(data.friendships.length, 0);
  assert.equal(await areFriends(createDatabase(data), alice._id, charlie._id), false);

  const emptyList = await request(app)
    .get("/api/friends")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.deepEqual(emptyList.body, { items: [], nextCursor: null });
});

test("friend list reports shared friends and excludes the signed-in viewer", async () => {
  const alice = makeUser("000000000000000000000011", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000012", "bob@example.com", "Bob Example");
  const charlie = makeUser("000000000000000000000013", "charlie@example.com", "Charlie Example");
  const diana = makeUser("000000000000000000000014", "diana@example.com", "Diana Example");
  const data = emptyData(
    [alice, bob, charlie, diana],
    [sessionFor(alice, aliceToken)],
  );
  data.friendships.push(
    makeFriendship(alice, bob),
    makeFriendship(alice, charlie),
    makeFriendship(alice, diana),
    makeFriendship(bob, charlie),
  );
  const app = createTestApp(data);

  const response = await request(app)
    .get("/api/friends?limit=20&includeMutualCounts=true")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(
    Object.fromEntries(response.body.items.map((friend: { id: string; mutualFriendCount: number }) => [friend.id, friend.mutualFriendCount])),
    {
      [bob._id.toHexString()]: 1,
      [charlie._id.toHexString()]: 1,
      [diana._id.toHexString()]: 0,
    },
  );
});

test("presence is restricted to friends and reflects all live connections", async () => {
  const alice = makeUser("000000000000000000000021", "alice@example.com", "Alice Example");
  const bob = makeUser("000000000000000000000022", "bob@example.com", "Bob Example");
  const stranger = makeUser("000000000000000000000023", "stranger@example.com", "Stranger");
  bob.lastActiveAt = new Date("2026-10-01T00:58:00.000Z");
  const data = emptyData([alice, bob, stranger], [sessionFor(alice, aliceToken)]);
  data.friendships.push(makeFriendship(alice, bob));
  const app = createTestApp(data);
  const ids = [bob, stranger, alice].map((user) => user._id.toHexString()).join(",");
  const url = `/api/friends/presence?ids=${ids}`;
  const bobId = bob._id.toHexString();

  const unauthenticated = await request(app).get(url);
  assert.equal(unauthenticated.status, 401);
  const invalid = await request(app).get("/api/friends/presence?ids=invalid")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.equal(invalid.status, 400);

  const offline = await request(app).get(url).set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
  assert.deepEqual(offline.body.items, [{ userId: bobId, isOnline: false, lastActiveAt: bob.lastActiveAt.toISOString() }]);
  assert.equal(offline.headers["cache-control"], "private, no-store");

  addPresenceConnection(bobId, "tab-one");
  addPresenceConnection(bobId, "tab-two");
  try {
    removePresenceConnection(bobId, "tab-one");
    const online = await request(app).get(url).set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
    assert.deepEqual(online.body.items, [{ userId: bobId, isOnline: true, lastActiveAt: bob.lastActiveAt.toISOString() }]);
  } finally {
    removePresenceConnection(bobId, "tab-one");
    removePresenceConnection(bobId, "tab-two");
  }
});
