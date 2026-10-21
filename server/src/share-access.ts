import { ObjectId, type Db, type Filter } from "mongodb";
import { collectionNames, type FriendshipDocument, type PostDocument, type ShareDocument } from "./db/documents";
import { areFriends } from "./friends/are-friends";
import type { FeedCursor } from "./post-access";

export interface VisibleShareRecord {
  share: ShareDocument;
  sourcePost: PostDocument;
}

/** A share is visible only when its own audience allows the current viewer. */
export async function canViewShare(
  database: Db,
  viewerId: ObjectId,
  share: Pick<ShareDocument, "authorId" | "visibility">,
): Promise<boolean> {
  if (viewerId.equals(share.authorId)) return true;

  switch (share.visibility) {
    case "public":
      return true;
    case "friends":
      return areFriends(database, viewerId, share.authorId);
    case "onlyMe":
      return false;
    default:
      return false;
  }
}

/** Load visible shares whose source posts are still Public, scanning past stale shares. */
export async function listVisibleShareRecords(
  database: Db,
  viewerId: ObjectId,
  options: { limit: number; cursor?: FeedCursor; authorId?: ObjectId },
): Promise<VisibleShareRecord[]> {
  let candidateFilter: Filter<ShareDocument>;

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
    const visibleConditions: Filter<ShareDocument>[] = [
      { authorId: viewerId },
      { visibility: "public" },
      ...(friendIds.length
        ? [{ visibility: "friends" as const, authorId: { $in: friendIds } }]
        : []),
    ];
    candidateFilter = { $or: visibleConditions };
  }

  const records: VisibleShareRecord[] = [];
  let scanCursor = options.cursor;
  const batchSize = options.limit + 1;

  while (records.length <= options.limit) {
    const cursorFilter: Filter<ShareDocument> | undefined = scanCursor
      ? {
        $or: [
          { createdAt: { $lt: scanCursor.createdAt } },
          { createdAt: scanCursor.createdAt, _id: { $lt: scanCursor.itemId } },
          ...(scanCursor.kind === "post"
            ? [{ createdAt: scanCursor.createdAt, _id: scanCursor.itemId }]
            : []),
        ],
      }
      : undefined;
    const filter: Filter<ShareDocument> = cursorFilter
      ? { $and: [candidateFilter, cursorFilter] }
      : candidateFilter;
    const candidates = await database
      .collection<ShareDocument>(collectionNames.shares)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(batchSize)
      .toArray();
    if (candidates.length === 0) break;

    const sourceIds = [...new Map(candidates.map((share) => [
      share.sourcePostId.toHexString(),
      share.sourcePostId,
    ])).values()];
    const sourcePosts = await database
      .collection<PostDocument>(collectionNames.posts)
      .find({ _id: { $in: sourceIds }, visibility: "public" })
      .toArray();
    const sourcesById = new Map(sourcePosts.map((post) => [post._id.toHexString(), post]));

    for (const share of candidates) {
      scanCursor = { createdAt: share.createdAt, itemId: share._id, kind: "share" };
      const sourcePost = sourcesById.get(share.sourcePostId.toHexString());
      if (sourcePost && await canViewShare(database, viewerId, share)) {
        records.push({ share, sourcePost });
      }
      if (records.length > options.limit) break;
    }

    if (records.length > options.limit || candidates.length < batchSize) break;
  }

  return records;
}
