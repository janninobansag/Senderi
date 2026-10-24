import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { Readable } from "node:stream";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import sharp from "sharp";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import {
  collectionNames,
  type FriendshipDocument,
  type GroupConversationDocument,
  type MessageDocument,
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { orderedUserPair } from "../src/friends/are-friends";
import { createChatsRouter } from "../src/routes/chats";
import type { PostPhotoStorage } from "../src/media/post-photo";

interface MessageTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  groups?: GroupConversationDocument[];
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
    if (field === "groupId") {
      if (typeof expected === "object" && expected !== null && "$exists" in expected) {
        return (message.groupId !== undefined) === expected.$exists;
      }
      return message.groupId ? matchesObjectId(message.groupId, expected) : false;
    }
    if (field === "clientId") return message.clientId === expected;
    if (field === "photoAssetId") return message.photoAssetId === expected;
    if (field === "moderationHiddenAt" && typeof expected === "object" && expected !== null && "$exists" in expected) {
      return (message.moderationHiddenAt !== undefined) === expected.$exists;
    }
    if (field === "isRead") return message.isRead === expected;
    if (field === "createdAt") {
      if (expected instanceof Date) return message.createdAt.getTime() === expected.getTime();
      if (typeof expected === "object" && expected !== null && "$lt" in expected) {
        return message.createdAt.getTime() < (expected.$lt as Date).getTime();
      }
      if (typeof expected === "object" && expected !== null && "$gt" in expected) {
        return message.createdAt.getTime() > (expected.$gt as Date).getTime();
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
      if (name === collectionNames.groupConversations) {
        return {
          find: () => ({ toArray: async () => data.groups ?? [] }),
        };
      }
      if (name === collectionNames.messages) {
        return {
          findOne: async (filter: MongoFilter) => data.messages.find((message) => matchesMessage(message, filter)) ?? null,
          insertOne: async (message: MessageDocument) => {
            data.messages.push(message);
            return { insertedId: message._id };
          },
          updateOne: async (filter: MongoFilter, update: MongoFilter) => {
            const message = data.messages.find((item) => matchesMessage(item, filter));
            if (!message) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(message, update.$set as Partial<MessageDocument>);
            return { matchedCount: 1, modifiedCount: 1 };
          },
          deleteOne: async (filter: MongoFilter) => {
            const index = data.messages.findIndex((item) => matchesMessage(item, filter));
            if (index < 0) return { deletedCount: 0 };
            data.messages.splice(index, 1);
            return { deletedCount: 1 };
          },
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

function createTestApp(data: MessageTestData, photoStorage?: PostPhotoStorage) {
  const database = createDatabase(data);
  const app = express();
  app.use(express.json());
  app.use("/api/chats", createChatsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://client.test"],
    now: () => fixedNow,
    ...(photoStorage ? { photoStorage } : {}),
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

test("moderator-hidden chat messages disappear from history, unread counts, and read updates", async () => {
  const alice = makeUser("000000000000000000000041", "alice@example.com");
  const bob = makeUser("000000000000000000000042", "bob@example.com");
  const hiddenMessage = messageFor("000000000000000000000043", alice, bob, "Hidden while reviewed");
  hiddenMessage.moderationHiddenAt = fixedNow;
  const visibleMessage = messageFor("000000000000000000000044", alice, bob, "Still visible");
  const data: MessageTestData = {
    users: [alice, bob],
    sessions: [sessionFor(alice, "alice-session"), sessionFor(bob, "bob-session")],
    friendships: [friendshipFor(alice, bob)],
    messages: [hiddenMessage, visibleMessage],
  };
  const app = createTestApp(data);
  const bobCookie = `${SESSION_COOKIE_NAME}=bob-session`;

  const history = await request(app).get(`/api/chats/${alice._id}/messages`).set("Cookie", bobCookie);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.map((item: { text: string }) => item.text), ["Still visible"]);

  const unread = await request(app).get("/api/chats/unread").set("Cookie", bobCookie);
  assert.equal(unread.body.items[0]?.unreadCount, 1);

  const markedRead = await request(app).patch(`/api/chats/${alice._id}/read`).set("Cookie", bobCookie).set("Origin", "http://client.test");
  assert.equal(markedRead.status, 204);
  assert.equal(hiddenMessage.isRead, false);
  assert.equal(visibleMessage.isRead, true);
});

test("senders can edit and permanently delete their text messages", async () => {
  const alice = makeUser("000000000000000000000031", "alice@example.com");
  const bob = makeUser("000000000000000000000032", "bob@example.com");
  const message = messageFor("000000000000000000000033", alice, bob, "Original text");
  const data: MessageTestData = {
    users: [alice, bob],
    sessions: [sessionFor(alice, "alice-session"), sessionFor(bob, "bob-session")],
    friendships: [friendshipFor(alice, bob)],
    messages: [message],
  };
  const app = createTestApp(data);
  const messageId = message._id.toHexString();

  const edited = await request(app)
    .patch(`/api/chats/messages/${messageId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`)
    .set("Origin", "http://client.test")
    .send({ text: "Updated text" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.text, "Updated text");
  assert.equal(edited.body.message.editedAt, fixedNow.toISOString());

  const emptyEdit = await request(app)
    .patch(`/api/chats/messages/${messageId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`)
    .set("Origin", "http://client.test")
    .send({ text: "   " });
  assert.equal(emptyEdit.status, 400);
  assert.equal(data.messages[0]?.text, "Updated text");

  const recipientCannotEdit = await request(app)
    .patch(`/api/chats/messages/${messageId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=bob-session`)
    .set("Origin", "http://client.test")
    .send({ text: "Unauthorized edit" });
  assert.equal(recipientCannotEdit.status, 404);

  const recipientCannotDelete = await request(app)
    .delete(`/api/chats/messages/${messageId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=bob-session`)
    .set("Origin", "http://client.test");
  assert.equal(recipientCannotDelete.status, 404);
  assert.equal(data.messages.length, 1);

  const deleted = await request(app)
    .delete(`/api/chats/messages/${messageId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`)
    .set("Origin", "http://client.test");
  assert.equal(deleted.status, 204);
  assert.equal(data.messages.length, 0);
});

test("photo messages upload privately and only conversation participants can retrieve them", async () => {
  const alice = makeUser("000000000000000000000021", "alice@example.com");
  const bob = makeUser("000000000000000000000022", "bob@example.com");
  const carol = makeUser("000000000000000000000023", "carol@example.com");
  const assets = new Map<string, { buffer: Buffer; contentType: "image/jpeg" | "image/png" | "image/webp" }>();
  const photoStorage: PostPhotoStorage = {
    upload: async (buffer, publicId) => {
      const detectedType = await import("file-type").then(({ fileTypeFromBuffer }) => fileTypeFromBuffer(buffer));
      assert.ok(detectedType?.mime === "image/jpeg" || detectedType?.mime === "image/png" || detectedType?.mime === "image/webp");
      assets.set(publicId, { buffer, contentType: detectedType.mime });
      return { assetId: publicId };
    },
    destroy: async (assetId) => { assets.delete(assetId); },
    download: async (assetId) => {
      const asset = assets.get(assetId);
      if (!asset) throw new Error("missing asset");
      return {
        stream: Readable.from([asset.buffer]),
        contentType: asset.contentType,
        contentLength: asset.buffer.length,
      };
    },
  };
  const data: MessageTestData = {
    users: [alice, bob, carol],
    sessions: [sessionFor(alice, "alice-session"), sessionFor(bob, "bob-session"), sessionFor(carol, "carol-session")],
    friendships: [friendshipFor(alice, bob)],
    messages: [],
  };
  const app = createTestApp(data, photoStorage);
  const realtimeEvents: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  app.set("realtimeServer", {
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        realtimeEvents.push({ room, event, payload });
      },
    }),
  });
  const image = await sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 190, g: 140, b: 60 } } })
    .png()
    .toBuffer();
  const aliceCookie = `${SESSION_COOKIE_NAME}=alice-session`;
  const bobCookie = `${SESSION_COOKIE_NAME}=bob-session`;
  const carolCookie = `${SESSION_COOKIE_NAME}=carol-session`;
  const bobId = bob._id.toHexString();

  const sent = await request(app)
    .post(`/api/chats/${bobId}/messages`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test")
    .field("clientId", "photo-client-id")
    .field("text", "Hello with a photo")
    .attach("file", image, { filename: "photo.png", contentType: "image/png" });
  assert.equal(sent.status, 201);
  assert.equal(sent.headers["cache-control"], "private, no-store");
  assert.equal(sent.body.message.text, "Hello with a photo");
  assert.match(sent.body.message.photoUrl, /^\/api\/chats\/messages\/[a-f\d]{24}\/photo$/);
  assert.equal(sent.body.message.clientId, "photo-client-id");
  assert.equal(data.messages.length, 1);
  assert.equal(assets.size, 1);
  assert.equal(realtimeEvents.length, 1);
  assert.equal(realtimeEvents[0]?.room, `user:${bobId}`);
  assert.equal(realtimeEvents[0]?.event, "message:new");
  assert.equal("clientId" in ((realtimeEvents[0]?.payload.message as Record<string, unknown> | undefined) ?? {}), false);

  const history = await request(app)
    .get(`/api/chats/${alice._id.toHexString()}/messages`)
    .set("Cookie", bobCookie);
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].photoUrl, sent.body.message.photoUrl);
  assert.equal("clientId" in history.body.items[0], false);

  const photoUrl = sent.body.message.photoUrl as string;
  const retrievedByRecipient = await request(app).get(photoUrl).set("Cookie", bobCookie);
  assert.equal(retrievedByRecipient.status, 200);
  assert.match(retrievedByRecipient.headers["content-type"], /^image\/(png|webp|jpeg)/);
  assert.equal(retrievedByRecipient.headers["cache-control"], "private, no-store");
  assert.ok(retrievedByRecipient.body.length > 0);

  const deniedToOtherUser = await request(app).get(photoUrl).set("Cookie", carolCookie);
  assert.equal(deniedToOtherUser.status, 404);

  const duplicate = await request(app)
    .post(`/api/chats/${bobId}/messages`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test")
    .field("clientId", "photo-client-id")
    .field("text", "Hello with a photo")
    .attach("file", image, { filename: "photo.png", contentType: "image/png" });
  assert.equal(duplicate.status, 200);
  assert.equal(data.messages.length, 1);
  assert.equal(assets.size, 1, "an idempotent retry does not upload a second asset");

  data.friendships.splice(0, 1);
  const deniedAfterFriendshipEnds = await request(app).get(photoUrl).set("Cookie", bobCookie);
  assert.equal(deniedAfterFriendshipEnds.status, 404);
  data.friendships.push(friendshipFor(alice, bob));

  const messageId = sent.body.message.id as string;
  const edited = await request(app)
    .patch(`/api/chats/messages/${messageId}`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test")
    .send({ text: "Updated photo caption" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.text, "Updated photo caption");
  assert.equal(edited.body.message.editedAt, fixedNow.toISOString());
  assert.equal(data.messages[0]?.text, "Updated photo caption");
  assert.deepEqual(realtimeEvents.slice(1).map(({ room, event }) => ({ room, event })), [
    { room: `user:${alice._id.toHexString()}`, event: "message:updated" },
    { room: `user:${bobId}`, event: "message:updated" },
  ]);

  const recipientCannotEdit = await request(app)
    .patch(`/api/chats/messages/${messageId}`)
    .set("Cookie", bobCookie)
    .set("Origin", "http://client.test")
    .send({ text: "Unauthorized caption" });
  assert.equal(recipientCannotEdit.status, 404);

  const removed = await request(app)
    .delete(`/api/chats/messages/${messageId}`)
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test");
  assert.equal(removed.status, 204);
  assert.equal(data.messages.length, 0);
  assert.equal(assets.size, 0, "permanent deletion removes the private Cloudinary asset");
  assert.deepEqual(realtimeEvents.slice(-2).map(({ room, event, payload }) => ({ room, event, messageId: payload.messageId })), [
    { room: `user:${alice._id.toHexString()}`, event: "message:deleted", messageId },
    { room: `user:${bobId}`, event: "message:deleted", messageId },
  ]);
  const photoAfterDelete = await request(app).get(photoUrl).set("Cookie", bobCookie);
  assert.equal(photoAfterDelete.status, 404);
});
