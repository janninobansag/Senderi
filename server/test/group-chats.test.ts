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
          findOne: async (filter: { _id: ObjectId; participantIds?: ObjectId; createdBy?: ObjectId }) => data.groups.find((group) =>
            group._id.equals(filter._id) &&
            (!filter.participantIds || group.participantIds.some((id) => id.equals(filter.participantIds))) &&
            (!filter.createdBy || group.createdBy.equals(filter.createdBy)),
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
          updateOne: async (
            filter: { _id: ObjectId; participantIds?: ObjectId | { $all: ObjectId[] }; createdBy?: ObjectId },
            update: { $set?: Record<string, unknown>; $addToSet?: Record<string, unknown>; $pull?: Record<string, ObjectId>; $unset?: Record<string, string> },
          ) => {
            const group = data.groups.find((item) => item._id.equals(filter._id) &&
              (!filter.participantIds || (filter.participantIds instanceof ObjectId
                ? item.participantIds.some((id) => id.equals(filter.participantIds))
                : filter.participantIds.$all.every((requiredId) => item.participantIds.some((id) => id.equals(requiredId))))) &&
              (!filter.createdBy || item.createdBy.equals(filter.createdBy)));
            if (!group) return { matchedCount: 0 };
            if (update.$set) {
              for (const [key, value] of Object.entries(update.$set)) {
                if (key.startsWith("readAtByUser.")) {
                  const userId = key.slice("readAtByUser.".length);
                  group.readAtByUser = { ...group.readAtByUser, [userId]: value as Date };
                } else {
                  Object.assign(group, { [key]: value });
                }
              }
            }
            if (update.$addToSet) {
              for (const [key, value] of Object.entries(update.$addToSet)) {
                const ids = (group[key as "participantIds" | "adminIds"] ?? []) as ObjectId[];
                const additions = typeof value === "object" && value !== null && "$each" in value
                  ? (value as { $each: ObjectId[] }).$each
                  : [value as ObjectId];
                (group as unknown as Record<string, unknown>)[key] = [...ids, ...additions.filter((id) => !ids.some((existing) => existing.equals(id)))];
              }
            }
            if (update.$pull) {
              for (const [key, value] of Object.entries(update.$pull)) {
                const ids = (group[key as "participantIds" | "adminIds"] ?? []) as ObjectId[];
                (group as unknown as Record<string, unknown>)[key] = ids.filter((id) => !id.equals(value));
              }
            }
            if (update.$unset) {
              for (const key of Object.keys(update.$unset)) {
                if (key.startsWith("readAtByUser.")) {
                  const userId = key.slice("readAtByUser.".length);
                  if (group.readAtByUser) delete group.readAtByUser[userId];
                }
              }
            }
            return { matchedCount: 1 };
          },
          deleteOne: async (filter: { _id: ObjectId; createdBy: ObjectId }) => {
            const index = data.groups.findIndex((group) => group._id.equals(filter._id) && group.createdBy.equals(filter.createdBy));
            if (index < 0) return { deletedCount: 0 };
            data.groups.splice(index, 1);
            return { deletedCount: 1 };
          },
        };
      }
      if (name === collectionNames.messages) {
        return {
          findOne: async () => null,
          find: (filter: { groupId?: ObjectId; $and?: Array<{ groupId?: ObjectId }> }) => {
            const groupId = filter.groupId ?? filter.$and?.find((condition) => condition.groupId)?.groupId;
            const found = groupId ? data.messages.filter((message) => message.groupId?.equals(groupId)) : [];
            const cursor = {
              sort: () => cursor,
              limit: () => cursor,
              toArray: async () => found,
            };
            return cursor;
          },
          deleteMany: async (filter: { groupId: ObjectId }) => {
            const before = data.messages.length;
            data.messages = data.messages.filter((message) => !message.groupId?.equals(filter.groupId));
            return { deletedCount: before - data.messages.length };
          },
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
  const realtimeEvents: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  app.set("realtimeServer", {
    to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { realtimeEvents.push({ room, event, payload }); } }),
  });
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
  const sentMessage: MessageDocument = {
    _id: new ObjectId("000000000000000000000111"),
    senderId: alice._id,
    recipientId: alice._id,
    groupId: new ObjectId(groupId),
    clientId: "group-read-receipt",
    text: "Read me",
    createdAt: fixedNow,
    isRead: false,
  };
  data.messages.push(sentMessage);

  const memberGroups = await request(app).get("/api/chats/groups").set("Cookie", bobCookie);
  assert.equal(memberGroups.status, 200);
  assert.equal(memberGroups.body.items[0].id, groupId);

  const memberHistory = await request(app).get(`/api/chats/groups/${groupId}/messages`).set("Cookie", bobCookie);
  assert.equal(memberHistory.status, 200);
  assert.equal(memberHistory.body.items[0]?.text, "Read me");
  assert.equal(memberHistory.body.items[0]?.isRead, undefined);

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
  const senderHistory = await request(app).get(`/api/chats/groups/${groupId}/messages`).set("Cookie", aliceCookie);
  assert.equal(senderHistory.body.items[0]?.isRead, true);
  assert.equal(realtimeEvents.some((event) => event.event === "message:read" && event.room === `user:${alice._id.toHexString()}`), true);
});


