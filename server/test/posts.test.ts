import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { Readable } from "node:stream";
import { ObjectId, type Db, type Document } from "mongodb";
import request from "supertest";
import sharp from "sharp";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type CommentDocument, type CommentReactionDocument, type FriendshipDocument, type LikeDocument, type NotificationDocument, type PostDocument, type SessionDocument, type ShareDocument, type ShareLikeDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import type { PostPhotoStorage } from "../src/media/post-photo";
import { createFriendsRouter } from "../src/routes/friends";
import { createPostsRouter, createUserPostsRouter } from "../src/routes/posts";

interface PostTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  likes: LikeDocument[];
  shareLikes: ShareLikeDocument[];
  comments: CommentDocument[];
  commentReactions: CommentReactionDocument[];
  shares: ShareDocument[];
  notifications: NotificationDocument[];
  posts: PostDocument[];
  failPostInsert?: boolean;
  failPostUpdate?: boolean;
}

type MongoFilter = Record<string, unknown>;

function matchesObjectId(actual: ObjectId, expected: unknown): boolean {
  if (expected instanceof ObjectId) return actual.equals(expected);
  if (typeof expected === "object" && expected !== null && "$in" in expected) {
    return (expected.$in as ObjectId[]).some((id) => actual.equals(id));
  }
  if (typeof expected === "object" && expected !== null && "$lt" in expected) {
    return actual.toHexString() < (expected.$lt as ObjectId).toHexString();
  }
  return false;
}

function matchesDate(actual: Date, expected: unknown): boolean {
  if (expected instanceof Date) return actual.getTime() === expected.getTime();
  if (typeof expected === "object" && expected !== null && "$lt" in expected) {
    return actual.getTime() < (expected.$lt as Date).getTime();
  }
  return false;
}

function matchesPost(post: PostDocument, filter: MongoFilter): boolean {
  if ("$and" in filter) {
    return (filter.$and as MongoFilter[]).every((condition) => matchesPost(post, condition));
  }
  if ("$or" in filter) {
    return (filter.$or as MongoFilter[]).some((condition) => matchesPost(post, condition));
  }

  return Object.entries(filter).every(([field, expected]) => {
    if (field === "authorId") return matchesObjectId(post.authorId, expected);
    if (field === "_id") return matchesObjectId(post._id, expected);
    if (field === "createdAt") return matchesDate(post.createdAt, expected);
    if (field === "photoAssetId" && typeof expected === "object" && expected !== null && "$exists" in expected) {
      return (post.photoAssetId !== undefined) === expected.$exists;
    }
    if (field === "hiddenAt" && typeof expected === "object" && expected !== null && "$exists" in expected) {
      return (post.hiddenAt !== undefined) === expected.$exists;
    }
    if (field === "visibility") {
      if (typeof expected === "object" && expected !== null && "$in" in expected) {
        return (expected.$in as PostDocument["visibility"][]).includes(post.visibility);
      }
      return post.visibility === expected;
    }
    if (field === "text" && typeof expected === "object" && expected !== null && "$regex" in expected) {
      return typeof post.text === "string" && new RegExp(String(expected.$regex), String(expected.$options ?? "")).test(post.text);
    }
    return false;
  });
}

function matchesLike(like: LikeDocument, filter: { postId?: ObjectId; userId?: ObjectId }): boolean {
  return (!filter.postId || like.postId.equals(filter.postId)) &&
    (!filter.userId || like.userId.equals(filter.userId));
}

function matchesShareLike(like: ShareLikeDocument, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "shareId") return matchesObjectId(like.shareId, expected);
    if (field === "userId") return matchesObjectId(like.userId, expected);
    return false;
  });
}

function matchesComment(comment: CommentDocument, filter: MongoFilter): boolean {
  if ("$and" in filter && !(filter.$and as MongoFilter[]).every((condition) => matchesComment(comment, condition))) return false;
  if ("$or" in filter && !(filter.$or as MongoFilter[]).some((condition) => matchesComment(comment, condition))) return false;

  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$and" || field === "$or") return true;
    if (field === "postId") return matchesObjectId(comment.postId, expected);
    if (field === "shareId") {
      if (typeof expected === "object" && expected !== null && "$exists" in expected) {
        return (comment.shareId !== undefined) === expected.$exists;
      }
      return comment.shareId ? matchesObjectId(comment.shareId, expected) : false;
    }
    if (field === "authorId") return matchesObjectId(comment.authorId, expected);
    if (field === "_id") return matchesObjectId(comment._id, expected);
    if (field === "parentCommentId") {
      if (typeof expected === "object" && expected !== null && "$exists" in expected) {
        return (comment.parentCommentId !== undefined) === expected.$exists;
      }
      return comment.parentCommentId ? matchesObjectId(comment.parentCommentId, expected) : false;
    }
    if (field === "replyToCommentId") {
      if (typeof expected === "object" && expected !== null && "$exists" in expected) {
        return (comment.replyToCommentId !== undefined) === expected.$exists;
      }
      return comment.replyToCommentId ? matchesObjectId(comment.replyToCommentId, expected) : false;
    }
    if (field === "createdAt") return matchesDate(comment.createdAt, expected);
    if (field === "hiddenAt" && typeof expected === "object" && expected !== null && "$exists" in expected) {
      return (comment.hiddenAt !== undefined) === expected.$exists;
    }
    return false;
  });
}

function matchesCommentReaction(reaction: CommentReactionDocument, filter: MongoFilter): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "postId") return matchesObjectId(reaction.postId, expected);
    if (field === "commentId") return matchesObjectId(reaction.commentId, expected);
    if (field === "userId") return matchesObjectId(reaction.userId, expected);
    return false;
  });
}

function matchesShare(share: ShareDocument, filter: MongoFilter): boolean {
  if ("$and" in filter && !(filter.$and as MongoFilter[]).every((condition) => matchesShare(share, condition))) return false;
  if ("$or" in filter && !(filter.$or as MongoFilter[]).some((condition) => matchesShare(share, condition))) return false;

  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$and" || field === "$or") return true;
    if (field === "authorId") return matchesObjectId(share.authorId, expected);
    if (field === "sourcePostId") return matchesObjectId(share.sourcePostId, expected);
    if (field === "sourceShareId") {
      if (typeof expected === "object" && expected !== null && "$exists" in expected) {
        return Boolean(share.sourceShareId) === Boolean(expected.$exists);
      }
      return share.sourceShareId ? matchesObjectId(share.sourceShareId, expected) : false;
    }
    if (field === "_id") return matchesObjectId(share._id, expected);
    if (field === "createdAt") return matchesDate(share.createdAt, expected);
    if (field === "caption" && typeof expected === "object" && expected !== null && "$regex" in expected) {
      return typeof share.caption === "string" && new RegExp(String(expected.$regex), String(expected.$options ?? "")).test(share.caption);
    }
    if (field === "visibility") {
      if (typeof expected === "object" && expected !== null && "$in" in expected) {
        return (expected.$in as ShareDocument["visibility"][]).includes(share.visibility);
      }
      return share.visibility === expected;
    }
    return false;
  });
}

