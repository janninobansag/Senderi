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
  avatarUrl?: string;
  coverId?: string;
  coverUrl?: string;
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
  avatarUrl?: string;
  coverId?: string;
  coverUrl?: string;
  createdAt: string;
}

function cloudinaryProfileImageUrl(
  cloudName: string | undefined,
  publicId: string | undefined,
  transformation: string,
): string | undefined {
  const safeCloudName = cloudName?.trim();
  if (!safeCloudName || !/^[a-z\d_-]+$/i.test(safeCloudName) || !publicId) return undefined;

  const pathSegments = publicId.split("/");
  if (pathSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }

  const encodedPublicId = pathSegments.map(encodeURIComponent).join("/");
  return `https://res.cloudinary.com/${safeCloudName}/image/upload/${transformation}/f_auto/q_auto/${encodedPublicId}`;
}

export function toPublicUserResponse(
  user: UserDocument,
  cloudName = process.env.CLOUDINARY_CLOUD_NAME,
): PublicUserResponse {
  const avatarUrl = cloudinaryProfileImageUrl(cloudName, user.avatarId, "c_fill,g_face,h_256,w_256");
  const coverUrl = cloudinaryProfileImageUrl(cloudName, user.coverId, "c_fill,g_auto,h_480,w_1600");

  return {
    id: user._id.toHexString(),
    displayName: user.displayName,
    bio: user.bio,
    info: user.info,
    ...(user.avatarId ? { avatarId: user.avatarId } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(user.coverId ? { coverId: user.coverId } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAuthUserResponse(user: UserDocument): AuthUserResponse {
  return {
    ...toPublicUserResponse(user),
    email: user.email,
  };
}
