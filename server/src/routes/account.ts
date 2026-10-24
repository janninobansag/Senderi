import { ObjectId, type Db } from "mongodb";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { hashPassword as hashArgon2idPassword, verifyPassword as verifyArgon2idPassword } from "../auth/password";
import { requireSession, type AuthenticatedSessionContext, clearSessionCookie } from "../auth/session";
import { getDatabase as getConnectedDatabase } from "../db/client";
import {
  collectionNames,
  type CommentDocument,
  type CommentReactionDocument,
  type FriendRequestDocument,
  type FriendshipDocument,
  type GroupConversationDocument,
  type LikeDocument,
  type MessageDocument,
  type NotificationDocument,
  type PostDocument,
  type PushSubscriptionDocument,
  type ShareDocument,
  type ShareLikeDocument,
  type UserDocument,
} from "../db/documents";
import { HttpError } from "../errors/http-error";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { cloudinaryProfileImageStorage, type ProfileImageStorage } from "../media/cloudinary";
import { cloudinaryPostPhotoStorage, type PostPhotoStorage } from "../media/post-photo";
import { disconnectUserSockets } from "../socket/server";

const emailSchema = z.string().trim().max(254).toLowerCase().pipe(z.email());

export const accountIdentitySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(80).optional(),
  email: emailSchema.optional(),
}).strict().refine((input) => input.displayName !== undefined || input.email !== undefined, {
  message: "Enter a new display name or email address.",
});

export const accountPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
}).strict();

export const deactivateAccountSchema = z.object({ currentPassword: z.string().min(1).max(128) }).strict();
export const deleteAccountSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  confirmation: z.literal("DELETE"),
}).strict();

export interface AccountRouterDependencies {
  getDatabase: () => Db;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, passwordHash: string) => Promise<boolean>;
  profileImageStorage: ProfileImageStorage;
  postPhotoStorage: PostPhotoStorage;
  disconnectUserSockets: (userId: ObjectId) => void;
  now: () => Date;
  getAllowedOrigins: () => readonly string[];
}