function createDatabase(data: PostTestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return {
          findOne: async (filter: { tokenHash: string }) =>
            data.sessions.find((session) => session.tokenHash === filter.tokenHash) ?? null,
        };
      }

      if (name === collectionNames.notifications) {
        return {
          insertOne: async (notification: NotificationDocument) => {
            data.notifications.push(notification);
            return { acknowledged: true, insertedId: notification._id };
          },
        };
      }

      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id?: ObjectId }) =>
            data.users.find((user) => filter._id && user._id.equals(filter._id)) ?? null,
          find: (filter: { _id: { $in: ObjectId[] } }) => ({
            toArray: async () => data.users.filter((user) =>
              filter._id.$in.some((id) => id.equals(user._id)),
            ),
          }),
        };
      }

      if (name === collectionNames.friendships) {
        return {
          findOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) =>
            data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            ) ?? null,
          find: (filter: { $or: Array<Partial<FriendshipDocument>> }) => ({
            toArray: async () => data.friendships.filter((friendship) =>
              filter.$or.some((condition) =>
                (condition.userIdLow && friendship.userIdLow.equals(condition.userIdLow)) ||
                (condition.userIdHigh && friendship.userIdHigh.equals(condition.userIdHigh)),
              ),
            ),
          }),
          deleteOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) => {
            const index = data.friendships.findIndex((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            );
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.friendships.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
        };
      }

      if (name === collectionNames.likes) {
        return {
          aggregate: (pipeline: Document[]) => ({
            toArray: async () => {
              const match = pipeline[0]?.["$match"] as { postId: { $in: ObjectId[] } };
              const group = pipeline[1]?.["$group"] as {
                viewerLikeCount: { $sum: { $cond: [{ $eq: [string, ObjectId] }, number, number] } };
              };
              const viewerId = group.viewerLikeCount.$sum.$cond[0].$eq[1];
              const summaries = new Map<string, { _id: ObjectId; likeCount: number; viewerLikeCount: number }>();
              for (const like of data.likes) {
                if (!match.postId.$in.some((postId) => postId.equals(like.postId))) continue;
                const key = like.postId.toHexString();
                const summary = summaries.get(key) ?? { _id: like.postId, likeCount: 0, viewerLikeCount: 0 };
                summary.likeCount += 1;
                if (like.userId.equals(viewerId)) summary.viewerLikeCount += 1;
                summaries.set(key, summary);
              }
              return [...summaries.values()];
            },
          }),
          countDocuments: async (filter: { postId: ObjectId }) =>
            data.likes.filter((like) => matchesLike(like, filter)).length,
          findOne: async (filter: { postId: ObjectId; userId: ObjectId }) =>
            data.likes.find((like) => matchesLike(like, filter)) ?? null,
          updateOne: async (
            filter: { postId: ObjectId; userId: ObjectId },
            update: { $setOnInsert: LikeDocument },
          ) => {
            if (data.likes.some((like) => matchesLike(like, filter))) {
              return { acknowledged: true, matchedCount: 1, upsertedCount: 0 };
            }
            data.likes.push(update.$setOnInsert);
            return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
          },
          deleteOne: async (filter: { postId: ObjectId; userId: ObjectId }) => {
            const index = data.likes.findIndex((like) => matchesLike(like, filter));
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.likes.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          deleteMany: async (filter: { postId: ObjectId }) => {
            const remaining = data.likes.filter((like) => !matchesLike(like, filter));
            const deletedCount = data.likes.length - remaining.length;
            data.likes.splice(0, data.likes.length, ...remaining);
            return { acknowledged: true, deletedCount };
          },
        };
      }

      if (name === collectionNames.shareLikes) {
        return {
          aggregate: (pipeline: Document[]) => ({
            toArray: async () => {
              const match = pipeline[0]?.["$match"] as { shareId: { $in: ObjectId[] } };
              const group = pipeline[1]?.["$group"] as {
                viewerLikeCount: { $sum: { $cond: [{ $eq: [string, ObjectId] }, number, number] } };
              };
              const viewerId = group.viewerLikeCount.$sum.$cond[0].$eq[1];
              const summaries = new Map<string, { _id: ObjectId; likeCount: number; viewerLikeCount: number }>();
              for (const like of data.shareLikes) {
                if (!match.shareId.$in.some((shareId) => shareId.equals(like.shareId))) continue;
                const key = like.shareId.toHexString();
                const summary = summaries.get(key) ?? { _id: like.shareId, likeCount: 0, viewerLikeCount: 0 };
                summary.likeCount += 1;
                if (like.userId.equals(viewerId)) summary.viewerLikeCount += 1;
                summaries.set(key, summary);
              }
              return [...summaries.values()];
            },
          }),
          countDocuments: async (filter: MongoFilter) =>
            data.shareLikes.filter((like) => matchesShareLike(like, filter)).length,
          findOne: async (filter: MongoFilter) =>
            data.shareLikes.find((like) => matchesShareLike(like, filter)) ?? null,
          updateOne: async (
            filter: MongoFilter,
            update: { $setOnInsert: ShareLikeDocument },
          ) => {
            if (data.shareLikes.some((like) => matchesShareLike(like, filter))) {
              return { acknowledged: true, matchedCount: 1, upsertedCount: 0 };
            }
            data.shareLikes.push(update.$setOnInsert);
            return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
          },
          deleteOne: async (filter: MongoFilter) => {
            const index = data.shareLikes.findIndex((like) => matchesShareLike(like, filter));
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.shareLikes.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          deleteMany: async (filter: MongoFilter) => {
            const remaining = data.shareLikes.filter((like) => !matchesShareLike(like, filter));
            const deletedCount = data.shareLikes.length - remaining.length;
            data.shareLikes.splice(0, data.shareLikes.length, ...remaining);
            return { acknowledged: true, deletedCount };
          },
        };
      }

      if (name === collectionNames.comments) {
        return {
          aggregate: (pipeline: Document[]) => ({
            toArray: async () => {
              const match = pipeline[0]?.["$match"] as MongoFilter;
              const group = pipeline[1]?.["$group"] as MongoFilter;
              const groupField = String(group._id).slice(1) as "postId" | "shareId";
              const summaries = new Map<string, { _id: ObjectId; commentCount: number }>();
              for (const comment of data.comments) {
                if (!matchesComment(comment, match)) continue;
                const groupId = comment[groupField];
                if (!groupId) continue;
                const key = groupId.toHexString();
                const summary = summaries.get(key) ?? { _id: groupId, commentCount: 0 };
                summary.commentCount += 1;
                summaries.set(key, summary);
              }
              return [...summaries.values()];
            },
          }),
          countDocuments: async (filter: MongoFilter) =>
            data.comments.filter((comment) => matchesComment(comment, filter)).length,
          findOne: async (filter: MongoFilter) =>
            data.comments.find((comment) => matchesComment(comment, filter)) ?? null,
          insertOne: async (comment: CommentDocument) => {
            data.comments.push(comment);
            return { acknowledged: true, insertedId: comment._id };
          },
          updateOne: async (filter: MongoFilter, update: { $set: Partial<CommentDocument> }) => {
            const comment = data.comments.find((candidate) => matchesComment(candidate, filter));
            if (!comment) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            Object.assign(comment, update.$set);
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
          },
          updateMany: async (filter: MongoFilter, update: { $unset?: Partial<Record<keyof CommentDocument, string>> }) => {
            const matching = data.comments.filter((comment) => matchesComment(comment, filter));
            for (const comment of matching) {
              if (update.$unset?.parentCommentId !== undefined) delete comment.parentCommentId;
              if (update.$unset?.replyToCommentId !== undefined) delete comment.replyToCommentId;
            }
            return { acknowledged: true, matchedCount: matching.length, modifiedCount: matching.length };
          },
          deleteOne: async (filter: MongoFilter) => {
            const index = data.comments.findIndex((comment) => matchesComment(comment, filter));
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.comments.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          deleteMany: async (filter: MongoFilter) => {
            const remaining = data.comments.filter((comment) => !matchesComment(comment, filter));
            const deletedCount = data.comments.length - remaining.length;
            data.comments.splice(0, data.comments.length, ...remaining);
            return { acknowledged: true, deletedCount };
          },
          find: (filter: MongoFilter) => {
            let result = data.comments.filter((comment) => matchesComment(comment, filter));
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) =>
                  right.createdAt.getTime() - left.createdAt.getTime() ||
                  right._id.toHexString().localeCompare(left._id.toHexString()),
                );
                return cursor;
              },
              limit: (limit: number) => {
                maximum = limit;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
        };
      }

      if (name === collectionNames.commentReactions) {
        return {
          countDocuments: async (filter: MongoFilter) => data.commentReactions.filter((reaction) => matchesCommentReaction(reaction, filter)).length,
          findOne: async (filter: MongoFilter) => data.commentReactions.find((reaction) => matchesCommentReaction(reaction, filter)) ?? null,
          updateOne: async (filter: MongoFilter, update: { $setOnInsert: CommentReactionDocument }) => {
            if (data.commentReactions.some((reaction) => matchesCommentReaction(reaction, filter))) {
              return { acknowledged: true, matchedCount: 1, upsertedCount: 0 };
            }
            data.commentReactions.push(update.$setOnInsert);
            return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
          },
          deleteOne: async (filter: MongoFilter) => {
            const index = data.commentReactions.findIndex((reaction) => matchesCommentReaction(reaction, filter));
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.commentReactions.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          deleteMany: async (filter: MongoFilter) => {
            const remaining = data.commentReactions.filter((reaction) => !matchesCommentReaction(reaction, filter));
            const deletedCount = data.commentReactions.length - remaining.length;
            data.commentReactions.splice(0, data.commentReactions.length, ...remaining);
            return { acknowledged: true, deletedCount };
          },
          find: (filter: MongoFilter) => ({
            toArray: async () => data.commentReactions.filter((reaction) => matchesCommentReaction(reaction, filter)),
          }),
        };
      }

      if (name === collectionNames.shares) {
        return {
          aggregate: (pipeline: Document[]) => ({
            toArray: async () => {
              const match = pipeline[0]?.["$match"] as MongoFilter;
              const group = pipeline[1]?.["$group"] as MongoFilter;
              const groupField = String(group._id).slice(1) as "sourcePostId" | "sourceShareId";
              const summaries = new Map<string, { _id: ObjectId; shareCount: number }>();
              for (const share of data.shares) {
                if (!matchesShare(share, match)) continue;
                const sourceId = share[groupField];
                if (!sourceId) continue;
                const key = sourceId.toHexString();
                const summary = summaries.get(key) ?? { _id: sourceId, shareCount: 0 };
                summary.shareCount += 1;
                summaries.set(key, summary);
              }
              return [...summaries.values()];
            },
          }),
          findOne: async (filter: MongoFilter) =>
            data.shares.find((share) => matchesShare(share, filter)) ?? null,
          insertOne: async (share: ShareDocument) => {
            data.shares.push(share);
            return { acknowledged: true, insertedId: share._id };
          },
          findOneAndUpdate: async (
            filter: MongoFilter,
            update: { $set: Partial<ShareDocument> },
          ) => {
            const share = data.shares.find((candidate) => matchesShare(candidate, filter));
            if (!share) return null;
            Object.assign(share, update.$set);
            return share;
          },
          deleteOne: async (filter: MongoFilter) => {
            const index = data.shares.findIndex((share) => matchesShare(share, filter));
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.shares.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          deleteMany: async (filter: MongoFilter) => {
            const remaining = data.shares.filter((share) => !matchesShare(share, filter));
            const deletedCount = data.shares.length - remaining.length;
            data.shares.splice(0, data.shares.length, ...remaining);
            return { acknowledged: true, deletedCount };
          },
          find: (filter: MongoFilter) => {
            let result = data.shares.filter((share) => matchesShare(share, filter));
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) =>
                  right.createdAt.getTime() - left.createdAt.getTime() ||
                  right._id.toHexString().localeCompare(left._id.toHexString()),
                );
                return cursor;
              },
              limit: (limit: number) => {
                maximum = limit;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
        };
      }

      if (name === collectionNames.posts) {
        return {
          insertOne: async (post: PostDocument) => {
            if (data.failPostInsert) throw new Error("Simulated post insert failure.");
            data.posts.push(post);
            return { acknowledged: true, insertedId: post._id };
          },
          findOne: async (filter: { _id: ObjectId }) =>
            data.posts.find((post) => post._id.equals(filter._id)) ?? null,
          findOneAndUpdate: async (
            filter: { _id: ObjectId; authorId: ObjectId; photoAssetId?: string | { $exists: boolean } },
            update: { $set: Partial<PostDocument> },
          ) => {
            if (data.failPostUpdate) throw new Error("Simulated post update failure.");
            const post = data.posts.find((candidate) => {
              if (!candidate._id.equals(filter._id) || !candidate.authorId.equals(filter.authorId)) return false;
              if (typeof filter.photoAssetId === "string") return candidate.photoAssetId === filter.photoAssetId;
              if (filter.photoAssetId && "$exists" in filter.photoAssetId) {
                return filter.photoAssetId.$exists ? candidate.photoAssetId !== undefined : candidate.photoAssetId === undefined;
              }
              return true;
            });
            if (!post) return null;
            Object.assign(post, update.$set);
            return post;
          },
          deleteOne: async (filter: { _id: ObjectId; authorId: ObjectId }) => {
            const index = data.posts.findIndex((post) =>
              post._id.equals(filter._id) && post.authorId.equals(filter.authorId),
            );
            if (index < 0) return { acknowledged: true, deletedCount: 0 };
            data.posts.splice(index, 1);
            return { acknowledged: true, deletedCount: 1 };
          },
          find: (filter: MongoFilter) => {
            let result = data.posts.filter((post) => matchesPost(post, filter));
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => {
                  const dateOrder = right.createdAt.getTime() - left.createdAt.getTime();
                  return dateOrder || right._id.toHexString().localeCompare(left._id.toHexString());
                });
                return cursor;
              },
              limit: (limit: number) => {
                maximum = limit;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
        };
      }

      return {};
    },
  } as unknown as Db;
}

function makeUser(id: string, email: string, displayName: string): UserDocument {
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  return {
    _id: new ObjectId(id),
    email,
    passwordHash: "$argon2id$private-test-hash",
    displayName,
    bio: "A public bio",
    info: { location: "Cebu" },
    createdAt,
    updatedAt: createdAt,
  };
}

function makePost(
  id: string,
  authorId: ObjectId,
  visibility: PostDocument["visibility"],
  createdAt: Date,
): PostDocument {
  return {
    _id: new ObjectId(id),
    authorId,
    text: `${visibility} post`,
    visibility,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeShare(
  id: string,
  authorId: ObjectId,
  sourcePostId: ObjectId,
  visibility: ShareDocument["visibility"],
  createdAt: Date,
): ShareDocument {
  return { _id: new ObjectId(id), authorId, sourcePostId, visibility, createdAt };
}

function sessionFor(user: UserDocument, token: string): SessionDocument {
  const createdAt = new Date();
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 60_000),
  };
}

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function makeLargeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 72, g: 125, b: 201 } },
  }).jpeg({ quality: 95 }).toBuffer();
}

function createPhotoStorage(overrides: Partial<PostPhotoStorage> = {}): PostPhotoStorage {
  return {
    upload: async (_buffer, publicId) => ({ assetId: `senderi/posts/${publicId}` }),
    destroy: async () => undefined,
    download: async () => ({ stream: Readable.from([validPng]), contentType: "image/png", contentLength: validPng.length }),
    ...overrides,
  };
}

function createApp(data: PostTestData, photoStorage = createPhotoStorage()) {
  const database = createDatabase(data);
  const app = express();
  app.use(express.json());
  app.use("/api/friends", createFriendsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    getCloudinaryCloudName: () => undefined,
  }));
  app.use("/api/users", createUserPostsRouter({ getDatabase: () => database }));
  app.use("/api/posts", createPostsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => ["http://localhost:5173"],
    photoStorage,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

const ids = {
  author: "000000000000000000000001",
  friend: "000000000000000000000002",
  outsider: "000000000000000000000003",
  public: "000000000000000000000011",
  friends: "000000000000000000000012",
  onlyMe: "000000000000000000000013",
};

function matrixFixture(): { data: PostTestData; tokens: Record<"author" | "friend" | "outsider", string> } {
  const author = makeUser(ids.author, "author@example.test", "Author");
  const friend = makeUser(ids.friend, "friend@example.test", "Friend");
  const outsider = makeUser(ids.outsider, "outsider@example.test", "Outsider");
  const tokens = { author: "author-session", friend: "friend-session", outsider: "outsider-session" };
  const now = Date.now();
  const data: PostTestData = {
    users: [author, friend, outsider],
    sessions: [sessionFor(author, tokens.author), sessionFor(friend, tokens.friend), sessionFor(outsider, tokens.outsider)],
    friendships: [{
      _id: new ObjectId(),
      userIdLow: author._id,
      userIdHigh: friend._id,
      createdAt: new Date(now),
    }],
    likes: [],
    shareLikes: [],
    comments: [],
    commentReactions: [],
    shares: [],
    notifications: [],
    posts: [
      makePost(ids.onlyMe, author._id, "onlyMe", new Date(now + 3)),
      makePost(ids.friends, author._id, "friends", new Date(now + 2)),
      makePost(ids.public, author._id, "public", new Date(now + 1)),
    ],
  };
  return { data, tokens };
}

test("feed, author timeline, and direct URLs enforce every audience for author, friend, and outsider", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const expectedByViewer = {
    author: [ids.onlyMe, ids.friends, ids.public],
    friend: [ids.friends, ids.public],
    outsider: [ids.public],
  } as const;

  for (const viewer of ["author", "friend", "outsider"] as const) {
    const authCookie = cookie(tokens[viewer]);
    const expected = expectedByViewer[viewer];
    const feed = await request(app).get("/api/posts").set("Cookie", authCookie).expect(200);
    assert.deepEqual(feed.body.items.map((post: { id: string }) => post.id), expected);
    assert.equal(feed.body.nextCursor, null);
    assert.equal(feed.headers["cache-control"], "private, no-store");

    const timeline = await request(app)
      .get(`/api/users/${ids.author}/posts`)
      .set("Cookie", authCookie)
      .expect(200);
    assert.deepEqual(timeline.body.items.map((post: { id: string }) => post.id), expected);

    for (const postId of [ids.onlyMe, ids.friends, ids.public] as const) {
      const visible = expected.includes(postId);
      const detail = await request(app).get(`/api/posts/${postId}`).set("Cookie", authCookie);
      assert.equal(detail.status, visible ? 200 : 404, `${viewer} access to ${postId}`);
      if (visible) {
        assert.equal(detail.body.post.id, postId);
        assert.equal(detail.body.post.author.displayName, "Author");
        assert.equal("email" in detail.body.post.author, false);
        assert.equal("passwordHash" in detail.body.post.author, false);
        assert.equal(detail.headers["cache-control"], "private, no-store");
      } else {
        assert.deepEqual(detail.body, {
          error: { code: "not_found", message: "Post was not found." },
        });
      }
    }
  }

  const hidden = await request(app)
    .get(`/api/posts/${ids.onlyMe}`)
    .set("Cookie", cookie(tokens.outsider));
  const nonexistent = await request(app)
    .get("/api/posts/000000000000000000000099")
    .set("Cookie", cookie(tokens.outsider));
  assert.equal(hidden.status, nonexistent.status);
  assert.deepEqual(hidden.body, nonexistent.body);
});

