import { ObjectId, type Db } from "mongodb";
import { Router } from "express";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { getDatabase } from "../db/client";
import { collectionNames, REPORT_RETENTION_MS, type CommentDocument, type GroupConversationDocument, type MessageDocument, type PostDocument, type ReportDocument, type ShareDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { areFriends } from "../friends/are-friends";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { canViewPost } from "../post-access";
import { canViewShare } from "../share-access";

const reportSchema = z.object({
  targetType: z.enum(["post", "share", "comment", "message"]),
  targetId: z.string().regex(/^[a-f\d]{24}$/i),
  reason: z.enum(["spam", "harassment", "hate", "violence", "sexual_content", "scam", "other"]),
  details: z.string().trim().max(1_000).optional().default(""),
}).strict();

function parseId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new HttpError(404, "not_found", "Content was not found.");
  return new ObjectId(value);
}

function excerpt(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 1_000);
}

function duplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export interface ReportsRouterDependencies {
  getDatabase: () => Db;
  getAllowedOrigins: () => readonly string[];
  now: () => Date;
}

const defaults: ReportsRouterDependencies = {
  getDatabase,
  getAllowedOrigins: () => (process.env.CLIENT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  now: () => new Date(),
};

export function createReportsRouter(overrides: Partial<ReportsRouterDependencies> = {}): Router {
  const dependencies = { ...defaults, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase, now: dependencies.now });

  router.get("/", authenticated, async (_request, response) => {
    const reporterId = (response.locals.authenticatedSession as AuthenticatedSessionContext).user._id;
    const reports = await dependencies.getDatabase().collection<ReportDocument>(collectionNames.reports)
      .find({ reporterId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .toArray();
    response.setHeader("Cache-Control", "private, no-store");
    response.json({ items: reports.map((report) => ({
      id: report._id.toHexString(), targetType: report.targetType, reason: report.reason,
      details: report.details ?? "", targetExcerpt: report.targetExcerpt, hasPhoto: report.hasPhoto,
      status: report.status, actionTaken: report.actionTaken === true,
      createdAt: report.createdAt.toISOString(), ...(report.reviewedAt ? { reviewedAt: report.reviewedAt.toISOString() } : {}),
    })) });
  });

  router.post("/", requireClientOrigin(dependencies.getAllowedOrigins), authenticated, async (request, response) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Choose a valid reason for reporting this item.");
    const database = dependencies.getDatabase();
    const reporterId = (response.locals.authenticatedSession as AuthenticatedSessionContext).user._id;
    const targetId = parseId(parsed.data.targetId);
    let targetOwnerId: ObjectId;
    let targetExcerpt: string;
    let hasPhoto: boolean;

    if (parsed.data.targetType === "post") {
      const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: targetId });
      if (!post || !await canViewPost(database, reporterId, post)) throw new HttpError(404, "not_found", "Content was not found.");
      targetOwnerId = post.authorId;
      targetExcerpt = excerpt(post.text);
      hasPhoto = Boolean(post.photoAssetId);
    } else if (parsed.data.targetType === "share") {
      const share = await database.collection<ShareDocument>(collectionNames.shares).findOne({ _id: targetId });
      const sourcePost = share ? await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: share.sourcePostId }) : null;
      if (!share || !sourcePost || !await canViewShare(database, reporterId, share) || !await canViewPost(database, reporterId, sourcePost)) {
        throw new HttpError(404, "not_found", "Content was not found.");
      }
      targetOwnerId = share.authorId;
      targetExcerpt = excerpt(share.caption ?? sourcePost.text);
      hasPhoto = Boolean(sourcePost.photoAssetId);
    } else if (parsed.data.targetType === "comment") {
      const comment = await database.collection<CommentDocument>(collectionNames.comments).findOne({ _id: targetId });
      const post = comment ? await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: comment.postId }) : null;
      const share = comment?.shareId ? await database.collection<ShareDocument>(collectionNames.shares).findOne({ _id: comment.shareId }) : null;
      if (!comment || comment.hiddenAt || !post || !await canViewPost(database, reporterId, post) ||
        (comment.shareId && (!share || !await canViewShare(database, reporterId, share)))) {
        throw new HttpError(404, "not_found", "Content was not found.");
      }
      targetOwnerId = comment.authorId;
      targetExcerpt = excerpt(comment.text);
      hasPhoto = Boolean(post.photoAssetId);
    } else {
      const message = await database.collection<MessageDocument>(collectionNames.messages).findOne({ _id: targetId });
      const canReportGroupMessage = message?.groupId
        ? Boolean(await database.collection<GroupConversationDocument>(collectionNames.groupConversations)
          .findOne({ _id: message.groupId, participantIds: reporterId }))
        : Boolean(message && message.recipientId.equals(reporterId) && await areFriends(database, reporterId, message.senderId));
      if (!message || message.moderationHiddenAt || message.senderId.equals(reporterId) || !canReportGroupMessage) {
        throw new HttpError(404, "not_found", "Content was not found.");
      }
      targetOwnerId = message.senderId;
      targetExcerpt = excerpt(message.text);
      hasPhoto = Boolean(message.photoAssetId);
    }

    if (targetOwnerId.equals(reporterId)) throw new HttpError(400, "cannot_report_own_content", "You cannot report your own content.");
    const createdAt = dependencies.now();
    const report: ReportDocument = {
      _id: new ObjectId(), reporterId, targetType: parsed.data.targetType, targetId, targetOwnerId,
      reason: parsed.data.reason, ...(parsed.data.details ? { details: parsed.data.details } : {}),
      targetExcerpt, hasPhoto, createdAt, status: "open",
      purgeAt: new Date(createdAt.getTime() + REPORT_RETENTION_MS),
    };
    try {
      await database.collection<ReportDocument>(collectionNames.reports).insertOne(report);
    } catch (error) {
      if (duplicateKey(error)) throw new HttpError(409, "already_reported", "You have already reported this item.");
      throw error;
    }
    response.setHeader("Cache-Control", "private, no-store");
    response.status(201).json({ reportId: report._id.toHexString() });
  });
  return router;
}

export const reportsRouter = createReportsRouter();
