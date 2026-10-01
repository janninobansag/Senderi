import type { ObjectId } from "mongodb";

/** MongoDB collection names; add new feature collections here. */
export const collectionNames = {
  users: "users",
  sessions: "sessions",
  friendRequests: "friendRequests",
  friendships: "friendships",
  posts: "posts",
  comments: "comments",
  likes: "likes",
  shares: "shares",
  messages: "messages",
  passwordResets: "passwordResets",
  socketTickets: "socketTickets",
  rateLimits: "rateLimits",
} as const;

/** Store a trimmed, lowercase email and an Argon2id password hash. */
export interface UserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  displayName: string;
  bio: string;
  info: {
    location?: string;
    website?: string;
  };
  avatarId?: string;
  coverId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Store the lexicographically ordered ObjectIds as userIdLow/userIdHigh. */
export interface FriendshipDocument {
  _id: ObjectId;
  userIdLow: ObjectId;
  userIdHigh: ObjectId;
  createdAt: Date;
}

export interface LikeDocument {
  _id: ObjectId;
  userId: ObjectId;
  postId: ObjectId;
  createdAt: Date;
}

export interface MessageDocument {
  _id: ObjectId;
  senderId: ObjectId;
  recipientId: ObjectId;
  clientId: string;
  text: string;
  createdAt: Date;
}

/** TTL-managed documents use BSON Date values in expiresAt. */
export interface ExpiringDocument {
  expiresAt: Date;
}

export interface SessionDocument extends ExpiringDocument {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  createdAt: Date;
}

export interface PasswordResetDocument extends ExpiringDocument {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  createdAt: Date;
}

export interface SocketTicketDocument extends ExpiringDocument {
  _id: ObjectId;
  userId: ObjectId;
  ticketHash: string;
  createdAt: Date;
}

export interface RateLimitDocument extends ExpiringDocument {
  _id: string;
  count: number;
  createdAt: Date;
}