test("profile photos paginate only visible photo posts without exposing storage IDs", async () => {
  const { data, tokens } = matrixFixture();
  for (const post of data.posts) post.photoAssetId = `senderi/posts/${post._id.toHexString()}`;
  data.posts.push(makePost("000000000000000000000014", data.users[0]!._id, "public", new Date(Date.now() + 4)));
  const app = createApp(data);
  const expectedByViewer = {
    author: [ids.onlyMe, ids.friends, ids.public],
    friend: [ids.friends, ids.public],
    outsider: [ids.public],
  } as const;

  for (const viewer of ["author", "friend", "outsider"] as const) {
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(app)
        .get(`/api/users/${ids.author}/photos`)
        .query({ limit: 1, ...(cursor ? { cursor } : {}) })
        .set("Cookie", cookie(tokens[viewer]))
        .expect(200);
      assert.equal(page.headers["cache-control"], "private, no-store");
      for (const post of page.body.items as Array<{ id: string; photoUrl?: string; photoAssetId?: string }>) {
        collected.push(post.id);
        assert.equal(post.photoUrl, `/api/posts/${post.id}/photo`);
        assert.equal("photoAssetId" in post, false);
      }
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(collected, expectedByViewer[viewer]);
  }

  await request(app).get(`/api/users/${ids.author}/photos`).expect(401);
  await request(app)
    .get(`/api/users/${ids.author}/photos?cursor=invalid`)
    .set("Cookie", cookie(tokens.author))
    .expect(400);
});

test("post search returns matching feed posts and shares only when their current audiences allow access", async () => {
  const { data, tokens } = matrixFixture();
  const author = data.users.find((user) => user._id.toHexString() === ids.author)!;
  const outsider = data.users.find((user) => user._id.toHexString() === ids.outsider)!;
  const publicPost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const friendsPost = data.posts.find((post) => post._id.toHexString() === ids.friends)!;
  const privatePost = data.posts.find((post) => post._id.toHexString() === ids.onlyMe)!;
  publicPost.text = "needle public note";
  friendsPost.text = "needle friends note";
  privatePost.text = "needle private note";
  const now = new Date(Date.now() + 10);
  const publicSource = makePost("000000000000000000000014", outsider._id, "public", now);
  publicSource.text = "needle source note";
  const hiddenSource = makePost("000000000000000000000015", outsider._id, "friends", now);
  hiddenSource.text = "needle hidden source";
  const hiddenFriendPost = makePost("000000000000000000000016", outsider._id, "friends", now);
  hiddenFriendPost.text = "needle outsider friends note";
  data.posts.push(publicSource, hiddenSource, hiddenFriendPost);
  const visibleShare = makeShare("000000000000000000000021", author._id, publicSource._id, "friends", new Date(now.getTime() + 1));
  const shareOfHiddenSource = makeShare("000000000000000000000022", author._id, hiddenSource._id, "public", new Date(now.getTime() + 2));
  shareOfHiddenSource.caption = "needle caption from hidden source";
  data.shares.push(visibleShare, shareOfHiddenSource);

  const app = createApp(data);
  const response = await request(app)
    .get("/api/posts/search?query=needle&limit=20")
    .set("Cookie", cookie(tokens.friend));

  assert.equal(response.status, 200);
  const resultKeys = response.body.items.map((post: { id: string; share?: { id: string } }) =>
    post.share ? `share:${post.share.id}` : `post:${post.id}`,
  );
  assert.deepEqual(new Set(resultKeys), new Set([
    `post:${publicPost._id.toHexString()}`,
    `post:${friendsPost._id.toHexString()}`,
    `post:${publicSource._id.toHexString()}`,
    `share:${visibleShare._id.toHexString()}`,
  ]));
  assert.equal(response.body.items.some((post: { id: string }) => post.id === privatePost._id.toHexString()), false);
  assert.equal(response.body.items.some((post: { id: string }) => post.id === hiddenFriendPost._id.toHexString()), false);
  assert.equal(response.body.items.some((post: { share?: { id: string } }) => post.share?.id === shareOfHiddenSource._id.toHexString()), false);
  assert.equal(response.headers["cache-control"], "private, no-store");

  const anonymous = await request(app).get("/api/posts/search?query=needle");
  assert.equal(anonymous.status, 401);
});

test("share creation accepts only a Public source and returns its public author context", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const sharesPath = `/api/posts/${ids.public}/shares`;

  const createdShare = await request(app)
    .post(sharesPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "public", caption: "  This is my note.  " })
    .expect(201);
  assert.equal(createdShare.body.share.author.id, ids.friend);
  assert.equal(createdShare.body.share.sourcePostId, ids.public);
  assert.equal(createdShare.body.share.visibility, "public");
  assert.equal(createdShare.body.share.caption, "This is my note.");
  assert.equal("email" in createdShare.body.share.author, false);
  assert.equal("passwordHash" in createdShare.body.share.author, false);
  assert.equal(createdShare.headers["cache-control"], "private, no-store");
  assert.equal(data.shares.length, 1);
  assert.equal(data.shares[0]!.authorId.toHexString(), ids.friend);
  assert.equal(data.shares[0]!.sourcePostId.toHexString(), ids.public);
  assert.equal(data.shares[0]!.caption, "This is my note.");
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.author);
  assert.equal(data.notifications[0]!.actorId.toHexString(), ids.friend);
  assert.equal(data.notifications[0]!.type, "post_share");
  assert.equal(data.notifications[0]!.postId?.toHexString(), ids.public);
  assert.equal(data.notifications[0]!.shareId, undefined, "sharing the original post keeps its notification on the original post");

  const friendFeed = await request(app)
    .get("/api/posts")
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  const sharedFeedItem = friendFeed.body.items.find((item: { share?: { id: string } }) =>
    item.share?.id === createdShare.body.share.id);
  assert.equal(sharedFeedItem?.share.caption, "This is my note.", "the feed must retain the share caption");

  for (const sourceId of [ids.friends, ids.onlyMe]) {
    await request(app)
      .post(`/api/posts/${sourceId}/shares`)
      .set("Origin", "http://localhost:5173")
      .set("Cookie", cookie(tokens.outsider))
      .send({ visibility: "public" })
      .expect(404);
  }
  await request(app)
    .post(sharesPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "invalid" })
    .expect(400);
  await request(app)
    .post(sharesPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "public", caption: "x".repeat(2_001) })
    .expect(400);
  await request(app)
    .post(sharesPath)
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "public" })
    .expect(403);
  await request(app)
    .post(sharesPath)
    .set("Origin", "http://localhost:5173")
    .send({ visibility: "public" })
    .expect(401);
  assert.equal(data.shares.length, 1, "rejected requests must not create share records");
});

test("resharing a shared post notifies its share owner with the original shared-card context", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const sourceShare = makeShare(
    "0000000000000000000000a3",
    new ObjectId(ids.friend),
    sourcePost._id,
    "public",
    new Date(),
  );
  data.shares.push(sourceShare);
  const app = createApp(data);

  await request(app)
    .post(`/api/posts/${ids.public}/shares`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ visibility: "public", sourceShareId: sourceShare._id.toHexString() })
    .expect(201);

  const shareOwnerNotification = data.notifications.find((notification) => notification.recipientId.equals(sourceShare.authorId));
  assert.equal(shareOwnerNotification?.type, "post_share");
  assert.equal(shareOwnerNotification?.postId?.toHexString(), ids.public);
  assert.equal(shareOwnerNotification?.shareId?.toHexString(), sourceShare._id.toHexString());

  const originalAuthorNotification = data.notifications.find((notification) => notification.recipientId.toHexString() === ids.author);
  assert.equal(originalAuthorNotification?.type, "post_share");
  assert.equal(originalAuthorNotification?.shareId, undefined, "the original author keeps a link to their source post");
});

test("share counts stay with the original post or the specific shared card", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const parentShare = makeShare(
    "0000000000000000000000a1",
    new ObjectId(ids.friend),
    sourcePost._id,
    "public",
    new Date(),
  );
  data.shares.push(parentShare);
  const app = createApp(data);
  const sharesPath = `/api/posts/${ids.public}/shares`;
  const origin = "http://localhost:5173";

  const directShare = await request(app)
    .post(sharesPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ visibility: "public" })
    .expect(201);
  const feedAfterDirectShare = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const originalAfterDirectShare = feedAfterDirectShare.body.items.find((item: { id: string; share?: unknown }) =>
    item.id === ids.public && !item.share);
  const parentAfterDirectShare = feedAfterDirectShare.body.items.find((item: { share?: { id: string; shareCount: number } }) =>
    item.share?.id === parentShare._id.toHexString());
  assert.equal(originalAfterDirectShare.shareCount, 2, "sharing the original increments its total");
  assert.equal(parentAfterDirectShare.share.shareCount, 0, "sharing the original does not count as sharing Jan's card");

  const nestedShare = await request(app)
    .post(sharesPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ visibility: "public", sourceShareId: parentShare._id.toHexString() })
    .expect(201);

  assert.equal(nestedShare.body.share.sourceShareId, parentShare._id.toHexString());
  const feed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const originalPost = feed.body.items.find((item: { id: string; share?: unknown }) =>
    item.id === ids.public && !item.share);
  const sharedPosts = feed.body.items.flatMap((item: { share?: { id: string; shareCount: number } }) =>
    item.share ? [item.share] : []);
  const parentCard = sharedPosts.find((share: { id: string }) => share.id === parentShare._id.toHexString());
  const directCard = sharedPosts.find((share: { id: string }) => share.id === directShare.body.share.id);
  const nestedCard = sharedPosts.find((share: { id: string }) => share.id === nestedShare.body.share.id);

  assert.equal(originalPost.shareCount, 3, "shares made from a shared card also increase the original post total");
  assert.equal(parentCard?.shareCount, 1, "a share card counts shares made from that card");
  assert.equal(directCard?.shareCount, 0);
  assert.equal(nestedCard?.shareCount, 0);
});

