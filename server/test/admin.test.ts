import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { isAdminId } from "../src/auth/admin";
import { toAuthUserResponse, toPublicUserResponse } from "../src/auth/user-response";
import { collectionNames, type AdminAuditDocument, type CommentDocument, type CommentReactionDocument, type PostDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { canViewPost } from "../src/post-access";
import { createAdminRouter } from "../src/routes/admin";

test("admin actions require an allowlisted session, audit changes, and revoke suspended sessions", async () => {
  const previousIds = process.env.ADMIN_USER_IDS;
  const previousOrigins = process.env.CLIENT_ORIGINS;
  const makeUser = (name: string): UserDocument => ({ _id: new ObjectId(), email: `${name}@example.com`, passwordHash: "hash", displayName: name, bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() });
  const admin = makeUser("admin");
  const member = makeUser("member");
  const users = [admin, member];
  const sessions = [admin, member].map((user) => ({ _id: new ObjectId(), userId: user._id, tokenHash: hashSessionToken(user === admin ? "admin-token" : "member-token"), expiresAt: new Date(Date.now() + 60_000) }));
  const tickets = [{ userId: member._id }];
  const post: PostDocument = { _id: new ObjectId(), authorId: member._id, text: "Private post", visibility: "onlyMe", createdAt: new Date(), updatedAt: new Date() };
  const comment: CommentDocument = { _id: new ObjectId(), postId: post._id, authorId: member._id, text: "Private comment", createdAt: new Date() };
  const audit: AdminAuditDocument[] = [];
  const db = { collection: (name: string) => {
    if (name === collectionNames.users) return {
      findOne: async ({ _id }: { _id: ObjectId }) => users.find((user) => user._id.equals(_id)) ?? null,
      findOneAndUpdate: async ({ _id }: { _id: ObjectId }, change: { $set?: Partial<UserDocument>; $unset?: Record<string, unknown> }) => {
        const user = users.find((item) => item._id.equals(_id));
        if (!user) return null;
        Object.assign(user, change.$set);
        if (change.$unset) delete user.suspendedAt;
        return user;
      },
    };
    if (name === collectionNames.sessions) return {
      findOne: async ({ tokenHash }: { tokenHash: string }) => sessions.find((item) => item.tokenHash === tokenHash) ?? null,
      deleteMany: async ({ userId }: { userId: ObjectId }) => { for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i]!.userId.equals(userId)) sessions.splice(i, 1); },
    };
    if (name === collectionNames.socketTickets) return { deleteMany: async ({ userId }: { userId: ObjectId }) => { for (let i = tickets.length - 1; i >= 0; i--) if (tickets[i]!.userId.equals(userId)) tickets.splice(i, 1); } };
    if (name === collectionNames.adminAudit) return { insertOne: async (event: AdminAuditDocument) => { audit.push(event); } };
    if (name === collectionNames.posts) return { updateOne: async (_filter: unknown, change: { $set?: Partial<PostDocument>; $unset?: Record<string, unknown> }) => { Object.assign(post, change.$set); if (change.$unset) { delete post.hiddenAt; delete post.hiddenBy; delete post.hiddenReason; } return { matchedCount: 1 }; } };
    if (name === collectionNames.comments) return { updateOne: async (_filter: unknown, change: { $set?: Partial<CommentDocument>; $unset?: Record<string, unknown> }) => { Object.assign(comment, change.$set); if (change.$unset) { delete comment.hiddenAt; delete comment.hiddenBy; delete comment.hiddenReason; } return { matchedCount: 1 }; } };
    throw new Error(`Unexpected collection ${name}`);
  } } as unknown as Db;
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ getDatabase: () => db }));
  app.use(errorHandler);
  const cookie = (token: string) => `${SESSION_COOKIE_NAME}=${token}`;
  const action = (path: string, token: string, body: object) => request(app).patch(path).set("Cookie", cookie(token)).set("Origin", "http://localhost:5173").send(body);

  try {
    process.env.CLIENT_ORIGINS = "http://localhost:5173";
    process.env.ADMIN_USER_IDS = `${admin._id},invalid`;
    assert.equal(isAdminId(admin._id), false);
    process.env.ADMIN_USER_IDS = admin._id.toHexString();
    assert.equal(toAuthUserResponse(admin).isAdmin, true);
    assert.equal(toAuthUserResponse(member).isAdmin, false);
    const badgePath = `/api/admin/users/${member._id}/badge`;
    assert.equal((await action(badgePath, "member-token", { enabled: true, reason: "Supporter" })).status, 403);
    assert.equal((await action(badgePath, "admin-token", { enabled: true, reason: "Community supporter" })).status, 200);
    assert.equal(toPublicUserResponse(member).supporterBadge, true);
    assert.equal(audit[0]?.actorId.toHexString(), admin._id.toHexString());
    assert.equal(audit[0]?.reason, "Community supporter");
    assert.equal((await action(`/api/admin/users/${member._id}/suspension`, "admin-token", { enabled: true, reason: "Repeated abuse" })).status, 200);
    assert.equal(sessions.length, 1);
    assert.equal(tickets.length, 0);
    assert.equal((await action(badgePath, "member-token", { enabled: false, reason: "Check" })).status, 401);
    const visibilityPath = `/api/admin/posts/${post._id}/visibility`;
    assert.equal((await action(visibilityPath, "admin-token", { hidden: true, reason: "Rule violation" })).status, 200);
    assert.equal(await canViewPost(db, member._id, post), false);
    assert.equal((await action(visibilityPath, "admin-token", { hidden: false, reason: "Appeal accepted" })).status, 200);
    assert.equal(await canViewPost(db, member._id, post), true);
    const commentPath = `/api/admin/comments/${comment._id}/visibility`;
    assert.equal((await action(commentPath, "admin-token", { hidden: true, reason: "Rule violation" })).status, 200);
    assert.ok(comment.hiddenAt);
    assert.equal((await action(commentPath, "admin-token", { hidden: false, reason: "Appeal accepted" })).status, 200);
    assert.equal(comment.hiddenAt, undefined);
    assert.deepEqual(audit.map((event) => event.action), ["badge_granted", "user_suspended", "posts_hidden", "posts_restored", "comments_hidden", "comments_restored"]);
  } finally {
    if (previousIds === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = previousIds;
    if (previousOrigins === undefined) delete process.env.CLIENT_ORIGINS; else process.env.CLIENT_ORIGINS = previousOrigins;
  }
});

