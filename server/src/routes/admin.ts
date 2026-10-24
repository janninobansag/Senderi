import { pipeline } from "node:stream/promises";
import { ObjectId, type Db } from "mongodb";
import { Router, type Request } from "express";
import { z } from "zod";
import { isAdminId, requireAdmin } from "../auth/admin";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase } from "../db/client";
import { collectionNames, REPORT_RETENTION_MS, type AdminAuditDocument, type CommentDocument, type CommentReactionDocument, type GroupConversationDocument, type MessageDocument, type PostDocument, type ReportDocument, type ReportStatus, type ShareDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { cloudinaryPostPhotoStorage } from "../media/post-photo";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { disconnectUserSockets } from "../socket/server";
import type { PostPhotoStorage } from "../media/post-photo";
import { createNotification } from "../notifications/create-notification";

const actionSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict();
const visibilitySchema = z.object({ hidden: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict();
const deleteCommentSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const listSchema = z.object({ q: z.string().trim().max(80).optional(), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
const reportListSchema = listSchema.extend({ status: z.enum(["open", "resolved", "dismissed", "all"]).default("open") }).strict();
const reportStatusSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  contentAction: z.enum(["none", "hide", "restore"]).default("none"),
  reason: z.string().trim().min(3).max(500),
}).strict().refine((value) => value.status !== "dismissed" || value.contentAction === "none", {
  message: "Dismissed reports cannot change the reported content.",
}).refine((value) => value.contentAction !== "restore" || value.status === "resolved", {
  message: "Reported content can only be restored on a resolved report.",
});

interface AdminRealtimeServer {
  to(room: string): { emit(event: "message:deleted" | "message:updated", payload: unknown): unknown };
}

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

async function moderateReportedContent(
  request: Request,
  database: Db,
  report: ReportDocument,
  moderatorId: ObjectId,
  reason: string,
  contentAction: "hide" | "restore",
): Promise<void> {
  const update = contentAction === "hide"
    ? { $set: { hiddenAt: new Date(), hiddenBy: moderatorId, hiddenReason: reason } }
    : { $unset: { hiddenAt: "" as const, hiddenBy: "" as const, hiddenReason: "" as const } };
  let message: MessageDocument | null = null;
  if (report.targetType === "post") {
    const result = await database.collection<PostDocument>(collectionNames.posts)
      .updateOne({ _id: report.targetId, authorId: report.targetOwnerId }, update);
    if (!result.matchedCount) throw new HttpError(404, "not_found", "Reported post was not found.");
  } else if (report.targetType === "share") {
    const result = await database.collection<ShareDocument>(collectionNames.shares)
      .updateOne({ _id: report.targetId, authorId: report.targetOwnerId }, update);
    if (!result.matchedCount) throw new HttpError(404, "not_found", "Reported shared post was not found.");
  } else if (report.targetType === "comment") {
    const result = await database.collection<CommentDocument>(collectionNames.comments)
      .updateOne({ _id: report.targetId, authorId: report.targetOwnerId }, update);
    if (!result.matchedCount) throw new HttpError(404, "not_found", "Reported comment was not found.");
  } else {
    const messages = database.collection<MessageDocument>(collectionNames.messages);
    message = await messages.findOne({ _id: report.targetId, senderId: report.targetOwnerId });
    if (!message) throw new HttpError(404, "not_found", "Reported message was not found.");
    const result = await messages.updateOne({ _id: report.targetId, senderId: report.targetOwnerId }, contentAction === "hide"
      ? { $set: { moderationHiddenAt: new Date(), moderationHiddenBy: moderatorId, moderationHiddenReason: reason } }
      : { $unset: { moderationHiddenAt: "" as const, moderationHiddenBy: "" as const, moderationHiddenReason: "" as const } });
    if (!result.matchedCount) throw new HttpError(404, "not_found", "Reported message was not found.");
  }

  if (report.targetType === "message" && message) {
    const realtimeServer = request.app.get("realtimeServer") as AdminRealtimeServer | undefined;
    const messageId = report.targetId.toHexString();
    const group = message.groupId
      ? await database.collection<GroupConversationDocument>(collectionNames.groupConversations).findOne({ _id: message.groupId })
      : null;
    const participants = group?.participantIds ?? [message.senderId, message.recipientId];
    if (contentAction === "hide") {
      const event = {
        messageId,
        senderId: message.senderId.toHexString(),
        recipientId: message.recipientId.toHexString(),
        ...(message.groupId ? { groupId: message.groupId.toHexString() } : {}),
      };
      for (const participantId of participants) {
        realtimeServer?.to(`user:${participantId.toHexString()}`).emit("message:deleted", event);
      }
    } else {
      for (const viewerId of participants) {
        realtimeServer?.to(`user:${viewerId.toHexString()}`).emit("message:updated", {
          message: {
            id: messageId,
            senderId: message.senderId.toHexString(),
            recipientId: message.recipientId.toHexString(),
            ...(message.groupId ? { groupId: message.groupId.toHexString() } : {}),
            text: message.text,
            createdAt: message.createdAt.toISOString(),
            ...(message.photoAssetId ? { photoUrl: `/api/chats/messages/${messageId}/photo` } : {}),
            ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
            ...(viewerId.equals(message.senderId) ? { clientId: message.clientId } : {}),
          },
        });
      }
    }
  }
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

  router.get("/reports", async (request, response) => {
    const { q, offset, status } = input(reportListSchema, request.query);
    const database = databaseFor();
    const filter = {
      ...(status === "all" ? {} : { status }),
      ...(q ? { $or: [
        { targetExcerpt: { $regex: escapeRegex(q), $options: "i" } },
        { details: { $regex: escapeRegex(q), $options: "i" } },
        { reason: { $regex: escapeRegex(q), $options: "i" } },
      ] } : {}),
    };
    const reports = await database.collection<ReportDocument>(collectionNames.reports)
      .find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(21).toArray();
    const userIds = [...new Map(reports.flatMap((report) => [
      [report.reporterId.toHexString(), report.reporterId] as const,
      [report.targetOwnerId.toHexString(), report.targetOwnerId] as const,
    ])).values()];
    const users = await database.collection<UserDocument>(collectionNames.users).find({ _id: { $in: userIds } }).toArray();
    const names = new Map(users.map((user) => [user._id.toHexString(), user.displayName]));
    response.json({ items: reports.slice(0, 20).map((report) => ({
      id: report._id.toHexString(), targetType: report.targetType, targetId: report.targetId.toHexString(),
      targetOwnerId: report.targetOwnerId.toHexString(), targetOwner: names.get(report.targetOwnerId.toHexString()) ?? "Deleted user",
      reporterId: report.reporterId.toHexString(), reporter: names.get(report.reporterId.toHexString()) ?? "Deleted user",
      reason: report.reason, details: report.details ?? "", targetExcerpt: report.targetExcerpt,
      hasPhoto: report.hasPhoto, status: report.status, createdAt: report.createdAt.toISOString(),
      reviewReason: report.reviewReason ?? "", actionTaken: report.actionTaken === true,
      purgeAt: report.purgeAt?.toISOString() ?? null,
    })), nextOffset: reports.length > 20 ? offset + 20 : null });
  });

  router.get("/reports/:reportId/photo", async (request, response) => {
    const report = await databaseFor().collection<ReportDocument>(collectionNames.reports)
      .findOne({ _id: id(String(request.params.reportId)) });
    if (!report?.hasPhoto) throw new HttpError(404, "not_found", "Reported photo was not found.");
    const database = databaseFor();
    let assetId: string | undefined;
    if (report.targetType === "post") {
      assetId = (await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: report.targetId }))?.photoAssetId;
    } else if (report.targetType === "share") {
      const share = await database.collection<ShareDocument>(collectionNames.shares).findOne({ _id: report.targetId });
      assetId = share
        ? (await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: share.sourcePostId }))?.photoAssetId
        : undefined;
    } else if (report.targetType === "comment") {
      const comment = await database.collection<CommentDocument>(collectionNames.comments).findOne({ _id: report.targetId });
      assetId = comment
        ? (await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: comment.postId }))?.photoAssetId
        : undefined;
    } else {
      assetId = (await database.collection<MessageDocument>(collectionNames.messages).findOne({ _id: report.targetId }))?.photoAssetId;
    }
    if (!assetId) throw new HttpError(404, "not_found", "Reported photo was not found.");

    let photo;
    try { photo = await photoStorage.download(assetId); }
    catch { throw new HttpError(502, "media_unavailable", "Reported photo is temporarily unavailable."); }
    response.setHeader("Content-Type", photo.contentType);
    response.setHeader("Vary", "Cookie");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await pipeline(photo.stream, response);
  });

  router.patch("/reports/:reportId/status", requireClientOrigin(), async (request, response) => {
    const { status, contentAction, reason } = input(reportStatusSchema, request.body);
    const reportId = id(String(request.params.reportId));
    const database = databaseFor();
    const reviewedBy = (response.locals.authenticatedSession as AuthenticatedSessionContext).user._id;
    const reports = database.collection<ReportDocument>(collectionNames.reports);
    const restoring = contentAction === "restore";
    const report = await reports.findOne(restoring
      ? { _id: reportId, status: "resolved", actionTaken: true }
      : { _id: reportId, status: "open" });
    if (!report) throw new HttpError(404, "not_found", "An open report or hidden report was not found.");
    if (contentAction === "hide" || contentAction === "restore") {
      await moderateReportedContent(request, database, report, reviewedBy, reason, contentAction);
    }
    const reviewedAt = new Date();
    const result = await database.collection<ReportDocument>(collectionNames.reports).findOneAndUpdate(
      restoring
        ? { _id: reportId, status: "resolved", actionTaken: true }
        : { _id: reportId, status: "open" },
      { $set: {
        status: restoring ? "resolved" as ReportStatus : status as ReportStatus,
        reviewedAt, reviewedBy, reviewReason: reason,
        purgeAt: new Date(reviewedAt.getTime() + REPORT_RETENTION_MS),
        actionTaken: contentAction === "hide" ? true : restoring ? false : false,
      } },
      { returnDocument: "after" },
    );
    if (!result) throw new HttpError(409, "report_changed", "This report changed while it was being reviewed.");
    const auditAction = contentAction === "hide"
      ? "report_content_hidden"
      : restoring ? "report_content_restored" : `report_${status}`;
    await audit(database, response.locals.authenticatedSession, result.targetId, auditAction, reason);
    try {
      await createNotification(database, {
        recipientId: report.reporterId,
        actorId: reviewedBy,
        type: "report_update",
        reportStatus: result.status,
        reportActionTaken: result.actionTaken === true,
      });
    } catch (error) {
      console.error("Could not notify the reporter about a reviewed report.", error);
    }
    if (contentAction === "hide") {
      try {
        await createNotification(database, {
          recipientId: report.targetOwnerId,
          actorId: reviewedBy,
          type: "content_moderated",
          moderatedContentType: report.targetType,
        });
      } catch (error) {
        console.error("Could not notify the content owner about moderation.", error);
      }
    }
    response.json({ status: result.status, actionTaken: result.actionTaken === true });
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

  router.delete("/comments/:itemId", requireClientOrigin(), async (request, response) => {
    const { reason } = input(deleteCommentSchema, request.body);
    const targetId = id(String(request.params.itemId));
    const database = databaseFor();
    const comments = database.collection<CommentDocument>(collectionNames.comments);
    const comment = await comments.findOne({ _id: targetId });
    if (!comment) throw new HttpError(404, "not_found", "Comment was not found.");

    let relatedCommentIds = [targetId];
    if (!comment.parentCommentId) {
      const replies = await comments.find({ parentCommentId: targetId }).toArray();
      relatedCommentIds = [...relatedCommentIds, ...replies.map((reply) => reply._id)];
      await comments.deleteMany({ _id: { $in: relatedCommentIds } });
    } else {
      await comments.deleteOne({ _id: targetId });
      await comments.updateMany(
        { replyToCommentId: targetId },
        { $unset: { replyToCommentId: "" } },
      );
    }

    await database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteMany({
      commentId: { $in: relatedCommentIds },
    });
    await audit(database, response.locals.authenticatedSession, targetId, "comments_deleted_permanently", reason);
    response.status(204).end();
  });

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
