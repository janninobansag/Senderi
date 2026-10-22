import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import {
  collectionNames,
  type FriendshipDocument,
  type MessageDocument,
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { orderedUserPair } from "../src/friends/are-friends";
import { createChatsRouter } from "../src/routes/chats";

interface MessageTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  messages: MessageDocument[];
}

type MongoFilter = Record<string, unknown>;

function matchesObjectId(actual: ObjectId, expected: unknown): boolean {
  if (expected instanceof ObjectId) return actual.equals(expected);
  if (typeof expected === "object" && expected !== null && "$lt" in expected) {
    return actual.toHexString() < (expected.$lt as ObjectId).toHexString();
  }
  return false;
}

function matchesMessage(message: MessageDocument, filter: MongoFilter): boolean {
  if ("$and" in filter) {
    return (filter.$and as MongoFilter[]).every((condition) => matchesMessage(message, condition));
  }
  if ("$or" in filter) {
    return (filter.$or as MongoFilter[]).some((condition) => matchesMessage(message, condition));
  }

  return Object.entries(filter).every(([field, expected]) => {
    if (field === "_id") return matchesObjectId(message._id, expected);
    if (field === "senderId") return matchesObjectId(message.senderId, expected);
    if (field === "recipientId") return matchesObjectId(message.recipientId, expected);
    if (field === "isRead") return message.isRead === expected;
    if (field === "createdAt") {
      if (expected instanceof Date) return message.createdAt.getTime() === expected.getTime();
      if (typeof expected === "object" && expected !== null && "$lt" in expected) {
        return message.createdAt.getTime() < (expected.$lt as Date).getTime();
      }
    }
    return false;
  });
}

class MessageCursor {
  private count = Number.POSITIVE_INFINITY;

  constructor(
    private readonly messages: MessageDocument[],
    private readonly filter: MongoFilter,
  ) {}

  sort(order: Record<string, number>): this {
    assert.deepEqual(order, { createdAt: -1, _id: -1 });
    return this;
  }

  limit(count: number): this {
    this.count = count;
    return this;
  }

  async toArray(): Promise<MessageDocument[]> {
    return this.messages
      .filter((message) => matchesMessage(message, this.filter))
      .sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right._id.toHexString().localeCompare(left._id.toHexString()),
      )
      .slice(0, this.count);
  }
}

