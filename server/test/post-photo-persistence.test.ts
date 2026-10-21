import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { Readable } from "node:stream";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type PostDocument, type SessionDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import type { PostPhotoStorage } from "../src/media/post-photo";
import { createPostsRouter } from "../src/routes/posts";

const mongoTestUri = process.env.MONGODB_TEST_URI?.trim();
const testDatabaseName = "senderi_m4_l3_test";
const clientOrigin = "http://localhost:5173";
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function createApp(database: Db, storage: PostPhotoStorage) {
  const app = express();
  app.use(express.json());
  app.use("/api/posts", createPostsRouter({
    getDatabase: () => database,
    getAllowedOrigins: () => [clientOrigin],
    photoStorage: storage,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test(
  "post photo asset ID remains usable after a new app and MongoDB connection are created",
  { skip: !mongoTestUri },
  async () => {
    if (!mongoTestUri) return;

    const userId = new ObjectId();
    const postId = new ObjectId();
    const sessionId = new ObjectId();
    const token = `m4-l3-${new ObjectId().toHexString()}`;
    const now = new Date();
    const user: UserDocument = {
      _id: userId,
      email: `${userId.toHexString()}@example.test`,
      passwordHash: "$argon2id$not-used-in-this-test",
      displayName: "M4 L3 Photo Persistence Test",
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
    const post: PostDocument = {
      _id: postId,
      authorId: userId,
      text: "Photo persistence check",
      visibility: "onlyMe",
      createdAt: now,
      updatedAt: now,
    };
    const firstClient = new MongoClient(mongoTestUri);
    let restartedClient: MongoClient | undefined;
    let inserted = false;
    const photoStorage: PostPhotoStorage = {
      upload: async () => ({ assetId: `senderi/posts/${postId.toHexString()}-persistent` }),
      destroy: async () => undefined,
      download: async (assetId) => {
        assert.equal(assetId, `senderi/posts/${postId.toHexString()}-persistent`);
        return { stream: Readable.from([validPng]), contentType: "image/png", contentLength: validPng.length };
      },
    };

    try {
      await firstClient.connect();
      const firstDatabase = firstClient.db(testDatabaseName);
      await firstDatabase.collection<UserDocument>(collectionNames.users).insertOne(user);
      inserted = true;
      await firstDatabase.collection<SessionDocument>(collectionNames.sessions).insertOne(session);
      await firstDatabase.collection<PostDocument>(collectionNames.posts).insertOne(post);

      const firstApp = createApp(firstDatabase, photoStorage);
      const uploaded = await request(firstApp)
        .put(`/api/posts/${postId.toHexString()}/photo`)
        .set("Origin", clientOrigin)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
        .attach("file", validPng, "photo.png")
        .expect(200);
      assert.equal(uploaded.body.post.photoUrl, `/api/posts/${postId.toHexString()}/photo`);

      await firstClient.close();

      restartedClient = new MongoClient(mongoTestUri);
      await restartedClient.connect();
      const restartedDatabase = restartedClient.db(testDatabaseName);
      const restartedPost = await restartedDatabase.collection<PostDocument>(collectionNames.posts).findOne({ _id: postId });
      assert.equal(restartedPost?.photoAssetId, `senderi/posts/${postId.toHexString()}-persistent`);

      const photoResponse = await request(createApp(restartedDatabase, photoStorage))
        .get(`/api/posts/${postId.toHexString()}/photo`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
        .expect(200);
      assert.equal(photoResponse.headers["cache-control"], "private, no-store");
      assert.deepEqual(photoResponse.body, validPng);
    } finally {
      if (inserted) {
        const cleanupClient = new MongoClient(mongoTestUri);
        try {
          await cleanupClient.connect();
          const cleanupDatabase = cleanupClient.db(testDatabaseName);
          await cleanupDatabase.collection<PostDocument>(collectionNames.posts).deleteOne({ _id: postId });
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
