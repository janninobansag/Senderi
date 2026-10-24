import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import {
  collectionNames,
  type FriendshipDocument,
  type GroupConversationDocument,
  type MessageDocument,
  type SessionDocument,
  type UserDocument,
} from "../src/db/documents";
import { orderedUserPair } from "../src/friends/are-friends";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { createChatsRouter } from "../src/routes/chats";

const fixedNow = new Date("2026-10-24T00:00:00.000Z");

interface TestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  groups: GroupConversationDocument[];
  messages: MessageDocument[];
}

function createDatabase(data: TestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return { findOne: async (filter: { tokenHash: string }) => data.sessions.find((item) => item.tokenHash === filter.tokenHash) ?? null };
      }
      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id: ObjectId }) => data.users.find((item) => item._id.equals(filter._id)) ?? null,
          find: (filter: { _id: { $in: ObjectId[] } }) => ({
            toArray: async () => data.users.filter((item) => filter._id.$in.some((id) => item._id.equals(id))),
          }),
        };
      }
      if (name === collectionNames.friendships) {
        return {
          findOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) => data.friendships.find((item) =>
            item.userIdLow.equals(filter.userIdLow) && item.userIdHigh.equals(filter.userIdHigh),
          ) ?? null,
        };
      }
      if (name === collectionNames.groupConversations) {
        return {
          findOne: async (filter: { _id: ObjectId; participantIds: ObjectId }) => data.groups.find((group) =>
            group._id.equals(filter._id) && group.participantIds.some((id) => id.equals(filter.participantIds)),
          ) ?? null,
          insertOne: async (group: GroupConversationDocument) => {
            data.groups.push(group);
            return { insertedId: group._id };
          },
          find: (filter: { participantIds: ObjectId }) => {
            const groups = data.groups.filter((group) => group.participantIds.some((id) => id.equals(filter.participantIds)));
            const cursor = {
              sort: () => cursor,
              limit: () => cursor,
              toArray: async () => groups,
            };
            return cursor;
          },
          updateOne: async (filter: { _id: ObjectId; participantIds: ObjectId }, update: { $set: Record<string, Date> }) => {
            const group = data.groups.find((item) => item._id.equals(filter._id) && item.participantIds.some((id) => id.equals(filter.participantIds)));
            if (!group) return { matchedCount: 0 };
            const readAt = update.$set[`readAtByUser.${filter.participantIds.toHexString()}`];
            if (readAt) group.readAtByUser = { ...group.readAtByUser, [filter.participantIds.toHexString()]: readAt };
            return { matchedCount: 1 };
          },
        };
      }
      if (name === collectionNames.messages) {
        return {
          findOne: async () => null,
          find: () => ({
            sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
          }),
          countDocuments: async () => 0,
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  } as unknown as Db;
}

function makeUser(id: string, name: string): UserDocument {
  return {
    _id: new ObjectId(id),
    email: `${name}@example.test`,
    passwordHash: "unused",
    displayName: name,
    bio: "",
    info: {},
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function friendship(first: UserDocument, second: UserDocument): FriendshipDocument {
  const [userIdLow, userIdHigh] = orderedUserPair(first._id, second._id);
  return { _id: new ObjectId(), userIdLow, userIdHigh, createdAt: fixedNow };
}

function session(user: UserDocument, token: string): SessionDocument {
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt: fixedNow,
    expiresAt: new Date(fixedNow.getTime() + 60_000),
  };
}

function createApp(data: TestData) {
  const database = createDatabase(data);
  const app = express();
  app.use(express.json());
  app.use("/api/chats", createChatsRouter({ getDatabase: () => database, getAllowedOrigins: () => ["http://client.test"], now: () => fixedNow }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test("group chats can be created by friends and history is private to group members", async () => {
  const alice = makeUser("000000000000000000000101", "alice");
  const bob = makeUser("000000000000000000000102", "bob");
  const carol = makeUser("000000000000000000000103", "carol");
  const dave = makeUser("000000000000000000000104", "dave");
  const data: TestData = {
    users: [alice, bob, carol, dave],
    sessions: [session(alice, "alice-session"), session(bob, "bob-session"), session(dave, "dave-session")],
    friendships: [friendship(alice, bob), friendship(alice, carol)],
    groups: [],
    messages: [],
  };
  const app = createApp(data);
  const aliceCookie = `${SESSION_COOKIE_NAME}=alice-session`;
  const bobCookie = `${SESSION_COOKIE_NAME}=bob-session`;
  const daveCookie = `${SESSION_COOKIE_NAME}=dave-session`;

  const created = await request(app)
    .post("/api/chats/groups")
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test")
    .send({ name: "Weekend plans", memberIds: [bob._id.toHexString(), carol._id.toHexString()] });
  assert.equal(created.status, 201);
  assert.equal(created.body.group.name, "Weekend plans");
  assert.deepEqual(created.body.group.participants.map((participant: { displayName: string }) => participant.displayName), ["alice", "bob", "carol"]);
  const groupId = created.body.group.id as string;

  const memberGroups = await request(app).get("/api/chats/groups").set("Cookie", bobCookie);
  assert.equal(memberGroups.status, 200);
  assert.equal(memberGroups.body.items[0].id, groupId);

  const memberHistory = await request(app).get(`/api/chats/groups/${groupId}/messages`).set("Cookie", bobCookie);
  assert.equal(memberHistory.status, 200);
  assert.deepEqual(memberHistory.body.items, []);

  const outsiderHistory = await request(app).get(`/api/chats/groups/${groupId}/messages`).set("Cookie", daveCookie);
  assert.equal(outsiderHistory.status, 404);

  const outsiderCreate = await request(app)
    .post("/api/chats/groups")
    .set("Cookie", aliceCookie)
    .set("Origin", "http://client.test")
    .send({ name: "Not my friend", memberIds: [bob._id.toHexString(), dave._id.toHexString()] });
  assert.equal(outsiderCreate.status, 400);

  const read = await request(app)
    .patch(`/api/chats/groups/${groupId}/read`)
    .set("Cookie", bobCookie)
    .set("Origin", "http://client.test");
  assert.equal(read.status, 204);
  assert.equal(data.groups[0]?.readAtByUser?.[bob._id.toHexString()]?.toISOString(), fixedNow.toISOString());
});