function createDatabase(data: MessageTestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return {
          findOne: async (filter: { tokenHash: string }) =>
            data.sessions.find((session) => session.tokenHash === filter.tokenHash) ?? null,
        };
      }
      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id: ObjectId }) =>
            data.users.find((user) => user._id.equals(filter._id)) ?? null,
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
      if (name === collectionNames.messages) {
        return {
          find: (filter: MongoFilter) => new MessageCursor(data.messages, filter),
          aggregate: (pipeline: MongoFilter[]) => ({
            toArray: async () => {
              const unreadBySender = new Map<string, number>();
              const filter = pipeline[0]?.$match as MongoFilter;
              for (const message of data.messages) {
                if (matchesMessage(message, filter)) {
                  const senderId = message.senderId.toHexString();
                  unreadBySender.set(senderId, (unreadBySender.get(senderId) ?? 0) + 1);
                }
              }
              return [...unreadBySender].map(([id, unreadCount]) => ({
                _id: new ObjectId(id),
                unreadCount,
              }));
            },
          }),
          updateMany: async (filter: MongoFilter, update: MongoFilter) => {
            const { isRead, readAt } = update.$set as { isRead: boolean; readAt: Date };
            let modifiedCount = 0;
            for (const message of data.messages) {
              if (matchesMessage(message, filter)) {
                message.isRead = isRead;
                message.readAt = readAt;
                modifiedCount += 1;
              }
            }
            return { modifiedCount };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as unknown as Db;
}

const fixedNow = new Date("2026-10-01T12:00:00.000Z");

function makeUser(id: string, email: string): UserDocument {
  return {
    _id: new ObjectId(id),
    email,
    passwordHash: "$argon2id$unused-in-this-test",
    displayName: email.split("@")[0] ?? "Test user",
    bio: "",
    info: {},
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function sessionFor(user: UserDocument, token: string): SessionDocument {
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt: fixedNow,
    expiresAt: new Date(fixedNow.getTime() + 60_000),
  };
}

function friendshipFor(first: UserDocument, second: UserDocument): FriendshipDocument {
  const [userIdLow, userIdHigh] = orderedUserPair(first._id, second._id);
  return { _id: new ObjectId(), userIdLow, userIdHigh, createdAt: fixedNow };
}

function messageFor(
  id: string,
  sender: UserDocument,
  recipient: UserDocument,
  text: string,
): MessageDocument {
  return {
    _id: new ObjectId(id),
    senderId: sender._id,
    recipientId: recipient._id,
    clientId: `client-${id}`,
    text,
    createdAt: fixedNow,
    isRead: false,
  };
}

function createTestApp(data: MessageTestData) {
  const database = createDatabase(data);
  const app = express();
  app.use("/api/chats", createChatsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://client.test"],
    now: () => fixedNow,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test("friend conversation history is stably paged newest-first and non-friends are denied", async () => {
  const alice = makeUser("000000000000000000000001", "alice@example.com");
  const bob = makeUser("000000000000000000000002", "bob@example.com");
  const carol = makeUser("000000000000000000000003", "carol@example.com");
  const friendship = friendshipFor(alice, bob);
  const data: MessageTestData = {
    users: [alice, bob, carol],
    sessions: [
      sessionFor(alice, "alice-session"),
      sessionFor(bob, "bob-session"),
      sessionFor(carol, "carol-session"),
    ],
    friendships: [friendship],
    // Equal timestamps exercise the ObjectId tie-breaker. The last record is
    // deliberately outside Alice and Bob's conversation.
    messages: [
      messageFor("000000000000000000000001", alice, bob, "first"),
      messageFor("000000000000000000000002", bob, alice, "second"),
      messageFor("000000000000000000000003", alice, bob, "third"),
      messageFor("000000000000000000000004", bob, alice, "fourth"),
      messageFor("000000000000000000000005", alice, bob, "fifth"),
      messageFor("ffffffffffffffffffffffff", alice, carol, "unrelated"),
    ],
  };
  const app = createTestApp(data);
  const aliceId = alice._id.toHexString();
  const bobId = bob._id.toHexString();
  const aliceCookie = `${SESSION_COOKIE_NAME}=alice-session`;
  const bobCookie = `${SESSION_COOKIE_NAME}=bob-session`;

  const firstPage = await request(app)
    .get(`/api/chats/${bobId}/messages?limit=2`)
    .set("Cookie", aliceCookie);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.headers["cache-control"], "private, no-store");
  assert.deepEqual(firstPage.body.items.map((message: { id: string }) => message.id), [
    "000000000000000000000005",
    "000000000000000000000004",
  ]);
  assert.notEqual(firstPage.body.nextCursor, null);
  assert.deepEqual(Object.keys(firstPage.body.items[0]).sort(), [
    "clientId", "createdAt", "id", "recipientId", "senderId", "text",
  ]);
  assert.equal(firstPage.body.items[0].clientId, "client-000000000000000000000005");
  assert.equal("clientId" in firstPage.body.items[1], false, "other authors' client IDs stay private");

  const secondPage = await request(app)
    .get(`/api/chats/${bobId}/messages?limit=2&cursor=${firstPage.body.nextCursor}`)
    .set("Cookie", aliceCookie);
  assert.equal(secondPage.status, 200);
  assert.deepEqual(secondPage.body.items.map((message: { id: string }) => message.id), [
    "000000000000000000000003",
    "000000000000000000000002",
  ]);
  assert.notEqual(secondPage.body.nextCursor, null);

  const thirdPage = await request(app)
    .get(`/api/chats/${bobId}/messages?limit=2&cursor=${secondPage.body.nextCursor}`)
    .set("Cookie", aliceCookie);
  assert.equal(thirdPage.status, 200);
  assert.deepEqual(thirdPage.body.items.map((message: { id: string }) => message.id), [
    "000000000000000000000001",
  ]);
  assert.equal(thirdPage.body.nextCursor, null);

  const reverseConversation = await request(app)
    .get(`/api/chats/${aliceId}/messages?limit=2`)
    .set("Cookie", bobCookie);
  assert.equal(reverseConversation.status, 200);
  assert.deepEqual(
    reverseConversation.body.items.map((message: { id: string }) => message.id),
    firstPage.body.items.map((message: { id: string }) => message.id),
  );

  const legacyMessage = messageFor("000000000000000000000006", bob, alice, "older history");
  delete legacyMessage.isRead;
  data.messages.push(legacyMessage);

  const unreadBeforeOpening = await request(app)
    .get("/api/chats/unread")
    .set("Cookie", aliceCookie);
  assert.equal(unreadBeforeOpening.status, 200);
  assert.equal(unreadBeforeOpening.headers["cache-control"], "private, no-store");
  assert.deepEqual(unreadBeforeOpening.body.items, [{ friendId: bobId, unreadCount: 2 }]);

  const markRead = await request(app)
    .patch(`/api/chats/${bobId}/read`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test");
  assert.equal(markRead.status, 204);
  assert.equal(data.messages.filter((message) => message.senderId.equals(bob._id) && message.recipientId.equals(alice._id) && message.isRead).length, 2);
  assert.equal(legacyMessage.isRead, undefined, "unread tracking leaves pre-feature history alone");

  const unreadAfterOpening = await request(app)
    .get("/api/chats/unread")
    .set("Cookie", aliceCookie);
  assert.deepEqual(unreadAfterOpening.body.items, []);

  const cannotMarkNonFriendRead = await request(app)
    .patch(`/api/chats/${carol._id.toHexString()}/read`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test");
  assert.equal(cannotMarkNonFriendRead.status, 404);

  const nonFriendHistory = await request(app)
    .get(`/api/chats/${aliceId}/messages`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=carol-session`);
  assert.equal(nonFriendHistory.status, 404);
  assert.deepEqual(nonFriendHistory.body, {
    error: { code: "conversation_not_found", message: "Conversation was not found." },
  });

  data.friendships.splice(0, 1);
  const formerFriendHistory = await request(app)
    .get(`/api/chats/${aliceId}/messages`)
    .set("Cookie", bobCookie);
  assert.equal(formerFriendHistory.status, 404);
});
test("message history requires authentication and validates IDs, cursors, and page limits", async () => {
  const alice = makeUser("000000000000000000000011", "alice@example.com");
  const bob = makeUser("000000000000000000000012", "bob@example.com");
  const app = createTestApp({
    users: [alice, bob],
    sessions: [sessionFor(alice, "alice-session")],
    friendships: [friendshipFor(alice, bob)],
    messages: [],
  });
  const bobId = bob._id.toHexString();

  const unauthenticated = await request(app).get(`/api/chats/${bobId}/messages`);
  assert.equal(unauthenticated.status, 401);

  const invalidFriend = await request(app)
    .get("/api/chats/not-an-id/messages")
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`);
  assert.equal(invalidFriend.status, 400);

  const invalidLimit = await request(app)
    .get(`/api/chats/${bobId}/messages?limit=51`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`);
  assert.equal(invalidLimit.status, 400);

  const invalidCursor = await request(app)
    .get(`/api/chats/${bobId}/messages?cursor=not-a-valid-cursor`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`);
  assert.equal(invalidCursor.status, 400);
  assert.equal(invalidCursor.body.error.code, "invalid_cursor");
});
