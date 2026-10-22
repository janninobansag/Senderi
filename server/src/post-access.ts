import { ObjectId, type Db, type Filter } from "mongodb";
import { collectionNames, type FriendshipDocument, type PostDocument } from "./db/documents";
import { HttpError } from "./errors/http-error";
import { areFriends } from "./friends/are-friends";

export interface FeedCursor {
  createdAt: Date;
  itemId: ObjectId;
  kind: "post" | "share";
}

export interface VisiblePostPage {
  items: PostDocument[];
  nextCursor: string | null;
}

export function encodePostCursor(
  item: { _id: ObjectId; createdAt: Date },
  kind: FeedCursor["kind"] = "post",
): string {
  return Buffer.from(JSON.stringify({
    createdAt: item.createdAt.toISOString(),
    id: item._id.toHexString(),
    kind,
  })).toString("base64url");
}

export function decodePostCursor(token: string): FeedCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null ||
      !("createdAt" in value) || typeof value.createdAt !== "string" ||
      !("id" in value) || typeof value.id !== "string" ||
      !/^[a-f\d]{24}$/i.test(value.id) ||
      ("kind" in value && value.kind !== "post" && value.kind !== "share")
    ) throw new Error("Invalid cursor payload.");

    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
      throw new Error("Invalid cursor date.");
    }
    return {
      createdAt,
      itemId: new ObjectId(value.id),
      kind: "kind" in value && value.kind === "share" ? "share" : "post",
    };
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
  options: { limit: number; cursor?: FeedCursor; authorId?: ObjectId; photosOnly?: boolean },
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

  if (options.photosOnly) {
    candidateFilter = { $and: [candidateFilter, { photoAssetId: { $exists: true } }] };
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
          { createdAt: scanCursor.createdAt, _id: { $lt: scanCursor.itemId } },
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
      scanCursor = { createdAt: post.createdAt, itemId: post._id, kind: "post" };
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
