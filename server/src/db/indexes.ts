import type { Db, IndexSpecification } from "mongodb";
import { collectionNames } from "./documents";

interface DatabaseIndexDefinition {
  collection: string;
  keys: IndexSpecification;
  options: {
    name: string;
    unique?: boolean;
    expireAfterSeconds?: number;
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
    collection: collectionNames.likes,
    keys: { userId: 1, postId: 1 },
    options: { name: "likes_user_post_unique", unique: true },
  },
  {
    collection: collectionNames.messages,
    keys: { senderId: 1, clientId: 1 },
    options: { name: "messages_sender_client_unique", unique: true },
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
