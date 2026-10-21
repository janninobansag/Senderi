import { ObjectId, type Db } from "mongodb";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type LikeDocument, type PostDocument, type PostVisibility, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { cloudinaryPostPhotoStorage, validatePostPhoto, type PostPhotoStorage } from "../media/post-photo";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { canViewPost, decodePostCursor, listVisiblePostDocuments } from "../post-access";

const postPageQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const createPostSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
  visibility: z.enum(["public", "friends", "onlyMe"]),
}).strict();

const updatePostSchema = z.object({
  visibility: z.enum(["public", "friends", "onlyMe"]),
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

interface PostListResponse {
  items: PostResponseItem[];
  nextCursor: string | null;
}

interface PostResponse {
  post: PostResponseItem;
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

function parsePageQuery(query: Record<string, unknown>) {
  const parsed = postPageQuerySchema.safeParse(query);
  if (!parsed.success) throw new HttpError(400, "validation_error", "Post page query is invalid.");
  return {
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ? decodePostCursor(parsed.data.cursor) : undefined,
  };
}

function toObjectIdOrNotFound(value: string, resource: "post" | "profile"): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(404, "not_found", resource === "post" ? "Post was not found." : "Profile was not found.");
  }
  return new ObjectId(value);
}

function toPostResponse(
  post: PostDocument,
  author: UserDocument,
  likeSummary: LikeSummary,
  cloudName?: string,
): PostResponseItem {
  return {
    id: post._id.toHexString(),
    author: toPublicUserResponse(author, cloudName),
    ...(post.text !== undefined ? { text: post.text } : {}),
    ...(post.photoAssetId ? { photoUrl: `/api/posts/${post._id.toHexString()}/photo` } : {}),
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString(),
    ...likeSummary,
  };
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
  const [authors, likeSummaries] = await Promise.all([
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
    )] : [];
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

    if (!post || !post.authorId.equals(viewerId)) {
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
      await validatePostPhoto(file);

      const assetName = `${post._id.toHexString()}-${randomUUID()}`;
      const uploaded = await dependencies.photoStorage.upload(file.buffer, assetName);
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
      const likeSummary = await getPostLikeSummary(database, updated._id, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        post: toPostResponse(updated, session.user, likeSummary, dependencies.getCloudinaryCloudName()),
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
        throw new HttpError(400, "validation_error", "Post audience is invalid.");
      }

      const postId = toObjectIdOrNotFound(String(request.params.postId), "post");
      const session = getAuthenticatedSession(response);
      const database = dependencies.getDatabase();
      const updated = await database
        .collection<PostDocument>(collectionNames.posts)
        .findOneAndUpdate(
          { _id: postId, authorId: session.user._id },
          { $set: { visibility: parsed.data.visibility, updatedAt: new Date() } },
          { returnDocument: "after" },
        );

      if (!updated) throw new HttpError(404, "not_found", "Post was not found.");

      const likeSummary = await getPostLikeSummary(database, updated._id, session.user._id);
      response.setHeader("Cache-Control", "private, no-store");
      response.json({
        post: toPostResponse(updated, session.user, likeSummary, dependencies.getCloudinaryCloudName()),
      } satisfies PostResponse);
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
        await database.collection<LikeDocument>(collectionNames.likes).updateOne(
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

      if (request.file) await validatePostPhoto(request.file);

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

      if (request.file) {
        const assetName = `${post._id.toHexString()}-${randomUUID()}`;
        const uploaded = await dependencies.photoStorage.upload(request.file.buffer, assetName);
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

  router.get("/", authenticated, async (request, response) => {
    const query = parsePageQuery(request.query as Record<string, unknown>);
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const page = await listVisiblePostDocuments(database, viewerId, query);
    const items = await toPostResponses(database, page.items, viewerId, dependencies.getCloudinaryCloudName());

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

    const likeSummary = await getPostLikeSummary(database, postId, viewerId);
    const body: PostResponse = {
      post: toPostResponse(post, author, likeSummary, dependencies.getCloudinaryCloudName()),
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
    const page = await listVisiblePostDocuments(database, viewerId, { ...query, authorId });
    const items = await toPostResponses(database, page.items, viewerId, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, page.nextCursor));
  });

  return router;
}

export const postsRouter = createPostsRouter();
export const userPostsRouter = createUserPostsRouter();
