import "dotenv/config";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import test from "node:test";
import express from "express";
import { MongoClient, ObjectId, type Db } from "mongodb";
import request from "supertest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { issueSocketTicket } from "../src/auth/socket-ticket";
import {
  collectionNames,
  type FriendshipDocument,
  type MessageDocument,
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { ensureDatabaseIndexes } from "../src/db/indexes";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { orderedUserPair } from "../src/friends/are-friends";
import { createChatsRouter } from "../src/routes/chats";
import type { MessageAckEvent, MessageNewEvent, MessageSendRequest } from "../src/socket/contracts";
import { createSocketServer } from "../src/socket/server";

const mongoTestUri = process.env.MONGODB_TEST_URI?.trim();
const testDatabaseName = "senderi_m6_l4_test";
const clientOrigin = "http://localhost:5173";

interface ServerEvents {
  connect: () => void;
  connect_error: (error: Error) => void;
  "message:ack": (payload: MessageAckEvent) => void;
  "message:new": (payload: MessageNewEvent) => void;
}

interface ClientEvents {
  "message:send": (payload: MessageSendRequest) => void;
}

type TestClient = ClientSocket<ServerEvents, ClientEvents>;

function makeUser(id: ObjectId, email: string, now: Date): UserDocument {
  return {
    _id: id,
    email,
    passwordHash: "$argon2id$not-used-in-this-test",
    displayName: email.split("@")[0] ?? "Persistence test user",
    bio: "",
    info: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeSession(userId: ObjectId, token: string, now: Date): SessionDocument {
  return {
    _id: new ObjectId(),
    userId,
    tokenHash: hashSessionToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
  };
}

function makeFriendship(firstId: ObjectId, secondId: ObjectId, now: Date): FriendshipDocument {
  const [userIdLow, userIdHigh] = orderedUserPair(firstId, secondId);
  return { _id: new ObjectId(), userIdLow, userIdHigh, createdAt: now };
}

function createChatsApp(database: Db, now: () => Date) {
  const app = express();
  app.use("/api/chats", createChatsRouter({ getDatabase: () => database, now }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function waitForConnect(socket: TestClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timed out.")), 5_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForAck(socket: TestClient): Promise<MessageAckEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message acknowledgement timed out.")), 5_000);
    socket.once("message:ack", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function waitForNewMessage(socket: TestClient): Promise<MessageNewEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("New-message event timed out.")), 5_000);
    socket.once("message:new", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function openClient(url: string, ticket: string): TestClient {
  return createClient<ServerEvents, ClientEvents>(url, {
    auth: { ticket },
    extraHeaders: { Origin: clientOrigin },
    transports: ["websocket"],
    reconnection: false,
    timeout: 5_000,
  });
}

function historyItems(messages: MessageDocument[], viewerId: ObjectId) {
  return messages.map((message) => ({
    id: message._id.toHexString(),
    senderId: message.senderId.toHexString(),
    recipientId: message.recipientId.toHexString(),
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    ...(message.senderId.equals(viewerId) ? { clientId: message.clientId } : {}),
  }));
}

test(
  "exchanged chat messages survive recreating the API and MongoDB connection with history matching stored records",
  { skip: !mongoTestUri },
  async () => {
    if (!mongoTestUri) return;

    const now = new Date();
    const aliceId = new ObjectId();
    const bobId = new ObjectId();
    const aliceToken = `m6-l4-${new ObjectId().toHexString()}`;
    const bobToken = `m6-l4-${new ObjectId().toHexString()}`;
    const alice = makeUser(aliceId, `${aliceId.toHexString()}@example.test`, now);
    const bob = makeUser(bobId, `${bobId.toHexString()}@example.test`, now);
    const aliceSession = makeSession(aliceId, aliceToken, now);
    const bobSession = makeSession(bobId, bobToken, now);
    const friendship = makeFriendship(aliceId, bobId, now);
    const firstMongoClient = new MongoClient(mongoTestUri);
    let restartedMongoClient: MongoClient | undefined;
    let socketServer: ReturnType<typeof createSocketServer> | undefined;
    let aliceSocket: TestClient | undefined;
    let bobSocket: TestClient | undefined;

    try {
      await firstMongoClient.connect();
      const firstDatabase = firstMongoClient.db(testDatabaseName);
      await ensureDatabaseIndexes(firstDatabase);
      await firstDatabase.collection<UserDocument>(collectionNames.users).insertMany([alice, bob]);
      await firstDatabase.collection<SessionDocument>(collectionNames.sessions).insertMany([aliceSession, bobSession]);
      await firstDatabase.collection<FriendshipDocument>(collectionNames.friendships).insertOne(friendship);

      const app = createChatsApp(firstDatabase, () => now);
      const httpServer = createServer(app);
      socketServer = createSocketServer(httpServer, {
        getDatabase: () => firstDatabase,
        now: () => now,
        getAllowedOrigins: () => [clientOrigin],
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Test chat server did not bind a TCP port.");
      const url = `http://127.0.0.1:${(address as AddressInfo).port}`;

      const aliceTicket = await issueSocketTicket(firstDatabase, aliceId, aliceSession._id, now);
      const bobTicket = await issueSocketTicket(firstDatabase, bobId, bobSession._id, now);
      aliceSocket = openClient(url, aliceTicket.ticket);
      bobSocket = openClient(url, bobTicket.ticket);
      await Promise.all([waitForConnect(aliceSocket), waitForConnect(bobSocket)]);

      const firstMessage: MessageSendRequest = {
        friendId: bobId.toHexString(),
        clientId: `alice-${new ObjectId().toHexString()}`,
        text: "Message from Alice before restart",
      };
      const firstAck = waitForAck(aliceSocket);
      const firstDelivery = waitForNewMessage(bobSocket);
      aliceSocket.emit("message:send", firstMessage);
      const [aliceAck, bobDelivery] = await Promise.all([firstAck, firstDelivery]);
      assert.equal(aliceAck.message.id, bobDelivery.message.id);

      const secondMessage: MessageSendRequest = {
        friendId: aliceId.toHexString(),
        clientId: `bob-${new ObjectId().toHexString()}`,
        text: "Reply from Bob before restart",
      };
      const secondAck = waitForAck(bobSocket);
      const secondDelivery = waitForNewMessage(aliceSocket);
      bobSocket.emit("message:send", secondMessage);
      const [bobAck, aliceDelivery] = await Promise.all([secondAck, secondDelivery]);
      assert.equal(bobAck.message.id, aliceDelivery.message.id);

      aliceSocket.disconnect();
      bobSocket.disconnect();
      aliceSocket = undefined;
      bobSocket = undefined;
      await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
      socketServer = undefined;
      await firstMongoClient.close();

      restartedMongoClient = new MongoClient(mongoTestUri);
      await restartedMongoClient.connect();
      const restartedDatabase = restartedMongoClient.db(testDatabaseName);
      const restartedApp = createChatsApp(restartedDatabase, () => new Date());
      const restartedHttpServer = createServer(restartedApp);
      socketServer = createSocketServer(restartedHttpServer, {
        getDatabase: () => restartedDatabase,
        now: () => new Date(),
        getAllowedOrigins: () => [clientOrigin],
      });
      await new Promise<void>((resolve, reject) => {
        restartedHttpServer.once("error", reject);
        restartedHttpServer.listen(0, "127.0.0.1", resolve);
      });
      const restartedAddress = restartedHttpServer.address();
      if (!restartedAddress || typeof restartedAddress === "string") {
        throw new Error("Restarted chat server did not bind a TCP port.");
      }

      const [restartedAliceTicket, restartedBobTicket] = await Promise.all([
        issueSocketTicket(restartedDatabase, aliceId, aliceSession._id, new Date()),
        issueSocketTicket(restartedDatabase, bobId, bobSession._id, new Date()),
      ]);
      aliceSocket = openClient(`http://127.0.0.1:${(restartedAddress as AddressInfo).port}`, restartedAliceTicket.ticket);
      bobSocket = openClient(`http://127.0.0.1:${(restartedAddress as AddressInfo).port}`, restartedBobTicket.ticket);
      await Promise.all([waitForConnect(aliceSocket), waitForConnect(bobSocket)]);

      const afterRestartMessage: MessageSendRequest = {
        friendId: bobId.toHexString(),
        clientId: `alice-after-restart-${new ObjectId().toHexString()}`,
        text: "Message after reconnecting to the restarted API",
      };
      const afterRestartAck = waitForAck(aliceSocket);
      const afterRestartDelivery = waitForNewMessage(bobSocket);
      aliceSocket.emit("message:send", afterRestartMessage);
      const [reconnectedAck, reconnectedDelivery] = await Promise.all([afterRestartAck, afterRestartDelivery]);
      assert.equal(reconnectedAck.message.id, reconnectedDelivery.message.id);

      const storedMessages = await restartedDatabase
        .collection<MessageDocument>(collectionNames.messages)
        .find({
          $or: [
            { senderId: aliceId, recipientId: bobId },
            { senderId: bobId, recipientId: aliceId },
          ],
        })
        .sort({ createdAt: -1, _id: -1 })
        .toArray();
      assert.equal(storedMessages.length, 3);

      const aliceHistory = await request(restartedApp)
        .get(`/api/chats/${bobId.toHexString()}/messages?limit=20`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${aliceToken}`);
      const bobHistory = await request(restartedApp)
        .get(`/api/chats/${aliceId.toHexString()}/messages?limit=20`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${bobToken}`);

      assert.equal(aliceHistory.status, 200, aliceHistory.text);
      assert.equal(bobHistory.status, 200, bobHistory.text);
      assert.deepEqual(aliceHistory.body.items, historyItems(storedMessages, aliceId));
      assert.deepEqual(bobHistory.body.items, historyItems(storedMessages, bobId));
      assert.ok(aliceHistory.body.items.some((item: { text: string }) => item.text === firstMessage.text));
      assert.ok(aliceHistory.body.items.some((item: { text: string }) => item.text === secondMessage.text));
      assert.ok(aliceHistory.body.items.some((item: { text: string }) => item.text === afterRestartMessage.text));
    } finally {
      aliceSocket?.disconnect();
      bobSocket?.disconnect();
      if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()));

      const cleanupClient = new MongoClient(mongoTestUri);
      try {
        await cleanupClient.connect();
        const cleanupDatabase = cleanupClient.db(testDatabaseName);
        await Promise.all([
          cleanupDatabase.collection<UserDocument>(collectionNames.users).deleteMany({ _id: { $in: [aliceId, bobId] } }),
          cleanupDatabase.collection<SessionDocument>(collectionNames.sessions).deleteMany({ _id: { $in: [aliceSession._id, bobSession._id] } }),
          cleanupDatabase.collection<FriendshipDocument>(collectionNames.friendships).deleteOne({ _id: friendship._id }),
          cleanupDatabase.collection<MessageDocument>(collectionNames.messages).deleteMany({
            senderId: { $in: [aliceId, bobId] },
            recipientId: { $in: [aliceId, bobId] },
          }),
          cleanupDatabase.collection(collectionNames.socketTickets).deleteMany({
            sessionId: { $in: [aliceSession._id, bobSession._id] },
          }),
        ]);
      } finally {
        await cleanupClient.close();
        await Promise.all([
          firstMongoClient.close(),
          ...(restartedMongoClient ? [restartedMongoClient.close()] : []),
        ]);
      }
    }
  },
);