test("group owners and admins can manage a group, members can leave, and ownership can transfer", async () => {
  const alice = makeUser("000000000000000000000201", "alice");
  const bob = makeUser("000000000000000000000202", "bob");
  const carol = makeUser("000000000000000000000203", "carol");
  const dave = makeUser("000000000000000000000204", "dave");
  const erin = makeUser("000000000000000000000205", "erin");
  const data: TestData = {
    users: [alice, bob, carol, dave, erin],
    sessions: [session(alice, "alice-manage-session"), session(bob, "bob-manage-session"), session(carol, "carol-manage-session")],
    friendships: [friendship(alice, bob), friendship(alice, carol), friendship(bob, dave), friendship(bob, erin)],
    groups: [],
    messages: [],
  };
  const app = createApp(data);
  const aliceCookie = `${SESSION_COOKIE_NAME}=alice-manage-session`;
  const bobCookie = `${SESSION_COOKIE_NAME}=bob-manage-session`;
  const carolCookie = `${SESSION_COOKIE_NAME}=carol-manage-session`;
  const created = await request(app).post("/api/chats/groups").set("Cookie", aliceCookie).set("Origin", "http://client.test")
    .send({ name: "Friends", memberIds: [bob._id.toHexString(), carol._id.toHexString()] });
  const groupId = created.body.group.id as string;
  const groupObjectId = new ObjectId(groupId);
  data.messages.push({
    _id: new ObjectId(), senderId: alice._id, recipientId: alice._id, groupId: groupObjectId,
    clientId: "delete-group-message", text: "This message is deleted with the group", createdAt: fixedNow, isRead: true,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.group.participants.map((participant: { role: string }) => participant.role), ["owner", "member", "member"]);

  const deniedRename = await request(app).patch(`/api/chats/groups/${groupId}`).set("Cookie", carolCookie).set("Origin", "http://client.test").send({ name: "Nope" });
  assert.equal(deniedRename.status, 403);
  const promote = await request(app).patch(`/api/chats/groups/${groupId}/members/${bob._id.toHexString()}/role`).set("Cookie", aliceCookie).set("Origin", "http://client.test").send({ role: "admin" });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.group.participants.find((participant: { id: string }) => participant.id === bob._id.toHexString()).role, "admin");

  const rename = await request(app).patch(`/api/chats/groups/${groupId}`).set("Cookie", bobCookie).set("Origin", "http://client.test").send({ name: "Renamed" });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.group.name, "Renamed");
  const add = await request(app).post(`/api/chats/groups/${groupId}/members`).set("Cookie", bobCookie).set("Origin", "http://client.test").send({ memberIds: [dave._id.toHexString(), erin._id.toHexString()] });
  assert.equal(add.status, 200);
  assert.equal(add.body.group.participants.find((participant: { id: string }) => participant.id === dave._id.toHexString()).role, "member");
  const nonAdminRemove = await request(app).delete(`/api/chats/groups/${groupId}/members/${dave._id.toHexString()}`).set("Cookie", carolCookie).set("Origin", "http://client.test");
  assert.equal(nonAdminRemove.status, 403);
  const adminRemove = await request(app).delete(`/api/chats/groups/${groupId}/members/${dave._id.toHexString()}`).set("Cookie", bobCookie).set("Origin", "http://client.test");
  assert.equal(adminRemove.status, 204);
  const adminCannotRemoveOwner = await request(app).delete(`/api/chats/groups/${groupId}/members/${alice._id.toHexString()}`).set("Cookie", bobCookie).set("Origin", "http://client.test");
  assert.equal(adminCannotRemoveOwner.status, 409);
  const ownerRemove = await request(app).delete(`/api/chats/groups/${groupId}/members/${erin._id.toHexString()}`).set("Cookie", aliceCookie).set("Origin", "http://client.test");
  assert.equal(ownerRemove.status, 204);

  const ownerCannotLeaveWithoutTransfer = await request(app).delete(`/api/chats/groups/${groupId}/members/me`).set("Cookie", aliceCookie).set("Origin", "http://client.test");
  assert.equal(ownerCannotLeaveWithoutTransfer.status, 409);
  const transfer = await request(app).patch(`/api/chats/groups/${groupId}/members/${bob._id.toHexString()}/role`).set("Cookie", aliceCookie).set("Origin", "http://client.test").send({ role: "owner" });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.group.participants.find((participant: { id: string }) => participant.id === alice._id.toHexString()).role, "admin");
  assert.equal(transfer.body.group.participants.find((participant: { id: string }) => participant.id === bob._id.toHexString()).role, "owner");

  const leave = await request(app).delete(`/api/chats/groups/${groupId}/members/me`).set("Cookie", carolCookie).set("Origin", "http://client.test");
  assert.equal(leave.status, 204);
  const carolGroups = await request(app).get("/api/chats/groups").set("Cookie", carolCookie);
  assert.deepEqual(carolGroups.body.items, []);

  const newOwnerRemovesFormerOwner = await request(app).delete(`/api/chats/groups/${groupId}/members/${alice._id.toHexString()}`).set("Cookie", bobCookie).set("Origin", "http://client.test");
  assert.equal(newOwnerRemovesFormerOwner.status, 204);
  const removedMemberCannotDelete = await request(app).delete(`/api/chats/groups/${groupId}`).set("Cookie", aliceCookie).set("Origin", "http://client.test");
  assert.equal(removedMemberCannotDelete.status, 404);
  const remove = await request(app).delete(`/api/chats/groups/${groupId}`).set("Cookie", bobCookie).set("Origin", "http://client.test");
  assert.equal(remove.status, 204);
  assert.equal(data.groups.length, 0);
  assert.equal(data.messages.length, 0);
});
