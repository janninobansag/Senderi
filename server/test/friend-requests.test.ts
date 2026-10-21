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
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { createFriendRequestsRouter } from "../src/routes/friend-requests";
import { createUsersRouter } from "../src/routes/users";

interface FriendTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  requests: FriendRequestDocument[];
}

function createDatabase(data: FriendTestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id?: ObjectId }) =>
            data.users.find((user) => filter._id && user._id.equals(filter._id)) ?? null,
          find: (filter: {
            displayName: { $regex: string; $options: string };
            _id: { $ne: ObjectId };
            $or?: Array<{
              createdAt?: { $lt: Date } | Date;
              _id?: { $lt: ObjectId };
            }>;
          }) => {
            const expression = new RegExp(filter.displayName.$regex, filter.displayName.$options);
            const matchesCursor = (user: UserDocument): boolean => {
              if (!filter.$or) return true;
              return filter.$or.some((condition) => {
                if (condition.createdAt instanceof Date) {
                  return user.createdAt.getTime() === condition.createdAt.getTime() &&
                    Boolean(condition._id?.$lt && user._id.toHexString() < condition._id.$lt.toHexString());
                }
                return Boolean(condition.createdAt?.$lt && user.createdAt < condition.createdAt.$lt);
              });
            };
            let result = data.users.filter((user) =>
              !user._id.equals(filter._id.$ne) && expression.test(user.displayName) && matchesCursor(user),
            );
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

      if (name === collectionNames.friendships) {
        return {
          findOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) =>
            data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            ) ?? null,
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
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function emptyData(users: UserDocument[], sessions: SessionDocument[]): FriendTestData {
  return { users, sessions, friendships: [], requests: [] };
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
