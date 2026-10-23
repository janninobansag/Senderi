import { ObjectId, type Db, type Filter } from "mongodb";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type CommentDocument, type CommentReactionDocument, type FriendshipDocument, type LikeDocument, type PostDocument, type PostVisibility, type ShareDocument, type ShareLikeDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { cloudinaryPostPhotoStorage, optimizePostPhoto, type PostPhotoStorage } from "../media/post-photo";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { canViewPost, decodePostCursor, encodePostCursor, listVisiblePostDocuments } from "../post-access";
import { listVisibleFeedRecords, type FeedRecord } from "../feed-access";
import { canViewShare } from "../share-access";
import { createNotification } from "../notifications/create-notification";

const postPageQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const postSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(80),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const commentPageQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const commentCollectionRoutes = ["/:postId/comments", "/:postId/shares/:shareId/comments"];
const commentItemRoutes = [
  "/:postId/comments/:commentId",
  "/:postId/shares/:shareId/comments/:commentId",
];

const createPostSchema = z.object({
  text: z.string().trim().max(5_000).optional().default(""),
  visibility: z.enum(["public", "friends", "onlyMe"]),
}).strict();

const updatePostSchema = z.object({
  text: z.string().trim().min(1).max(5_000).optional(),
  visibility: z.enum(["public", "friends", "onlyMe"]).optional(),
}).strict().refine((value) => value.text !== undefined || value.visibility !== undefined);

const updateShareSchema = z.object({
  visibility: z.enum(["public", "friends", "onlyMe"]),
}).strict();

const createCommentSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  parentCommentId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  replyToCommentId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  mentionedUserIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(10).optional().default([]),
}).strict().refine((value) => !value.replyToCommentId || Boolean(value.parentCommentId), {
  message: "Reply targets require a parent comment.",
});

const updateCommentSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
}).strict();

