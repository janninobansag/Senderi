/** Opaque identifiers are serialized as strings in HTTP responses. */
export type UserId = string;

/** Values stored in post and share visibility fields. */
export type Visibility = "public" | "friends" | "onlyMe";

/** Safe profile fields returned for another signed-in user. */
export interface User {
  id: UserId;
  displayName: string;
  bio: string;
  info: {
    location?: string;
    website?: string;
  };
  avatarId?: string;
  avatarUrl?: string;
  coverId?: string;
  coverUrl?: string;
  createdAt: string;
}

/** Relationship of the signed-in viewer to the requested profile. */
export type ProfileFriendshipStatus = "self" | "friends" | "none";

export interface ProfileResponse {
  user: User;
  friendshipStatus: ProfileFriendshipStatus;
}

/** Additional private fields returned only for the authenticated user. */
export interface CurrentUser extends User {
  email: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface PaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Public profile results returned by paged user search. */
export type UserSearchResponse = Page<User>;

/** Lifecycle states for a request; only pending requests are created here. */
export type FriendRequestStatus = "pending" | "accepted" | "declined" | "cancelled";

/** Public representation of a friend request. */
export interface FriendRequest {
  id: string;
  senderId: UserId;
  recipientId: UserId;
  status: FriendRequestStatus;
  createdAt: string;
  respondedAt?: string;
}

/** Pending requests that involve the signed-in user. */
export interface FriendRequestsResponse {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface CreateFriendRequestResponse {
  request: FriendRequest;
}

export interface RespondToFriendRequestResponse {
  request: FriendRequest;
}

/** Activity delivered to the signed-in user. */
export type NotificationType =
  | "post_like"
  | "share_like"
  | "post_comment"
  | "post_share"
  | "friend_request"
  | "friend_accepted";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  actor: User;
  createdAt: string;
  isRead: boolean;
  postId?: string;
  shareId?: string;
  friendRequestId?: string;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  unreadCount: number;
}

/** Public profiles returned for the signed-in user's accepted friends. */
export interface FriendListItem extends User {
  /** Other friends shared with the signed-in viewer; does not include the viewer. */
  mutualFriendCount?: number;
}

export type FriendListResponse = Page<FriendListItem>;

/** Presence is visible only to accepted friends. */
export interface FriendPresenceItem {
  userId: UserId;
  isOnline: boolean;
  lastActiveAt?: string;
}

export interface FriendPresenceResponse {
  items: FriendPresenceItem[];
}

/** A visible post with its public author profile; never contains storage secrets. */
export interface PostLikeState {
  likeCount: number;
  isLikedByViewer: boolean;
}

export interface Post extends PostLikeState {
  id: string;
  author: User;
  /** Number of shares visible to the current viewer. */
  shareCount: number;
  text?: string;
  /** Same-origin API route; photo bytes remain protected by the post audience check. */
  photoUrl?: string;
  visibility: Visibility;
  createdAt: string;
  /** Present on feed/timeline items that wrap this post in a share card. */
  share?: Share;
}

export type PostListResponse = Page<Post>;

export interface PostResponse {
  post: Post;
}

/** Current Like count and signed-in viewer state for a visible post. */
export type LikeResponse = PostLikeState;

/** Text and audience fields accepted for a post; multipart requests may add one photo. */
export interface CreatePostRequest {
  text: string;
  visibility: Visibility;
}

export interface CreatePostResponse {
  post: Post;
}

/** Audience changes are accepted only from the post author. */
export interface UpdatePostRequest {
  visibility: Visibility;
}

/** The public share context attached to a source post in a feed. */
export interface Share extends PostLikeState {
  id: string;
  author: User;
  sourcePostId: string;
  /** Number of visible shares made from this specific share card. */
  shareCount: number;
  sourceShareId?: string;
  /** Optional text the author added when sharing the source post. */
  caption?: string;
  visibility: Visibility;
  createdAt: string;
}

export interface CreateShareRequest {
  visibility: Visibility;
  caption?: string;
  sourceShareId?: string;
}

export interface CreateShareResponse {
  share: Share;
}

export interface UpdateShareRequest {
  visibility: Visibility;
}

export interface UpdateShareResponse {
  share: Share;
}

export interface UpdateShareRequest {
  visibility: Visibility;
}

export interface UpdateShareResponse {
  share: Share;
}

/** Public comment data attached to a post; private account fields are excluded. */
export interface Comment {
  id: string;
  postId: string;
  author: User;
  text: string;
  createdAt: string;
}

export type CommentListResponse = Page<Comment>;

export interface CreateCommentRequest {
  text: string;
}

export interface CreateCommentResponse {
  comment: Comment;
}

/** A stored one-to-one message returned in authorized conversation history. */
export interface Message {
  id: string;
  senderId: UserId;
  recipientId: UserId;
  text: string;
  createdAt: string;
  /** Included in history only when the current viewer authored this message. */
  clientId?: string;
}

export type MessageHistoryResponse = Page<Message>;

export interface ChatUnreadConversation {
  friendId: UserId;
  unreadCount: number;
}

export interface ChatUnreadResponse {
  items: ChatUnreadConversation[];
}

export interface SocketTicketResponse {
  ticket: string;
  expiresAt: string;
}

export interface MessageSendRequest {
  friendId: UserId;
  clientId: string;
  text: string;
}

export interface MessageAckEvent {
  clientId: string;
  message: Message;
}

export interface MessageNewEvent {
  message: Message;
}

export interface MessageErrorEvent {
  clientId?: string;
  code: string;
  message: string;
}
