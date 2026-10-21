import assert from "node:assert/strict";
import test from "node:test";
import { closeDatabase, connectToDatabase } from "../src/db/client";
import type { Db } from "mongodb";
import { databaseIndexes, ensureDatabaseIndexes } from "../src/db/indexes";

test("MongoDB configuration is required before server startup", async () => {
  await assert.rejects(connectToDatabase("  "), /MONGODB_URI is required.*server\/\.env/);
});

test("closing an uninitialized database connection is safe", async () => {
  await closeDatabase();
});

test("database indexes cover documented uniqueness and expiry rules", () => {
  const uniqueIndexes = databaseIndexes.filter((index) => index.options.unique);
  assert.deepEqual(
    uniqueIndexes.map(({ collection, keys }) => [collection, keys]),
    [
      ["users", { email: 1 }],
      ["friendships", { userIdLow: 1, userIdHigh: 1 }],
      ["friendRequests", { userIdLow: 1, userIdHigh: 1 }],
      ["likes", { userId: 1, postId: 1 }],
      ["messages", { senderId: 1, clientId: 1 }],
      ["passwordResets", { userId: 1 }],
      ["socketTickets", { ticketHash: 1 }],
    ],
  );

  const pendingFriendRequestIndex = databaseIndexes.find(
    (index) => index.options.name === "friend_requests_pending_pair_unique",
  );
  assert.deepEqual(pendingFriendRequestIndex?.options.partialFilterExpression, { status: "pending" });
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.options.name.startsWith("friendships_"))
      .map(({ keys, options }) => [keys, options.name]),
    [
      [{ userIdLow: 1, userIdHigh: 1 }, "friendships_pair_unique"],
      [{ userIdLow: 1, createdAt: -1, _id: -1 }, "friendships_low_created_at"],
      [{ userIdHigh: 1, createdAt: -1, _id: -1 }, "friendships_high_created_at"],
    ],
  );
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.options.name.startsWith("posts_"))
      .map(({ keys, options }) => [keys, options.name]),
    [
      [{ authorId: 1, createdAt: -1, _id: -1 }, "posts_author_newest_first"],
      [{ visibility: 1, createdAt: -1, _id: -1 }, "posts_visibility_newest_first"],
    ],
  );
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.options.name.startsWith("messages_"))
      .map(({ keys, options }) => [keys, options.name]),
    [
      [{ senderId: 1, clientId: 1 }, "messages_sender_client_unique"],
      [{ senderId: 1, recipientId: 1, createdAt: -1, _id: -1 }, "messages_conversation_newest_first"],
    ],
  );
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.options.name.startsWith("socket_tickets_"))
      .map(({ keys, options }) => [keys, options.name, options.unique ?? false]),
    [
      [{ ticketHash: 1 }, "socket_tickets_hash_unique", true],
      [{ expiresAt: 1 }, "socket_tickets_expires_at_ttl", false],
    ],
  );

  const ttlIndexes = databaseIndexes.filter((index) => index.options.expireAfterSeconds !== undefined);
  assert.deepEqual(
    ttlIndexes.map(({ collection, keys, options }) => [collection, keys, options.expireAfterSeconds]),
    [
      ["sessions", { expiresAt: 1 }, 0],
      ["passwordResets", { expiresAt: 1 }, 0],
      ["socketTickets", { expiresAt: 1 }, 0],
      ["rateLimits", { expiresAt: 1 }, 0],
    ],
  );
});

test("startup creates every declared database index", async () => {
  const createdIndexes: Array<{ collection: string; keys: unknown; options: unknown }> = [];
  const database = {
    collection: (collection: string) => ({
      createIndex: async (keys: unknown, options: unknown) => {
        createdIndexes.push({ collection, keys, options });
        return "created";
      },
    }),
  } as unknown as Db;

  await ensureDatabaseIndexes(database);

  assert.deepEqual(
    createdIndexes,
    databaseIndexes.map(({ collection, keys, options }) => ({ collection, keys, options })),
  );
});