function commentContainsMention(text: string, displayName: string): boolean {
  const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escapedName}(?=$|[\\s.,!?;:])`, "u").test(text);
}

const createShareSchema = z.object({
  visibility: z.enum(["public", "friends", "onlyMe"]),
  caption: z.string().trim().max(2_000).optional(),
  sourceShareId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
}).strict();

interface PostResponseItem {
  id: string;
  author: ReturnType<typeof toPublicUserResponse>;
  text?: string;
  photoUrl?: string;
  visibility: PostVisibility;
  createdAt: string;
  likeCount: number;
  isLikedByViewer: boolean;
  commentCount: number;
  shareCount: number;
  share?: ShareResponseItem;
}

interface ShareResponseItem {
  id: string;
  author: ReturnType<typeof toPublicUserResponse>;
  sourcePostId: string;
  sourceShareId?: string;
  caption?: string;
  visibility: PostVisibility;
  createdAt: string;
  likeCount: number;
  isLikedByViewer: boolean;
  commentCount: number;
  shareCount: number;
}

interface LikeSummary {
  likeCount: number;
  isLikedByViewer: boolean;
}

interface AggregatedLikeSummary {
  _id: ObjectId;
  likeCount: number;
  viewerLikeCount: number;
}

interface AggregatedShareCount {
  _id: ObjectId;
  shareCount: number;
}

interface AggregatedCommentCount {
  _id: ObjectId;
  commentCount: number;
}

interface PostListResponse {
  items: PostResponseItem[];
  nextCursor: string | null;
}

interface PostResponse {
  post: PostResponseItem;
}

interface CreateShareResponse {
  share: ShareResponseItem;
}

interface UpdateShareResponse {
  share: ShareResponseItem;
}

interface CommentResponseItem {
  id: string;
  postId: string;
  parentCommentId?: string;
  replyToCommentId?: string;
  author: ReturnType<typeof toPublicUserResponse>;
  text: string;
  createdAt: string;
  reactionCount: number;
  isReactedByViewer: boolean;
  replyCount: number;
  replies: CommentResponseItem[];
}

interface CommentCursor {
  createdAt: Date;
  commentId: ObjectId;
}

export interface PostsRouterDependencies {
  getDatabase: () => Db;
  getCloudinaryCloudName: () => string | undefined;
  getAllowedOrigins: () => readonly string[];
  photoStorage: PostPhotoStorage;
}

const defaultDependencies: PostsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getCloudinaryCloudName: () => process.env.CLOUDINARY_CLOUD_NAME,
  getAllowedOrigins: () => (process.env.CLIENT_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  photoStorage: cloudinaryPostPhotoStorage,
};

function getAuthenticatedSession(response: Response): AuthenticatedSessionContext {
  return response.locals.authenticatedSession as AuthenticatedSessionContext;
}

function getCommentScopeFilter(postId: ObjectId, shareId?: ObjectId): Filter<CommentDocument> {
  return {
    postId,
    ...(shareId ? { shareId } : { shareId: { $exists: false } }),
  };
}

async function getCommentThreadContext(
  database: Db,
  viewerId: ObjectId,
  postId: ObjectId,
  shareId?: ObjectId,
): Promise<{ post: PostDocument; share?: ShareDocument }> {
  const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
  if (!post) throw new HttpError(404, "not_found", "Post was not found.");

  if (!shareId) {
    if (!(await canViewPost(database, viewerId, post))) {
      throw new HttpError(404, "not_found", "Post was not found.");
    }
    return { post };
  }

  const share = await database.collection<ShareDocument>(collectionNames.shares).findOne({
    _id: shareId,
    sourcePostId: postId,
  });
  if (
    !share || post.visibility !== "public" || post.hiddenAt ||
    !(await canViewShare(database, viewerId, share))
  ) {
    throw new HttpError(404, "not_found", "Shared post was not found.");
  }
  return { post, share };
}

function parsePageQuery(query: Record<string, unknown>) {
  const parsed = postPageQuerySchema.safeParse(query);
  if (!parsed.success) throw new HttpError(400, "validation_error", "Post page query is invalid.");
  return {
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ? decodePostCursor(parsed.data.cursor) : undefined,
  };
}

function escapeSearchTerm(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeCommentCursor(token: string): CommentCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null ||
      !("createdAt" in value) || typeof value.createdAt !== "string" ||
      !("id" in value) || typeof value.id !== "string" ||
      !/^[a-f\d]{24}$/i.test(value.id)
    ) throw new Error("Invalid cursor payload.");

    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
      throw new Error("Invalid cursor date.");
    }
    return { createdAt, commentId: new ObjectId(value.id) };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Comment cursor is invalid.");
  }
}

function encodeCommentCursor(comment: Pick<CommentDocument, "_id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({
    createdAt: comment.createdAt.toISOString(),
    id: comment._id.toHexString(),
  })).toString("base64url");
}

function parseCommentPageQuery(query: Record<string, unknown>) {
  const parsed = commentPageQuerySchema.safeParse(query);
  if (!parsed.success) throw new HttpError(400, "validation_error", "Comment page query is invalid.");
  return {
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ? decodeCommentCursor(parsed.data.cursor) : undefined,
  };
}

function toObjectIdOrNotFound(value: string, resource: "post" | "profile" | "share" | "comment"): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    const message = resource === "profile" ? "Profile was not found." : resource === "share" ? "Shared post was not found." : resource === "comment" ? "Comment was not found." : "Post was not found.";
    throw new HttpError(404, "not_found", message);
  }
  return new ObjectId(value);
}

function toPostResponse(
  post: PostDocument,
  author: UserDocument,
  likeSummary: LikeSummary,
  cloudName?: string,
  shareCount = 0,
  commentCount = 0,
): PostResponseItem {
  return {
    id: post._id.toHexString(),
    author: toPublicUserResponse(author, cloudName),
    ...(post.text !== undefined ? { text: post.text } : {}),
    ...(post.photoAssetId ? { photoUrl: `/api/posts/${post._id.toHexString()}/photo` } : {}),
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString(),
    ...likeSummary,
    commentCount,
    shareCount,
  };
}

async function getVisibleCommentCounts(database: Db, posts: PostDocument[]): Promise<Map<string, number>> {
  if (posts.length === 0) return new Map();
  const summaries = await database.collection<CommentDocument>(collectionNames.comments)
    .aggregate<AggregatedCommentCount>([
      { $match: { postId: { $in: posts.map((post) => post._id) }, shareId: { $exists: false }, hiddenAt: { $exists: false } } },
      { $group: { _id: "$postId", commentCount: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(summaries.map((summary) => [summary._id.toHexString(), summary.commentCount]));
}

async function getVisibleShareCommentCounts(database: Db, shares: ShareDocument[]): Promise<Map<string, number>> {
  if (shares.length === 0) return new Map();
  const summaries = await database.collection<CommentDocument>(collectionNames.comments)
    .aggregate<AggregatedCommentCount>([
      { $match: { shareId: { $in: shares.map((share) => share._id) }, hiddenAt: { $exists: false } } },
      { $group: { _id: "$shareId", commentCount: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(summaries.map((summary) => [summary._id.toHexString(), summary.commentCount]));
}

async function getVisiblePostShareCounts(
  database: Db,
  posts: PostDocument[],
  viewerId: ObjectId,
): Promise<Map<string, number>> {
  const publicPosts = posts.filter((post) => post.visibility === "public");
  if (publicPosts.length === 0) return new Map();

  const postIds = publicPosts.map((post) => post._id);
  const friendships = await database.collection<FriendshipDocument>(collectionNames.friendships)
    .find({ $or: [{ userIdLow: viewerId }, { userIdHigh: viewerId }] })
    .toArray();
  const friendIds = friendships.map((friendship) =>
    friendship.userIdLow.equals(viewerId) ? friendship.userIdHigh : friendship.userIdLow,
  );
  const visibleShareConditions: Filter<ShareDocument>[] = [
    { visibility: "public" },
    ...(friendIds.length ? [{ visibility: "friends" as const, authorId: { $in: friendIds } }] : []),
    { authorId: viewerId },
  ];
  const summaries = await database.collection<ShareDocument>(collectionNames.shares)
    .aggregate<AggregatedShareCount>([
      {
        $match: {
          sourcePostId: { $in: postIds },
          $or: visibleShareConditions,
        },
      },
      { $group: { _id: "$sourcePostId", shareCount: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(summaries.map((summary) => [summary._id.toHexString(), summary.shareCount]));
}

async function getVisibleShareShareCounts(
  database: Db,
  shares: ShareDocument[],
  viewerId: ObjectId,
): Promise<Map<string, number>> {
  const publicShares = shares.filter((share) => share.visibility === "public");
  if (publicShares.length === 0) return new Map();

  const shareIds = publicShares.map((share) => share._id);
  const friendships = await database.collection<FriendshipDocument>(collectionNames.friendships)
    .find({ $or: [{ userIdLow: viewerId }, { userIdHigh: viewerId }] })
    .toArray();
  const friendIds = friendships.map((friendship) =>
    friendship.userIdLow.equals(viewerId) ? friendship.userIdHigh : friendship.userIdLow,
  );
  const visibleShareConditions: Filter<ShareDocument>[] = [
    { visibility: "public" },
    ...(friendIds.length ? [{ visibility: "friends" as const, authorId: { $in: friendIds } }] : []),
    { authorId: viewerId },
  ];
  const summaries = await database.collection<ShareDocument>(collectionNames.shares)
    .aggregate<AggregatedShareCount>([
      {
        $match: {
          sourceShareId: { $in: shareIds },
          $or: visibleShareConditions,
        },
      },
      { $group: { _id: "$sourceShareId", shareCount: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(summaries.map((summary) => [summary._id.toHexString(), summary.shareCount]));
}

function toCommentResponse(
  comment: CommentDocument,
  author: UserDocument,
  cloudName?: string,
  reactionCount = 0,
  isReactedByViewer = false,
  replyCount = 0,
): CommentResponseItem {
  return {
    id: comment._id.toHexString(),
    postId: comment.postId.toHexString(),
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId.toHexString() } : {}),
    ...(comment.replyToCommentId ? { replyToCommentId: comment.replyToCommentId.toHexString() } : {}),
    author: toPublicUserResponse(author, cloudName),
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    reactionCount,
    isReactedByViewer,
    replyCount,
    replies: [],
  };
}

async function getCommentReactionSummary(database: Db, commentId: ObjectId, viewerId: ObjectId) {
  const reactions = database.collection<CommentReactionDocument>(collectionNames.commentReactions);
  const [reactionCount, viewerReaction] = await Promise.all([
    reactions.countDocuments({ commentId }),
    reactions.findOne({ commentId, userId: viewerId }),
  ]);
  return { reactionCount, isReactedByViewer: Boolean(viewerReaction) };
}

async function toCommentResponses(
  database: Db,
  comments: CommentDocument[],
  viewerId: ObjectId,
  cloudName?: string,
): Promise<CommentResponseItem[]> {
  if (comments.length === 0) return [];
  const authorIds = [...new Map(comments.map((comment) => [
    comment.authorId.toHexString(),
    comment.authorId,
  ])).values()];
  const authors = await database
    .collection<UserDocument>(collectionNames.users)
    .find({ _id: { $in: authorIds } }, {
      projection: {
        _id: 1,
        displayName: 1,
        bio: 1,
        info: 1,
        avatarId: 1,
        coverId: 1,
        createdAt: 1,
        supporterBadge: 1,
        verifiedBadge: 1,
      },
    })
    .toArray();
  const reactions = await database.collection<CommentReactionDocument>(collectionNames.commentReactions)
    .find({ commentId: { $in: comments.map((comment) => comment._id) } })
    .toArray();
  const authorsById = new Map(authors.map((author) => [author._id.toHexString(), author]));
  const reactionsByCommentId = new Map<string, CommentReactionDocument[]>();
  for (const reaction of reactions) {
    const key = reaction.commentId.toHexString();
    const current = reactionsByCommentId.get(key) ?? [];
    current.push(reaction);
    reactionsByCommentId.set(key, current);
  }
  return comments.flatMap((comment) => {
    const author = authorsById.get(comment.authorId.toHexString());
    if (!author) return [];
    const commentReactions = reactionsByCommentId.get(comment._id.toHexString()) ?? [];
    return [toCommentResponse(
      comment,
      author,
      cloudName,
      commentReactions.length,
      commentReactions.some((reaction) => reaction.userId.equals(viewerId)),
    )];
  });
}

async function toPostResponses(
  database: Db,
  posts: PostDocument[],
  viewerId: ObjectId,
  cloudName?: string,
): Promise<PostResponseItem[]> {
  if (posts.length === 0) return [];

  const authorIds = [...new Map(posts.map((post) => [
    post.authorId.toHexString(),
    post.authorId,
  ])).values()];
  const postIds = posts.map((post) => post._id);
  const [authors, likeSummaries, shareCounts, commentCounts] = await Promise.all([
    database
      .collection<UserDocument>(collectionNames.users)
      .find({ _id: { $in: authorIds } }, {
        projection: {
          _id: 1,
          displayName: 1,
          bio: 1,
          info: 1,
          avatarId: 1,
          coverId: 1,
          createdAt: 1,
          supporterBadge: 1,
          verifiedBadge: 1,
        },
      })
      .toArray(),
    database.collection<LikeDocument>(collectionNames.likes).aggregate<AggregatedLikeSummary>([
      { $match: { postId: { $in: postIds } } },
      {
        $group: {
          _id: "$postId",
          likeCount: { $sum: 1 },
          viewerLikeCount: { $sum: { $cond: [{ $eq: ["$userId", viewerId] }, 1, 0] } },
        },
      },
    ]).toArray(),
    getVisiblePostShareCounts(database, posts, viewerId),
    getVisibleCommentCounts(database, posts),
  ]);
  const authorsById = new Map(authors.map((author) => [author._id.toHexString(), author]));
  const likesByPostId = new Map(likeSummaries.map((summary) => [summary._id.toHexString(), {
    likeCount: summary.likeCount,
    isLikedByViewer: summary.viewerLikeCount > 0,
  }]));

  return posts.flatMap((post) => {
    const author = authorsById.get(post.authorId.toHexString());
    return author ? [toPostResponse(
      post,
      author,
      likesByPostId.get(post._id.toHexString()) ?? { likeCount: 0, isLikedByViewer: false },
      cloudName,
      shareCounts.get(post._id.toHexString()) ?? 0,
      commentCounts.get(post._id.toHexString()) ?? 0,
    )] : [];
  });
}

function toShareResponse(
  share: ShareDocument,
  author: UserDocument,
  cloudName?: string,
  likeSummary: LikeSummary = { likeCount: 0, isLikedByViewer: false },
  shareCount = 0,
  commentCount = 0,
): ShareResponseItem {
  return {
    id: share._id.toHexString(),
    author: toPublicUserResponse(author, cloudName),
    sourcePostId: share.sourcePostId.toHexString(),
    ...(share.sourceShareId ? { sourceShareId: share.sourceShareId.toHexString() } : {}),
    ...(share.caption ? { caption: share.caption } : {}),
    visibility: share.visibility,
    createdAt: share.createdAt.toISOString(),
    ...likeSummary,
    commentCount,
    shareCount,
  };
}

async function toFeedResponses(
  database: Db,
  records: FeedRecord[],
  viewerId: ObjectId,
  cloudName?: string,
): Promise<PostResponseItem[]> {
  if (records.length === 0) return [];
  const posts = records.map((record) => record.kind === "post" ? record.post : record.sourcePost);
  const shares = records.flatMap((record) => record.kind === "share" ? [record.share] : []);
  const shareIds = shares.map((share) => share._id);
  const [postResponses, shareAuthors, shareLikeSummaries, shareShareCounts, shareCommentCounts] = await Promise.all([
    toPostResponses(database, posts, viewerId, cloudName),
    shares.length > 0
      ? database
        .collection<UserDocument>(collectionNames.users)
        .find({ _id: { $in: [...new Map(shares.map((share) => [
          share.authorId.toHexString(),
          share.authorId,
        ])).values()] } }, {
          projection: {
            _id: 1,
            displayName: 1,
            bio: 1,
            info: 1,
            avatarId: 1,
            coverId: 1,
            createdAt: 1,
            supporterBadge: 1,
            verifiedBadge: 1,
          },
        })
        .toArray()
      : Promise.resolve([] as UserDocument[]),
    shares.length > 0
      ? database.collection<ShareLikeDocument>(collectionNames.shareLikes).aggregate<AggregatedLikeSummary>([
        { $match: { shareId: { $in: shareIds } } },
        {
          $group: {
            _id: "$shareId",
            likeCount: { $sum: 1 },
            viewerLikeCount: { $sum: { $cond: [{ $eq: ["$userId", viewerId] }, 1, 0] } },
          },
        },
      ]).toArray()
      : Promise.resolve([] as AggregatedLikeSummary[]),
    getVisibleShareShareCounts(database, shares, viewerId),
    getVisibleShareCommentCounts(database, shares),
  ]);
  const postResponsesById = new Map(postResponses.map((post) => [post.id, post]));
  const shareAuthorsById = new Map(shareAuthors.map((author) => [author._id.toHexString(), author]));
  const shareLikesById = new Map(shareLikeSummaries.map((summary) => [summary._id.toHexString(), {
    likeCount: summary.likeCount,
    isLikedByViewer: summary.viewerLikeCount > 0,
  }]));

  return records.flatMap((record) => {
    const sourcePost = record.kind === "post" ? record.post : record.sourcePost;
    const postResponse = postResponsesById.get(sourcePost._id.toHexString());
    if (!postResponse) return [];
    if (record.kind === "post") return [postResponse];
    const shareAuthor = shareAuthorsById.get(record.share.authorId.toHexString());
    return shareAuthor
      ? [{
        ...postResponse,
        share: toShareResponse(
          record.share,
          shareAuthor,
          cloudName,
          shareLikesById.get(record.share._id.toHexString()) ?? { likeCount: 0, isLikedByViewer: false },
          shareShareCounts.get(record.share._id.toHexString()) ?? 0,
          shareCommentCounts.get(record.share._id.toHexString()) ?? 0,
        ),
      }]
      : [];
  });
}

async function getPostLikeSummary(database: Db, postId: ObjectId, viewerId: ObjectId): Promise<LikeSummary> {
  const likes = database.collection<LikeDocument>(collectionNames.likes);
  const [likeCount, viewerLike] = await Promise.all([
    likes.countDocuments({ postId }),
    likes.findOne({ postId, userId: viewerId }, { projection: { _id: 1 } }),
  ]);
  return { likeCount, isLikedByViewer: viewerLike !== null };
}

async function getShareLikeSummary(database: Db, shareId: ObjectId, viewerId: ObjectId): Promise<LikeSummary> {
  const likes = database.collection<ShareLikeDocument>(collectionNames.shareLikes);
  const [likeCount, viewerLike] = await Promise.all([
    likes.countDocuments({ shareId }),
    likes.findOne({ shareId, userId: viewerId }, { projection: { _id: 1 } }),
  ]);
  return { likeCount, isLikedByViewer: viewerLike !== null };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

function toPostListResponse(posts: PostResponseItem[], nextCursor: string | null): PostListResponse {
  return { items: posts, nextCursor };
}

export function createPostsRouter(overrides: Partial<PostsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });
  const uploadPhoto = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  }).single("file");
  const uploadPost = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 },
  }).single("file");

  const requirePostOwner = async (request: Parameters<typeof authenticated>[0], response: Response, next: Parameters<typeof authenticated>[2]) => {
    const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
    const post = await dependencies.getDatabase()
      .collection<PostDocument>(collectionNames.posts)
      .findOne({ _id: postId });
    const viewerId = getAuthenticatedSession(response).user._id;

    if (!post || post.hiddenAt || !post.authorId.equals(viewerId)) {
      throw new HttpError(404, "not_found", "Post was not found.");
    }

    response.locals.postPhotoPost = post;
    next();
  };

  router.put(
    "/:postId/photo",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    requirePostOwner,
    uploadPhoto,
    async (request, response) => {
      const post = response.locals.postPhotoPost as PostDocument;
      const file = request.file;
      if (!file) throw new HttpError(400, "missing_file", "Choose one photo to upload.");
      const optimizedPhoto = await optimizePostPhoto(file);

      const assetName = `${post._id.toHexString()}-${randomUUID()}`;
      const uploaded = await dependencies.photoStorage.upload(optimizedPhoto, assetName);
      const database = dependencies.getDatabase();
      const previousAssetId = post.photoAssetId;
      let updated: PostDocument | null;

      try {
        updated = await database.collection<PostDocument>(collectionNames.posts).findOneAndUpdate(
          {
            _id: post._id,
            authorId: getAuthenticatedSession(response).user._id,
            ...(previousAssetId ? { photoAssetId: previousAssetId } : { photoAssetId: { $exists: false } }),
          },
          { $set: { photoAssetId: uploaded.assetId, updatedAt: new Date() } },
          { returnDocument: "after" },
        );

        if (!updated) {
          throw new HttpError(409, "post_photo_conflict", "The post changed while its photo was uploading. Try again.");
        }
      } catch (error) {
        await dependencies.photoStorage.destroy(uploaded.assetId).catch(() => {
          console.error("Failed to clean up abandoned post photo.");
        });
        throw error;
      }

      if (previousAssetId) {
        await dependencies.photoStorage.destroy(previousAssetId).catch(() => {
          console.error("Failed to delete replaced post photo.");
        });
      }

      const session = getAuthenticatedSession(response);
      const [likeSummary, shareCounts, commentCounts] = await Promise.all([
        getPostLikeSummary(database, updated._id, session.user._id),
        getVisiblePostShareCounts(database, [updated], session.user._id),
        getVisibleCommentCounts(database, [updated]),
      ]);
      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        post: toPostResponse(
          updated,
          session.user,
          likeSummary,
          dependencies.getCloudinaryCloudName(),
          shareCounts.get(updated._id.toHexString()) ?? 0,
          commentCounts.get(updated._id.toHexString()) ?? 0,
        ),
      } satisfies PostResponse);
    },
  );

  router.get("/:postId/photo", authenticated, async (request, response) => {
    const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
    const database = dependencies.getDatabase();
    const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
    const viewerId = getAuthenticatedSession(response).user._id;

    if (!post?.photoAssetId || !(await canViewPost(database, viewerId, post))) {
      throw new HttpError(404, "not_found", "Post photo was not found.");
    }

    let photo;
    try {
      photo = await dependencies.photoStorage.download(post.photoAssetId);
    } catch {
      throw new HttpError(502, "media_unavailable", "Post photo is temporarily unavailable.");
    }

    response.status(200);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Content-Type", photo.contentType);
    if (photo.contentLength !== undefined) response.setHeader("Content-Length", String(photo.contentLength));
    await pipeline(photo.stream, response);
  });

  router.patch(
    "/:postId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const parsed = updatePostSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Post changes are invalid.");
      }

      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const updated = await database
        .collection<PostDocument>(collectionNames.posts)
        .findOneAndUpdate(
          { _id: postId, authorId: session.user._id, hiddenAt: { $exists: false } },
          { $set: { ...parsed.data, updatedAt: new Date() } },
          { returnDocument: "after" },
        );

      if (!updated) throw new HttpError(404, "not_found", "Post was not found.");

      const [likeSummary, shareCounts, commentCounts] = await Promise.all([
        getPostLikeSummary(database, updated._id, session.user._id),
        getVisiblePostShareCounts(database, [updated], session.user._id),
        getVisibleCommentCounts(database, [updated]),
      ]);
      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        post: toPostResponse(
          updated,
          session.user,
          likeSummary,
          dependencies.getCloudinaryCloudName(),
          shareCounts.get(updated._id.toHexString()) ?? 0,
          commentCounts.get(updated._id.toHexString()) ?? 0,
        ),
      } satisfies PostResponse);
    },
  );

  router.delete(
    "/:postId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    requirePostOwner,
    async (_request, response) => {
      const post = response.locals.postPhotoPost as PostDocument;
      const database = dependencies.getDatabase();

      if (post.photoAssetId) {
        try {
          await dependencies.photoStorage.destroy(post.photoAssetId);
        } catch {
          console.error("Failed to delete post photo.");
          throw new HttpError(502, "post_photo_delete_failed", "The post photo could not be deleted, so the post was kept. Try again.");
        }
      }

      const viewerId = getAuthenticatedSession(response).user._id;
      const deleted = await database.collection<PostDocument>(collectionNames.posts).deleteOne({
        _id: post._id,
        authorId: viewerId,
      });
      if (deleted.deletedCount !== 1) throw new HttpError(404, "not_found", "Post was not found.");

      const sourceShares = await database.collection<ShareDocument>(collectionNames.shares)
        .find({ sourcePostId: post._id }).toArray();

      await Promise.all([
        database.collection<LikeDocument>(collectionNames.likes).deleteMany({ postId: post._id }),
        database.collection<CommentDocument>(collectionNames.comments).deleteMany({ postId: post._id }),
        database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteMany({ postId: post._id }),
        database.collection<ShareLikeDocument>(collectionNames.shareLikes).deleteMany({
          shareId: { $in: sourceShares.map((share) => share._id) },
        }),
        database.collection<ShareDocument>(collectionNames.shares).deleteMany({ sourcePostId: post._id }),
      ]);

      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  router.put(
    "/:postId/like",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
      if (!post || !(await canViewPost(database, session.user._id, post))) {
        throw new HttpError(404, "not_found", "Post was not found.");
      }

      try {
        const result = await database.collection<LikeDocument>(collectionNames.likes).updateOne(
          { userId: session.user._id, postId },
          {
            $setOnInsert: {
              _id: new ObjectId(),
              userId: session.user._id,
              postId,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount === 1 && !post.authorId.equals(session.user._id)) {
          await createNotification(database, {
            recipientId: post.authorId,
            actorId: session.user._id,
            type: "post_like",
            postId,
          });
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }

      const likeSummary = await getPostLikeSummary(database, postId, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json(likeSummary);
    },
  );

  router.delete(
    "/:postId/like",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
      if (!post || !(await canViewPost(database, session.user._id, post))) {
        throw new HttpError(404, "not_found", "Post was not found.");
      }

      await database.collection<LikeDocument>(collectionNames.likes).deleteOne({
        userId: session.user._id,
        postId,
      });
      const likeSummary = await getPostLikeSummary(database, postId, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json(likeSummary);
    },
  );

  router.put(
    "/:postId/shares/:shareId/like",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const shareId = toObjectIdOrNotFound(String(request.params.shareId), "share");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const [share, sourcePost] = await Promise.all([
        database.collection<ShareDocument>(collectionNames.shares).findOne({ _id: shareId, sourcePostId: postId }),
        database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId }),
      ]);
      if (!share || !sourcePost || sourcePost.visibility !== "public" || sourcePost.hiddenAt || !(await canViewShare(database, session.user._id, share))) {
        throw new HttpError(404, "not_found", "Shared post was not found.");
      }

      try {
        const result = await database.collection<ShareLikeDocument>(collectionNames.shareLikes).updateOne(
          { userId: session.user._id, shareId },
          {
            $setOnInsert: {
              _id: new ObjectId(),
              userId: session.user._id,
              shareId,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount === 1 && !share.authorId.equals(session.user._id)) {
          await createNotification(database, {
            recipientId: share.authorId,
            actorId: session.user._id,
            type: "share_like",
            postId,
            shareId,
          });
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }

      const likeSummary = await getShareLikeSummary(database, shareId, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json(likeSummary);
    },
  );

  router.delete(
    "/:postId/shares/:shareId/like",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const shareId = toObjectIdOrNotFound(String(request.params.shareId), "share");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const [share, sourcePost] = await Promise.all([
        database.collection<ShareDocument>(collectionNames.shares).findOne({ _id: shareId, sourcePostId: postId }),
        database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId }),
      ]);
      if (!share || !sourcePost || sourcePost.visibility !== "public" || sourcePost.hiddenAt || !(await canViewShare(database, session.user._id, share))) {
        throw new HttpError(404, "not_found", "Shared post was not found.");
      }

      await database.collection<ShareLikeDocument>(collectionNames.shareLikes).deleteOne({
        userId: session.user._id,
        shareId,
      });
      const likeSummary = await getShareLikeSummary(database, shareId, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json(likeSummary);
    },
  );

  router.get(commentCollectionRoutes, authenticated, async (request, response) => {
    const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const shareId = request.params.shareId
      ? toObjectIdOrNotFound(String(request.params.shareId), "share")
      : undefined;
    await getCommentThreadContext(database, viewerId, postId, shareId);
    const scopeFilter = getCommentScopeFilter(postId, shareId);

    const page = parseCommentPageQuery(request.query as Record<string, unknown>);
    const cursorFilter: Filter<CommentDocument> | undefined = page.cursor
      ? {
        $or: [
          { createdAt: { $lt: page.cursor.createdAt } },
          { createdAt: page.cursor.createdAt, _id: { $lt: page.cursor.commentId } },
        ],
      }
      : undefined;
    const rootFilter: Filter<CommentDocument> = {
      ...scopeFilter,
      parentCommentId: { $exists: false },
      hiddenAt: { $exists: false },
    };
    const filter: Filter<CommentDocument> = cursorFilter
      ? { $and: [rootFilter, cursorFilter] }
      : rootFilter;
    const comments = await database
      .collection<CommentDocument>(collectionNames.comments)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(page.limit + 1)
      .toArray();
    const hasMore = comments.length > page.limit;
    const pageComments = hasMore ? comments.slice(0, page.limit) : comments;
    const replies = pageComments.length > 0
      ? await database.collection<CommentDocument>(collectionNames.comments)
        .find({
          ...scopeFilter,
          parentCommentId: { $in: pageComments.map((comment) => comment._id) },
          hiddenAt: { $exists: false },
        })
        .toArray()
      : [];
    replies.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left._id.toHexString().localeCompare(right._id.toHexString()));
    const flatItems = await toCommentResponses(database, [...pageComments, ...replies], viewerId, dependencies.getCloudinaryCloudName());
    const itemsById = new Map(flatItems.map((comment) => [comment.id, comment]));
    const repliesByParentId = new Map<string, CommentResponseItem[]>();
    const replyCountByTargetId = new Map<string, number>();
    for (const reply of flatItems) {
      if (!reply.parentCommentId) continue;
      const parentReplies = repliesByParentId.get(reply.parentCommentId) ?? [];
      parentReplies.push(reply);
      repliesByParentId.set(reply.parentCommentId, parentReplies);
      if (reply.replyToCommentId) {
        replyCountByTargetId.set(reply.replyToCommentId, (replyCountByTargetId.get(reply.replyToCommentId) ?? 0) + 1);
      }
    }
    const items = pageComments.flatMap((comment) => {
      const item = itemsById.get(comment._id.toHexString());
      const commentReplies = (repliesByParentId.get(comment._id.toHexString()) ?? []).map((reply) => ({
        ...reply,
        replyCount: replyCountByTargetId.get(reply.id) ?? 0,
      }));
      return item ? [{ ...item, replyCount: commentReplies.length, replies: commentReplies }] : [];
    });
    const nextCursor = hasMore && pageComments.length > 0
      ? encodeCommentCursor(pageComments[pageComments.length - 1]!)
      : null;

    response.setHeader("Cache-Control", "private, no-store");
    response.json({ items, nextCursor });
  });

  router.post(
    commentCollectionRoutes,
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const database = dependencies.getDatabase();
      const session = getAuthenticatedSession(response);
      const shareId = request.params.shareId
        ? toObjectIdOrNotFound(String(request.params.shareId), "share")
        : undefined;
      const { post, share } = await getCommentThreadContext(database, session.user._id, postId, shareId);
      const scopeFilter = getCommentScopeFilter(postId, shareId);

      const parsed = createCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Comment text or reply target is invalid.");
      }

      const parentCommentId = parsed.data.parentCommentId ? new ObjectId(parsed.data.parentCommentId) : undefined;
      const parentComment = parentCommentId
        ? await database.collection<CommentDocument>(collectionNames.comments).findOne({
          ...scopeFilter,
          _id: parentCommentId,
          parentCommentId: { $exists: false },
          hiddenAt: { $exists: false },
        })
        : null;
      if (parentCommentId && !parentComment) throw new HttpError(404, "not_found", "Comment was not found.");
      const replyToCommentId = parsed.data.replyToCommentId ? new ObjectId(parsed.data.replyToCommentId) : undefined;
      const replyTarget = replyToCommentId && parentCommentId
        ? await database.collection<CommentDocument>(collectionNames.comments).findOne({
          ...scopeFilter,
          _id: replyToCommentId,
          parentCommentId,
          hiddenAt: { $exists: false },
        })
        : null;
      if (replyToCommentId && !replyTarget) throw new HttpError(404, "not_found", "Reply target was not found.");

      const mentionedIds = [...new Set(parsed.data.mentionedUserIds)].map((id) => new ObjectId(id));
      const mentionedUsers = mentionedIds.length > 0
        ? await database.collection<UserDocument>(collectionNames.users).find({ _id: { $in: mentionedIds } }).toArray()
        : [];
      if (mentionedUsers.length !== mentionedIds.length) {
        throw new HttpError(400, "validation_error", "One or more mentioned accounts could not be found.");
      }
      for (const mentionedUser of mentionedUsers) {
        if (!commentContainsMention(parsed.data.text, mentionedUser.displayName)) {
          throw new HttpError(400, "validation_error", "Mentioned accounts must appear in the comment.");
        }
        if (!(await canViewPost(database, mentionedUser._id, post))) {
          throw new HttpError(400, "validation_error", "Mentioned accounts must be able to view this post.");
        }
      }

      const comment: CommentDocument = {
        _id: new ObjectId(),
        postId,
        ...(shareId ? { shareId } : {}),
        ...(parentCommentId ? { parentCommentId } : {}),
        ...(replyToCommentId ? { replyToCommentId } : {}),
        ...(mentionedIds.length ? { mentionedUserIds: mentionedIds } : {}),
        authorId: session.user._id,
        text: parsed.data.text,
        createdAt: new Date(),
      };
      await database.collection<CommentDocument>(collectionNames.comments).insertOne(comment);
      const commentRecipientId = replyTarget?.authorId ?? parentComment?.authorId ?? share?.authorId ?? post.authorId;
      await createNotification(database, {
        recipientId: commentRecipientId,
        actorId: session.user._id,
        type: "post_comment",
        postId,
      });
      for (const mentionedUser of mentionedUsers) {
        if (mentionedUser._id.equals(commentRecipientId)) continue;
        await createNotification(database, {
          recipientId: mentionedUser._id,
          actorId: session.user._id,
          type: "post_mention",
          postId,
        });
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({
        comment: toCommentResponse(comment, session.user, dependencies.getCloudinaryCloudName()),
      });
    },
  );

  router.post(
    commentItemRoutes.map((path) => `${path}/reaction`),
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const commentId = toObjectIdOrNotFound(String(request.params.commentId), "comment");
      const viewerId = getAuthenticatedSession(response).user._id;
      const database = dependencies.getDatabase();
      const shareId = request.params.shareId
        ? toObjectIdOrNotFound(String(request.params.shareId), "share")
        : undefined;
      await getCommentThreadContext(database, viewerId, postId, shareId);
      const scopeFilter = getCommentScopeFilter(postId, shareId);

      const comment = await database.collection<CommentDocument>(collectionNames.comments).findOne({
        ...scopeFilter,
        _id: commentId,
        hiddenAt: { $exists: false },
      });
      if (!comment) throw new HttpError(404, "not_found", "Comment was not found.");
      if (comment.parentCommentId) {
        const parent = await database.collection<CommentDocument>(collectionNames.comments).findOne({
          ...scopeFilter,
          _id: comment.parentCommentId,
          parentCommentId: { $exists: false },
          hiddenAt: { $exists: false },
        });
        if (!parent) throw new HttpError(404, "not_found", "Comment was not found.");
      }

      await database.collection<CommentReactionDocument>(collectionNames.commentReactions).updateOne(
        { commentId, userId: viewerId },
        { $setOnInsert: { _id: new ObjectId(), postId, commentId, userId: viewerId, createdAt: new Date() } },
        { upsert: true },
      );
      response.setHeader("Cache-Control", "private, no-store");
      response.json(await getCommentReactionSummary(database, commentId, viewerId));
    },
  );

  router.delete(
    commentItemRoutes.map((path) => `${path}/reaction`),
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const commentId = toObjectIdOrNotFound(String(request.params.commentId), "comment");
      const viewerId = getAuthenticatedSession(response).user._id;
      const database = dependencies.getDatabase();
      const shareId = request.params.shareId
        ? toObjectIdOrNotFound(String(request.params.shareId), "share")
        : undefined;
      await getCommentThreadContext(database, viewerId, postId, shareId);
      const scopeFilter = getCommentScopeFilter(postId, shareId);

      const comment = await database.collection<CommentDocument>(collectionNames.comments).findOne({
        ...scopeFilter,
        _id: commentId,
        hiddenAt: { $exists: false },
      });
      if (!comment) throw new HttpError(404, "not_found", "Comment was not found.");
      if (comment.parentCommentId) {
        const parent = await database.collection<CommentDocument>(collectionNames.comments).findOne({
          ...scopeFilter,
          _id: comment.parentCommentId,
          parentCommentId: { $exists: false },
          hiddenAt: { $exists: false },
        });
        if (!parent) throw new HttpError(404, "not_found", "Comment was not found.");
      }

      await database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteOne({ commentId, userId: viewerId });
      response.setHeader("Cache-Control", "private, no-store");
      response.json(await getCommentReactionSummary(database, commentId, viewerId));
    },
  );

  router.patch(
    commentItemRoutes,
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const commentId = toObjectIdOrNotFound(String(request.params.commentId), "comment");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const shareId = request.params.shareId
        ? toObjectIdOrNotFound(String(request.params.shareId), "share")
        : undefined;
      await getCommentThreadContext(database, session.user._id, postId, shareId);
      const scopeFilter = getCommentScopeFilter(postId, shareId);

      const parsed = updateCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Comment text must contain 1 to 2000 characters.");
      }

      const filter: Filter<CommentDocument> = {
        ...scopeFilter,
        _id: commentId,
        authorId: session.user._id,
        hiddenAt: { $exists: false },
      };
      const comments = database.collection<CommentDocument>(collectionNames.comments);
      const comment = await comments.findOne(filter);
      if (!comment) throw new HttpError(404, "not_found", "Comment was not found.");
      const updated = await comments.updateOne(filter, { $set: { text: parsed.data.text } });
      if (updated.matchedCount !== 1) throw new HttpError(404, "not_found", "Comment was not found.");

      const [reactionSummary, replyCount] = await Promise.all([
        getCommentReactionSummary(database, commentId, session.user._id),
        comment.parentCommentId
          ? comments.countDocuments({ ...scopeFilter, replyToCommentId: commentId, hiddenAt: { $exists: false } })
          : comments.countDocuments({ ...scopeFilter, parentCommentId: commentId, hiddenAt: { $exists: false } }),
      ]);
      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        comment: toCommentResponse(
          { ...comment, text: parsed.data.text },
          session.user,
          dependencies.getCloudinaryCloudName(),
          reactionSummary.reactionCount,
          reactionSummary.isReactedByViewer,
          replyCount,
        ),
      });
    },
  );

  router.delete(
    commentItemRoutes,
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const commentId = toObjectIdOrNotFound(String(request.params.commentId), "comment");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const shareId = request.params.shareId
        ? toObjectIdOrNotFound(String(request.params.shareId), "share")
        : undefined;
      await getCommentThreadContext(database, session.user._id, postId, shareId);
      const scopeFilter = getCommentScopeFilter(postId, shareId);

      const comments = database.collection<CommentDocument>(collectionNames.comments);
      const existing = await comments.findOne({
        ...scopeFilter,
        _id: commentId,
        authorId: session.user._id,
        hiddenAt: { $exists: false },
      });
      if (!existing) throw new HttpError(404, "not_found", "Comment was not found.");
      let relatedCommentIds = [commentId];
      if (!existing.parentCommentId) {
        const replies = await comments.find({ ...scopeFilter, parentCommentId: commentId }).toArray();
        relatedCommentIds = [...relatedCommentIds, ...replies.map((reply) => reply._id)];
        const deleted = await comments.deleteMany({
          ...scopeFilter,
          $or: [
            { _id: commentId, authorId: session.user._id, hiddenAt: { $exists: false } },
            { parentCommentId: commentId },
          ],
        });
        if (deleted.deletedCount === 0) throw new HttpError(404, "not_found", "Comment was not found.");
      } else {
        const deleted = await comments.deleteOne({
          ...scopeFilter,
          _id: commentId,
          authorId: session.user._id,
          hiddenAt: { $exists: false },
        });
        if (deleted.deletedCount !== 1) throw new HttpError(404, "not_found", "Comment was not found.");
        await comments.updateMany(
          { ...scopeFilter, replyToCommentId: commentId },
          { $unset: { replyToCommentId: "" } },
        );
      }
      await database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteMany({
        commentId: { $in: relatedCommentIds },
      });

      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  router.post(
    "/:postId/shares",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const sourcePost = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
      if (!sourcePost || sourcePost.visibility !== "public" || sourcePost.hiddenAt) {
        throw new HttpError(404, "not_found", "Post was not found.");
      }

      const parsed = createShareSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Share audience is invalid.");
      }

      const sourceShareId = parsed.data.sourceShareId ? new ObjectId(parsed.data.sourceShareId) : undefined;
      if (sourceShareId) {
        const sourceShare = await database.collection<ShareDocument>(collectionNames.shares).findOne({
          _id: sourceShareId,
          sourcePostId: sourcePost._id,
          visibility: "public",
        });
        if (!sourceShare || !(await canViewShare(database, session.user._id, sourceShare))) {
          throw new HttpError(404, "not_found", "Shared post was not found.");
        }
      }

      const share: ShareDocument = {
        _id: new ObjectId(),
        authorId: session.user._id,
        sourcePostId: sourcePost._id,
        ...(sourceShareId ? { sourceShareId } : {}),
        ...(parsed.data.caption ? { caption: parsed.data.caption } : {}),
        visibility: parsed.data.visibility,
        createdAt: new Date(),
      };
      await database.collection<ShareDocument>(collectionNames.shares).insertOne(share);
      await createNotification(database, {
        recipientId: sourcePost.authorId,
        actorId: session.user._id,
        type: "post_share",
        postId,
      });

      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({
        share: toShareResponse(share, session.user, dependencies.getCloudinaryCloudName()),
      } satisfies CreateShareResponse);
    },
  );

  router.patch(
    "/:postId/shares/:shareId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const shareId = toObjectIdOrNotFound(String(request.params.shareId), "share");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const parsed = updateShareSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Share audience is invalid.");
      }

      const sourcePost = await database.collection<PostDocument>(collectionNames.posts).findOne({
        _id: postId,
        visibility: "public",
        hiddenAt: { $exists: false },
      });
      if (!sourcePost) throw new HttpError(404, "not_found", "Shared post was not found.");

      const updatedShare = await database.collection<ShareDocument>(collectionNames.shares).findOneAndUpdate(
        { _id: shareId, sourcePostId: postId, authorId: session.user._id },
        { $set: { visibility: parsed.data.visibility } },
        { returnDocument: "after" },
      );
      if (!updatedShare) throw new HttpError(404, "not_found", "Shared post was not found.");
      const [likeSummary, shareCounts, commentCounts] = await Promise.all([
        getShareLikeSummary(database, shareId, session.user._id),
        getVisibleShareShareCounts(database, [updatedShare], session.user._id),
        getVisibleShareCommentCounts(database, [updatedShare]),
      ]);

      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        share: toShareResponse(
          updatedShare,
          session.user,
          dependencies.getCloudinaryCloudName(),
          likeSummary,
          shareCounts.get(shareId.toHexString()) ?? 0,
          commentCounts.get(shareId.toHexString()) ?? 0,
        ),
      } satisfies UpdateShareResponse);
    },
  );

  router.delete(
    "/:postId/shares/:shareId",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    async (request, response) => {
      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const shareId = toObjectIdOrNotFound(String(request.params.shareId), "share");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const deleted = await database.collection<ShareDocument>(collectionNames.shares).deleteOne({
        _id: shareId,
        sourcePostId: postId,
        authorId: session.user._id,
      });
      if (deleted.deletedCount !== 1) throw new HttpError(404, "not_found", "Shared post was not found.");
      const shareComments = await database.collection<CommentDocument>(collectionNames.comments)
        .find({ postId, shareId })
        .toArray();
      const shareCommentIds = shareComments.map((comment) => comment._id);
      await Promise.all([
        database.collection<ShareLikeDocument>(collectionNames.shareLikes).deleteMany({ shareId }),
        database.collection<CommentDocument>(collectionNames.comments).deleteMany({ postId, shareId }),
        database.collection<CommentReactionDocument>(collectionNames.commentReactions).deleteMany({
          postId,
          commentId: { $in: shareCommentIds },
        }),
      ]);

      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  router.post(
    "/",
    requireClientOrigin(dependencies.getAllowedOrigins),
    authenticated,
    uploadPost,
    async (request, response) => {
      const parsed = createPostSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpError(400, "validation_error", "Post text or audience is invalid.");
      }
      if (!request.file && !parsed.data.text) {
        throw new HttpError(400, "validation_error", "A post must include text or a photo.");
      }

      const optimizedPhoto = request.file ? await optimizePostPhoto(request.file) : undefined;

      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const now = new Date();
      const post: PostDocument = {
        _id: new ObjectId(),
        authorId: session.user._id,
        text: parsed.data.text,
        visibility: parsed.data.visibility,
        createdAt: now,
        updatedAt: now,
      };
      let uploadedAssetId: string | undefined;

      if (optimizedPhoto) {
        const assetName = `${post._id.toHexString()}-${randomUUID()}`;
        const uploaded = await dependencies.photoStorage.upload(optimizedPhoto, assetName);
        uploadedAssetId = uploaded.assetId;
        post.photoAssetId = uploaded.assetId;
      }

      try {
        await database.collection<PostDocument>(collectionNames.posts).insertOne(post);
      } catch (error) {
        if (uploadedAssetId) {
          await dependencies.photoStorage.destroy(uploadedAssetId).catch(() => {
            console.error("Failed to clean up abandoned post photo.");
          });
        }
        throw error;
      }

      response.setHeader("Cache-Control", "private, no-store");
      response.status(201).json({
        post: toPostResponse(post, session.user, { likeCount: 0, isLikedByViewer: false }, dependencies.getCloudinaryCloudName()),
      } satisfies PostResponse);
    },
  );

  router.get("/search", authenticated, async (request, response) => {
    const parsed = postSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new HttpError(400, "validation_error", "Post search query is invalid.");

    const { query: searchTerm, cursor: cursorToken, limit } = parsed.data;
    const cursor = cursorToken ? decodePostCursor(cursorToken) : undefined;
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const friendships = await database.collection<FriendshipDocument>(collectionNames.friendships)
      .find({ $or: [{ userIdLow: viewerId }, { userIdHigh: viewerId }] })
      .toArray();
    const friendIds = friendships.map((friendship) =>
      friendship.userIdLow.equals(viewerId) ? friendship.userIdHigh : friendship.userIdLow,
    );
    const pattern = escapeSearchTerm(searchTerm);
    const postAudienceFilter: Filter<PostDocument> = {
      $or: [
        { authorId: viewerId },
        { visibility: "public" },
        ...(friendIds.length ? [{ authorId: { $in: friendIds }, visibility: "friends" as const }] : []),
      ],
    };
    const shareAudienceFilter: Filter<ShareDocument> = {
      $or: [
        { authorId: viewerId },
        { visibility: "public" },
        ...(friendIds.length ? [{ authorId: { $in: friendIds }, visibility: "friends" as const }] : []),
      ],
    };
    const postCursorFilter: Filter<PostDocument> | undefined = cursor ? {
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.itemId } },
      ],
    } : undefined;
    const shareCursorFilter: Filter<ShareDocument> | undefined = cursor ? {
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.itemId } },
        ...(cursor.kind === "post" ? [{ createdAt: cursor.createdAt, _id: cursor.itemId }] : []),
      ],
    } : undefined;
    const [matchingPosts, matchingPublicSources] = await Promise.all([
      database.collection<PostDocument>(collectionNames.posts)
        .find({
          $and: [postAudienceFilter, { hiddenAt: { $exists: false } }, { text: { $regex: pattern, $options: "i" } }, ...(postCursorFilter ? [postCursorFilter] : [])],
        })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .toArray(),
      database.collection<PostDocument>(collectionNames.posts)
        .find({ visibility: "public", hiddenAt: { $exists: false }, text: { $regex: pattern, $options: "i" } }, { projection: { _id: 1 } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(500)
        .toArray(),
    ]);
    const sourceIds = [...new Map(matchingPublicSources.map((post) => [post._id.toHexString(), post._id])).values()];
    const shareMatchFilter: Filter<ShareDocument> = sourceIds.length
      ? { $or: [{ caption: { $regex: pattern, $options: "i" } }, { sourcePostId: { $in: sourceIds } }] }
      : { caption: { $regex: pattern, $options: "i" } };
    const matchingShares = await database.collection<ShareDocument>(collectionNames.shares)
      .find({
        $and: [shareAudienceFilter, shareMatchFilter, ...(shareCursorFilter ? [shareCursorFilter] : [])],
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const shareSourceIds = [...new Map(matchingShares.map((share) => [share.sourcePostId.toHexString(), share.sourcePostId])).values()];
    const shareSources = await database.collection<PostDocument>(collectionNames.posts)
      .find({ _id: { $in: shareSourceIds }, visibility: "public", hiddenAt: { $exists: false } })
      .toArray();
    const shareSourcesById = new Map(shareSources.map((post) => [post._id.toHexString(), post]));

    const visibleRecords: FeedRecord[] = [];
    for (const post of matchingPosts) {
      if (await canViewPost(database, viewerId, post)) visibleRecords.push({ kind: "post", post });
    }
    for (const share of matchingShares) {
      const sourcePost = shareSourcesById.get(share.sourcePostId.toHexString());
      if (sourcePost && await canViewShare(database, viewerId, share)) {
        visibleRecords.push({ kind: "share", share, sourcePost });
      }
    }
    visibleRecords.sort((left, right) => {
      const leftCreatedAt = left.kind === "post" ? left.post.createdAt : left.share.createdAt;
      const rightCreatedAt = right.kind === "post" ? right.post.createdAt : right.share.createdAt;
      const dateDifference = rightCreatedAt.getTime() - leftCreatedAt.getTime();
      if (dateDifference !== 0) return dateDifference;
      const leftId = left.kind === "post" ? left.post._id : left.share._id;
      const rightId = right.kind === "post" ? right.post._id : right.share._id;
      const idDifference = rightId.toHexString().localeCompare(leftId.toHexString());
      if (idDifference !== 0) return idDifference;
      return left.kind === right.kind ? 0 : left.kind === "post" ? -1 : 1;
    });
    const hasMore = visibleRecords.length > limit;
    const pageRecords = visibleRecords.slice(0, limit);
    const lastRecord = pageRecords.at(-1);
    const nextCursor = hasMore && lastRecord
      ? encodePostCursor(
        lastRecord.kind === "post" ? lastRecord.post : lastRecord.share,
        lastRecord.kind,
      )
      : null;
    const items = await toFeedResponses(database, pageRecords, viewerId, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, nextCursor));
  });

  router.get("/", authenticated, async (request, response) => {
    const query = parsePageQuery(request.query as Record<string, unknown>);
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const page = await listVisibleFeedRecords(database, viewerId, query);
    const items = await toFeedResponses(database, page.items, viewerId, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, page.nextCursor));
  });

  router.get("/:postId", authenticated, async (request, response) => {
    const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
    const database = dependencies.getDatabase();
    const post = await database.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
    const viewerId = getAuthenticatedSession(response).user._id;

    if (!post || !(await canViewPost(database, viewerId, post))) {
      throw new HttpError(404, "not_found", "Post was not found.");
    }

    const author = await database
      .collection<UserDocument>(collectionNames.users)
      .findOne({ _id: post.authorId });
    if (!author) throw new HttpError(404, "not_found", "Post was not found.");

    const [likeSummary, shareCounts, commentCounts] = await Promise.all([
      getPostLikeSummary(database, postId, viewerId),
      getVisiblePostShareCounts(database, [post], viewerId),
      getVisibleCommentCounts(database, [post]),
    ]);
    const body: PostResponse = {
      post: toPostResponse(
        post,
        author,
        likeSummary,
        dependencies.getCloudinaryCloudName(),
        shareCounts.get(postId.toHexString()) ?? 0,
        commentCounts.get(postId.toHexString()) ?? 0,
      ),
    };
    response.setHeader("Cache-Control", "private, no-store");
    response.json(body);
  });

  return router;
}

export function createUserPostsRouter(overrides: Partial<PostsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });

  router.get("/:userId/posts", authenticated, async (request, response) => {
    const authorId = toObjectIdOrNotFound(String(request.params.userId), "profile");
    const database = dependencies.getDatabase();
    const author = await database.collection<UserDocument>(collectionNames.users).findOne({ _id: authorId });
    if (!author) throw new HttpError(404, "not_found", "Profile was not found.");

    const query = parsePageQuery(request.query as Record<string, unknown>);
    const viewerId = getAuthenticatedSession(response).user._id;
    const page = await listVisibleFeedRecords(database, viewerId, { ...query, authorId });
    const items = await toFeedResponses(database, page.items, viewerId, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, page.nextCursor));
  });

  router.get("/:userId/photos", authenticated, async (request, response) => {
    const authorId = toObjectIdOrNotFound(String(request.params.userId), "profile");
    const database = dependencies.getDatabase();
    const author = await database.collection<UserDocument>(collectionNames.users).findOne({ _id: authorId });
    if (!author) throw new HttpError(404, "not_found", "Profile was not found.");

    const query = parsePageQuery(request.query as Record<string, unknown>);
    const viewerId = getAuthenticatedSession(response).user._id;
    const page = await listVisiblePostDocuments(database, viewerId, { ...query, authorId, photosOnly: true });
    const items = await toPostResponses(database, page.items, viewerId, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, page.nextCursor));
  });

  return router;
}

export const postsRouter = createPostsRouter();
export const userPostsRouter = createUserPostsRouter();
