import type { UserDocument } from "../db/documents";

export interface PublicUserResponse {
  id: string;
  displayName: string;
  bio: string;
  info: {
    location?: string;
    website?: string;
  };
  avatarId?: string;
  coverId?: string;
  createdAt: string;
}

export interface AuthUserResponse {
  id: string;
  email: string;
  displayName: string;
  bio: string;
  info: {
    location?: string;
    website?: string;
  };
  avatarId?: string;
  coverId?: string;
  createdAt: string;
}

export function toPublicUserResponse(user: UserDocument): PublicUserResponse {
  return {
    id: user._id.toHexString(),
    displayName: user.displayName,
    bio: user.bio,
    info: user.info,
    ...(user.avatarId ? { avatarId: user.avatarId } : {}),
    ...(user.coverId ? { coverId: user.coverId } : {}),
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAuthUserResponse(user: UserDocument): AuthUserResponse {
  return {
    ...toPublicUserResponse(user),
    email: user.email,
  };
}
