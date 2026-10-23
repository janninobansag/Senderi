import { pipeline } from "node:stream/promises";
import { ObjectId, type Db } from "mongodb";
import { Router } from "express";
import { z } from "zod";
import { isAdminId, requireAdmin } from "../auth/admin";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase } from "../db/client";
import { collectionNames, type AdminAuditDocument, type CommentDocument, type PostDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { cloudinaryPostPhotoStorage } from "../media/post-photo";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { disconnectUserSockets } from "../socket/server";
import type { PostPhotoStorage } from "../media/post-photo";

const actionSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict();
const visibilitySchema = z.object({ hidden: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict();
const listSchema = z.object({ q: z.string().trim().max(80).optional(), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();

function id(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new HttpError(404, "not_found", "Item was not found.");
  return new ObjectId(value);
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "validation_error", "Invalid admin request.");
  return parsed.data;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createAdminRouter(dependencies: { getDatabase?: () => Db; photoStorage?: PostPhotoStorage } = {}) {
  const databaseFor = dependencies.getDatabase ?? getDatabase;
  const photoStorage = dependencies.photoStorage ?? cloudinaryPostPhotoStorage;
  const router = Router();
  router.use(requireSession({ getDatabase: databaseFor }), requireAdmin);
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "private, no-store"); next(); });

  router.get("/users", async (request, response) => {
    const { q, offset } = input(listSchema, request.query);
    const filter = q ? { $or: [
      { displayName: { $regex: escapeRegex(q), $options: "i" } },
      { email: { $regex: escapeRegex(q), $options: "i" } },
    ] } : {};
    const users = await databaseFor().collection<UserDocument>(collectionNames.users)
      .find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(21).toArray();
    response.json({ items: users.slice(0, 20).map((user) => ({
      ...toPublicUserResponse(user), email: user.email, isAdmin: isAdminId(user._id),
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
    })), nextOffset: users.length > 20 ? offset + 20 : null });
  });

  router.patch("/users/:userId/badge", requireClientOrigin(), async (request, response) => {
    const { enabled, reason } = input(actionSchema, request.body);
    const targetId = id(String(request.params.userId));
    const database = databaseFor();
    const updated = await database.collection<UserDocument>(collectionNames.users).findOneAndUpdate(
      { _id: targetId }, { $set: { supporterBadge: enabled, updatedAt: new Date() } }, { returnDocument: "after" },
    );
    if (!updated) throw new HttpError(404, "not_found", "User was not found.");
    await audit(database, response.locals.authenticatedSession, targetId, enabled ? "badge_granted" : "badge_removed", reason);
    response.json({ supporterBadge: updated.supporterBadge === true });
  });

  router.patch("/users/:userId/verified-badge", requireClientOrigin(), async (request, response) => {
    const { enabled, reason } = input(actionSchema, request.body);
    const targetId = id(String(request.params.userId));
    const database = databaseFor();
    const updated = await database.collection<UserDocument>(collectionNames.users).findOneAndUpdate(
      { _id: targetId }, { $set: { verifiedBadge: enabled, updatedAt: new Date() } }, { returnDocument: "after" },
    );
    if (!updated) throw new HttpError(404, "not_found", "User was not found.");
    await audit(database, response.locals.authenticatedSession, targetId, enabled ? "verified_badge_granted" : "verified_badge_removed", reason);
    response.json({ verifiedBadge: updated.verifiedBadge === true });
  });

  router.patch("/users/:userId/suspension", requireClientOrigin(), async (request, response) => {
    const { enabled, reason } = input(actionSchema, request.body);
    const targetId = id(String(request.params.userId));
    if (isAdminId(targetId)) throw new HttpError(400, "invalid_target", "An allowlisted admin cannot be suspended.");
    const database = databaseFor();
    const users = database.collection<UserDocument>(collectionNames.users);
    const update = enabled ? { $set: { suspendedAt: new Date() } } : { $unset: { suspendedAt: "" as const } };
    const updated = await users.findOneAndUpdate({ _id: targetId }, update, { returnDocument: "after" });
    if (!updated) throw new HttpError(404, "not_found", "User was not found.");
    if (enabled) {
      await Promise.all([
        database.collection(collectionNames.sessions).deleteMany({ userId: targetId }),
        database.collection(collectionNames.socketTickets).deleteMany({ userId: targetId }),
      ]);
      disconnectUserSockets(targetId);
    }
    await audit(database, response.locals.authenticatedSession, targetId, enabled ? "user_suspended" : "user_reactivated", reason);
    response.json({ suspendedAt: updated.suspendedAt?.toISOString() ?? null });
  });

  router.get("/posts", async (request, response) => {
    const { q, offset } = input(listSchema, request.query);
    const database = databaseFor();
    const posts = await database.collection<PostDocument>(collectionNames.posts)
      .find(q ? { text: { $regex: escapeRegex(q), $options: "i" } } : {})
      .sort({ createdAt: -1, _id: -1 }).skip(offset).limit(21).toArray();
    const authors = await loadAuthors(database, posts.map((post) => post.authorId));
    response.json({ items: posts.slice(0, 20).map((post) => ({
      id: post._id.toHexString(), author: authors.get(post.authorId.toHexString()) ?? "Unknown user",
      text: post.text ?? "", visibility: post.visibility, hasPhoto: !!post.photoAssetId,
      hiddenAt: post.hiddenAt?.toISOString() ?? null, createdAt: post.createdAt.toISOString(),
    })), nextOffset: posts.length > 20 ? offset + 20 : null });
  });

  router.get("/posts/:postId/photo", async (request, response) => {
    const post = await databaseFor().collection<PostDocument>(collectionNames.posts).findOne({ _id: id(String(request.params.postId)) });
    if (!post?.photoAssetId) throw new HttpError(404, "not_found", "Photo was not found.");
    let photo;
    try { photo = await photoStorage.download(post.photoAssetId); }
    catch { throw new HttpError(502, "media_unavailable", "Photo is temporarily unavailable."); }
    response.setHeader("Content-Type", photo.contentType);
    response.setHeader("Vary", "Cookie");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await pipeline(photo.stream, response);
  });

  router.get("/comments", async (request, response) => {
    const { q, offset } = input(listSchema, request.query);
    const database = databaseFor();
    const comments = await database.collection<CommentDocument>(collectionNames.comments)
      .find(q ? { text: { $regex: escapeRegex(q), $options: "i" } } : {})
      .sort({ createdAt: -1, _id: -1 }).skip(offset).limit(21).toArray();
    const authors = await loadAuthors(database, comments.map((comment) => comment.authorId));
    response.json({ items: comments.slice(0, 20).map((comment) => ({
      id: comment._id.toHexString(), postId: comment.postId.toHexString(),
      author: authors.get(comment.authorId.toHexString()) ?? "Unknown user", text: comment.text,
      hiddenAt: comment.hiddenAt?.toISOString() ?? null, createdAt: comment.createdAt.toISOString(),
    })), nextOffset: comments.length > 20 ? offset + 20 : null });
  });

  for (const kind of ["posts", "comments"] as const) {
    router.patch(`/${kind}/:itemId/visibility`, requireClientOrigin(), async (request, response) => {
      const { hidden, reason } = input(visibilitySchema, request.body);
      const targetId = id(String(request.params.itemId));
      const database = databaseFor();
      const actorId = (response.locals.authenticatedSession as AuthenticatedSessionContext).user._id;
      const update = hidden
        ? { $set: { hiddenAt: new Date(), hiddenBy: actorId, hiddenReason: reason } }
        : { $unset: { hiddenAt: "", hiddenBy: "", hiddenReason: "" } };
      const result = await database.collection(kind).updateOne({ _id: targetId }, update);
      if (!result.matchedCount) throw new HttpError(404, "not_found", "Content was not found.");
      await audit(database, response.locals.authenticatedSession, targetId, `${kind}_${hidden ? "hidden" : "restored"}`, reason);
      response.json({ hidden });
    });
  }

  router.get("/audit", async (request, response) => {
    const { offset } = input(listSchema, request.query);
    const events = await databaseFor().collection<AdminAuditDocument>(collectionNames.adminAudit)
      .find().sort({ createdAt: -1, _id: -1 }).skip(offset).limit(21).toArray();
    response.json({ items: events.slice(0, 20).map((event) => ({
      id: event._id.toHexString(), actorId: event.actorId.toHexString(), targetId: event.targetId.toHexString(),
      action: event.action, reason: event.reason, createdAt: event.createdAt.toISOString(),
    })), nextOffset: events.length > 20 ? offset + 20 : null });
  });
  return router;
}

async function loadAuthors(database: Db, ids: ObjectId[]): Promise<Map<string, string>> {
  const users = await database.collection<UserDocument>(collectionNames.users).find({ _id: { $in: ids } }).toArray();
  return new Map(users.map((user) => [user._id.toHexString(), user.displayName]));
}

async function audit(database: Db, context: AuthenticatedSessionContext, targetId: ObjectId, action: string, reason: string) {
  await database.collection<AdminAuditDocument>(collectionNames.adminAudit).insertOne({
    _id: new ObjectId(), actorId: context.user._id, targetId, action, reason, createdAt: new Date(),
  });
}