test("comments on a shared post stay with the share instead of increasing the original post", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const share = makeShare(
    "0000000000000000000000a2",
    new ObjectId(ids.friend),
    sourcePost._id,
    "public",
    new Date(),
  );
  data.shares.push(share);
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const sourceCommentsPath = `/api/posts/${ids.public}/comments`;
  const shareCommentsPath = `/api/posts/${ids.public}/shares/${share._id.toHexString()}/comments`;

  const sourceComment = await request(app)
    .post(sourceCommentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Original post comment" })
    .expect(201);
  const shareComment = await request(app)
    .post(shareCommentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Comment on Jan's share" })
    .expect(201);
  assert.equal(shareComment.body.comment.postId, ids.public);
  assert.equal(data.comments.find((comment) => comment._id.toHexString() === shareComment.body.comment.id)?.shareId?.toHexString(), share._id.toHexString());
  const shareCommentNotification = data.notifications.find((notification) =>
    notification.type === "post_comment" && notification.recipientId.equals(share.authorId));
  assert.equal(shareCommentNotification?.shareId?.toHexString(), share._id.toHexString());

  await request(app)
    .post(shareCommentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "Reply on the share", parentCommentId: shareComment.body.comment.id })
    .expect(201);

  const sourceComments = await request(app).get(sourceCommentsPath).set("Cookie", cookie(tokens.outsider)).expect(200);
  const shareComments = await request(app).get(shareCommentsPath).set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.deepEqual(sourceComments.body.items.map((comment: { id: string }) => comment.id), [sourceComment.body.comment.id]);
  assert.equal(shareComments.body.items.length, 1);
  assert.equal(shareComments.body.items[0].id, shareComment.body.comment.id);
  assert.equal(shareComments.body.items[0].replyCount, 1);

  const feed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const originalPost = feed.body.items.find((item: { id: string; share?: unknown }) => item.id === ids.public && !item.share);
  const sharedPost = feed.body.items.find((item: { share?: { id: string } }) => item.share?.id === share._id.toHexString());
  assert.equal(originalPost.commentCount, 1);
  assert.equal(sharedPost.share.commentCount, 2);

  const sharedPostDetail = await request(app)
    .get(`/api/posts/${ids.public}/shares/${share._id.toHexString()}`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(sharedPostDetail.body.post.share.id, share._id.toHexString());
  assert.equal(sharedPostDetail.body.post.share.commentCount, 2);

  await request(app)
    .delete(`/api/posts/${ids.public}/shares/${share._id.toHexString()}`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(204);
  assert.equal(data.comments.some((comment) => comment.shareId?.equals(share._id)), false, "deleting a share removes its comment thread");
  const sourceCommentsAfterShareDelete = await request(app).get(sourceCommentsPath).set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.deepEqual(sourceCommentsAfterShareDelete.body.items.map((comment: { id: string }) => comment.id), [sourceComment.body.comment.id]);
});

test("share audience changes are owner-only and never change the source post audience", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const share = makeShare(
    "000000000000000000000081",
    new ObjectId(ids.friend),
    sourcePost._id,
    "public",
    new Date(),
  );
  data.shares.push(share);
  data.shareLikes.push({
    _id: new ObjectId(),
    userId: new ObjectId(ids.author),
    shareId: share._id,
    createdAt: new Date(),
  });
  const app = createApp(data);
  const path = `/api/posts/${ids.public}/shares/${share._id.toHexString()}`;
  const origin = "http://localhost:5173";

  await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "friends" })
    .expect(404);
  await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "friends" })
    .expect(200)
    .then((response) => {
      assert.equal(response.body.share.id, share._id.toHexString());
      assert.equal(response.body.share.visibility, "friends");
    });

  assert.equal(share.visibility, "friends");
  assert.equal(sourcePost.visibility, "public", "updating a share must not update its source post");
});

test("removing a share deletes only the share record and is restricted to its author", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePost = data.posts.find((post) => post._id.toHexString() === ids.public)!;
  const share = makeShare(
    "000000000000000000000082",
    new ObjectId(ids.friend),
    sourcePost._id,
    "public",
    new Date(),
  );
  data.shares.push(share);
  const app = createApp(data);
  const path = `/api/posts/${ids.public}/shares/${share._id.toHexString()}`;
  const origin = "http://localhost:5173";

  await request(app)
    .delete(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(404);
  await request(app)
    .delete(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(204);

  assert.equal(data.shares.some((candidate) => candidate._id.equals(share._id)), false);
  assert.equal(data.shareLikes.some((like) => like.shareId.equals(share._id)), false);
  assert.equal(data.posts.some((candidate) => candidate._id.equals(sourcePost._id)), true);
});

test("feed and profile timelines require both visible share audience and a currently Public source", async () => {
  const { data, tokens } = matrixFixture();
  const publicSource = new ObjectId(ids.public);
  const friendsSource = new ObjectId(ids.friends);
  const authorId = new ObjectId(ids.author);
  const friendId = new ObjectId(ids.friend);
  const now = new Date("2026-10-10T12:00:00.000Z");
  data.shares = [
    makeShare("000000000000000000000021", friendId, publicSource, "public", new Date(now.getTime() + 5)),
    makeShare("000000000000000000000022", friendId, publicSource, "friends", new Date(now.getTime() + 4)),
    makeShare("000000000000000000000023", friendId, publicSource, "onlyMe", new Date(now.getTime() + 3)),
    makeShare("000000000000000000000024", authorId, publicSource, "onlyMe", new Date(now.getTime() + 2)),
    makeShare("000000000000000000000025", friendId, friendsSource, "public", new Date(now.getTime() + 1)),
  ];
  const app = createApp(data);
  const shareIds = async (path: string, viewer: "author" | "friend" | "outsider") => {
    const page = await request(app).get(path).set("Cookie", cookie(tokens[viewer])).expect(200);
    return page.body.items.flatMap((item: { share?: { id: string } }) => item.share ? [item.share.id] : []);
  };

  assert.deepEqual(await shareIds("/api/posts", "author"), [
    "000000000000000000000021",
    "000000000000000000000022",
    "000000000000000000000024",
  ]);
  assert.deepEqual(await shareIds("/api/posts", "friend"), [
    "000000000000000000000021",
    "000000000000000000000022",
    "000000000000000000000023",
  ]);
  assert.deepEqual(await shareIds("/api/posts", "outsider"), [
    "000000000000000000000021",
  ]);

  const publicShareDetail = await request(app)
    .get(`/api/posts/${ids.public}/shares/000000000000000000000021`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(publicShareDetail.body.post.share.id, "000000000000000000000021");
  await request(app)
    .get(`/api/posts/${ids.public}/shares/000000000000000000000022`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);

  assert.deepEqual(await shareIds(`/api/users/${ids.friend}/posts`, "friend"), [
    "000000000000000000000021",
    "000000000000000000000022",
    "000000000000000000000023",
  ]);
  assert.deepEqual(await shareIds(`/api/users/${ids.friend}/posts`, "author"), [
    "000000000000000000000021",
    "000000000000000000000022",
  ]);
  assert.deepEqual(await shareIds(`/api/users/${ids.friend}/posts`, "outsider"), [
    "000000000000000000000021",
  ]);

  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const outsiderShare = outsiderFeed.body.items.find((item: { share?: { id: string } }) =>
    item.share?.id === "000000000000000000000021");
  assert.equal(outsiderShare.text, "public post", "a visible share card contains the public source post");
  assert.equal(outsiderFeed.body.items.some((item: { share?: { id: string } }) =>
    item.share?.id === "000000000000000000000025"), false,
  "a Public share must not expose a source whose current audience is Friends");
});

test("mixed post and share feed pages stay newest-first without duplicates", async () => {
  const { data, tokens } = matrixFixture();
  const authorId = new ObjectId(ids.author);
  const friendId = new ObjectId(ids.friend);
  const base = Date.UTC(2026, 9, 10, 12, 0, 0);
  data.posts = [
    makePost("000000000000000000000401", authorId, "public", new Date(base + 10_000)),
    makePost("000000000000000000000402", authorId, "public", new Date(base + 8_000)),
    makePost("000000000000000000000403", authorId, "public", new Date(base + 6_000)),
  ];
  data.shares = [
    makeShare("000000000000000000000404", friendId, data.posts[0]!._id, "public", new Date(base + 9_000)),
    makeShare("000000000000000000000405", friendId, data.posts[0]!._id, "public", new Date(base + 7_000)),
    makeShare("000000000000000000000406", friendId, data.posts[0]!._id, "public", new Date(base + 5_000)),
  ];
  const app = createApp(data);
  const collected: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await request(app)
      .get("/api/posts")
      .query({ limit: 2, ...(cursor ? { cursor } : {}) })
      .set("Cookie", cookie(tokens.outsider))
      .expect(200);
    collected.push(...page.body.items.map((item: { id: string; share?: { id: string } }) =>
      item.share?.id ?? item.id));
    cursor = page.body.nextCursor;
  } while (cursor);

  assert.deepEqual(collected, [
    "000000000000000000000401",
    "000000000000000000000404",
    "000000000000000000000402",
    "000000000000000000000405",
    "000000000000000000000403",
    "000000000000000000000406",
  ]);
  assert.equal(new Set(collected).size, 6);
});

test("feed cursor keeps a share after an equally dated post with the same record ID", async () => {
  const { data, tokens } = matrixFixture();
  const sharedId = "000000000000000000000501";
  const authorId = new ObjectId(ids.author);
  const friendId = new ObjectId(ids.friend);
  const createdAt = new Date("2026-10-10T12:00:00.000Z");
  data.posts = [makePost(sharedId, authorId, "public", createdAt)];
  data.shares = [makeShare(sharedId, friendId, data.posts[0]!._id, "public", createdAt)];
  const app = createApp(data);

  const first = await request(app)
    .get("/api/posts?limit=1")
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(first.body.items[0].share, undefined);
  assert.ok(first.body.nextCursor);

  const second = await request(app)
    .get("/api/posts")
    .query({ limit: 1, cursor: first.body.nextCursor })
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(second.body.items[0].share.id, sharedId);
  assert.equal(second.body.nextCursor, null);
});

test("existing share cards stop exposing source content as soon as its audience is no longer Public", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const shareResponse = await request(app)
    .post(`/api/posts/${ids.public}/shares`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ visibility: "public" })
    .expect(201);
  const shareId = shareResponse.body.share.id as string;

  const assertShareVisibility = async (expectedViewers: Array<"author" | "friend" | "outsider">) => {
    for (const viewer of ["author", "friend", "outsider"] as const) {
      const feed = await request(app).get("/api/posts").set("Cookie", cookie(tokens[viewer])).expect(200);
      assert.equal(
        feed.body.items.some((item: { share?: { id: string } }) => item.share?.id === shareId),
        expectedViewers.includes(viewer),
        `${viewer} share visibility`,
      );
    }
  };

  await assertShareVisibility(["author", "friend", "outsider"]);
  await request(app)
    .patch(`/api/posts/${ids.public}`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "friends" })
    .expect(200);
  await assertShareVisibility([]);

  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.equal(outsiderFeed.body.items.some((item: { id: string }) => item.id === ids.public), false,
    "source text must not remain in a share wrapper or regular feed item for an unauthorized viewer");
  await request(app)
    .post(`/api/posts/${ids.public}/shares`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "public" })
    .expect(404);

  await request(app)
    .patch(`/api/posts/${ids.public}`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "public" })
    .expect(200);
  await assertShareVisibility(["author", "friend", "outsider"]);
  await request(app)
    .patch(`/api/posts/${ids.public}`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "onlyMe" })
    .expect(200);
  await assertShareVisibility([]);

  const sharerTimeline = await request(app)
    .get(`/api/users/${ids.outsider}/posts`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(sharerTimeline.body.items.some((item: { share?: { id: string } }) => item.share?.id === shareId), false,
    "the sharer's own profile must also hide a share when its source is not Public");
});

test("visible post responses include the Like count and viewer-specific Like state", async () => {
  const { data, tokens } = matrixFixture();
  const publicPostId = new ObjectId(ids.public);
  data.likes.push(
    { _id: new ObjectId(), userId: new ObjectId(ids.author), postId: publicPostId, createdAt: new Date() },
    { _id: new ObjectId(), userId: new ObjectId(ids.friend), postId: publicPostId, createdAt: new Date() },
  );
  const app = createApp(data);

  const authorFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.author)).expect(200);
  const friendFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.friend)).expect(200);
  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const authorPost = authorFeed.body.items.find((post: { id: string }) => post.id === ids.public);
  const friendPost = friendFeed.body.items.find((post: { id: string }) => post.id === ids.public);
  const outsiderPost = outsiderFeed.body.items.find((post: { id: string }) => post.id === ids.public);

  assert.deepEqual(
    { count: authorPost.likeCount, liked: authorPost.isLikedByViewer },
    { count: 2, liked: true },
  );
  assert.deepEqual(
    { count: friendPost.likeCount, liked: friendPost.isLikedByViewer },
    { count: 2, liked: true },
  );
  assert.deepEqual(
    { count: outsiderPost.likeCount, liked: outsiderPost.isLikedByViewer },
    { count: 2, liked: false },
  );

  const friendTimeline = await request(app)
    .get(`/api/users/${ids.author}/posts`)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  const timelinePost = friendTimeline.body.items.find((post: { id: string }) => post.id === ids.public);
  assert.equal(timelinePost.likeCount, 2);
  assert.equal(timelinePost.isLikedByViewer, true);

  const detail = await request(app).get(`/api/posts/${ids.public}`).set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.equal(detail.body.post.likeCount, 2);
  assert.equal(detail.body.post.isLikedByViewer, false);
});

