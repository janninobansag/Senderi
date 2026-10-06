import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { MongoClient, ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type SessionDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { createUsersRouter } from "../src/routes/users";

const mongoTestUri = process.env.MONGODB_TEST_URI?.trim();
const testDatabaseName = "senderi_m2_l3_test";
const clientOrigin = "http://localhost:5173";
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function createApp(database: Db) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/users",
    createUsersRouter({
      getDatabase: () => database,
      getAllowedOrigins: () => [clientOrigin],
      getCloudinaryCloudName: () => "senderi-test",
      now: () => new Date(),
      imageStorage: {
        upload: async (_buffer, publicId) => ({ assetId: `senderi/profiles/${publicId}` }),
        destroy: async () => undefined,
      },
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test(
  "avatar and cover public IDs remain available after recreating the API app and MongoDB connection",
  { skip: !mongoTestUri },
  async () => {
    if (!mongoTestUri) return;

    const userId = new ObjectId();
    const sessionId = new ObjectId();
    const token = `m2-l3-${new ObjectId().toHexString()}`;
    const now = new Date();
    const user: UserDocument = {
      _id: userId,
      email: `${userId.toHexString()}@example.test`,
      passwordHash: "$argon2id$not-used-in-this-test",
      displayName: "M2 L3 Persistence Test",
      bio: "",
      info: {},
      createdAt: now,
      updatedAt: now,
    };
    const session: SessionDocument = {
      _id: sessionId,
      userId,
      tokenHash: hashSessionToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
    };
    const firstClient = new MongoClient(mongoTestUri);
    let restartedClient: MongoClient | undefined;
    let documentsInserted = false;

    try {
      await firstClient.connect();
      const firstDatabase = firstClient.db(testDatabaseName);
      await firstDatabase.collection<UserDocument>(collectionNames.users).insertOne(user);
      documentsInserted = true;
      await firstDatabase.collection<SessionDocument>(collectionNames.sessions).insertOne(session);

      const firstApp = createApp(firstDatabase);
      for (const imageKind of ["avatar", "cover"] as const) {
        const response = await request(firstApp)
          .put(`/api/users/me/${imageKind}`)
          .set("Origin", clientOrigin)
          .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
          .attach("file", validPng, `${imageKind}.png`);

        assert.equal(response.status, 200, response.text);
        assert.equal(typeof response.body.user[`${imageKind}Id`], "string");
      }

      await firstClient.close();

      restartedClient = new MongoClient(mongoTestUri);
      await restartedClient.connect();
      const restartedApp = createApp(restartedClient.db(testDatabaseName));
      const profile = await request(restartedApp)
        .get(`/api/users/${userId.toHexString()}`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);

      assert.equal(profile.status, 200, profile.text);
      assert.match(profile.body.user.avatarId, new RegExp(`^senderi/profiles/${userId.toHexString()}-avatar-[0-9a-f-]{36}$`));
      assert.match(profile.body.user.coverId, new RegExp(`^senderi/profiles/${userId.toHexString()}-cover-[0-9a-f-]{36}$`));
      assert.match(profile.body.user.avatarUrl, /senderi\/profiles\//);
      assert.match(profile.body.user.coverUrl, /senderi\/profiles\//);
    } finally {
      if (documentsInserted) {
        const cleanupClient = new MongoClient(mongoTestUri);
        try {
          await cleanupClient.connect();
          const cleanupDatabase = cleanupClient.db(testDatabaseName);
          await cleanupDatabase.collection<UserDocument>(collectionNames.users).deleteOne({ _id: userId });
          await cleanupDatabase.collection<SessionDocument>(collectionNames.sessions).deleteOne({ _id: sessionId });
        } finally {
          await cleanupClient.close();
        }
      }

      await Promise.all([
        firstClient.close(),
        ...(restartedClient ? [restartedClient.close()] : []),
      ]);
    }
  },
);
