import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import { hashSessionToken, SESSION_COOKIE_NAME } from "../src/auth/session";
import { collectionNames, type FriendshipDocument, type PostDocument, type SessionDocument, type UserDocument } from "../src/db/documents";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { createPostsRouter, createUserPostsRouter } from "../src/routes/posts";

interface PostTestData {
  users: UserDocument[];
  sessions: SessionDocument[];
  friendships: FriendshipDocument[];
  posts: PostDocument[];
}

type MongoFilter = Record<string, unknown>;

function matchesObjectId(actual: ObjectId, expected: unknown): boolean {
  if (expected instanceof ObjectId) return actual.equals(expected);
  if (typeof expected === "object" && expected !== null && "$in" in expected) {
    return (expected.$in as ObjectId[]).some((id) => actual.equals(id));
  }
  if (typeof expected === "object" && expected !== null && "$lt" in expected) {
    return actual.toHexString() < (expected.$lt as ObjectId).toHexString();
  }
  return false;
}

function matchesDate(actual: Date, expected: unknown): boolean {
  if (expected instanceof Date) return actual.getTime() === expected.getTime();
  if (typeof expected === "object" && expected !== null && "$lt" in expected) {
    return actual.getTime() < (expected.$lt as Date).getTime();
  }
  return false;
}

function matchesPost(post: PostDocument, filter: MongoFilter): boolean {
  if ("$and" in filter) {
    return (filter.$and as MongoFilter[]).every((condition) => matchesPost(post, condition));
  }
  if ("$or" in filter) {
    return (filter.$or as MongoFilter[]).some((condition) => matchesPost(post, condition));
  }

  return Object.entries(filter).every(([field, expected]) => {
    if (field === "authorId") return matchesObjectId(post.authorId, expected);
    if (field === "_id") return matchesObjectId(post._id, expected);
    if (field === "createdAt") return matchesDate(post.createdAt, expected);
    if (field === "visibility") {
      if (typeof expected === "object" && expected !== null && "$in" in expected) {
        return (expected.$in as PostDocument["visibility"][]).includes(post.visibility);
      }
      return post.visibility === expected;
    }
    return false;
  });
}

function createDatabase(data: PostTestData): Db {
  return {
    collection: (name: string) => {
      if (name === collectionNames.sessions) {
        return {
          findOne: async (filter: { tokenHash: string }) =>
            data.sessions.find((session) => session.tokenHash === filter.tokenHash) ?? null,
        };
      }

      if (name === collectionNames.users) {
        return {
          findOne: async (filter: { _id?: ObjectId }) =>
            data.users.find((user) => filter._id && user._id.equals(filter._id)) ?? null,
          find: (filter: { _id: { $in: ObjectId[] } }) => ({
            toArray: async () => data.users.filter((user) =>
              filter._id.$in.some((id) => id.equals(user._id)),
            ),
          }),
        };
      }

      if (name === collectionNames.friendships) {
        return {
          findOne: async (filter: Pick<FriendshipDocument, "userIdLow" | "userIdHigh">) =>
            data.friendships.find((friendship) =>
              friendship.userIdLow.equals(filter.userIdLow) &&
              friendship.userIdHigh.equals(filter.userIdHigh),
            ) ?? null,
          find: (filter: { $or: Array<Partial<FriendshipDocument>> }) => ({
            toArray: async () => data.friendships.filter((friendship) =>
              filter.$or.some((condition) =>
                (condition.userIdLow && friendship.userIdLow.equals(condition.userIdLow)) ||
                (condition.userIdHigh && friendship.userIdHigh.equals(condition.userIdHigh)),
              ),
            ),
          }),
        };
      }

      if (name === collectionNames.posts) {
        return {
          insertOne: async (post: PostDocument) => {
            data.posts.push(post);
            return { acknowledged: true, insertedId: post._id };
          },
          findOne: async (filter: { _id: ObjectId }) =>
            data.posts.find((post) => post._id.equals(filter._id)) ?? null,
          find: (filter: MongoFilter) => {
            let result = data.posts.filter((post) => matchesPost(post, filter));
            let maximum = Number.POSITIVE_INFINITY;
            const cursor = {
              sort: () => {
                result = result.toSorted((left, right) => {
                  const dateOrder = right.createdAt.getTime() - left.createdAt.getTime();
                  return dateOrder || right._id.toHexString().localeCompare(left._id.toHexString());
                });
                return cursor;
              },
              limit: (limit: number) => {
                maximum = limit;
                return cursor;
              },
              toArray: async () => result.slice(0, maximum),
            };
            return cursor;
          },
        };
      }

      return {};
    },
  } as unknown as Db;
}

function makeUser(id: string, email: string, displayName: string): UserDocument {
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  return {
    _id: new ObjectId(id),
    email,
    passwordHash: "$argon2id$private-test-hash",
    displayName,
    bio: "A public bio",
    info: { location: "Cebu" },
    createdAt,
    updatedAt: createdAt,
  };
}

