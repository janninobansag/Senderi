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
      ["shareLikes", { userId: 1, shareId: 1 }],
      ["commentReactions", { commentId: 1, userId: 1 }],
      ["reports", { reporterId: 1, targetType: 1, targetId: 1 }],
      ["pushSubscriptions", { endpoint: 1 }],
      ["messages", { senderId: 1, clientId: 1 }],
      ["passwordResets", { userId: 1 }],
      ["socketTickets", { ticketHash: 1 }],
    ],
  );
  assert.deepEqual(
    databaseIndexes.find((index) => index.options.name === "reports_reporter_target_unique")?.options.partialFilterExpression,
    { status: "open" },
  );

  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.collection === "shareLikes")
      .map(({ keys, options }) => [keys, options.name, options.unique ?? false]),
    [
      [{ userId: 1, shareId: 1 }, "share_likes_user_share_unique", true],
      [{ shareId: 1 }, "share_likes_by_share", false],
    ],
  );
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.collection === "commentReactions")
      .map(({ keys, options }) => [keys, options.name, options.unique ?? false]),
    [
      [{ commentId: 1, userId: 1 }, "comment_reactions_comment_user_unique", true],
      [{ commentId: 1 }, "comment_reactions_by_comment", false],
      [{ postId: 1 }, "comment_reactions_by_post", false],
    ],
  );
  assert.deepEqual(
    databaseIndexes.find((index) => index.options.name === "comments_post_reply_target"),
    {
      collection: "comments",
      keys: { postId: 1, replyToCommentId: 1 },
      options: { name: "comments_post_reply_target" },
    },
  );

  const pendingFriendRequestIndex = databaseIndexes.find(
    (index) => index.options.name === "friend_requests_pending_pair_unique",
  );
  assert.deepEqual(pendingFriendRequestIndex?.options.partialFilterExpression, { status: "pending" });
  assert.deepEqual(
    databaseIndexes.find((index) => index.options.name === "notifications_recipient_newest_first"),
    {
      collection: "notifications",
      keys: { recipientId: 1, createdAt: -1, _id: -1 },
      options: { name: "notifications_recipient_newest_first" },
    },
  );
  assert.deepEqual(
    databaseIndexes.find((index) => index.options.name === "reports_status_newest_first"),
    {
      collection: "reports",
      keys: { status: 1, createdAt: -1, _id: -1 },
      options: { name: "reports_status_newest_first" },
    },
  );
  assert.deepEqual(
    databaseIndexes.find((index) => index.options.name === "push_subscriptions_user"),
    {
      collection: "pushSubscriptions",
      keys: { userId: 1 },
      options: { name: "push_subscriptions_user" },
    },
  );
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
      [{ createdAt: -1, _id: -1 }, "posts_admin_newest_first"],
    ],
  );
  assert.deepEqual(
    databaseIndexes
      .filter((index) => index.options.name.startsWith("messages_"))
      .map(({ keys, options }) => [keys, options.name]),
    [
      [{ senderId: 1, clientId: 1 }, "messages_sender_client_unique"],
      [{ senderId: 1, recipientId: 1, createdAt: -1, _id: -1 }, "messages_conversation_newest_first"],
      [{ recipientId: 1, isRead: 1, senderId: 1 }, "messages_recipient_is_read_by_sender"],
      [{ groupId: 1, createdAt: -1, _id: -1 }, "messages_group_newest_first"],
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
      ["reports", { purgeAt: 1 }, 0],
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
      listIndexes: () => ({ toArray: async () => [] }),
      dropIndex: async () => "dropped",
      updateMany: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }),
    }),
  } as unknown as Db;

  await ensureDatabaseIndexes(database);

  assert.deepEqual(
    createdIndexes,
    databaseIndexes.map(({ collection, keys, options }) => ({ collection, keys, options })),
  );
});

test("startup replaces the all-time report duplicate index with an open-report-only index", async () => {
  const droppedIndexes: string[] = [];
  const createdIndexes: Array<{ collection: string; keys: unknown; options: unknown }> = [];
  const reportBackfills: Array<{ filter: unknown; update: unknown }> = [];
  const database = {
    collection: (collection: string) => ({
      createIndex: async (keys: unknown, options: unknown) => {
        createdIndexes.push({ collection, keys, options });
        return "created";
      },
      listIndexes: () => ({ toArray: async () => collection === "reports" ? [{ name: "reports_reporter_target_unique", unique: true }] : [] }),
      dropIndex: async (name: string) => { droppedIndexes.push(name); return "dropped"; },
      updateMany: async (filter: unknown, update: unknown) => { reportBackfills.push({ filter, update }); return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; },
    }),
  } as unknown as Db;

  await ensureDatabaseIndexes(database);

  assert.deepEqual(droppedIndexes, ["reports_reporter_target_unique"]);
  assert.deepEqual(reportBackfills, [{
    filter: { purgeAt: { $exists: false } },
    update: [{ $set: { purgeAt: { $add: [{ $ifNull: ["$reviewedAt", "$createdAt"] }, 604_800_000] } } }],
  }]);
  assert.deepEqual(
    createdIndexes.find((index) => (index.options as { name?: string }).name === "reports_reporter_target_unique")?.options,
    { name: "reports_reporter_target_unique", unique: true, partialFilterExpression: { status: "open" } },
  );
});
