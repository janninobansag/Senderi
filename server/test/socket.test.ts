import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  FriendshipDocument,
  MessageDocument,
  SessionDocument,
  SocketTicketDocument,
  UserDocument,
} from "../src/db/documents";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { hashSocketTicket } from "../src/auth/socket-ticket";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { orderedUserPair } from "../src/friends/are-friends";
import { createAuthRouter } from "../src/routes/auth";
import { createChatsRouter } from "../src/routes/chats";
import type { MessageAckEvent, MessageErrorEvent, MessageNewEvent, MessageSendRequest } from "../src/socket/contracts";
import { createSocketServer, disconnectUserSockets } from "../src/socket/server";
import { isUserOnline } from "../src/socket/presence";

const CLIENT_ORIGIN = "http://localhost:5173";
const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

interface SocketTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  socketTickets: SocketTicketDocument[];
  friendships: FriendshipDocument[];
  messages: MessageDocument[];
}

interface ServerEvents {
  connect: () => void;
  connect_error: (error: Error) => void;
  "message:ack": (payload: MessageAckEvent) => void;
  "message:new": (payload: MessageNewEvent) => void;
  "message:error": (payload: MessageErrorEvent) => void;
}

interface ClientEvents {
  "message:send": (payload: MessageSendRequest) => void;
}

type TestClient = ClientSocket<ServerEvents, ClientEvents>;

function makeUser(id: string, email: string): UserDocument {
  return {
    _id: new ObjectId(id),
    email,
    passwordHash: "$argon2id$unused-in-this-test",
    displayName: email.split("@")[0] ?? "Test user",
    bio: "",
    info: {},
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function sessionFor(user: UserDocument, token: string): SessionDocument {
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + 7 * 24 * 60 * 60 * 1_000),
  };
}

function friendshipFor(first: UserDocument, second: UserDocument): FriendshipDocument {
  const [userIdLow, userIdHigh] = orderedUserPair(first._id, second._id);
  return { _id: new ObjectId(), userIdLow, userIdHigh, createdAt: FIXED_NOW };
}

function matchesExpiry(expiresAt: Date, filter: { $gt: Date } | undefined): boolean {
  return filter === undefined || expiresAt.getTime() > filter.$gt.getTime();
}

