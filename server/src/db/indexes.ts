import type { Db, Document, IndexSpecification } from "mongodb";
import { collectionNames } from "./documents";

interface DatabaseIndexDefinition {
  collection: string;
  keys: IndexSpecification;
  options: {
    name: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Document;
  };
}

/**
 * Keep index declarations centralized so every server start applies the same
 * persistence rules. Friendship pairs use scalar, lexicographically ordered
 * userIdLow/userIdHigh fields rather than an array; this permits each user to
 * have multiple friends while enforcing one record per pair. All TTL fields
 * are BSON dates named expiresAt.
 */
export const databaseIndexes: readonly DatabaseIndexDefinition[] = [
  // Signup stores a trimmed, lowercase email before this unique index is applied.
  {
    collection: collectionNames.users,
    keys: { email: 1 },
    options: { name: "users_email_unique", unique: true },
  },
  {
    collection: collectionNames.friendships,
    keys: { userIdLow: 1, userIdHigh: 1 },
    options: { name: "friendships_pair_unique", unique: true },
  },
  {
    collection: collectionNames.friendships,
    keys: { userIdLow: 1, createdAt: -1, _id: -1 },
    options: { name: "friendships_low_created_at" },
  },
  {
    collection: collectionNames.friendships,
    keys: { userIdHigh: 1, createdAt: -1, _id: -1 },
    options: { name: "friendships_high_created_at" },
  },
  {
    collection: collectionNames.friendRequests,
    keys: { userIdLow: 1, userIdHigh: 1 },
    options: {
      name: "friend_requests_pending_pair_unique",
      unique: true,
      partialFilterExpression: { status: "pending" },
    },
  },
  {
    collection: collectionNames.friendRequests,
    keys: { recipientId: 1, status: 1, createdAt: -1, _id: -1 },
    options: { name: "friend_requests_incoming_pending" },
  },
  {
    collection: collectionNames.friendRequests,
    keys: { senderId: 1, status: 1, createdAt: -1, _id: -1 },
    options: { name: "friend_requests_outgoing_pending" },
  },
  {
    collection: collectionNames.posts,
    keys: { authorId: 1, createdAt: -1, _id: -1 },
    options: { name: "posts_author_newest_first" },
  },
  {
    collection: collectionNames.posts,
    keys: { visibility: 1, createdAt: -1, _id: -1 },
    options: { name: "posts_visibility_newest_first" },
  },
  {
    collection: collectionNames.posts,
    keys: { createdAt: -1, _id: -1 },
    options: { name: "posts_admin_newest_first" },
  },
  {
    collection: collectionNames.likes,
    keys: { userId: 1, postId: 1 },
    options: { name: "likes_user_post_unique", unique: true },
  },
  {
    collection: collectionNames.shareLikes,
    keys: { userId: 1, shareId: 1 },
    options: { name: "share_likes_user_share_unique", unique: true },
  },
  {
    collection: collectionNames.shareLikes,
    keys: { shareId: 1 },
    options: { name: "share_likes_by_share" },
  },
  {
    collection: collectionNames.comments,
    keys: { postId: 1, createdAt: -1, _id: -1 },
    options: { name: "comments_post_newest_first" },
  },
  {
    collection: collectionNames.comments,
    keys: { createdAt: -1, _id: -1 },
    options: { name: "comments_admin_newest_first" },
  },
  {
    collection: collectionNames.adminAudit,
    keys: { createdAt: -1, _id: -1 },
    options: { name: "admin_audit_newest_first" },
  },
  {
    collection: collectionNames.shares,
    keys: { authorId: 1, createdAt: -1, _id: -1 },
    options: { name: "shares_author_newest_first" },
  },
  {
    collection: collectionNames.shares,
    keys: { visibility: 1, createdAt: -1, _id: -1 },
    options: { name: "shares_visibility_newest_first" },
  },
  {
    collection: collectionNames.shares,
    keys: { sourceShareId: 1, visibility: 1 },
    options: { name: "shares_source_share_visibility" },
  },
  {
    collection: collectionNames.notifications,
    keys: { recipientId: 1, createdAt: -1, _id: -1 },
    options: { name: "notifications_recipient_newest_first" },
  },
  {
    collection: collectionNames.pushSubscriptions,
    keys: { endpoint: 1 },
    options: { name: "push_subscriptions_endpoint_unique", unique: true },
  },
  {
    collection: collectionNames.pushSubscriptions,
    keys: { userId: 1 },
    options: { name: "push_subscriptions_user" },
  },
  {
    collection: collectionNames.messages,
    keys: { senderId: 1, clientId: 1 },
    options: { name: "messages_sender_client_unique", unique: true },
  },
  {
    collection: collectionNames.messages,
    keys: { senderId: 1, recipientId: 1, createdAt: -1, _id: -1 },
    options: { name: "messages_conversation_newest_first" },
  },
  {
    collection: collectionNames.messages,
    keys: { recipientId: 1, isRead: 1, senderId: 1 },
    options: { name: "messages_recipient_is_read_by_sender" },
  },
  {
    collection: collectionNames.sessions,
    keys: { expiresAt: 1 },
    options: { name: "sessions_expires_at_ttl", expireAfterSeconds: 0 },
  },
  {
    collection: collectionNames.passwordResets,
    keys: { userId: 1 },
    options: { name: "password_resets_user_unique", unique: true },
  },
  {
    collection: collectionNames.passwordResets,
    keys: { expiresAt: 1 },
    options: { name: "password_resets_expires_at_ttl", expireAfterSeconds: 0 },
  },
  {
    collection: collectionNames.socketTickets,
    keys: { ticketHash: 1 },
    options: { name: "socket_tickets_hash_unique", unique: true },
  },
  {
    collection: collectionNames.socketTickets,
    keys: { expiresAt: 1 },
    options: { name: "socket_tickets_expires_at_ttl", expireAfterSeconds: 0 },
  },
  {
    collection: collectionNames.rateLimits,
    keys: { expiresAt: 1 },
    options: { name: "rate_limits_expires_at_ttl", expireAfterSeconds: 0 },
  },
];

export async function ensureDatabaseIndexes(database: Db): Promise<void> {
  for (const index of databaseIndexes) {
    await database.collection(index.collection).createIndex(index.keys, index.options);
  }
}
