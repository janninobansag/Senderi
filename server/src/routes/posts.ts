import { ObjectId, type Db } from "mongodb";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireSession, type AuthenticatedSessionContext } from "../auth/session";
import { toPublicUserResponse } from "../auth/user-response";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type PostDocument, type PostVisibility, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";
import { canViewPost, decodePostCursor, listVisiblePostDocuments } from "../post-access";

const postPageQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

interface PostResponseItem {
  id: string;
  author: ReturnType<typeof toPublicUserResponse>;
  text?: string;
  visibility: PostVisibility;
  createdAt: string;
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
}

const defaultDependencies: PostsRouterDependencies = {
  getDatabase: getConnectedDatabase,
  getCloudinaryCloudName: () => process.env.CLOUDINARY_CLOUD_NAME,
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

function toPostResponse(post: PostDocument, author: UserDocument, cloudName?: string): PostResponseItem {
  return {
    id: post._id.toHexString(),
    author: toPublicUserResponse(author, cloudName),
    ...(post.text !== undefined ? { text: post.text } : {}),
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString(),
  };
}

async function toPostResponses(database: Db, posts: PostDocument[], cloudName?: string): Promise<PostResponseItem[]> {
  if (posts.length === 0) return [];

  const authorIds = [...new Map(posts.map((post) => [
    post.authorId.toHexString(),
    post.authorId,
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
      },
    })
    .toArray();
  const authorsById = new Map(authors.map((author) => [author._id.toHexString(), author]));

  return posts.flatMap((post) => {
    const author = authorsById.get(post.authorId.toHexString());
    return author ? [toPostResponse(post, author, cloudName)] : [];
  });
}

function toPostListResponse(posts: PostResponseItem[], nextCursor: string | null): PostListResponse {
  return { items: posts, nextCursor };
}

export function createPostsRouter(overrides: Partial<PostsRouterDependencies> = {}): Router {
  const dependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  const authenticated = requireSession({ getDatabase: dependencies.getDatabase });

  router.get("/", authenticated, async (request, response) => {
    const query = parsePageQuery(request.query as Record<string, unknown>);
    const database = dependencies.getDatabase();
    const viewerId = getAuthenticatedSession(response).user._id;
    const page = await listVisiblePostDocuments(database, viewerId, query);
    const items = await toPostResponses(database, page.items, dependencies.getCloudinaryCloudName());

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

    const body: PostResponse = {
      post: toPostResponse(post, author, dependencies.getCloudinaryCloudName()),
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
    const items = await toPostResponses(database, page.items, dependencies.getCloudinaryCloudName());

    response.setHeader("Cache-Control", "private, no-store");
    response.json(toPostListResponse(items, page.nextCursor));
  });

  return router;
}

export const postsRouter = createPostsRouter();
export const userPostsRouter = createUserPostsRouter();
