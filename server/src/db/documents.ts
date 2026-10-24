import type { ObjectId } from "mongodb";

/** MongoDB collection names; add new feature collections here. */
export const collectionNames = {
  users: "users",
  sessions: "sessions",
  friendRequests: "friendRequests",
  friendships: "friendships",
  posts: "posts",
  comments: "comments",
  commentReactions: "commentReactions",
  likes: "likes",
  shareLikes: "shareLikes",
  shares: "shares",
  notifications: "notifications",
  pushSubscriptions: "pushSubscriptions",
  messages: "messages",
  groupConversations: "groupConversations",
  passwordResets: "passwordResets",
  socketTickets: "socketTickets",
  rateLimits: "rateLimits",
  adminAudit: "adminAudit",
  reports: "reports",
} as const;

export const REPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

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
  supporterBadge?: boolean;
  verifiedBadge?: boolean;
  suspendedAt?: Date;
  /** Set when the owner temporarily disables sign-in. Logging in clears this field. */
  deactivatedAt?: Date;
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
  status: "pending" | "accepted" | "declined" | "cancelled";
  createdAt: Date;
  respondedAt?: Date;
}

/** A post's audience is checked against its author and the viewer's current friendship. */
export type PostVisibility = "public" | "friends" | "onlyMe";

export interface PostDocument {
  _id: ObjectId;
  authorId: ObjectId;
  text?: string;
  mentionedUserIds?: ObjectId[];
  /** Cloudinary authenticated asset public ID; never return it to clients. */
  photoAssetId?: string;
  visibility: PostVisibility;
  createdAt: Date;
  updatedAt: Date;
  hiddenAt?: Date;
  hiddenBy?: ObjectId;
  hiddenReason?: string;
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
  shareId?: ObjectId;
  parentCommentId?: ObjectId;
  replyToCommentId?: ObjectId;
  mentionedUserIds?: ObjectId[];
  authorId: ObjectId;
  text: string;
  createdAt: Date;
  editedAt?: Date;
  hiddenAt?: Date;
  hiddenBy?: ObjectId;
  hiddenReason?: string;
}

export interface CommentReactionDocument {
  _id: ObjectId;
  postId: ObjectId;
  commentId: ObjectId;
  userId: ObjectId;
  createdAt: Date;
}

export interface AdminAuditDocument {
  _id: ObjectId;
  actorId: ObjectId;
  targetId: ObjectId;
  action: string;
  reason: string;
  createdAt: Date;
}

export type ReportTargetType = "post" | "share" | "comment" | "message";
export type ReportReason = "spam" | "harassment" | "hate" | "violence" | "sexual_content" | "scam" | "other";
export type ReportStatus = "open" | "resolved" | "dismissed";

/** A report keeps a small content snapshot so moderators have context if the item changes. */
export interface ReportDocument {
  _id: ObjectId;
  reporterId: ObjectId;
  targetType: ReportTargetType;
  targetId: ObjectId;
  targetOwnerId: ObjectId;
  reason: ReportReason;
  details?: string;
  targetExcerpt: string;
  hasPhoto: boolean;
  createdAt: Date;
  status: ReportStatus;
  reviewedAt?: Date;
  reviewedBy?: ObjectId;
  reviewReason?: string;
  actionTaken?: boolean;
  purgeAt?: Date;
}

/** A share points to a source post and has its own author and audience. */
export interface ShareDocument {
  _id: ObjectId;
  authorId: ObjectId;
  sourcePostId: ObjectId;
  /** Set when this share was created from another share of the same post. */
  sourceShareId?: ObjectId;
  /** Optional text the author added when sharing the source post. */
  caption?: string;
  visibility: PostVisibility;
  hiddenAt?: Date;
  hiddenBy?: ObjectId;
  hiddenReason?: string;
  createdAt: Date;
}

export type NotificationType =
  | "post_like"
  | "share_like"
  | "post_comment"
  | "post_mention"
  | "post_body_mention"
  | "post_share"
  | "friend_request"
  | "friend_accepted"
  | "report_update"
  | "content_moderated";

export interface NotificationDocument {
  _id: ObjectId;
  recipientId: ObjectId;
  actorId: ObjectId;
  type: NotificationType;
  postId?: ObjectId;
  shareId?: ObjectId;
  friendRequestId?: ObjectId;
  reportStatus?: ReportStatus;
  reportActionTaken?: boolean;
  moderatedContentType?: ReportTargetType;
  createdAt: Date;
  readAt?: Date;
}

export interface PushSubscriptionDocument {
  _id: ObjectId;
  userId: ObjectId;
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDocument {
  _id: ObjectId;
  senderId: ObjectId;
  recipientId: ObjectId;
  groupId?: ObjectId;
  clientId: string;
  text: string;
  /** Private Cloudinary asset ID; clients only receive an authenticated photo route. */
  photoAssetId?: string;
  editedAt?: Date;
  moderationHiddenAt?: Date;
  moderationHiddenBy?: ObjectId;
  moderationHiddenReason?: string;
  createdAt: Date;
  /** Explicitly false only for newly delivered messages awaiting the recipient. */
  isRead?: boolean;
  readAt?: Date;
}

export interface GroupConversationDocument {
  _id: ObjectId;
  name: string;
  createdBy: ObjectId;
  participantIds: ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  readAtByUser?: Record<string, Date>;
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
