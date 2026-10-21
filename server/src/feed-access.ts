import type { Db, ObjectId } from "mongodb";
import { type PostDocument, type ShareDocument } from "./db/documents";
import { listVisiblePostDocuments, encodePostCursor, type FeedCursor } from "./post-access";
import { listVisibleShareRecords } from "./share-access";

export type FeedRecord =
  | { kind: "post"; post: PostDocument }
  | { kind: "share"; share: ShareDocument; sourcePost: PostDocument };

export interface VisibleFeedPage {
  items: FeedRecord[];
  nextCursor: string | null;
}

function getCreatedAt(record: FeedRecord): Date {
  return record.kind === "post" ? record.post.createdAt : record.share.createdAt;
}

function getId(record: FeedRecord) {
  return record.kind === "post" ? record.post._id : record.share._id;
}

function encodeFeedCursor(record: FeedRecord): string {
  return encodePostCursor(
    { _id: getId(record), createdAt: getCreatedAt(record) },
    record.kind,
  );
}

/** Merge the visible post and share streams into one stable newest-first page. */
export async function listVisibleFeedRecords(
  database: Db,
  viewerId: ObjectId,
  options: { limit: number; cursor?: FeedCursor; authorId?: ObjectId },
): Promise<VisibleFeedPage> {
  const streamLimit = options.limit + 1;
  const [posts, shares] = await Promise.all([
    listVisiblePostDocuments(database, viewerId, { ...options, limit: streamLimit }),
    listVisibleShareRecords(database, viewerId, { ...options, limit: streamLimit }),
  ]);
  const records: FeedRecord[] = [
    ...posts.items.map((post) => ({ kind: "post" as const, post })),
    ...shares.map(({ share, sourcePost }) => ({ kind: "share" as const, share, sourcePost })),
  ].sort((left, right) => {
    const dateDifference = getCreatedAt(right).getTime() - getCreatedAt(left).getTime();
    if (dateDifference !== 0) return dateDifference;
    const idDifference = getId(right).toHexString().localeCompare(getId(left).toHexString());
    if (idDifference !== 0) return idDifference;
    return left.kind === right.kind ? 0 : left.kind === "post" ? -1 : 1;
  });
  const hasMore = records.length > options.limit;
  const items = hasMore ? records.slice(0, options.limit) : records;
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? encodeFeedCursor(items[items.length - 1]!) : null,
  };
}