function createDatabase(data: SocketTestData): Db {
  return {
    collection: (name: string) => {
      if (name === "users") {
        return {
          findOne: async (filter: { _id?: ObjectId }) =>
            data.users.find((user) => filter._id === undefined || user._id.equals(filter._id)) ?? null,
          updateOne: async (filter: { _id: ObjectId }, update: { $max: { lastActiveAt: Date } }) => {
            const user = data.users.find((item) => item._id.equals(filter._id));
            if (user && (!user.lastActiveAt || user.lastActiveAt < update.$max.lastActiveAt)) {
              user.lastActiveAt = update.$max.lastActiveAt;
            }
            return { acknowledged: true };
          },
        };
      }
      if (name === "sessions") {
        return {
          findOne: async (filter: {
            _id?: ObjectId;
            userId?: ObjectId;
            tokenHash?: string;
            expiresAt?: { $gt: Date };
          }) => data.sessions.find((session) =>
            (filter._id === undefined || session._id.equals(filter._id)) &&
            (filter.userId === undefined || session.userId.equals(filter.userId)) &&
            (filter.tokenHash === undefined || session.tokenHash === filter.tokenHash) &&
            matchesExpiry(session.expiresAt, filter.expiresAt),
          ) ?? null,
        };
      }
      if (name === "socketTickets") {
        return {
          insertOne: async (ticket: SocketTicketDocument) => {
            data.socketTickets.push(ticket);
            return { acknowledged: true, insertedId: ticket._id };
          },
          findOneAndDelete: async (filter: { ticketHash: string; expiresAt: { $gt: Date } }) => {
            const index = data.socketTickets.findIndex((ticket) =>
              ticket.ticketHash === filter.ticketHash && matchesExpiry(ticket.expiresAt, filter.expiresAt),
            );
            return index < 0 ? null : data.socketTickets.splice(index, 1)[0] ?? null;
          },
        };
      }
      if (name === "friendships") {
        return {
          findOne: async (filter: { userIdLow: ObjectId; userIdHigh: ObjectId }) =>
            data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) && friendship.userIdHigh.equals(filter.userIdHigh),
            ) ?? null,
        };
      }
      if (name === "messages") {
        return {
          findOne: async (filter: { senderId: ObjectId; clientId: string }) =>
            data.messages.find((message) =>
              message.senderId.equals(filter.senderId) && message.clientId === filter.clientId,
            ) ?? null,
          insertOne: async (message: MessageDocument) => {
            if (data.messages.some((stored) =>
              stored.senderId.equals(message.senderId) && stored.clientId === message.clientId,
            )) {
              throw Object.assign(new Error("Duplicate sender/client ID"), { code: 11000 });
            }
            data.messages.push(message);
            return { acknowledged: true, insertedId: message._id };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as unknown as Db;
}

interface SocketFixture {
  data: SocketTestData;
  database: Db;
  app: express.Express;
  url: string;
  setNow: (value: Date) => void;
  close: () => Promise<void>;
}

async function createFixture(): Promise<SocketFixture> {
  const alice = makeUser("000000000000000000000001", "alice@example.com");
  const bob = makeUser("000000000000000000000002", "bob@example.com");
  const data: SocketTestData = {
    users: [alice, bob],
    sessions: [sessionFor(alice, "alice-session"), sessionFor(bob, "bob-session")],
    socketTickets: [],
    friendships: [friendshipFor(alice, bob)],
    messages: [],
  };
  const database = createDatabase(data);
  let now = FIXED_NOW;
  let ticketSequence = 0;
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({
    getDatabase: () => database,
    createSocketTicketToken: () => `${"A".repeat(42)}${ALPHABET[ticketSequence++ % ALPHABET.length]}`,
    now: () => now,
    getAllowedOrigins: () => [CLIENT_ORIGIN],
  }));
  app.use("/api/chats", createChatsRouter({
    getDatabase: () => database,
    now: () => now,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = createServer(app);
  const socketServer = createSocketServer(server, {
    getDatabase: () => database,
    now: () => now,
    getAllowedOrigins: () => [CLIENT_ORIGIN],
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test socket server did not bind a TCP port.");

  return {
    data,
    database,
    app,
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    setNow: (value) => { now = value; },
    close: () => new Promise<void>((resolve) => socketServer.close(() => resolve())),
  };
}

async function issueTicket(fixture: SocketFixture, token = "alice-session") {
  return request(fixture.app)
    .post("/api/auth/socket-ticket")
    .set("Origin", CLIENT_ORIGIN)
    .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);
}

function openClient(fixture: SocketFixture, ticket: string, origin = CLIENT_ORIGIN): TestClient {
  return createClient<ServerEvents, ClientEvents>(fixture.url, {
    auth: { ticket },
    extraHeaders: { Origin: origin },
    transports: ["websocket"],
    reconnection: false,
    timeout: 3_000,
  });
}

function waitForConnect(socket: TestClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timed out.")), 3_000);
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

function waitForConnectError(socket: TestClient): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Expected the socket connection to be rejected.")), 3_000);
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      resolve(error);
    });
    socket.once("connect", () => {
      clearTimeout(timeout);
      reject(new Error("Socket connection unexpectedly succeeded."));
    });
  });
}

function waitForAck(socket: TestClient): Promise<MessageAckEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message acknowledgement timed out.")), 3_000);
    socket.once("message:ack", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function waitForNewMessage(socket: TestClient): Promise<MessageNewEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("New message event timed out.")), 3_000);
    socket.once("message:new", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function waitForMessageError(socket: TestClient): Promise<MessageErrorEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message error event timed out.")), 3_000);
    socket.once("message:error", (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

function closeClients(...clients: TestClient[]): void {
  for (const client of clients) client.disconnect();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "Expected presence to update before timeout.");
}

test("presence stays online across tabs and saves the final disconnect time", async () => {
  const fixture = await createFixture();
  const userId = fixture.data.users[0]!._id.toHexString();
  let first: TestClient | undefined;
  let second: TestClient | undefined;
  try {
    first = openClient(fixture, (await issueTicket(fixture)).body.ticket as string);
    await waitForConnect(first);
    await waitUntil(() => isUserOnline(userId));
    assert.equal(fixture.data.users[0]?.lastActiveAt?.toISOString(), FIXED_NOW.toISOString());

    second = openClient(fixture, (await issueTicket(fixture)).body.ticket as string);
    await waitForConnect(second);
    first.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(isUserOnline(userId), true);

    fixture.setNow(new Date(FIXED_NOW.getTime() + 120_000));
    second.disconnect();
    await waitUntil(() => !isUserOnline(userId));
    assert.equal(fixture.data.users[0]?.lastActiveAt?.toISOString(), new Date(FIXED_NOW.getTime() + 120_000).toISOString());
  } finally {
    closeClients(...[first, second].filter((socket): socket is TestClient => socket !== undefined));
    await fixture.close();
  }
});

test("socket tickets are issued to a live session and consumed once after origin and ticket checks", async () => {
  const fixture = await createFixture();
  let client: TestClient | undefined;
  let reusedClient: TestClient | undefined;
  let badOriginClient: TestClient | undefined;
  let invalidTicketClient: TestClient | undefined;

  try {
    const unauthenticated = await request(fixture.app)
      .post("/api/auth/socket-ticket")
      .set("Origin", CLIENT_ORIGIN);
    assert.equal(unauthenticated.status, 401);

    const wrongOrigin = await request(fixture.app)
      .post("/api/auth/socket-ticket")
      .set("Origin", "https://evil.example")
      .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`);
    assert.equal(wrongOrigin.status, 403);

    const invalidBody = await request(fixture.app)
      .post("/api/auth/socket-ticket")
      .set("Origin", CLIENT_ORIGIN)
      .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`)
      .send({ unexpected: true });
    assert.equal(invalidBody.status, 400);

    const response = await issueTicket(fixture);
    assert.equal(response.status, 201);
    assert.equal(response.body.expiresAt, new Date(FIXED_NOW.getTime() + 60_000).toISOString());
    const ticket = response.body.ticket as string;
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fixture.data.socketTickets.length, 1);
    assert.equal(fixture.data.socketTickets[0]?.ticketHash, hashSocketTicket(ticket));
    assert.notEqual(fixture.data.socketTickets[0]?.ticketHash, ticket);
    assert.ok(fixture.data.socketTickets[0]?.userId.equals(fixture.data.users[0]!._id));
    assert.ok(fixture.data.socketTickets[0]?.sessionId.equals(fixture.data.sessions[0]!._id));

    badOriginClient = openClient(fixture, ticket, "https://evil.example");
    await waitForConnectError(badOriginClient);
    assert.equal(fixture.data.socketTickets.length, 1, "a rejected origin must not consume a ticket");

    invalidTicketClient = openClient(fixture, "Z".repeat(43));
    await waitForConnectError(invalidTicketClient);
    assert.equal(fixture.data.socketTickets.length, 1);

    client = openClient(fixture, ticket);
    await waitForConnect(client);
    assert.equal(fixture.data.socketTickets.length, 0);

    reusedClient = openClient(fixture, ticket);
    await waitForConnectError(reusedClient);
  } finally {
    closeClients(...[client, reusedClient, badOriginClient, invalidTicketClient].filter(
      (socket): socket is TestClient => socket !== undefined,
    ));
    await fixture.close();
  }
});

test("expired socket tickets cannot authenticate a connection", async () => {
  const fixture = await createFixture();
  let client: TestClient | undefined;
  try {
    const response = await issueTicket(fixture);
    assert.equal(response.status, 201);
    const ticket = response.body.ticket as string;
    fixture.setNow(new Date(FIXED_NOW.getTime() + 60_001));
    client = openClient(fixture, ticket);
    await waitForConnectError(client);
    assert.equal(fixture.data.socketTickets.length, 0, "expired ticket is atomically discarded when claimed");
  } finally {
    closeClients(...(client ? [client] : []));
    await fixture.close();
  }
});

test("a ticket cannot authenticate after its issuing session is revoked", async () => {
  const fixture = await createFixture();
  let client: TestClient | undefined;
  try {
    const response = await issueTicket(fixture);
    assert.equal(response.status, 201);
    const ticket = response.body.ticket as string;
    fixture.data.sessions.splice(0, 1);

    client = openClient(fixture, ticket);
    await waitForConnectError(client);
    assert.equal(fixture.data.socketTickets.length, 0);
  } finally {
    closeClients(...(client ? [client] : []));
    await fixture.close();
  }
});

test("suspension rejects tickets and disconnects an active socket", async () => {
  const fixture = await createFixture();
  let connected: TestClient | undefined;
  let denied: TestClient | undefined;
  try {
    const first = await issueTicket(fixture);
    connected = openClient(fixture, first.body.ticket as string);
    await waitForConnect(connected);
    const second = await issueTicket(fixture);
    fixture.data.users[0]!.suspendedAt = new Date();
    denied = openClient(fixture, second.body.ticket as string);
    await waitForConnectError(denied);
    const disconnected = new Promise<void>((resolve) => connected!.once("disconnect", () => resolve()));
    disconnectUserSockets(fixture.data.users[0]!._id);
    await disconnected;
    assert.equal(connected.connected, false);
  } finally {
    closeClients(...(connected ? [connected] : []), ...(denied ? [denied] : []));
    await fixture.close();
  }
});

test("message sends persist once before ack and new events, including duplicate concurrent retries", async () => {
  const fixture = await createFixture();
  let alice: TestClient | undefined;
  let bob: TestClient | undefined;
  let unexpectedError: MessageErrorEvent | undefined;
  try {
    const aliceTicketResponse = await issueTicket(fixture, "alice-session");
    const bobTicketResponse = await issueTicket(fixture, "bob-session");
    alice = openClient(fixture, aliceTicketResponse.body.ticket as string);
    bob = openClient(fixture, bobTicketResponse.body.ticket as string);
    await Promise.all([waitForConnect(alice), waitForConnect(bob)]);

    let newEventCount = 0;
    bob.on("message:new", () => { newEventCount += 1; });
    alice.on("message:error", (event) => { unexpectedError = event; });

    const send: MessageSendRequest = {
      friendId: fixture.data.users[1]!._id.toHexString(),
      clientId: "retry-0001",
      text: "  Hello, Bob!  ",
    };
    const firstAck = waitForAck(alice);
    const retryAck = waitForAck(alice);
    const newMessage = waitForNewMessage(bob);
    alice.emit("message:send", send);
    alice.emit("message:send", send);

    const [first, retry, delivered] = await Promise.all([firstAck, retryAck, newMessage]);
    assert.equal(fixture.data.messages.length, 1);
    assert.equal(first.message.id, retry.message.id);
    assert.equal(first.message.id, delivered.message.id);
    assert.equal(first.message.text, "Hello, Bob!");
    assert.equal(first.clientId, send.clientId);
    assert.deepEqual(Object.keys(first.message).sort(), ["createdAt", "id", "recipientId", "senderId", "text"]);
    assert.equal(newEventCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(newEventCount, 1, "a duplicate client ID must not emit a second new-message event");
    assert.equal(unexpectedError, undefined);

    const invalidErrorPromise = waitForMessageError(alice);
    alice.emit("message:send", { ...send, clientId: "blank-text", text: "   " });
    const invalidError = await invalidErrorPromise;
    assert.equal(invalidError.code, "invalid_message");
    assert.equal(invalidError.clientId, "blank-text");
    assert.equal(fixture.data.messages.length, 1);
  } finally {
    closeClients(...[alice, bob].filter((socket): socket is TestClient => socket !== undefined));
    await fixture.close();
  }
});

test("offline delivery persists and removing a friend blocks open-socket sends and history reads", async () => {
  const fixture = await createFixture();
  let alice: TestClient | undefined;
  try {
    const ticketResponse = await issueTicket(fixture);
    alice = openClient(fixture, ticketResponse.body.ticket as string);
    await waitForConnect(alice);

    const payload: MessageSendRequest = {
      friendId: fixture.data.users[1]!._id.toHexString(),
      clientId: "offline-0001",
      text: "Stored while Bob is offline",
    };
    const acknowledgement = waitForAck(alice);
    alice.emit("message:send", payload);
    const ack = await acknowledgement;
    assert.equal(fixture.data.messages.length, 1);
    assert.equal(ack.message.text, payload.text);
    assert.equal(ack.message.senderId, fixture.data.users[0]!._id.toHexString());
    assert.equal(ack.message.recipientId, fixture.data.users[1]!._id.toHexString());

    fixture.data.friendships.splice(0, 1);
    const history = await request(fixture.app)
      .get(`/api/chats/${fixture.data.users[1]!._id.toHexString()}/messages`)
      .set("Cookie", `${SESSION_COOKIE_NAME}=alice-session`);
    assert.equal(history.status, 404, "removed friends cannot load prior conversation history");
    assert.equal(history.body.error.code, "conversation_not_found");

    const deniedPromise = waitForMessageError(alice);
    alice.emit("message:send", { ...payload, clientId: "after-removal-0001" });
    const denied = await deniedPromise;
    assert.equal(denied.code, "not_friends");
    assert.equal(fixture.data.messages.length, 1, "friendship removal blocks sends on an already-open socket");
  } finally {
    closeClients(...(alice ? [alice] : []));
    await fixture.close();
  }
});

test("multiple sockets for one user receive one delivery and retries persist only once", async () => {
  const fixture = await createFixture();
  let aliceTabOne: TestClient | undefined;
  let aliceTabTwo: TestClient | undefined;
  let bob: TestClient | undefined;
  try {
    const [firstTicket, secondTicket, bobTicket] = await Promise.all([
      issueTicket(fixture, "alice-session"),
      issueTicket(fixture, "alice-session"),
      issueTicket(fixture, "bob-session"),
    ]);
    aliceTabOne = openClient(fixture, firstTicket.body.ticket as string);
    aliceTabTwo = openClient(fixture, secondTicket.body.ticket as string);
    bob = openClient(fixture, bobTicket.body.ticket as string);
    await Promise.all([
      waitForConnect(aliceTabOne),
      waitForConnect(aliceTabTwo),
      waitForConnect(bob),
    ]);

    let tabOneDeliveries = 0;
    let tabTwoDeliveries = 0;
    aliceTabOne.on("message:new", () => { tabOneDeliveries += 1; });
    aliceTabTwo.on("message:new", () => { tabTwoDeliveries += 1; });

    const payload: MessageSendRequest = {
      friendId: fixture.data.users[0]!._id.toHexString(),
      clientId: "multi-tab-0001",
      text: "One stored message for both tabs",
    };
    const firstAck = waitForAck(bob);
    const firstTabDelivery = waitForNewMessage(aliceTabOne);
    const secondTabDelivery = waitForNewMessage(aliceTabTwo);
    bob.emit("message:send", payload);
    const [ack, deliveredToTabOne, deliveredToTabTwo] = await Promise.all([
      firstAck,
      firstTabDelivery,
      secondTabDelivery,
    ]);

    assert.equal(fixture.data.messages.length, 1);
    assert.equal(deliveredToTabOne.message.id, ack.message.id);
    assert.equal(deliveredToTabTwo.message.id, ack.message.id);

    const retryAck = waitForAck(bob);
    bob.emit("message:send", payload);
    const retry = await retryAck;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(retry.message.id, ack.message.id);
    assert.equal(fixture.data.messages.length, 1, "retrying the same client ID must not persist another message");
    assert.equal(tabOneDeliveries, 1, "a retry must not broadcast a duplicate to the first tab");
    assert.equal(tabTwoDeliveries, 1, "a retry must not broadcast a duplicate to the second tab");
  } finally {
    closeClients(...[aliceTabOne, aliceTabTwo, bob].filter((socket): socket is TestClient => socket !== undefined));
    await fixture.close();
  }
});
