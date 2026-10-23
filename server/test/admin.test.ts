import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { isAdminId } from "../src/auth/admin";
import { toAuthUserResponse, toPublicUserResponse } from "../src/auth/user-response";
import { collectionNames, type AdminAuditDocument, type CommentDocument, type PostDocument, type UserDocument } from "../src/db/documents";
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