test("share reactions are independent from the source post and other shares", async () => {
  const { data, tokens } = matrixFixture();
  const sourcePostId = new ObjectId(ids.public);
  const authorId = new ObjectId(ids.author);
  const friendId = new ObjectId(ids.friend);
  const shareOne = makeShare("000000000000000000000061", authorId, sourcePostId, "public", new Date());
  const shareTwo = makeShare("000000000000000000000062", friendId, sourcePostId, "public", new Date());
  const hiddenShare = makeShare("000000000000000000000063", friendId, sourcePostId, "onlyMe", new Date());
  data.shares = [shareOne, shareTwo, hiddenShare];
  data.likes.push({
    _id: new ObjectId(),
    userId: authorId,
    postId: sourcePostId,
    createdAt: new Date(),
  });
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const shareOneLikeUrl = `/api/posts/${ids.public}/shares/${shareOne._id.toHexString()}/like`;
  const shareTwoLikeUrl = `/api/posts/${ids.public}/shares/${shareTwo._id.toHexString()}/like`;
  const hiddenShareLikeUrl = `/api/posts/${ids.public}/shares/${hiddenShare._id.toHexString()}/like`;

  const firstLike = await request(app)
    .put(shareOneLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.deepEqual(firstLike.body, { likeCount: 1, isLikedByViewer: true });
  const duplicateLike = await request(app)
    .put(shareOneLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.deepEqual(duplicateLike.body, { likeCount: 1, isLikedByViewer: true });

  await request(app)
    .put(shareTwoLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200, { likeCount: 1, isLikedByViewer: true });
  await request(app)
    .put(hiddenShareLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);

  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const authorFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.author)).expect(200);
  const friendFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.friend)).expect(200);
  const sourcePost = outsiderFeed.body.items.find((item: { id: string; share?: unknown }) =>
    item.id === ids.public && !item.share);
  const authorSourcePost = authorFeed.body.items.find((item: { id: string; share?: unknown }) =>
    item.id === ids.public && !item.share);
  const friendSourcePost = friendFeed.body.items.find((item: { id: string; share?: unknown }) =>
    item.id === ids.public && !item.share);
  assert.equal(authorSourcePost.shareCount, 2, "authors see the public and friends-only shares available to them");
  assert.equal(friendSourcePost.shareCount, 3, "viewers see their own private shares as well as public shares");
  assert.equal(sourcePost.shareCount, 2, "viewers cannot infer the existence of shares hidden from them");
  const visibleShares = outsiderFeed.body.items.flatMap((item: { share?: { id: string; likeCount: number; isLikedByViewer: boolean } }) =>
    item.share ? [item.share] : []);
  const firstShareInFeed = visibleShares.find((share: { id: string }) => share.id === shareOne._id.toHexString());
  const secondShareInFeed = visibleShares.find((share: { id: string }) => share.id === shareTwo._id.toHexString());
  assert.deepEqual(
    { count: sourcePost.likeCount, liked: sourcePost.isLikedByViewer },
    { count: 1, liked: false },
    "liking a share must not change the original post reaction",
  );
  assert.deepEqual(
    { count: firstShareInFeed.likeCount, liked: firstShareInFeed.isLikedByViewer },
    { count: 1, liked: true },
  );
  assert.deepEqual(
    { count: secondShareInFeed.likeCount, liked: secondShareInFeed.isLikedByViewer },
    { count: 1, liked: false },
    "another share of the same source keeps its own reaction state",
  );
  assert.equal(data.likes.length, 1);
  assert.equal(data.shareLikes.length, 2);
  assert.equal(data.notifications.length, 1, "a newly liked shared card notifies its owner once, but self-likes do not notify");
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.author);
  assert.equal(data.notifications[0]!.type, "share_like");
  assert.equal(data.notifications[0]!.shareId?.toHexString(), shareOne._id.toHexString());

  const removeLike = await request(app)
    .delete(shareOneLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.deepEqual(removeLike.body, { likeCount: 0, isLikedByViewer: false });
  await request(app)
    .delete(shareOneLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200, { likeCount: 0, isLikedByViewer: false });
  assert.equal(data.shareLikes.length, 1, "unliking one share leaves the other share's reaction intact");
  assert.equal(data.likes.length, 1, "unliking a share leaves source-post reactions intact");
});

test("Like and unlike routes are idempotent, count two users, and deny hidden posts", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const publicLikeUrl = `/api/posts/${ids.public}/like`;

  const firstLike = await request(app)
    .put(publicLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.deepEqual(firstLike.body, { likeCount: 1, isLikedByViewer: true });
  assert.equal(data.notifications.length, 0, "the post author liking their own post does not notify themselves");

  const duplicateLikes = await Promise.all([
    request(app)
      .put(publicLikeUrl)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens.author))
      .expect(200),
    request(app)
      .put(publicLikeUrl)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens.author))
      .expect(200),
  ]);
  for (const duplicateLike of duplicateLikes) {
    assert.deepEqual(duplicateLike.body, { likeCount: 1, isLikedByViewer: true });
  }
  assert.equal(data.likes.length, 1);

  const secondUserLike = await request(app)
    .put(publicLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(secondUserLike.body, { likeCount: 2, isLikedByViewer: true });
  assert.equal(data.likes.length, 2);
  assert.equal(data.notifications.length, 1, "the new Like by another user notifies the author once");
  assert.equal(data.notifications[0]!.type, "post_like");
  assert.equal(data.notifications[0]!.actorId.toHexString(), ids.friend);

  const removeLike = await request(app)
    .delete(publicLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(removeLike.body, { likeCount: 1, isLikedByViewer: false });
  const duplicateRemoval = await request(app)
    .delete(publicLikeUrl)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(duplicateRemoval.body, { likeCount: 1, isLikedByViewer: false });
  assert.equal(data.likes.length, 1);

  for (const [viewer, postId] of [
    ["outsider", ids.friends],
    ["friend", ids.onlyMe],
  ] as const) {
    await request(app)
      .put(`/api/posts/${postId}/like`)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens[viewer]))
      .expect(404);
    await request(app)
      .delete(`/api/posts/${postId}/like`)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens[viewer]))
      .expect(404);
  }

  await request(app)
    .put(publicLikeUrl)
    .set("Origin", origin)
    .expect(401);
  await request(app)
    .put(publicLikeUrl)
    .set("Origin", "https://unexpected.example")
    .set("Cookie", cookie(tokens.outsider))
    .expect(403);
  assert.equal(data.likes.length, 1);
});

test("Likes and comments on a Friends post are revoked immediately after a friend removes the friendship", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const likePath = `/api/posts/${ids.friends}/like`;
  const commentsPath = `/api/posts/${ids.friends}/comments`;

  const friendLike = await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(friendLike.body, { likeCount: 1, isLikedByViewer: true });
  const friendComment = await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "Comment while we are friends" })
    .expect(201);
  assert.equal(friendComment.body.comment.text, "Comment while we are friends");
  const readableComments = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.equal(readableComments.body.items.length, 1);

  await request(app).get(commentsPath).set("Cookie", cookie(tokens.outsider)).expect(404);
  await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Outsider comment" })
    .expect(404);
  await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);
  await request(app)
    .delete(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);

  await request(app)
    .delete(`/api/friends/${ids.author}`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(204);
  assert.equal(data.friendships.length, 0, "the friendship removal must persist before the next request");

  await request(app).get(commentsPath).set("Cookie", cookie(tokens.friend)).expect(404);
  await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "Former-friend comment" })
    .expect(404);
  await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(404);
  await request(app)
    .delete(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(404);

  assert.equal(data.likes.length, 1, "denied Like changes must not alter the existing Like record");
  assert.equal(data.comments.length, 1, "denied comments must not be stored after access is revoked");
  const authorPost = await request(app)
    .get(`/api/posts/${ids.friends}`)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.equal(authorPost.body.post.likeCount, 1);
  const authorComments = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.deepEqual(authorComments.body.items.map((comment: { text: string }) => comment.text), [
    "Comment while we are friends",
  ]);
});

test("direct Like and comment routes deny non-owners after a Public post changes to Only me", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const postPath = `/api/posts/${ids.public}`;
  const likePath = `${postPath}/like`;
  const commentsPath = `${postPath}/comments`;

  await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Visible before the audience change" })
    .expect(201);

  await request(app)
    .patch(postPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "onlyMe" })
    .expect(200);

  for (const viewer of ["friend", "outsider"] as const) {
    await request(app).get(commentsPath).set("Cookie", cookie(tokens[viewer])).expect(404);
    await request(app)
      .post(commentsPath)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens[viewer]))
      .send({ text: "Must not be stored" })
      .expect(404);
    await request(app)
      .put(likePath)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens[viewer]))
      .expect(404);
    await request(app)
      .delete(likePath)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens[viewer]))
      .expect(404);
  }

  assert.equal(data.likes.length, 1, "denied requests must not add or remove the existing Like");
  assert.equal(data.comments.length, 1, "denied requests must not add comments after the audience change");
  const authorPost = await request(app)
    .get(postPath)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.equal(authorPost.body.post.likeCount, 1);
  const authorComments = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.deepEqual(authorComments.body.items.map((comment: { text: string }) => comment.text), [
    "Visible before the audience change",
  ]);
});

test("a Public share disappears when its source changes to Friends while direct access follows current friendship", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const origin = "http://localhost:5173";
  const postPath = `/api/posts/${ids.public}`;
  const likePath = `${postPath}/like`;
  const commentsPath = `${postPath}/comments`;
  const createdShare = await request(app)
    .post(`${postPath}/shares`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ visibility: "public" })
    .expect(201);
  const shareId = createdShare.body.share.id as string;

  for (const viewer of ["author", "friend", "outsider"] as const) {
    const feed = await request(app)
      .get("/api/posts")
      .set("Cookie", cookie(tokens[viewer]))
      .expect(200);
    assert.ok(
      feed.body.items.some((item: { share?: { id: string } }) => item.share?.id === shareId),
      `${viewer} should see the Public share before the source audience changes`,
    );
  }

  await request(app)
    .patch(postPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "friends" })
    .expect(200);

  for (const viewer of ["author", "friend", "outsider"] as const) {
    const feed = await request(app)
      .get("/api/posts")
      .set("Cookie", cookie(tokens[viewer]))
      .expect(200);
    assert.equal(
      feed.body.items.some((item: { share?: { id: string } }) => item.share?.id === shareId),
      false,
      `${viewer} must not see a share whose source is no longer Public`,
    );
    const directPost = await request(app).get(postPath).set("Cookie", cookie(tokens[viewer]));
    assert.equal(directPost.status, viewer === "outsider" ? 404 : 200);
  }

  const sharerTimeline = await request(app)
    .get(`/api/users/${ids.friend}/posts`)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.equal(
    sharerTimeline.body.items.some((item: { share?: { id: string } }) => item.share?.id === shareId),
    false,
    "the share author must not retain the stale share card on their own timeline",
  );

  const friendLike = await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(friendLike.body, { likeCount: 1, isLikedByViewer: true });
  const friendComments = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.equal(friendComments.body.items.length, 0);
  await request(app)
    .put(likePath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);
  await request(app).get(commentsPath).set("Cookie", cookie(tokens.outsider)).expect(404);
  assert.equal(data.shares.length, 1, "changing source visibility should hide, not erase, the share record");
});

test("post creation attributes the authenticated author and returns only public author fields", async () => {
  const { data, tokens } = matrixFixture();
  const response = await request(createApp(data))
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "  A fresh update  ", visibility: "friends" })
    .expect(201);

  assert.equal(response.body.post.text, "A fresh update");
  assert.equal(response.body.post.visibility, "friends");
  assert.equal(response.body.post.author.id, ids.friend);
  assert.equal("email" in response.body.post.author, false);
  assert.equal("passwordHash" in response.body.post.author, false);
  assert.equal(response.body.post.likeCount, 0);
  assert.equal(response.body.post.isLikedByViewer, false);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(data.posts.length, 4);
  assert.equal(data.posts.at(-1)?.authorId.toHexString(), ids.friend);
  assert.equal(data.posts.at(-1)?.text, "A fresh update");
});

test("post creation stores and notifies selected mentions who can view the post", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const friend = data.users.find((user) => user._id.toHexString() === ids.friend)!;
  friend.displayName = "Jan Bansag";

  const created = await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ text: "Hello @Jan Bansag", visibility: "public", mentionedUserIds: [ids.friend] })
    .expect(201);

  assert.deepEqual(data.posts.at(-1)?.mentionedUserIds?.map((id) => id.toHexString()), [ids.friend]);
  assert.equal(created.body.post.text, "Hello @Jan Bansag");
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0]!.type, "post_body_mention");
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.friend);
  assert.equal(data.notifications[0]!.postId?.toHexString(), created.body.post.id);

  const postCount = data.posts.length;
  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ text: "This does not name the selected account", visibility: "public", mentionedUserIds: [ids.friend] })
    .expect(400);

  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ text: "Hello @Outsider", visibility: "friends", mentionedUserIds: [ids.outsider] })
    .expect(400);

  assert.equal(data.posts.length, postCount, "invalid or inaccessible mentions must not create posts");
  assert.equal(data.notifications.length, 1, "invalid or inaccessible mentions must not notify anyone");
});

test("post creation rejects missing, blank, oversized, malformed, or non-text-only fields", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const authCookie = cookie(tokens.author);
  const invalidBodies = [
    {},
    { text: "   ", visibility: "public" },
    { text: "x".repeat(5_001), visibility: "public" },
    { text: "Valid text", visibility: "private" },
    { text: "Valid text", visibility: "public", authorId: ids.outsider },
    { text: "Valid text", visibility: "public", photoAssetId: "asset-id" },
  ];

  for (const body of invalidBodies) {
    const response = await request(app)
      .post("/api/posts")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", authCookie)
      .send(body)
      .expect(400);
    assert.equal(response.body.error.code, "validation_error");
  }

  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .send({ text: "Unauthenticated", visibility: "public" })
    .expect(401);
  assert.equal(data.posts.length, 3);
});