function makePost(
  id: string,
  authorId: ObjectId,
  visibility: PostDocument["visibility"],
  createdAt: Date,
): PostDocument {
  return {
    _id: new ObjectId(id),
    authorId,
    text: `${visibility} post`,
    visibility,
    createdAt,
    updatedAt: createdAt,
  };
}

function sessionFor(user: UserDocument, token: string): SessionDocument {
  const createdAt = new Date();
  return {
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(token),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 60_000),
  };
}

function createApp(data: PostTestData) {
  const database = createDatabase(data);
  const app = express();
  app.use(express.json());
  app.use("/api/users", createUserPostsRouter({ getDatabase: () => database }));
  app.use("/api/posts", createPostsRouter({ getDatabase: () => database }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function cookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

const ids = {
  author: "000000000000000000000001",
  friend: "000000000000000000000002",
  outsider: "000000000000000000000003",
  public: "000000000000000000000011",
  friends: "000000000000000000000012",
  onlyMe: "000000000000000000000013",
};

function matrixFixture(): { data: PostTestData; tokens: Record<"author" | "friend" | "outsider", string> } {
  const author = makeUser(ids.author, "author@example.test", "Author");
  const friend = makeUser(ids.friend, "friend@example.test", "Friend");
  const outsider = makeUser(ids.outsider, "outsider@example.test", "Outsider");
  const tokens = { author: "author-session", friend: "friend-session", outsider: "outsider-session" };
  const now = Date.now();
  const data: PostTestData = {
    users: [author, friend, outsider],
    sessions: [sessionFor(author, tokens.author), sessionFor(friend, tokens.friend), sessionFor(outsider, tokens.outsider)],
    friendships: [{
      _id: new ObjectId(),
      userIdLow: author._id,
      userIdHigh: friend._id,
      createdAt: new Date(now),
    }],
    posts: [
      makePost(ids.onlyMe, author._id, "onlyMe", new Date(now + 3)),
      makePost(ids.friends, author._id, "friends", new Date(now + 2)),
      makePost(ids.public, author._id, "public", new Date(now + 1)),
    ],
  };
  return { data, tokens };
}

test("feed, author timeline, and direct URLs enforce every audience for author, friend, and outsider", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const expectedByViewer = {
    author: [ids.onlyMe, ids.friends, ids.public],
    friend: [ids.friends, ids.public],
    outsider: [ids.public],
  } as const;

  for (const viewer of ["author", "friend", "outsider"] as const) {
    const authCookie = cookie(tokens[viewer]);
    const expected = expectedByViewer[viewer];
    const feed = await request(app).get("/api/posts").set("Cookie", authCookie).expect(200);
    assert.deepEqual(feed.body.items.map((post: { id: string }) => post.id), expected);
    assert.equal(feed.body.nextCursor, null);
    assert.equal(feed.headers["cache-control"], "private, no-store");

    const timeline = await request(app)
      .get(`/api/users/${ids.author}/posts`)
      .set("Cookie", authCookie)
      .expect(200);
    assert.deepEqual(timeline.body.items.map((post: { id: string }) => post.id), expected);

    for (const postId of [ids.onlyMe, ids.friends, ids.public] as const) {
      const visible = expected.includes(postId);
      const detail = await request(app).get(`/api/posts/${postId}`).set("Cookie", authCookie);
      assert.equal(detail.status, visible ? 200 : 404, `${viewer} access to ${postId}`);
      if (visible) {
        assert.equal(detail.body.post.id, postId);
        assert.equal(detail.body.post.author.displayName, "Author");
        assert.equal("email" in detail.body.post.author, false);
        assert.equal("passwordHash" in detail.body.post.author, false);
        assert.equal(detail.headers["cache-control"], "private, no-store");
      } else {
        assert.deepEqual(detail.body, {
          error: { code: "not_found", message: "Post was not found." },
        });
      }
    }
  }

  const hidden = await request(app)
    .get(`/api/posts/${ids.onlyMe}`)
    .set("Cookie", cookie(tokens.outsider));
  const nonexistent = await request(app)
    .get("/api/posts/000000000000000000000099")
    .set("Cookie", cookie(tokens.outsider));
  assert.equal(hidden.status, nonexistent.status);
  assert.deepEqual(hidden.body, nonexistent.body);
});

test("post creation attributes the authenticated author and returns only public author fields", async () => {
  const { data, tokens } = matrixFixture();
  const response = await request(createApp(data))
    .post("/api/posts")
    .set("Cookie", cookie(tokens.friend))
    .send({ text: "  A fresh update  ", visibility: "friends" })
    .expect(201);

  assert.equal(response.body.post.text, "A fresh update");
  assert.equal(response.body.post.visibility, "friends");
  assert.equal(response.body.post.author.id, ids.friend);
  assert.equal("email" in response.body.post.author, false);
  assert.equal("passwordHash" in response.body.post.author, false);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(data.posts.length, 4);
  assert.equal(data.posts.at(-1)?.authorId.toHexString(), ids.friend);
  assert.equal(data.posts.at(-1)?.text, "A fresh update");
});

test("post creation rejects missing, blank, oversized, malformed, or non-text-only fields", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  const authCookie = cookie(tokens.author);
  const invalidBodies = [
    {},
    { text: "   ", visibility: "public" },
    { text: "x".repeat(5_001), visibility: "public" },
    { text: "Valid text", visibility: "private" },
    { text: "Valid text", visibility: "public", authorId: ids.outsider },
    { text: "Valid text", visibility: "public", photoAssetId: "asset-id" },
  ];

  for (const body of invalidBodies) {
    const response = await request(app)
      .post("/api/posts")
      .set("Cookie", authCookie)
      .send(body)
      .expect(400);
    assert.equal(response.body.error.code, "validation_error");
  }

  await request(app).post("/api/posts").send({ text: "Unauthenticated", visibility: "public" }).expect(401);
  assert.equal(data.posts.length, 3);
});

test("two accounts see newly created posts after reloading according to each selected audience", async () => {
  const { data, tokens } = matrixFixture();
  data.posts = [];
  const app = createApp(data);

  for (const visibility of ["public", "friends", "onlyMe"] as const) {
    await request(app)
      .post("/api/posts")
      .set("Cookie", cookie(tokens.author))
      .send({ text: `${visibility} update`, visibility })
      .expect(201);
  }

  const authorFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.author)).expect(200);
  const friendFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.friend)).expect(200);
  const outsiderFeed = await request(app).get("/api/posts").set("Cookie", cookie(tokens.outsider)).expect(200);
  assert.deepEqual(new Set(authorFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "onlyMe update", "friends update", "public update",
  ]));
  assert.deepEqual(new Set(friendFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "friends update", "public update",
  ]));
  assert.deepEqual(new Set(outsiderFeed.body.items.map((post: { text: string }) => post.text)), new Set([
    "public update",
  ]));

  const friendTimeline = await request(app)
    .get(`/api/users/${ids.author}/posts`)
    .set("Cookie", cookie(tokens.friend))
    .expect(200);
  assert.deepEqual(friendTimeline.body.items.map((post: { visibility: string }) => post.visibility), [
    "friends", "public",
  ]);
});

