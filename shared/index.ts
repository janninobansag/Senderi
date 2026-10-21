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
export type FriendRequestStatus = "pending" | "accepted" | "declined";

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

/** Public profiles returned for the signed-in user's accepted friends. */
export type FriendListResponse = Page<User>;

/** A visible post with its public author profile; never contains storage secrets. */
export interface Post {
  id: string;
  author: User;
  text?: string;
  /** Same-origin API route; photo bytes remain protected by the post audience check. */
  photoUrl?: string;
  visibility: Visibility;
  createdAt: string;
}

export type PostListResponse = Page<Post>;

export interface PostResponse {
  post: Post;
}

/** Text-only post fields accepted from an authenticated author. */
export interface CreatePostRequest {
  text: string;
  visibility: Visibility;
}

export interface CreatePostResponse {
  post: Post;
}
