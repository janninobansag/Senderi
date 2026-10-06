import { ObjectId, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toAuthUserResponse, toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type FriendshipDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { validateBody } from "../middleware/validate-body";
import { cloudinaryProfileImageStorage, type ProfileImageStorage } from "../media/cloudinary";
import { validateProfileImage } from "../media/profile-image";

const displayNameSchema = z.string().trim().min(1).max(80);
const bioSchema = z.string().trim().max(500);
const locationSchema = z.string().trim().max(120);
const websiteSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (value === "") return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Website must be a valid HTTPS URL.");

export const profilePatchSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    bio: bioSchema.optional(),
    info: z
      .object({
        location: locationSchema.optional(),
        website: websiteSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one profile field is required.");

type ProfilePatchInput = z.infer<typeof profilePatchSchema>;

export interface UsersRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  getCloudinaryCloudName: () => string | undefined;
  now: () => Date;
  imageStorage: ProfileImageStorage;
}

const defaultDependencies: UsersRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getAllowedOrigins: () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  getCloudinaryCloudName: () => process.env.CLOUDINARY_CLOUD_NAME,
  now: () => new Date(),
  imageStorage: cloudinaryProfileImageStorage,
};

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new HttpError(404, "not_found", "Requested profile was not found.");
  }
  return new ObjectId(value);
}

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

export function createUsersRouter(
  overrides: Partial<UsersRouterDependencies> = {},
): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  router.get("/:userId", authenticated, async (request, response) => {
    const userId = toObjectId(String(request.params.userId));
    const database = dependencies.getDatabase();
    const user = await database
      .collection<UserDocument>(collectionNames.users)
      .findOne({ _id: userId });

    if (!user) {
      throw new HttpError(404, "not_found", "Requested profile was not found.");
    }

    const currentUserId = getAuthenticatedSession(response).user._id;
    let friendshipStatus: "self" | "friends" | "none" = "none";
    if (currentUserId.equals(user._id)) {
      friendshipStatus = "self";
    } else {
      const [userIdLow, userIdHigh] = [currentUserId, user._id].sort((left, right) =>
        left.toHexString().localeCompare(right.toHexString()),
      );
      const friendship = await database
        .collection<FriendshipDocument>(collectionNames.friendships)
        .findOne({ userIdLow, userIdHigh });
      if (friendship) friendshipStatus = "friends";
    }

    response.setHeader("Cache-Control", "private, no-store");
    response.json({
      user: toPublicUserResponse(user, dependencies.getCloudinaryCloudName()),
      friendshipStatus,
    });
  });

  router.patch(
    "/me",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    validateBody(profilePatchSchema),
    async (request, response) => {
      const input = request.body as ProfilePatchInput;
      const session = getAuthenticatedSession(response);
      const update: Partial<UserDocument> = { updatedAt: dependencies.now() };

      if (input.displayName !== undefined) update.displayName = input.displayName;
      if (input.bio !== undefined) update.bio = input.bio;
      if (input.info !== undefined) {
        update.info = {
          ...session.user.info,
          ...input.info,
        };
        if (input.info.location === "") delete update.info.location;
        if (input.info.website === "") delete update.info.website;
      }

      const database = dependencies.getDatabase();
      const updated = await database
        .collection<UserDocument>(collectionNames.users)
        .findOneAndUpdate(
          { _id: session.user._id },
          { $set: update },
          { returnDocument: "after" },
        );

      if (!updated) {
        throw new HttpError(404, "not_found", "Requested profile was not found.");
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.json({ user: toAuthUserResponse(updated) });
    },
  );

  for (const imageKind of ["avatar", "cover"] as const) {
    router.put(
      `/me/${imageKind}`,
      requireClientOrigin(dependencies.getAllowedOrigins),
      authenticated,
      upload.single("file"),
      async (request, response) => {
        const file = request.file;
        if (!file) {
          throw new HttpError(400, "file_required", "Attach one image file in the file field.");
        }

        await validateProfileImage(file);
        const session = getAuthenticatedSession(response);
        const database = dependencies.getDatabase();
        const users = database.collection<UserDocument>(collectionNames.users);
        const currentUser = await users.findOne({ _id: session.user._id });
        if (!currentUser) {
          throw new HttpError(404, "not_found", "Requested profile was not found.");
        }

        const oldAssetId = imageKind === "avatar" ? currentUser.avatarId : currentUser.coverId;
        const publicId = `${session.user._id.toHexString()}-${imageKind}-${randomUUID()}`;
        const uploaded = await dependencies.imageStorage.upload(file.buffer, publicId);

        try {
          const update = imageKind === "avatar"
            ? { avatarId: uploaded.assetId, updatedAt: dependencies.now() }
            : { coverId: uploaded.assetId, updatedAt: dependencies.now() };
          const updated = await users.findOneAndUpdate(
            { _id: session.user._id },
            { $set: update },
            { returnDocument: "after" },
          );

          if (!updated) {
            throw new HttpError(404, "not_found", "Requested profile was not found.");
          }

          if (oldAssetId) {
            await dependencies.imageStorage.destroy(oldAssetId).catch((error) => {
              console.error("Failed to delete replaced profile image", error);
            });
          }

          response.setHeader("Cache-Control", "private, no-store");
          response.json({ user: toAuthUserResponse(updated) });
        } catch (error) {
          await dependencies.imageStorage.destroy(uploaded.assetId).catch((cleanupError) => {
            console.error("Failed to clean up abandoned profile image", cleanupError);
          });
          throw error;
        }
      },
    );
  }

  return router;
}

export const usersRouter = createUsersRouter();
