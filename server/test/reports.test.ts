import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type AdminAuditDocument, type CommentDocument, type MessageDocument, type NotificationDocument, type PostDocument, type ReportDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { createAdminRouter } from "../src/routes/admin";
import { createReportsRouter } from "../src/routes/reports";

test("users can report visible posts, comments, and received messages, but not their own/private content or duplicate reports", async () => {
  const reporter: UserDocument = { _id: new ObjectId(), email: "reporter@example.com", passwordHash: "hash", displayName: "Reporter", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const author: UserDocument = { _id: new ObjectId(), email: "author@example.com", passwordHash: "hash", displayName: "Author", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const sessionToken = "report-session-token";
  const session = { _id: new ObjectId(), userId: reporter._id, tokenHash: hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 60_000) };
  const publicPost: PostDocument = { _id: new ObjectId(), authorId: author._id, text: "Suspicious link", visibility: "public", createdAt: new Date(), updatedAt: new Date() };
  const privatePost: PostDocument = { _id: new ObjectId(), authorId: author._id, text: "Private note", visibility: "onlyMe", createdAt: new Date(), updatedAt: new Date() };
  const ownPost: PostDocument = { _id: new ObjectId(), authorId: reporter._id, text: "My own post", visibility: "public", createdAt: new Date(), updatedAt: new Date() };
  const comment: CommentDocument = { _id: new ObjectId(), postId: publicPost._id, authorId: author._id, text: "Rude comment", createdAt: new Date() };
  const message: MessageDocument = { _id: new ObjectId(), senderId: author._id, recipientId: reporter._id, clientId: "message-1", text: "Harassing message", createdAt: new Date() };
  const posts = [publicPost, privatePost, ownPost];
  const storedReports: ReportDocument[] = [];
  const db = { collection: (name: string) => {
    if (name === collectionNames.users) return { findOne: async ({ _id }: { _id: ObjectId }) => [reporter, author].find((user) => user._id.equals(_id)) ?? null };
    if (name === collectionNames.sessions) return { findOne: async ({ tokenHash }: { tokenHash: string }) => tokenHash === session.tokenHash ? session : null };
    if (name === collectionNames.posts) return { findOne: async ({ _id }: { _id: ObjectId }) => posts.find((post) => post._id.equals(_id)) ?? null };
    if (name === collectionNames.comments) return { findOne: async ({ _id }: { _id: ObjectId }) => _id.equals(comment._id) ? comment : null };
    if (name === collectionNames.messages) return { findOne: async ({ _id }: { _id: ObjectId }) => _id.equals(message._id) ? message : null };
    if (name === collectionNames.friendships) return { findOne: async () => ({ _id: new ObjectId() }) };
    if (name === collectionNames.reports) return {
      find: ({ reporterId }: { reporterId: ObjectId }) => {
        let found = storedReports.filter((report) => report.reporterId.equals(reporterId));
        const cursor = {
          sort() { found = found.toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime()); return cursor; },
          limit() { return cursor; },
          toArray: async () => found,
        };
        return cursor;
      },
      insertOne: async (report: ReportDocument) => {
        if (report.status === "open" && storedReports.some((stored) =>
          stored.status === "open" && stored.reporterId.equals(report.reporterId) &&
          stored.targetType === report.targetType && stored.targetId.equals(report.targetId),
        )) {
          throw Object.assign(new Error("Duplicate report"), { code: 11000 });
        }
        storedReports.push(report);
        return { insertedId: report._id };
      },
    };
    throw new Error(`Unexpected collection ${name}`);
  } } as unknown as Db;
  const app = express();
  app.use(express.json());
  app.use("/api/reports", createReportsRouter({ getDatabase: () => db, getAllowedOrigins: () => ["http://localhost:5173"], now: () => new Date("2026-10-24T00:00:00.000Z") }));
  app.use(errorHandler);
  const submit = (targetType: "post" | "comment" | "message", targetId: ObjectId, token = sessionToken) => request(app).post("/api/reports")
    .set("Origin", "http://localhost:5173")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
    .send({ targetType, targetId: targetId.toHexString(), reason: "spam", details: "Repeated suspicious link" });

  assert.equal((await request(app).post("/api/reports").send({})).status, 403);
  assert.equal((await submit("post", publicPost._id, "invalid-token")).status, 401);
  const privateList = await request(app).get("/api/reports").set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
  assert.equal(privateList.status, 200);
  assert.deepEqual(privateList.body.items, []);
  const created = await submit("post", publicPost._id);
  assert.equal(created.status, 201);
  assert.equal(storedReports.length, 1);
  assert.equal(storedReports[0]?.targetOwnerId.toHexString(), author._id.toHexString());
  assert.equal(storedReports[0]?.targetExcerpt, "Suspicious link");
  assert.equal(storedReports[0]?.purgeAt?.toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal((await submit("post", publicPost._id)).status, 409);
  storedReports[0]!.status = "resolved";
  storedReports[0]!.actionTaken = false;
  storedReports[0]!.reviewedAt = new Date("2026-10-24T12:00:00.000Z");
  storedReports[0]!.purgeAt = new Date("2026-10-31T12:00:00.000Z");
  const repeatedReport = await submit("post", publicPost._id);
  assert.equal(repeatedReport.status, 201);
  assert.notEqual(repeatedReport.body.reportId, storedReports[0]?._id.toHexString());
  assert.equal(storedReports[1]?.status, "open");
  assert.equal((await submit("comment", comment._id)).status, 201);
  assert.equal((await submit("message", message._id)).status, 201);
  assert.equal((await submit("post", privatePost._id)).status, 404);
  assert.equal((await submit("post", ownPost._id)).status, 400);
  assert.equal(storedReports.length, 4);
  const myReports = await request(app).get("/api/reports").set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
  assert.equal(myReports.body.items.length, 4);
  assert.equal(myReports.body.items.find((item: { id: string }) => item.id === storedReports[0]?._id.toHexString())?.status, "resolved");
  assert.equal(myReports.body.items.find((item: { id: string }) => item.id === repeatedReport.body.reportId)?.status, "open");
});

test("admins can review reports and close them with an audited reason", async () => {
  const previousAdmins = process.env.ADMIN_USER_IDS;
  const previousOrigins = process.env.CLIENT_ORIGINS;
  const admin: UserDocument = { _id: new ObjectId(), email: "admin@example.com", passwordHash: "hash", displayName: "Moderator", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const reporter: UserDocument = { _id: new ObjectId(), email: "reporter@example.com", passwordHash: "hash", displayName: "Reporter", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const sessionToken = "moderator-report-session";
  const session = { _id: new ObjectId(), userId: admin._id, tokenHash: hashSessionToken(sessionToken), expiresAt: new Date(Date.now() + 60_000) };
  const author: UserDocument = { _id: new ObjectId(), email: "author@example.com", passwordHash: "hash", displayName: "Author", bio: "", info: {}, createdAt: new Date(), updatedAt: new Date() };
  const comment: CommentDocument = { _id: new ObjectId(), postId: new ObjectId(), authorId: author._id, text: "An abusive comment", createdAt: new Date() };
  const message: MessageDocument = { _id: new ObjectId(), senderId: author._id, recipientId: reporter._id, clientId: "reported-message", text: "Harassing message", createdAt: new Date() };
  const report: ReportDocument = {
    _id: new ObjectId(), reporterId: reporter._id, targetType: "comment", targetId: comment._id, targetOwnerId: author._id,
    reason: "harassment", details: "Repeated personal attacks", targetExcerpt: "An abusive comment", hasPhoto: false,
    createdAt: new Date("2026-10-23T12:00:00.000Z"), status: "open", purgeAt: new Date("2026-10-30T12:00:00.000Z"),
  };
  const audit: AdminAuditDocument[] = [];
  const notifications: NotificationDocument[] = [];
  const db = { collection: (name: string) => {
    if (name === collectionNames.users) return {
      findOne: async ({ _id }: { _id: ObjectId }) => [admin, reporter, author].find((user) => _id.equals(user._id)) ?? null,
      find: ({ _id }: { _id: { $in: ObjectId[] } }) => ({ toArray: async () => [admin, reporter, author].filter((user) => _id.$in.some((id) => id.equals(user._id))) }),
    };
    if (name === collectionNames.sessions) return { findOne: async ({ tokenHash }: { tokenHash: string }) => tokenHash === session.tokenHash ? session : null };
    if (name === collectionNames.reports) return {
      findOne: async (filter: { status?: string; actionTaken?: boolean }) =>
        report.status === filter.status && (filter.actionTaken === undefined || report.actionTaken === filter.actionTaken) ? report : null,
      find: (filter: { status?: string }) => ({
        sort() { return this; }, skip() { return this; }, limit() { return this; },
        toArray: async () => filter.status && filter.status !== "all" && filter.status !== report.status ? [] : [report],
      }),
      findOneAndUpdate: async (filter: { status?: string; actionTaken?: boolean }, update: { $set: Partial<ReportDocument> }) => {
        if (filter.status !== report.status || (filter.actionTaken !== undefined && report.actionTaken !== filter.actionTaken)) return null;
        Object.assign(report, update.$set);
        return report;
      },
    };
    if (name === collectionNames.comments) return {
      updateOne: async (_filter: unknown, update: { $set?: Partial<CommentDocument>; $unset?: Record<string, unknown> }) => {
        Object.assign(comment, update.$set);
        if (update.$unset) { delete comment.hiddenAt; delete comment.hiddenBy; delete comment.hiddenReason; }
        return { matchedCount: 1 };
      },
    };
    if (name === collectionNames.messages) return {
      findOne: async ({ _id }: { _id: ObjectId }) => _id.equals(message._id) ? message : null,
      updateOne: async (_filter: unknown, update: { $set?: Partial<MessageDocument>; $unset?: Record<string, unknown> }) => {
        Object.assign(message, update.$set);
        if (update.$unset) { delete message.moderationHiddenAt; delete message.moderationHiddenBy; delete message.moderationHiddenReason; }
        return { matchedCount: 1 };
      },
    };
    if (name === collectionNames.notifications) return { insertOne: async (notification: NotificationDocument) => { notifications.push(notification); } };
    if (name === collectionNames.adminAudit) return { insertOne: async (event: AdminAuditDocument) => { audit.push(event); } };
    throw new Error(`Unexpected collection ${name}`);
  } } as unknown as Db;
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({ getDatabase: () => db }));
  app.use(errorHandler);
  const realtimeEvents: Array<{ room: string; event: string }> = [];
  app.set("realtimeServer", {
    to: (room: string) => ({ emit: (event: string) => { realtimeEvents.push({ room, event }); } }),
  });
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;

  try {
    process.env.ADMIN_USER_IDS = admin._id.toHexString();
    process.env.CLIENT_ORIGINS = "http://localhost:5173";
    const list = await request(app).get("/api/admin/reports?status=open").set("Cookie", cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0]?.targetExcerpt, "An abusive comment");
    assert.equal(list.body.items[0]?.reporter, "Reporter");
    assert.equal(list.body.items[0]?.purgeAt, "2026-10-30T12:00:00.000Z");
    const review = await request(app).patch(`/api/admin/reports/${report._id}/status`).set("Cookie", cookie).set("Origin", "http://localhost:5173").send({ status: "resolved", contentAction: "hide", reason: "Reviewed against community rules" });
    assert.equal(review.status, 200);
    assert.equal(report.status, "resolved");
    assert.equal(report.actionTaken, true);
    assert.equal(report.purgeAt?.getTime(), (report.reviewedAt?.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1_000);
    assert.ok(comment.hiddenAt);
    assert.equal(report.reviewReason, "Reviewed against community rules");
    assert.equal(audit[0]?.action, "report_content_hidden");
    assert.equal(audit[0]?.reason, "Reviewed against community rules");
    assert.equal(notifications[0]?.type, "report_update");
    assert.equal(notifications[0]?.reportActionTaken, true);
    assert.equal(notifications[0]?.recipientId.toHexString(), reporter._id.toHexString());
    assert.equal(notifications[1]?.type, "content_moderated");
    assert.equal(notifications[1]?.recipientId.toHexString(), author._id.toHexString());
    assert.equal(notifications[1]?.moderatedContentType, "comment");

    const previousPurgeAt = report.purgeAt?.getTime() ?? 0;
    const restored = await request(app).patch(`/api/admin/reports/${report._id}/status`).set("Cookie", cookie).set("Origin", "http://localhost:5173").send({ status: "resolved", contentAction: "restore", reason: "Restored after moderator review" });
    assert.equal(restored.status, 200);
    assert.equal(report.actionTaken, false);
    assert.ok((report.purgeAt?.getTime() ?? 0) > previousPurgeAt);
    assert.equal(comment.hiddenAt, undefined);
    assert.equal(audit[1]?.action, "report_content_restored");
    assert.equal(notifications[2]?.type, "report_update");

    report.status = "open";
    delete report.reviewedAt;
    delete report.purgeAt;
    report.targetType = "message";
    report.targetId = message._id;
    report.targetOwnerId = author._id;
    const hiddenMessage = await request(app).patch(`/api/admin/reports/${report._id}/status`).set("Cookie", cookie).set("Origin", "http://localhost:5173").send({ status: "resolved", contentAction: "hide", reason: "Message violates the safety rules" });
    assert.equal(hiddenMessage.status, 200);
    assert.ok(message.moderationHiddenAt);
    assert.deepEqual(realtimeEvents.slice(-2).map((item) => item.event), ["message:deleted", "message:deleted"]);
    assert.equal(report.actionTaken, true);
    assert.equal(notifications[4]?.type, "content_moderated");
    assert.equal(notifications[4]?.recipientId.toHexString(), author._id.toHexString());
    assert.equal(notifications[4]?.moderatedContentType, "message");

    const restoredMessage = await request(app).patch(`/api/admin/reports/${report._id}/status`).set("Cookie", cookie).set("Origin", "http://localhost:5173").send({ status: "resolved", contentAction: "restore", reason: "Restored after appeal review" });
    assert.equal(restoredMessage.status, 200);
    assert.equal(message.moderationHiddenAt, undefined);
    assert.deepEqual(realtimeEvents.slice(-2).map((item) => item.event), ["message:updated", "message:updated"]);
  } finally {
    if (previousAdmins === undefined) delete process.env.ADMIN_USER_IDS; else process.env.ADMIN_USER_IDS = previousAdmins;
    if (previousOrigins === undefined) delete process.env.CLIENT_ORIGINS; else process.env.CLIENT_ORIGINS = previousOrigins;
  }
});