test("two accounts see newly created posts after reloading according to each selected audience", async () => {
  const { data, tokens } = matrixFixture();
  data.posts = [];
  const app = createApp(data);

  for (const visibility of ["public", "friends", "onlyMe"] as const) {
    await request(app)
      .post("/api/posts")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", cookie(tokens.author))
      .send({ text: `${visibility} update`, visibility })
      .expect(201);
  }

  const authorFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.author)).expect(200);
  const friendFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.friend)).expect(200);
  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.deepEqual(new Set(authorFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "onlyMe update", "friends update", "public update",
  ]));
  assert.deepEqual(new Set(friendFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "friends update", "public update",
  ]));
  assert.deepEqual(new Set(outsiderFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "public update",
  ]));

  const friendTimeline = await request(app)
    .get(`/api/users/${ids.author}/posts`)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(friendTimeline.body.items.map((post: { visibility: string }) => post.visibility), [
    "friends", "public",
  ]);
});

test("post creation publishes text and an inspected photo together and removes an orphan if insert fails", async () => {
  const { data, tokens } = matrixFixture();
  const originalPhoto = await makeLargeJpeg();
  const uploaded: Array<{ buffer: Buffer; publicId: string }> = [];
  const destroyed: string[] = [];
  const storage = createPhotoStorage({
    upload: async (buffer, publicId) => {
      uploaded.push({ buffer, publicId });
      return { assetId: `senderi/posts/${publicId}` };
    },
    destroy: async (assetId) => { destroyed.push(assetId); },
  });
  const app = createApp(data, storage);

  const response = await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .field("text", "A caption with a photo for @Friend")
    .field("visibility", "friends")
    .field("mentionedUserIds", JSON.stringify([ids.friend]))
    .attach("file", originalPhoto, "moment.jpg")
    .expect(201);

  const post = data.posts.at(-1)!;
  assert.equal(post.text, "A caption with a photo for @Friend");
  assert.equal(post.visibility, "friends");
  assert.equal(post.authorId.toHexString(), ids.author);
  assert.deepEqual(post.mentionedUserIds?.map((id) => id.toHexString()), [ids.friend]);
  assert.equal(data.notifications.at(-1)?.type, "post_body_mention");
  assert.equal(data.notifications.at(-1)?.recipientId.toHexString(), ids.friend);
  assert.equal(post.photoAssetId, uploaded[0] && `senderi/posts/${uploaded[0].publicId}`);
  const optimizedPhoto = uploaded[0]?.buffer;
  assert.ok(optimizedPhoto);
  assert.ok(optimizedPhoto.length < originalPhoto.length, "new post photos should be compressed before storage");
  const optimizedMetadata = await sharp(optimizedPhoto).metadata();
  assert.equal(optimizedMetadata.format, "webp");
  assert.ok(optimizedMetadata.width && optimizedMetadata.width <= 2048);
  assert.ok(optimizedMetadata.height && optimizedMetadata.height <= 2048);
  assert.equal(response.body.post.photoUrl, `/api/posts/${post._id.toHexString()}/photo`);
  assert.equal("photoAssetId" in response.body.post, false);
  assert.deepEqual(destroyed, []);

  data.failPostInsert = true;
  const countBeforeFailure = data.posts.length;
  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .field("text", "This insert will fail")
    .field("visibility", "public")
    .attach("file", originalPhoto, "moment.jpg")
    .expect(500);

  assert.equal(data.posts.length, countBeforeFailure);
  assert.equal(uploaded.length, 2);
  assert.deepEqual(destroyed, [`senderi/posts/${uploaded[1]!.publicId}`]);
});

test("post creation accepts an image without text but rejects empty text-only posts", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data, createPhotoStorage());
  const originalPhoto = await makeLargeJpeg();

  const imageOnly = await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .field("text", "   ")
    .field("visibility", "public")
    .attach("file", originalPhoto, "photo-only.jpg")
    .expect(201);

  assert.equal(data.posts.at(-1)?.text, "");
  assert.equal(imageOnly.body.post.text, "");
  assert.ok(imageOnly.body.post.photoUrl);

  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ text: "   ", visibility: "public" })
    .expect(400);
});

test("post creation rejects invalid and oversized multipart photos before storage or insert", async () => {
  const { data, tokens } = matrixFixture();
  const uploads: string[] = [];
  const storage = createPhotoStorage({
    upload: async (_buffer, publicId) => {
      uploads.push(publicId);
      return { assetId: `senderi/posts/${publicId}` };
    },
  });
  const app = createApp(data, storage);
  const initialPostCount = data.posts.length;

  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .field("text", "Not really an image")
    .field("visibility", "public")
    .attach("file", Buffer.from("not an image"), "fake.png")
    .expect(400);

  await request(app)
    .post("/api/posts")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .field("text", "Too large")
    .field("visibility", "friends")
    .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), "large.png")
    .expect(413);

  assert.equal(data.posts.length, initialPostCount);
  assert.deepEqual(uploads, []);
});

test("post text and audience edits validate input and allow only the author to persist changes", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const post = data.posts.find((candidate) => candidate._id.toHexString() === ids.public)!;
  const path = `/api/posts/${ids.public}`;
  const origin = "http://localhost:5173";

  const updated = await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "onlyMe" })
    .expect(200);
  assert.equal(updated.body.post.visibility, "onlyMe");
  assert.equal(data.posts.find((candidate) => candidate._id.equals(post._id))?.visibility, "onlyMe");
  assert.equal(updated.headers["cache-control"], "private, no-store");

  const updatedText = await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ text: "  Updated post text  " })
    .expect(200);
  assert.equal(updatedText.body.post.text, "Updated post text");
  assert.equal(data.posts.find((candidate) => candidate._id.equals(post._id))?.text, "Updated post text");
  assert.equal(updatedText.body.post.visibility, "onlyMe");

  for (const body of [
    { visibility: "private" },
    { visibility: "public", authorId: ids.outsider },
    { text: "   " },
    { text: "x".repeat(5_001) },
    {},
  ]) {
    const invalid = await request(app)
      .patch(path)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens.author))
      .send(body)
      .expect(400);
    assert.equal(invalid.body.error.code, "validation_error");
  }

  await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ visibility: "public" })
    .expect(404);
  await request(app)
    .patch(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Not my post" })
    .expect(404);
  await request(app)
    .patch(`/api/posts/${ids.outsider}`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "public" })
    .expect(404);
  await request(app)
    .patch(path)
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "public" })
    .expect(403);
  await request(app)
    .patch(path)
    .set("Origin", origin)
    .send({ visibility: "public" })
    .expect(401);

  assert.equal(data.posts.find((candidate) => candidate._id.equals(post._id))?.visibility, "onlyMe");
});

