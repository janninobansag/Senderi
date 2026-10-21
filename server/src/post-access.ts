import { ObjectId, type Db, type Filter } from "mongodb";
import { collectionNames, type FriendshipDocument, type PostDocument } from "./db/documents";
import { HttpError } from "./errors/http-error";
import { areFriends } from "./friends/are-friends";

export interface PostCursor {
  createdAt: Date;
  postId: ObjectId;
}

export interface VisiblePostPage {
  items: PostDocument[];
  nextCursor: string | null;
}

export function encodePostCursor(post: Pick<PostDocument, "_id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({
    createdAt: post.createdAt.toISOString(),
    id: post._id.toHexString(),
  })).toString("base64url");
}

export function decodePostCursor(token: string): PostCursor {
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
    return { createdAt, postId: new ObjectId(value.id) };
  } catch {
    throw new HttpError(400, "invalid_cursor", "Post cursor is invalid.");
  }
}

/** The central post-read policy, shared by feed, timeline, and detail routes. */
export async function canViewPost(
  database: Db,
  viewerId: ObjectId,
  post: Pick<PostDocument, "authorId" | "visibility">,
): Promise<boolean> {
  if (viewerId.equals(post.authorId)) return true;

  switch (post.visibility) {
    case "public":
      return true;
    case "friends":
      return areFriends(database, viewerId, post.authorId);
    case "onlyMe":
      return false;
    default:
      return false;
  }
}

/** Return a newest-first page of visible posts, scanning past hidden candidates. */
export async function listVisiblePostDocuments(
  database: Db,
  viewerId: ObjectId,
  options: { limit: number; cursor?: PostCursor; authorId?: ObjectId },
): Promise<VisiblePostPage> {
  let candidateFilter: Filter<PostDocument>;

  if (options.authorId) {
    if (options.authorId.equals(viewerId)) {
      candidateFilter = { authorId: options.authorId };
    } else if (await areFriends(database, viewerId, options.authorId)) {
      candidateFilter = {
        authorId: options.authorId,
        visibility: { $in: ["public", "friends"] },
      };
    } else {
      candidateFilter = { authorId: options.authorId, visibility: "public" };
    }
  } else {
    const friendships = await database
      .collection<FriendshipDocument>(collectionNames.friendships)
      .find({ $or: [{ userIdLow: viewerId }, { userIdHigh: viewerId }] })
      .toArray();
    const friendIds = friendships.map((friendship) =>
      friendship.userIdLow.equals(viewerId) ? friendship.userIdHigh : friendship.userIdLow,
    );
    const visibleConditions: Filter<PostDocument>[] = [
      { authorId: viewerId },
      { visibility: "public" },
      ...(friendIds.length
        ? [{ visibility: "friends" as const, authorId: { $in: friendIds } }]
        : []),
    ];
    candidateFilter = { $or: visibleConditions };
  }

  const items: PostDocument[] = [];
  let scanCursor = options.cursor;
  let hasMoreVisible = false;
  const batchSize = options.limit + 1;

  while (items.length <= options.limit) {
    const cursorFilter: Filter<PostDocument> | undefined = scanCursor
      ? {
        $or: [
          { createdAt: { $lt: scanCursor.createdAt } },
          { createdAt: scanCursor.createdAt, _id: { $lt: scanCursor.postId } },
        ],
      }
      : undefined;
    const filter: Filter<PostDocument> = cursorFilter
      ? { $and: [candidateFilter, cursorFilter] }
      : candidateFilter;
    const candidates = await database
      .collection<PostDocument>(collectionNames.posts)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(batchSize)
      .toArray();

    if (candidates.length === 0) break;

    for (const post of candidates) {
      scanCursor = { createdAt: post.createdAt, postId: post._id };
      if (await canViewPost(database, viewerId, post)) items.push(post);
      if (items.length > options.limit) {
        hasMoreVisible = true;
        break;
      }
    }

    if (hasMoreVisible || candidates.length < batchSize) break;
  }

  const hasExtraItem = items.length > options.limit;
  if (hasExtraItem) items.pop();
  return {
    items,
    nextCursor: hasExtraItem && items.length > 0
      ? encodePostCursor(items[items.length - 1])
      : null,
  };
}
