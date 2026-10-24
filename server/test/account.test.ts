import assert from "node:assert/strict";
import { ObjectId, type Db } from "mongodb";
import express from "express";
import { test } from "node:test";
import request from "supertest";
import { SESSION_COOKIE_NAME, hashSessionToken } from "../src/auth/session";
import { collectionNames, type SessionDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { createAccountRouter, type AccountRouterDependencies } from "../src/routes/account";

const userId = new ObjectId("64b000000000000000000001");
const sessionId = new ObjectId("64b000000000000000000002");
const now = new Date("2026-10-24T00:00:00.000Z");

function setup(options: { passwordMatches?: boolean; postPhotoId?: string } = {}) {
  const user: UserDocument = {
    _id: userId,
    email: "member@example.com",
    passwordHash: "test-password-hash",
    displayName: "Senderi Member",
    bio: "",
    info: {},
    ...(options.postPhotoId ? { avatarId: "profile-avatar", coverId: "profile-cover" } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const session: SessionDocument = {
    _id: sessionId,
    userId,
    tokenHash: hashSessionToken("account-test-session"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  const deletedCollections: string[] = [];
  const destroyedAssets: string[] = [];
  const disconnected: ObjectId[] = [];
  let userDeleted = false;
  let mediaFailure = false;

  const database = {
    collection: (name: string) => ({
      findOne: async (filter: { tokenHash?: string; _id?: ObjectId }) => {
        if (name === collectionNames.sessions && filter.tokenHash === session.tokenHash) return session;
        if (name === collectionNames.users && filter._id?.equals(userId)) return user;
        return null;
      },
      find: () => ({
        project: () => ({
          toArray: async () => name === collectionNames.posts && options.postPhotoId
            ? [{ _id: new ObjectId("64b000000000000000000003"), photoAssetId: options.postPhotoId }]
            : [],
        }),
        toArray: async () => name === collectionNames.posts && options.postPhotoId
          ? [{ _id: new ObjectId("64b000000000000000000003"), photoAssetId: options.postPhotoId }]
          : [],
      }),
      updateOne: async (_filter: unknown, update: { $set?: Partial<UserDocument>; $unset?: Record<string, string> }) => {
        if (name === collectionNames.users && update.$set) Object.assign(user, update.$set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      },
      updateMany: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }),
      findOneAndUpdate: async () => user,
      deleteMany: async () => { deletedCollections.push(name); return { acknowledged: true, deletedCount: 1 }; },
      deleteOne: async () => { userDeleted = true; return { acknowledged: true, deletedCount: 1 }; },
    }),
  } as unknown as Db;

  const dependencies: Partial<AccountRouterDependencies> = {
    getDatabase: () => database,
    verifyPassword: async (password) => password === "current password" && options.passwordMatches !== false,
    hashPassword: async (password) => `hashed:${password}`,
    profileImageStorage: {
      upload: async () => ({ assetId: "unused" }),
      destroy: async (assetId) => { destroyedAssets.push(assetId); },
    },
    postPhotoStorage: {
      upload: async () => ({ assetId: "unused" }),
      destroy: async (assetId) => {
        destroyedAssets.push(assetId);
        if (mediaFailure) throw new Error("Cloudinary unavailable");
      },
      download: async () => { throw new Error("unused"); },
    },
    disconnectUserSockets: (id) => disconnected.push(id),
    now: () => now,
    getAllowedOrigins: () => ["http://localhost:5173"],
  };
  const app = express();
  app.use(express.json());
  app.use("/api/account", createAccountRouter(dependencies));
  app.use(errorHandler);

  return {
    app,
    user,
    deletedCollections,
    destroyedAssets,
    disconnected,
    setMediaFailure: (value: boolean) => { mediaFailure = value; },
    wasUserDeleted: () => userDeleted,
  };
}

function accountRequest(app: express.Express, method: "post" | "delete", path: string) {
  return request(app)[method](path)
    .set("Origin", "http://localhost:5173")
    .set("Cookie", `${SESSION_COOKIE_NAME}=account-test-session`);
}

test("deactivation verifies the password, revokes sessions, and clears its session cookie", async () => {
  const test = setup();
  const response = await accountRequest(test.app, "post", "/api/account/deactivate")
    .send({ currentPassword: "current password" });

  assert.equal(response.status, 204);
  assert.ok(test.user.deactivatedAt);
  assert.ok(test.deletedCollections.includes(collectionNames.sessions));
  assert.ok(test.deletedCollections.includes(collectionNames.pushSubscriptions));
  assert.equal(test.disconnected.length, 1);
  assert.match(response.headers["set-cookie"]?.[0] ?? "", /Max-Age=0/);
});

test("account deletion requires the correct password before touching media or records", async () => {
  const test = setup({ passwordMatches: false, postPhotoId: "post-photo" });
  const response = await accountRequest(test.app, "delete", "/api/account/me")
    .send({ currentPassword: "wrong password", confirmation: "DELETE" });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "invalid_password");
  assert.deepEqual(test.destroyedAssets, []);
  assert.deepEqual(test.deletedCollections, []);
  assert.equal(test.wasUserDeleted(), false);
});

test("permanent deletion removes stored profile and post images before removing account records", async () => {
  const test = setup({ postPhotoId: "post-photo" });
  const response = await accountRequest(test.app, "delete", "/api/account/me")
    .send({ currentPassword: "current password", confirmation: "DELETE" });

  assert.equal(response.status, 204);
  assert.deepEqual(test.destroyedAssets.sort(), ["post-photo", "profile-avatar", "profile-cover"]);
  assert.ok(test.deletedCollections.includes(collectionNames.messages));
  assert.ok(test.deletedCollections.includes(collectionNames.posts));
  assert.equal(test.wasUserDeleted(), true);
  assert.equal(test.disconnected.length, 1);
  assert.match(response.headers["set-cookie"]?.[0] ?? "", /Max-Age=0/);
});

test("failed hosted-image deletion leaves the account records in place for retry", async () => {
  const test = setup({ postPhotoId: "post-photo" });
  test.setMediaFailure(true);
  const response = await accountRequest(test.app, "delete", "/api/account/me")
    .send({ currentPassword: "current password", confirmation: "DELETE" });

  assert.equal(response.status, 500);
  assert.equal(test.wasUserDeleted(), false);
  assert.deepEqual(test.deletedCollections, []);
});