test("post deletion is owner-only and removes the post, related records, and Cloudinary photo", async () => {
  const { data, tokens } = matrixFixture();
  const post = data.posts.find((candidate) => candidate._id.toHexString() === ids.public)!;
  const otherPost = data.posts.find((candidate) => candidate._id.toHexString() === ids.friends)!;
  post.photoAssetId = "senderi/posts/delete-me";
  data.likes = [
    { _id: new ObjectId(), userId: new ObjectId(ids.friend), postId: post._id, createdAt: new Date() },
    { _id: new ObjectId(), userId: new ObjectId(ids.friend), postId: otherPost._id, createdAt: new Date() },
  ];
  data.comments = [
    { _id: new ObjectId(), postId: post._id, authorId: new ObjectId(ids.friend), text: "Remove me", createdAt: new Date() },
    { _id: new ObjectId(), postId: otherPost._id, authorId: new ObjectId(ids.friend), text: "Keep me", createdAt: new Date() },
  ];
  data.shares = [
    makeShare("000000000000000000000071", new ObjectId(ids.friend), post._id, "public", new Date()),
    makeShare("000000000000000000000072", new ObjectId(ids.friend), otherPost._id, "public", new Date()),
  ];
  const deletedShareId = data.shares[0]!._id;
  const remainingShareId = data.shares[1]!._id;
  data.shareLikes = [
    { _id: new ObjectId(), userId: new ObjectId(ids.friend), shareId: data.shares[0]!._id, createdAt: new Date() },
    { _id: new ObjectId(), userId: new ObjectId(ids.friend), shareId: data.shares[1]!._id, createdAt: new Date() },
  ];
  const destroyed: string[] = [];
  const app = createApp(data, createPhotoStorage({
    destroy: async (assetId) => { destroyed.push(assetId); },
  }));
  const path = `/api/posts/${ids.public}`;
  const origin = "http://localhost:5173";

  await request(app)
    .delete(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(404);
  await request(app)
    .delete(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);
  assert.deepEqual(destroyed, [], "non-owners must not trigger photo deletion");

  const deleted = await request(app)
    .delete(path)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(204);
  assert.equal(deleted.headers["cache-control"], "private, no-store");
  assert.deepEqual(destroyed, ["senderi/posts/delete-me"]);
  assert.equal(data.posts.some((candidate) => candidate._id.equals(post._id)), false);
  assert.equal(data.likes.some((like) => like.postId.equals(post._id)), false);
  assert.equal(data.comments.some((comment) => comment.postId.equals(post._id)), false);
  assert.equal(data.shares.some((share) => share.sourcePostId.equals(post._id)), false);
  assert.equal(data.likes.some((like) => like.postId.equals(otherPost._id)), true);
  assert.equal(data.comments.some((comment) => comment.postId.equals(otherPost._id)), true);
  assert.equal(data.shares.some((share) => share.sourcePostId.equals(otherPost._id)), true);
  assert.equal(data.shareLikes.some((like) => like.shareId.equals(deletedShareId)), false);
  assert.equal(data.shareLikes.some((like) => like.shareId.equals(remainingShareId)), true);
  assert.equal(data.shareLikes.length, 1, "deleting a source post removes its share reactions but preserves unrelated ones");

  await request(app).get(path).set("Cookie", cookie(tokens.author)).expect(404);
});

test("post deletion preserves the database post if Cloudinary photo removal fails", async () => {
  const { data, tokens } = matrixFixture();
  const post = data.posts.find((candidate) => candidate._id.toHexString() === ids.public)!;
  post.photoAssetId = "senderi/posts/keep-on-failure";
  const app = createApp(data, createPhotoStorage({
    destroy: async () => { throw new Error("simulated Cloudinary failure"); },
  }));

  const response = await request(app)
    .delete(`/api/posts/${ids.public}`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .expect(502);
  assert.equal(response.body.error.code, "post_photo_delete_failed");
  assert.equal(data.posts.some((candidate) => candidate._id.equals(post._id)), true);
});

test("feed, direct post, and the same photo URL recheck access after every audience change", async () => {
  const { data, tokens } = matrixFixture();
  const post = data.posts.find((candidate) => candidate._id.toHexString() === ids.public)!;
  post.photoAssetId = "senderi/posts/old-photo";
  data.posts = [post];
  const downloads: string[] = [];
  const storage = createPhotoStorage({
    download: async (assetId) => {
      downloads.push(assetId);
      return { stream: Readable.from([validPng]), contentType: "image/png", contentLength: validPng.length };
    },
  });
  const app = createApp(data, storage);
  const origin = "http://localhost:5173";
  const oldPhotoUrl = `/api/posts/${post._id.toHexString()}/photo`;

  for (const visibility of ["onlyMe", "friends", "public"] as const) {
    const edited = await request(app)
      .patch(`/api/posts/${post._id.toHexString()}`)
      .set("Origin", origin)
      .set("Cookie", cookie(tokens.author))
      .send({ visibility })
      .expect(200);
    assert.equal(edited.body.post.visibility, visibility);
    assert.equal(edited.body.post.photoUrl, oldPhotoUrl);

    for (const viewer of ["author", "friend", "outsider"] as const) {
      const visible = viewer === "author" || visibility === "public" || (viewer === "friend" && visibility === "friends");
      const authCookie = cookie(tokens[viewer]);
      const feed = await request(app).get("/api/posts").set("Cookie", authCookie).expect(200);
      assert.equal(feed.body.items.some((item: { id: string }) => item.id === post._id.toHexString()), visible,
        `${viewer} feed access for ${visibility}`);

      const detail = await request(app).get(`/api/posts/${post._id.toHexString()}`).set("Cookie", authCookie);
      assert.equal(detail.status, visible ? 200 : 404, `${viewer} direct post access for ${visibility}`);

      const photo = await request(app).get(oldPhotoUrl).set("Cookie", authCookie);
      assert.equal(photo.status, visible ? 200 : 404, `${viewer} old photo URL access for ${visibility}`);
      if (visible) assert.equal(photo.headers["cache-control"], "private, no-store");
    }
  }

  assert.equal(downloads.length, 6);
  assert.ok(downloads.every((assetId) => assetId === "senderi/posts/old-photo"));
});

test("feed and author timeline paginate newest first without duplicates", async () => {
  const { data, tokens } = matrixFixture();
  const authorId = new ObjectId(ids.author);
  data.posts = Array.from({ length: 5 }, (_, index) => makePost(
    (100 + index).toString(16).padStart(24, "0"),
    authorId,
    "public",
    new Date(Date.UTC(2026, 9, 1, 0, index)),
  ));
  const app = createApp(data);

  for (const path of ["/api/posts", `/api/users/${ids.author}/posts`]) {
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(app)
        .get(path)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .set("Cookie", cookie(tokens.outsider))
        .expect(200);
      collected.push(...page.body.items.map((post: { id: string }) => post.id));
      cursor = page.body.nextCursor;
    } while (cursor);

    assert.deepEqual(collected, data.posts.toSorted((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right._id.toHexString().localeCompare(left._id.toHexString()),
    ).map((post) => post._id.toHexString()));
    assert.equal(new Set(collected).size, 5);
  }
});

test("author timeline scans past hidden posts to fill a visible page", async () => {
  const { data, tokens } = matrixFixture();
  const authorId = new ObjectId(ids.author);
  const now = Date.now();
  data.posts = Array.from({ length: 25 }, (_, index) => makePost(
    (200 + index).toString(16).padStart(24, "0"),
    authorId,
    "onlyMe",
    new Date(now + (25 - index) * 1_000),
  ));
  data.posts.push(makePost(
    "0000000000000000000002ff",
    authorId,
    "public",
    new Date(now - 60_000),
  ));
  const page = await request(createApp(data))
    .get(`/api/users/${ids.author}/posts?limit=2`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);

  assert.deepEqual(page.body.items.map((post: { visibility: string }) => post.visibility), ["public"]);
  assert.equal(page.body.nextCursor, null);
});

test("post reads require a valid session and reject malformed IDs and page queries", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  await request(app).get("/api/posts").expect(401);
  await request(app).get("/api/posts/not-an-object-id").set("Cookie", cookie(tokens.author)).expect(404);
  await request(app).get("/api/users/not-an-object-id/posts").set("Cookie", cookie(tokens.author)).expect(404);
  await request(app).get("/api/posts?limit=51").set("Cookie", cookie(tokens.author)).expect(400);
  await request(app).get("/api/posts?cursor=not-valid!!").set("Cookie", cookie(tokens.author)).expect(400);
  await request(app).get("/api/posts?cursor=YWJj").set("Cookie", cookie(tokens.author)).expect(400);
});

test("post photo upload inspects bytes, replaces only the owner's photo, and deletes the old asset after saving", async () => {
  const { data, tokens } = matrixFixture();
  const originalPhoto = await makeLargeJpeg();
  const post = data.posts[0]!;
  post.photoAssetId = "senderi/posts/old-photo";
  const destroyed: string[] = [];
  const uploaded: Array<{ buffer: Buffer; publicId: string }> = [];
  const storage = createPhotoStorage({
    upload: async (buffer, publicId) => {
      uploaded.push({ buffer, publicId });
      return { assetId: "senderi/posts/new-photo" };
    },
    destroy: async (assetId) => {
      assert.equal(data.posts[0]?.photoAssetId, "senderi/posts/new-photo", "database replacement must happen before old asset deletion");
      destroyed.push(assetId);
    },
  });
  const response = await request(createApp(data, storage))
    .put(`/api/posts/${post._id.toHexString()}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .attach("file", originalPhoto, "photo.jpg")
    .expect(200);

  assert.equal(uploaded.length, 1);
  const optimizedPhoto = uploaded[0]?.buffer;
  assert.ok(optimizedPhoto);
  assert.ok(optimizedPhoto.length < originalPhoto.length, "Cloudinary should receive fewer bytes than the original");
  const optimizedMetadata = await sharp(optimizedPhoto).metadata();
  assert.equal(optimizedMetadata.format, "webp");
  assert.ok(optimizedMetadata.width && optimizedMetadata.width <= 2048);
  assert.ok(optimizedMetadata.height && optimizedMetadata.height <= 2048);
  assert.match(uploaded[0]?.publicId ?? "", new RegExp(`^${post._id.toHexString()}-[0-9a-f-]{36}$`));
  assert.equal(data.posts[0]?.photoAssetId, "senderi/posts/new-photo");
  assert.deepEqual(destroyed, ["senderi/posts/old-photo"]);
  assert.equal(response.body.post.photoUrl, `/api/posts/${post._id.toHexString()}/photo`);
  assert.equal("photoAssetId" in response.body.post, false);
  assert.equal(JSON.stringify(response.body).includes("cloudinary"), false);
});

test("post photo upload rejects non-owners, invalid content, missing files, and oversized or multiple files", async () => {
  const { data, tokens } = matrixFixture();
  const uploads: string[] = [];
  const storage = createPhotoStorage({
    upload: async (_buffer, publicId) => {
      uploads.push(publicId);
      return { assetId: `senderi/posts/${publicId}` };
    },
  });
  const app = createApp(data, storage);
  const postId = ids.public;

  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "https://unexpected.example")
    .set("Cookie", cookie(tokens.author))
    .attach("file", validPng, "photo.png")
    .expect(403);
  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .attach("file", validPng, "photo.png")
    .expect(401);

  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .attach("file", validPng, "photo.png")
    .expect(404);
  assert.equal(uploads.length, 0);

  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .attach("file", Buffer.from("not an image"), "photo.png")
    .expect(400);
  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .expect(400);
  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), "large.png")
    .expect(413);
  await request(app)
    .put(`/api/posts/${postId}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .attach("file", validPng, "first.png")
    .attach("file", validPng, "second.png")
    .expect(400);

  assert.equal(uploads.length, 0);
});

test("failed post photo persistence deletes the new Cloudinary asset and keeps the old ID", async () => {
  const { data, tokens } = matrixFixture();
  const post = data.posts[0]!;
  post.photoAssetId = "senderi/posts/old-photo";
  data.failPostUpdate = true;
  const destroyed: string[] = [];
  const app = createApp(data, createPhotoStorage({
    upload: async () => ({ assetId: "senderi/posts/new-photo" }),
    destroy: async (assetId) => { destroyed.push(assetId); },
  }));

  await request(app)
    .put(`/api/posts/${post._id.toHexString()}/photo`)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .attach("file", validPng, "photo.png")
    .expect(500);

  assert.equal(post.photoAssetId, "senderi/posts/old-photo");
  assert.deepEqual(destroyed, ["senderi/posts/new-photo"]);
});

test("photo byte requests recheck current audience, never expose Cloudinary IDs, and disable caching", async () => {
  const { data, tokens } = matrixFixture();
  for (const post of data.posts) post.photoAssetId = `senderi/posts/${post._id.toHexString()}`;
  const downloaded: string[] = [];
  const app = createApp(data, createPhotoStorage({
    download: async (assetId) => {
      downloaded.push(assetId);
      return { stream: Readable.from([validPng]), contentType: "image/png", contentLength: validPng.length };
    },
  }));
  const authorizedIds = {
    author: [ids.onlyMe, ids.friends, ids.public],
    friend: [ids.friends, ids.public],
    outsider: [ids.public],
  } as const;

  for (const viewer of ["author", "friend", "outsider"] as const) {
    for (const postId of [ids.onlyMe, ids.friends, ids.public] as const) {
      const visible = authorizedIds[viewer].includes(postId);
      const response = await request(app)
        .get(`/api/posts/${postId}/photo`)
        .set("Cookie", cookie(tokens[viewer]));
      assert.equal(response.status, visible ? 200 : 404, `${viewer} access to ${postId} photo`);
      if (visible) {
        assert.equal(response.headers["content-type"], "image/png");
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(response.headers.vary, "Cookie");
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.deepEqual(response.body, validPng);
      } else {
        assert.deepEqual(response.body, { error: { code: "not_found", message: "Post photo was not found." } });
      }
    }
  }

  assert.equal(downloaded.length, 6, "hidden requests must not contact Cloudinary");
  const outsiderResponse = await request(app)
    .get(`/api/posts/${ids.onlyMe}/photo`)
    .set("Cookie", cookie(tokens.outsider));
  const missingResponse = await request(app)
    .get("/api/posts/000000000000000000000099/photo")
    .set("Cookie", cookie(tokens.outsider));
  assert.equal(outsiderResponse.status, 404);
  assert.deepEqual(outsiderResponse.body, missingResponse.body);

  const visiblePost = await request(app)
    .get(`/api/posts/${ids.public}`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(visiblePost.body.post.photoUrl, `/api/posts/${ids.public}/photo`);
  assert.equal("photoAssetId" in visiblePost.body.post, false);
  assert.equal(JSON.stringify(visiblePost.body).includes("senderi/posts/"), false);
  await request(app).get(`/api/posts/${ids.public}/photo`).expect(401);

  data.friendships = [];
  const removedFriend = await request(app)
    .get(`/api/posts/${ids.friends}/photo`)
    .set("Cookie", cookie(tokens.friend));
  assert.equal(removedFriend.status, 404, "friends access must be revoked immediately after friendship removal");
});

test("comments paginate newest first with stable cursors and return only public author fields", async () => {
  const { data, tokens } = matrixFixture();
  const postId = new ObjectId(ids.public);
  const authorId = new ObjectId(ids.author);
  const createdAt = new Date("2026-10-01T12:00:00.000Z");
  data.comments = Array.from({ length: 5 }, (_, index) => ({
    _id: new ObjectId((300 + index).toString(16).padStart(24, "0")),
    postId,
    authorId,
    text: `Comment ${index + 1}`,
    createdAt,
  }));
  const app = createApp(data);
  const collected: Array<{ id: string; text: string; author: { id: string; email?: string; passwordHash?: string } }> = [];
  let cursor: string | null = null;

  do {
    const page = await request(app)
      .get(`/api/posts/${ids.public}/comments`)
      .query({ limit: 2, ...(cursor ? { cursor } : {}) })
      .set("Cookie", cookie(tokens.outsider))
      .expect(200);
    assert.equal(page.headers["cache-control"], "private, no-store");
    collected.push(...page.body.items);
    cursor = page.body.nextCursor;
  } while (cursor);

  assert.deepEqual(collected.map((comment) => comment.text), [
    "Comment 5", "Comment 4", "Comment 3", "Comment 2", "Comment 1",
  ]);
  assert.equal(new Set(collected.map((comment) => comment.id)).size, 5);
  assert.ok(collected.every((comment) => comment.author.id === ids.author));
  assert.ok(collected.every((comment) => !("email" in comment.author) && !("passwordHash" in comment.author)));
});

test("post responses count visible comments and omit moderated comments from the count", async () => {
  const { data, tokens } = matrixFixture();
  const postId = new ObjectId(ids.public);
  const authorId = new ObjectId(ids.author);
  data.comments = [
    { _id: new ObjectId("000000000000000000000401"), postId, authorId, text: "Visible 1", createdAt: new Date() },
    { _id: new ObjectId("000000000000000000000402"), postId, authorId, text: "Visible 2", createdAt: new Date() },
    { _id: new ObjectId("000000000000000000000403"), postId, authorId, text: "Visible 3", createdAt: new Date() },
    { _id: new ObjectId("000000000000000000000404"), postId, authorId, text: "Hidden", createdAt: new Date(), hiddenAt: new Date() },
  ];
  const app = createApp(data);

  const feed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  const feedPost = feed.body.items.find((item: { id: string }) => item.id === ids.public);
  assert.equal(feedPost.commentCount, 3);

  const detail = await request(app)
    .get(`/api/posts/${ids.public}`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(detail.body.post.commentCount, 3);
});

test("comment creation validates text, requires an allowed origin, and stops after access is revoked", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const postPath = `/api/posts/${ids.public}`;
  const commentsPath = `${postPath}/comments`;

  await request(app)
    .post(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Missing origin" })
    .expect(403);
  await request(app)
    .post(commentsPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "   " })
    .expect(400);
  await request(app)
    .post(commentsPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "x".repeat(2_001) })
    .expect(400);
  await request(app)
    .post(commentsPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Allowed comment", extra: "not accepted" })
    .expect(400);

  const created = await request(app)
    .post(commentsPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "  Allowed comment  " })
    .expect(201);
  assert.equal(created.body.comment.text, "Allowed comment");
  assert.equal(created.body.comment.author.id, ids.outsider);
  assert.equal("email" in created.body.comment.author, false);
  assert.equal(created.headers["cache-control"], "private, no-store");
  assert.equal(data.comments.length, 1);
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0]!.type, "post_comment");
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.author);

  await request(app)
    .patch(postPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.author))
    .send({ visibility: "onlyMe" })
    .expect(200);

  await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);
  await request(app)
    .post(commentsPath)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Should be denied" })
    .expect(404);
  assert.equal(data.comments.length, 1, "a denied viewer must not add comments after the post becomes Only me");

  const authorPage = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.deepEqual(authorPage.body.items.map((comment: { text: string }) => comment.text), ["Allowed comment"]);
});