const defaults: AccountRouterDependencies = {
  getDatabase: getConnectedDatabase,
  hashPassword: hashArgon2idPassword,
  verifyPassword: verifyArgon2idPassword,
  profileImageStorage: cloudinaryProfileImageStorage,
  postPhotoStorage: cloudinaryPostPhotoStorage,
  disconnectUserSockets,
  now: () => new Date(),
  getAllowedOrigins: () => (process.env.CLIENT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
};

function getSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

async function verifyCurrentPassword(
  response: Response,
  password: string,
  dependencies: AccountRouterDependencies,
): Promise<AuthenticatedSessionContext> {
  const session = getSession(response);
  if (!(await dependencies.verifyPassword(password, session.user.passwordHash))) {
    throw new HttpError(403, "invalid_password", "The current password is incorrect.");
  }
  return session;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

async function deleteAccountData(database: Db, user: UserDocument, dependencies: AccountRouterDependencies): Promise<void> {
  const userId = user._id;
  const posts = await database.collection<PostDocument>(collectionNames.posts)
    .find({ authorId: userId }, { projection: { _id: 1, photoAssetId: 1 } })
    .toArray();
  const postIds = posts.map((post) => post._id);
  const messages = await database.collection<MessageDocument>(collectionNames.messages)
    .find({ $or: [{ senderId: userId }, { recipientId: userId }] }, { projection: { photoAssetId: 1 } })
    .toArray();

  const shareCollection = database.collection<ShareDocument>(collectionNames.shares);
  const sharesById = new Map<string, ShareDocument>();
  let previousShareCount = -1;
  while (previousShareCount !== sharesById.size) {
    previousShareCount = sharesById.size;
    const shareIds = [...sharesById.values()].map((share) => share._id);
    const relatedShares = await shareCollection.find({
      $or: [
        { authorId: userId },
        { sourcePostId: { $in: postIds } },
        ...(shareIds.length ? [{ sourceShareId: { $in: shareIds } }] : []),
      ],
    }).toArray();
    for (const share of relatedShares) sharesById.set(share._id.toHexString(), share);
  }
  const shareIds = [...sharesById.values()].map((share) => share._id);

  const commentCollection = database.collection<CommentDocument>(collectionNames.comments);
  const commentsById = new Map<string, CommentDocument>();
  let previousCommentCount = -1;
  while (previousCommentCount !== commentsById.size) {
    previousCommentCount = commentsById.size;
    const commentIds = [...commentsById.values()].map((comment) => comment._id);
    const relatedComments = await commentCollection.find({
      $or: [
        { authorId: userId },
        { postId: { $in: postIds } },
        ...(shareIds.length ? [{ shareId: { $in: shareIds } }] : []),
        ...(commentIds.length ? [
          { parentCommentId: { $in: commentIds } },
          { replyToCommentId: { $in: commentIds } },
        ] : []),
      ],
    }).toArray();
    for (const comment of relatedComments) commentsById.set(comment._id.toHexString(), comment);
  }

  const commentIds = [...commentsById.values()].map((comment) => comment._id);
  const assetDeleteTasks: Promise<void>[] = [];
  for (const assetId of new Set([user.avatarId, user.coverId].filter((id): id is string => Boolean(id)))) {
    assetDeleteTasks.push(dependencies.profileImageStorage.destroy(assetId));
  }
  for (const assetId of new Set([
    ...posts.map((post) => post.photoAssetId),
    ...messages.map((message) => message.photoAssetId),
  ].filter((id): id is string => Boolean(id)))) {
    assetDeleteTasks.push(dependencies.postPhotoStorage.destroy(assetId));
  }

  // Delete hosted media first so a storage failure leaves the account and its records available for retry.
  await Promise.all(assetDeleteTasks);

  const mentionsRemoved = { $pull: { mentionedUserIds: userId } };
  await Promise.all([
    database.collection<PostDocument>(collectionNames.posts).updateMany({ mentionedUserIds: userId }, mentionsRemoved),
    database.collection<CommentDocument>(collectionNames.comments).updateMany({ mentionedUserIds: userId }, mentionsRemoved),
  ]);

  const deleteTasks: Promise<unknown>[] = [
    database.collection<PostDocument>(collectionNames.posts).deleteMany({ authorId: userId }),
    database.collection<ShareDocument>(collectionNames.shares).deleteMany({ _id: { $in: shareIds } }),
    database.collection<CommentDocument>(collectionNames.comments).deleteMany({ _id: { $in: commentIds } }),
    database.collection<LikeDocument>(collectionNames.likes).deleteMany({ $or: [{ userId }, { postId: { $in: postIds } }] }),
    database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteMany({
      $or: [{ userId }, { postId: { $in: postIds } }, { commentId: { $in: commentIds } }],
    }),
    database.collection<ShareLikeDocument>(collectionNames.shareLikes).deleteMany({ $or: [{ userId }, { shareId: { $in: shareIds } }] }),
    database.collection<MessageDocument>(collectionNames.messages).deleteMany({ $or: [{ senderId: userId }, { recipientId: userId }] }),
    database.collection<GroupConversationDocument>(collectionNames.groupConversations)
      .updateMany({ participantIds: userId }, { $pull: { participantIds: userId } }),
    database.collection<FriendshipDocument>(collectionNames.friendships).deleteMany({ $or: [{ userIdLow: userId }, { userIdHigh: userId }] }),
    database.collection<FriendRequestDocument>(collectionNames.friendRequests).deleteMany({ $or: [{ senderId: userId }, { recipientId: userId }] }),
    database.collection<NotificationDocument>(collectionNames.notifications).deleteMany({
      $or: [
        { actorId: userId },
        { recipientId: userId },
        { postId: { $in: postIds } },
        { shareId: { $in: shareIds } },
      ],
    }),
    database.collection(collectionNames.pushSubscriptions).deleteMany({ userId }),
    database.collection(collectionNames.sessions).deleteMany({ userId }),
    database.collection(collectionNames.passwordResets).deleteMany({ userId }),
    database.collection(collectionNames.socketTickets).deleteMany({ userId }),
    database.collection(collectionNames.adminAudit).deleteMany({ $or: [{ actorId: userId }, { targetId: userId }] }),
    database.collection(collectionNames.reports).deleteMany({ $or: [{ reporterId: userId }, { targetOwnerId: userId }] }),
  ];
  await Promise.all(deleteTasks);

  const deleted = await database.collection<UserDocument>(collectionNames.users).deleteOne({ _id: userId });
  if (deleted.deletedCount !== 1) throw new HttpError(404, "not_found", "The account could not be found.");
}

export function createAccountRouter(overrides: Partial<AccountRouterDependencies> = {}): Router {
  const dependencies = { ...defaults, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase, now: dependencies.now });

  router.patch("/identity", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const parsed = accountIdentitySchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Enter a valid display name or email address.");
    const session = await verifyCurrentPassword(response, parsed.data.currentPassword, dependencies);
    const database = dependencies.getDatabase();
    const update: Partial<UserDocument> = { updatedAt: dependencies.now() };
    if (parsed.data.displayName !== undefined) update.displayName = parsed.data.displayName;
    if (parsed.data.email !== undefined) {
      const existing = await database.collection<UserDocument>(collectionNames.users).findOne(
        { email: parsed.data.email, _id: { $ne: session.user._id } },
        { projection: { _id: 1 } },
      );
      if (existing) throw new HttpError(409, "email_already_exists", "An account with this email already exists.");
      update.email = parsed.data.email;
    }

    try {
      const user = await database.collection<UserDocument>(collectionNames.users).findOneAndUpdate(
        { _id: session.user._id },
        { $set: update },
        { returnDocument: "after" },
      );
      if (!user) throw new HttpError(404, "not_found", "The account could not be found.");
      response.setHeader("Cache-Control", "private, no-store");
      response.json({ user: { displayName: user.displayName, email: user.email } });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new HttpError(409, "email_already_exists", "An account with this email already exists.");
      throw error;
    }
  });

  router.post("/password", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const parsed = accountPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Use a new password with at least 12 characters.");
    const session = await verifyCurrentPassword(response, parsed.data.currentPassword, dependencies);
    const database = dependencies.getDatabase();
    const passwordHash = await dependencies.hashPassword(parsed.data.newPassword);
    await Promise.all([
      database.collection<UserDocument>(collectionNames.users).updateOne(
        { _id: session.user._id },
        { $set: { passwordHash, updatedAt: dependencies.now() } },
      ),
      database.collection(collectionNames.sessions).deleteMany({ userId: session.user._id, _id: { $ne: session.sessionId } }),
      database.collection(collectionNames.passwordResets).deleteMany({ userId: session.user._id }),
      database.collection(collectionNames.socketTickets).deleteMany({ userId: session.user._id }),
    ]);
    response.setHeader("Cache-Control", "private, no-store");
    response.status(204).end();
  });

  router.post("/deactivate", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const parsed = deactivateAccountSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Enter your current password to deactivate your account.");
    const session = await verifyCurrentPassword(response, parsed.data.currentPassword, dependencies);
    const database = dependencies.getDatabase();
    const now = dependencies.now();
    await database.collection<UserDocument>(collectionNames.users).updateOne(
      { _id: session.user._id },
      { $set: { deactivatedAt: now, updatedAt: now } },
    );
    await Promise.all([
      database.collection(collectionNames.sessions).deleteMany({ userId: session.user._id }),
      database.collection(collectionNames.socketTickets).deleteMany({ userId: session.user._id }),
      database.collection<PushSubscriptionDocument>(collectionNames.pushSubscriptions).deleteMany({ userId: session.user._id }),
    ]);
    dependencies.disconnectUserSockets(session.user._id);
    clearSessionCookie(response);
    response.setHeader("Cache-Control", "private, no-store");
    response.status(204).end();
  });

  router.delete("/me", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request: Request, response: Response) => {
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Enter your password and type DELETE to permanently remove your account.");
    const session = await verifyCurrentPassword(response, parsed.data.currentPassword, dependencies);
    await deleteAccountData(dependencies.getDatabase(), session.user, dependencies);
    dependencies.disconnectUserSockets(session.user._id);
    clearSessionCookie(response);
    response.setHeader("Cache-Control", "private, no-store");
    response.status(204).end();
  });

  return router;
}