test("feed and author timeline paginate newest first without duplicates", async () => {
  const { data, tokens } = matrixFixture();
  const authorId = new ObjectId(ids.author);
  data.posts = Array.from({ length: 5 }, (_, index) => makePost(
    (100 + index).toString(16).padStart(24, "0"),
    authorId,
    "public",
    new Date(Date.UTC(2026, 9, 1, 0, index)),
  ));
  const app = createApp(data);

  for (const path of ["/api/posts", `/api/users/${ids.author}/posts`]) {
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(app)
        .get(path)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .set("Cookie", cookie(tokens.outsider))
        .expect(200);
      collected.push(...page.body.items.map((post: { id: string }) => post.id));
      cursor = page.body.nextCursor;
    } while (cursor);

    assert.deepEqual(collected, data.posts.toSorted((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right._id.toHexString().localeCompare(left._id.toHexString()),
    ).map((post) => post._id.toHexString()));
    assert.equal(new Set(collected).size, 5);
  }
});

test("author timeline scans past hidden posts to fill a visible page", async () => {
  const { data, tokens } = matrixFixture();
  const authorId = new ObjectId(ids.author);
  const now = Date.now();
  data.posts = Array.from({ length: 25 }, (_, index) => makePost(
    (200 + index).toString(16).padStart(24, "0"),
    authorId,
    "onlyMe",
    new Date(now + (25 - index) * 1_000),
  ));
  data.posts.push(makePost(
    "0000000000000000000002ff",
    authorId,
    "public",
    new Date(now - 60_000),
  ));
  const page = await request(createApp(data))
    .get(`/api/users/${ids.author}/posts?limit=2`)
    .set("Cookie", cookie(tokens.outsider))
    .expect(200);

  assert.deepEqual(page.body.items.map((post: { visibility: string }) => post.visibility), ["public"]);
  assert.equal(page.body.nextCursor, null);
});

test("post reads require a valid session and reject malformed IDs and page queries", async () => {
  const { data, tokens } = matrixFixture();
  const app = createApp(data);
  await request(app).get("/api/posts").expect(401);
  await request(app).get("/api/posts/not-an-object-id").set("Cookie", cookie(tokens.author)).expect(404);
  await request(app).get("/api/users/not-an-object-id/posts").set("Cookie", cookie(tokens.author)).expect(404);
  await request(app).get("/api/posts?limit=51").set("Cookie", cookie(tokens.author)).expect(400);
  await request(app).get("/api/posts?cursor=not-valid!!").set("Cookie", cookie(tokens.author)).expect(400);
  await request(app).get("/api/posts?cursor=YWJj").set("Cookie", cookie(tokens.author)).expect(400);
});