test("admin can permanently delete comments and clean up their thread data", async () => {
  const previousIds = process.env.ADMIN_USER_IDS;
  const previousOrigins = process.env.CLIENT_ORIGINS;
  const admin: UserDocument = { _id: new ObjectId(), email: "admin@example.com", passwordHash: "hash", displayName: "Admin", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const rootId = new ObjectId();
  const replyId = new ObjectId();
  const replyToDeleteId = new ObjectId();
  const replyThatReferencesId = new ObjectId();
  const unrelatedId = new ObjectId();
  const postId = new ObjectId();
  const root: CommentDocument = { _id: rootId, postId, authorId: admin._id, text: "Root comment", createdAt: new Date() };
  const reply: CommentDocument = { _id: replyId, postId, authorId: admin._id, text: "Reply", parentCommentId: rootId, createdAt: new Date() };
  const secondRoot: CommentDocument = { _id: new ObjectId(), postId, authorId: admin._id, text: "Another root", createdAt: new Date() };
  const replyToDelete: CommentDocument = { _id: replyToDeleteId, postId, authorId: admin._id, text: "Reply to remove", parentCommentId: secondRoot._id, createdAt: new Date() };
  const replyThatReferences: CommentDocument = { _id: replyThatReferencesId, postId, authorId: admin._id, text: "Nested reply", parentCommentId: secondRoot._id, replyToCommentId: replyToDeleteId, createdAt: new Date() };
  const unrelated: CommentDocument = { _id: unrelatedId, postId, authorId: admin._id, text: "Keep me", createdAt: new Date() };
  let comments = [root, reply, secondRoot, replyToDelete, replyThatReferences, unrelated];
  const reactions: CommentReactionDocument[] = [rootId, replyId, replyToDeleteId, unrelatedId].map((commentId) => ({ _id: new ObjectId(), postId, commentId, userId: admin._id, createdAt: new Date() }));
  const sessions = [{ tokenHash: hashSessionToken("admin-delete-token"), userId: admin._id, expiresAt: new Date(Date.now() + 60_000) }];
  const audit: AdminAuditDocument[] = [];
  const db = { collection: (name: string) => {
    if (name === collectionNames.users) return { findOne: async ({ _id }: { _id: ObjectId }) => _id.equals(admin._id) ? admin : null };
    if (name === collectionNames.sessions) return { findOne: async ({ tokenHash }: { tokenHash: string }) => sessions.find((session) => session.tokenHash === tokenHash) ?? null };
    if (name === collectionNames.comments) return {
      findOne: async ({ _id }: { _id: ObjectId }) => comments.find((comment) => comment._id.equals(_id)) ?? null,
      find: ({ parentCommentId }: { parentCommentId: ObjectId }) => ({ toArray: async () => comments.filter((comment) => comment.parentCommentId?.equals(parentCommentId)) }),
      deleteMany: async ({ _id }: { _id: { $in: ObjectId[] } }) => {
        const before = comments.length;
        comments = comments.filter((comment) => !_id.$in.some((deletedId) => deletedId.equals(comment._id)));
        return { deletedCount: before - comments.length };
      },
      deleteOne: async ({ _id }: { _id: ObjectId }) => {
        const before = comments.length;
        comments = comments.filter((comment) => !comment._id.equals(_id));
        return { deletedCount: before - comments.length };
      },
      updateMany: async ({ replyToCommentId }: { replyToCommentId: ObjectId }, update: { $unset: Record<string, unknown> }) => {
        for (const comment of comments) if (comment.replyToCommentId?.equals(replyToCommentId) && Object.hasOwn(update.$unset, "replyToCommentId")) delete comment.replyToCommentId;
        return { modifiedCount: 1 };
      },
    };
    if (name === collectionNames.commentReactions) return { deleteMany: async ({ commentId }: { commentId: { $in: ObjectId[] } }) => {
      for (let index = reactions.length - 1; index >= 0; index--) if (commentId.$in.some((deletedId) => deletedId.equals(reactions[index]!.commentId))) reactions.splice(index, 1);
    } };
    if (name === collectionNames.adminAudit) return { insertOne: async (event: AdminAuditDocument) => { audit.push(event); } };
    throw new Error(`Unexpected collection ${name}`);
  } } as unknown as Db;
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ getDatabase: () => db }));
  app.use(errorHandler);
  const deleteComment = (commentId: ObjectId, reason: string) => request(app).delete(`/api/admin/comments/${commentId}`)
    .set("Cookie", `${SESSION_COOKIE_NAME}=admin-delete-token`)
    .set("Origin", "http://localhost:5173")
    .send({ reason });

  try {
    process.env.CLIENT_ORIGINS = "http://localhost:5173";
    process.env.ADMIN_USER_IDS = admin._id.toHexString();
    assert.equal((await deleteComment(rootId, "Remove abusive thread")).status, 204);
    assert.deepEqual(comments.map((comment) => comment._id.toHexString()), [
      secondRoot._id.toHexString(), replyToDeleteId.toHexString(), replyThatReferencesId.toHexString(), unrelatedId.toHexString(),
    ]);
    assert.deepEqual(reactions.map((reaction) => reaction.commentId.toHexString()), [replyToDeleteId.toHexString(), unrelatedId.toHexString()]);

    assert.equal((await deleteComment(replyToDeleteId, "Remove abusive reply")).status, 204);
    assert.equal(comments.some((comment) => comment._id.equals(replyToDeleteId)), false);
    assert.equal(replyThatReferences.replyToCommentId, undefined);
    assert.deepEqual(reactions.map((reaction) => reaction.commentId.toHexString()), [unrelatedId.toHexString()]);
    assert.deepEqual(audit.map((event) => event.action), ["comments_deleted_permanently", "comments_deleted_permanently"]);
    assert.equal(audit[0]?.reason, "Remove abusive thread");
  } finally {
    if (previousIds === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = previousIds;
    if (previousOrigins === undefined) delete process.env.CLIENT_ORIGINS; else process.env.CLIENT_ORIGINS = previousOrigins;
  }
});
