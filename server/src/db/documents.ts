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
  shareLikes: "shareLikes",
  shares: "shares",
  notifications: "notifications",
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
  lastActiveAt?: Date;
}

/** Store the lexicographically ordered ObjectIds as userIdLow/userIdHigh. */
export interface FriendshipDocument {
  _id: ObjectId;
  userIdLow: ObjectId;
  userIdHigh: ObjectId;
  createdAt: Date;
}

/** A friend request keeps its direction and a canonical pair for deduplication. */
export interface FriendRequestDocument {
  _id: ObjectId;
  senderId: ObjectId;
  recipientId: ObjectId;
  userIdLow: ObjectId;
  userIdHigh: ObjectId;
  status: "pending" | "accepted" | "declined";
  createdAt: Date;
  respondedAt?: Date;
}

/** A post's audience is checked against its author and the viewer's current friendship. */
export type PostVisibility = "public" | "friends" | "onlyMe";

export interface PostDocument {
  _id: ObjectId;
  authorId: ObjectId;
  text?: string;
  /** Cloudinary authenticated asset public ID; never return it to clients. */
  photoAssetId?: string;
  visibility: PostVisibility;
  createdAt: Date;
  updatedAt: Date;
}

export interface LikeDocument {
  _id: ObjectId;
  userId: ObjectId;
  postId: ObjectId;
  createdAt: Date;
}

/** A reaction belongs to one share card, independently of its source post. */
export interface ShareLikeDocument {
  _id: ObjectId;
  userId: ObjectId;
  shareId: ObjectId;
  createdAt: Date;
}

/** A text comment belongs to a post and its author is the authenticated user. */
export interface CommentDocument {
  _id: ObjectId;
  postId: ObjectId;
  authorId: ObjectId;
  text: string;
  createdAt: Date;
}

/** A share points to a source post and has its own author and audience. */
export interface ShareDocument {
  _id: ObjectId;
  authorId: ObjectId;
  sourcePostId: ObjectId;
  /** Optional text the author added when sharing the source post. */
  caption?: string;
  visibility: PostVisibility;
  createdAt: Date;
}

export type NotificationType =
  | "post_like"
  | "share_like"
  | "post_comment"
  | "post_share"
  | "friend_request"
  | "friend_accepted";

export interface NotificationDocument {
  _id: ObjectId;
  recipientId: ObjectId;
  actorId: ObjectId;
  type: NotificationType;
  postId?: ObjectId;
  shareId?: ObjectId;
  friendRequestId?: ObjectId;
  createdAt: Date;
  readAt?: Date;
}

export interface MessageDocument {
  _id: ObjectId;
  senderId: ObjectId;
  recipientId: ObjectId;
  clientId: string;
  text: string;
  createdAt: Date;
  /** Explicitly false only for newly delivered messages awaiting the recipient. */
  isRead?: boolean;
  readAt?: Date;
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
  sessionId: ObjectId;
  ticketHash: string;
  createdAt: Date;
}

export interface RateLimitDocument extends ExpiringDocument {
  _id: string;
  count: number;
  createdAt: Date;
}