test("comments and replies notify mentioned accounts who can view the post", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const friend = data.users.find((user) => user._id.toHexString() === ids.friend)!;
  friend.displayName = "Jan Bansag";
  const commentsPath = `/api/posts/${ids.public}/comments`;
  const origin = "http://localhost:5173";

  const created = await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Hello @Jan Bansag", mentionedUserIds: [ids.friend] })
    .expect(201);
  assert.deepEqual(data.comments[0]!.mentionedUserIds?.map((id) => id.toHexString()), [ids.friend]);
  assert.equal(data.notifications.length, 2);
  assert.equal(data.notifications[0]!.type, "post_comment");
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.author);
  assert.equal(data.notifications[1]!.type, "post_mention");
  assert.equal(data.notifications[1]!.recipientId.toHexString(), ids.friend);

  await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({
      text: "A reply to myself mentioning @Jan Bansag",
      parentCommentId: created.body.comment.id,
      mentionedUserIds: [ids.friend],
    })
    .expect(201);
  assert.equal(data.notifications.length, 3);
  assert.equal(data.notifications[2]!.type, "post_mention");
  assert.equal(data.notifications[2]!.recipientId.toHexString(), ids.friend);

  await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "This text does not mention the account", mentionedUserIds: [ids.friend] })
    .expect(400);

  await request(app)
    .post(`/api/posts/${ids.friends}/comments`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ text: "Hello @Outsider", mentionedUserIds: [ids.outsider] })
    .expect(400);
  assert.equal(data.comments.length, 2, "invalid or inaccessible mentions must not add comments");
  assert.equal(data.notifications.length, 3, "invalid or inaccessible mentions must not notify anyone");
});

test("comment authors can edit and permanently delete only their own visible comments", async () => {
  const { data, tokens } = matrixFixture();
  const comment: CommentDocument = {
    _id: new ObjectId("000000000000000000000301"),
    postId: new ObjectId(ids.public),
    authorId: new ObjectId(ids.outsider),
    text: "Original comment",
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
  };
  const hiddenComment: CommentDocument = {
    _id: new ObjectId("000000000000000000000302"),
    postId: new ObjectId(ids.public),
    authorId: new ObjectId(ids.outsider),
    text: "Hidden comment",
    createdAt: new Date("2026-10-20T12:01:00.000Z"),
    hiddenAt: new Date(),
  };
  data.comments.push(comment, hiddenComment);
  data.commentReactions.push({
    _id: new ObjectId(),
    postId: comment.postId,
    commentId: comment._id,
    userId: comment.authorId,
    createdAt: new Date(),
  });
  const app = createApp(data);
  const commentPath = `/api/posts/${ids.public}/comments/${comment._id.toHexString()}`;
  const hiddenCommentPath = `/api/posts/${ids.public}/comments/${hiddenComment._id.toHexString()}`;
  const origin = "http://localhost:5173";

  await request(app)
    .patch(commentPath)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "No origin" })
    .expect(403);
  await request(app)
    .patch(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "   " })
    .expect(400);
  await request(app)
    .patch(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ text: "Edited by someone else" })
    .expect(404);

  const updated = await request(app)
    .patch(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "  Updated comment  " })
    .expect(200);
  assert.equal(updated.body.comment.text, "Updated comment");
  assert.equal(updated.body.comment.id, comment._id.toHexString());
  assert.equal(updated.body.comment.author.id, ids.outsider);
  assert.equal(updated.body.comment.reactionCount, 1);
  assert.equal(updated.body.comment.isReactedByViewer, true);
  assert.equal(typeof updated.body.comment.editedAt, "string");
  assert.equal(updated.headers["cache-control"], "private, no-store");
  assert.equal(comment.text, "Updated comment");
  assert.equal(comment.editedAt?.toISOString(), updated.body.comment.editedAt);

  const refreshedComments = await request(app)
    .get(`/api/posts/${ids.public}/comments`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(refreshedComments.body.items.find((item: { id: string }) => item.id === comment._id.toHexString())?.editedAt, updated.body.comment.editedAt);

  await request(app)
    .delete(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(404);
  await request(app)
    .patch(hiddenCommentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Restore hidden comment" })
    .expect(404);
  await request(app)
    .delete(hiddenCommentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);

  await request(app)
    .delete(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(204);
  assert.equal(data.comments.includes(comment), false, "deletion permanently removes the comment record");
  assert.equal(data.comments.includes(hiddenComment), true, "a hidden comment is not altered by owner actions");
  assert.equal(data.commentReactions.length, 0, "deleting a comment removes its reactions");
  await request(app)
    .delete(commentPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(404);
});

test("comments support replies and reactions, and permanently delete a thread with its main comment", async () => {
  const { data, tokens } = matrixFixture();
  const root: CommentDocument = {
    _id: new ObjectId("000000000000000000000501"),
    postId: new ObjectId(ids.public),
    authorId: new ObjectId(ids.author),
    text: "A starting comment",
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
  };
  data.comments.push(root);
  const app = createApp(data);
  const commentsPath = `/api/posts/${ids.public}/comments`;
  const rootPath = `${commentsPath}/${root._id.toHexString()}`;
  const origin = "http://localhost:5173";

  const replyResponse = await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "A reply", parentCommentId: root._id.toHexString() })
    .expect(201);
  const replyId = replyResponse.body.comment.id as string;
  assert.equal(replyResponse.body.comment.parentCommentId, root._id.toHexString());
  assert.equal(replyResponse.body.comment.reactionCount, 0);
  assert.equal(replyResponse.body.comment.replyCount, 0);
  assert.deepEqual(replyResponse.body.comment.replies, []);
  assert.equal(data.notifications[0]!.recipientId.toHexString(), ids.author);

  const nestedReplyResponse = await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({
      text: "A reply to that reply",
      parentCommentId: root._id.toHexString(),
      replyToCommentId: replyId,
    })
    .expect(201);
  const nestedReplyId = nestedReplyResponse.body.comment.id as string;
  assert.equal(nestedReplyResponse.body.comment.parentCommentId, root._id.toHexString());
  assert.equal(nestedReplyResponse.body.comment.replyToCommentId, replyId);
  assert.equal(data.notifications[1]!.recipientId.toHexString(), ids.outsider, "replying to a reply notifies its author");

  const listed = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(listed.body.items.length, 1);
  assert.deepEqual(listed.body.items[0].replies.map((reply: { id: string }) => reply.id), [replyId, nestedReplyId]);
  assert.equal(listed.body.items[0].replies[0].replyCount, 1);
  assert.equal(listed.body.items[0].replies[1].replyToCommentId, replyId);
  assert.equal(listed.body.items[0].replyCount, 2);
  assert.equal(listed.body.items[0].isReactedByViewer, false);

  const secondReplyResponse = await request(app)
    .post(commentsPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "A second reply", parentCommentId: root._id.toHexString() })
    .expect(201);
  const secondReplyId = secondReplyResponse.body.comment.id as string;
  const afterSecondReply = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(afterSecondReply.body.items[0].replyCount, 3);

  const replyPath = `${commentsPath}/${replyId}`;
  const editedReply = await request(app)
    .patch(replyPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .send({ text: "Updated reply" })
    .expect(200);
  assert.equal(editedReply.body.comment.replyCount, 1);

  const liked = await request(app)
    .post(`${replyPath}/reaction`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(liked.body, { reactionCount: 1, isReactedByViewer: true });
  await request(app)
    .post(`${replyPath}/reaction`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.equal(data.commentReactions.length, 1, "reacting twice does not add a duplicate");

  const unliked = await request(app)
    .delete(`${replyPath}/reaction`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(unliked.body, { reactionCount: 0, isReactedByViewer: false });

  await request(app)
    .delete(`${commentsPath}/${secondReplyId}`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.friend))
    .expect(204);
  const afterReplyDelete = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(afterReplyDelete.body.items[0].replyCount, 2);

  await request(app)
    .delete(replyPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.outsider))
    .expect(204);
  const afterReplyTargetDelete = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.equal(afterReplyTargetDelete.body.items[0].replyCount, 1);
  assert.equal(afterReplyTargetDelete.body.items[0].replies[0].id, nestedReplyId);
  assert.equal(afterReplyTargetDelete.body.items[0].replies[0].replyToCommentId, undefined);

  const editedRoot = await request(app)
    .patch(rootPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .send({ text: "Updated starting comment" })
    .expect(200);
  assert.equal(editedRoot.body.comment.replyCount, 1);

  await request(app)
    .post(`${commentsPath}/${nestedReplyId}/reaction`)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(200);
  assert.equal(data.commentReactions.length, 1);

  await request(app)
    .delete(rootPath)
    .set("Origin", origin)
    .set("Cookie", cookie(tokens.author))
    .expect(204);
  assert.equal(data.comments.some((comment) => comment._id.equals(root._id)), false);
  assert.equal(data.comments.some((comment) => comment._id.toHexString() === replyId), false);
  assert.equal(data.comments.some((comment) => comment._id.toHexString() === nestedReplyId), false);
  assert.equal(data.commentReactions.length, 0);
  const afterParentDelete = await request(app)
    .get(commentsPath)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);
  assert.equal(afterParentDelete.body.items.length, 0, "all replies in the deleted thread are permanently removed");
});

test("comment routes require a session and reject malformed post IDs, cursors, and page limits", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  await request(app).get(`/api/posts/${ids.public}/comments`).expect(401);
  await request(app)
    .post(`/api/posts/${ids.public}/comments`)
    .set("Origin", "http://localhost:5173")
    .send({ text: "Sign in first" })
    .expect(401);
  await request(app)
    .get("/api/posts/not-an-object-id/comments")
    .set("Cookie", cookie(tokens.author))
    .expect(404);
  await request(app)
    .get(`/api/posts/${ids.public}/comments?limit=51`)
    .set("Cookie", cookie(tokens.author))
    .expect(400);
  await request(app)
    .get(`/api/posts/${ids.public}/comments?cursor=YWJj`)
    .set("Cookie", cookie(tokens.author))
    .expect(400);
});

test("moderated posts and comments disappear from every regular read path", async () => {
  const { data, tokens } = matrixFixture();
  const post = data.posts.find((item) => item._id.equals(new ObjectId(ids.public)))!;
  post.photoAssetId = "senderi/posts/test-photo";
  post.hiddenAt = new Date();
  data.shares.push(makeShare("0000000000000000000000ef", data.users[1]!._id, post._id, "public", new Date()));
  const hiddenComment: CommentDocument = { _id: new ObjectId(), postId: data.posts[1]!._id, authorId: data.users[1]!._id, text: "Moderated", createdAt: new Date(), hiddenAt: new Date() };
  data.comments.push(hiddenComment);
  const app = createApp(data);
  const auth = cookie(tokens.author);
  const feed = await request(app).get("/api/posts").set("Cookie", auth).expect(200);
  assert.equal(feed.body.items.some((item: { id: string; share?: { id: string } }) => item.id === ids.public || item.share?.id === "0000000000000000000000ef"), false);
  const timeline = await request(app).get(`/api/users/${ids.author}/posts`).set("Cookie", auth).expect(200);
  assert.equal(timeline.body.items.some((item: { id: string }) => item.id === ids.public), false);
  const search = await request(app).get("/api/posts/search?query=public").set("Cookie", auth).expect(200);
  assert.equal(search.body.items.length, 0);
  const photos = await request(app).get(`/api/users/${ids.author}/photos`).set("Cookie", auth).expect(200);
  assert.equal(photos.body.items.length, 0);
  await request(app).get(`/api/posts/${ids.public}`).set("Cookie", auth).expect(404);
  await request(app).get(`/api/posts/${ids.public}/photo`).set("Cookie", auth).expect(404);
  const comments = await request(app).get(`/api/posts/${ids.friends}/comments`).set("Cookie", auth).expect(200);
  assert.equal(comments.body.items.length, 0);
  delete post.hiddenAt;
  delete hiddenComment.hiddenAt;
  assert.equal((await request(app).get(`/api/posts/${ids.public}`).set("Cookie", auth)).status, 200);
  assert.equal((await request(app).get(`/api/posts/${ids.friends}/comments`).set("Cookie", auth)).body.items.length, 1);
});
