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
