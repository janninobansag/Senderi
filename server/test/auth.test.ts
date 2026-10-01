import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import argon2 from "argon2";
import express from "express";
import { ObjectId, type Db } from "mongodb";
import request from "supertest";
import type {
  PasswordResetDocument,
  RateLimitDocument,
  SessionDocument,
  UserDocument,
} from "../src/db/documents";
import { hashPassword } from "../src/auth/password";
import { hashPasswordResetToken, storePasswordResetToken } from "../src/auth/password-reset";
import { SESSION_COOKIE_NAME, hashSessionToken } from "../src/auth/session";
import { createAuthRouter, type AuthRouterDependencies } from "../src/routes/auth";
import { errorHandler } from "../src/middleware/error-handler";
import { notFoundHandler } from "../src/middleware/not-found";
import { sendPasswordResetEmail } from "../src/auth/brevo";

interface MemoryDatabase {
  db: Db;
  users: UserDocument[];
  sessions: SessionDocument[];
  passwordResets: PasswordResetDocument[];
  rateLimits: RateLimitDocument[];
}

function createMemoryDatabase(): MemoryDatabase {
  const users: UserDocument[] = [];
  const sessions: SessionDocument[] = [];
  const passwordResets: PasswordResetDocument[] = [];
  const rateLimits: RateLimitDocument[] = [];

  const collections = {
    users: {
      findOne: async (filter: { email?: string; _id?: ObjectId }) =>
        users.find(
          (storedUser) =>
            (filter.email === undefined || storedUser.email === filter.email) &&
            (filter._id === undefined || storedUser._id.equals(filter._id)),
        ) ?? null,
      insertOne: async (user: UserDocument) => {
        if (users.some((storedUser) => storedUser.email === user.email)) {
          throw Object.assign(new Error("Duplicate email index"), {
            code: 11000,
            keyPattern: { email: 1 },
          });
        }
        users.push(user);
        return { acknowledged: true, insertedId: user._id };
      },
      deleteOne: async ({ _id }: { _id: ObjectId }) => {
        const index = users.findIndex((user) => user._id.equals(_id));
        if (index >= 0) users.splice(index, 1);
        return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
      },
      updateOne: async (
        { _id }: { _id: ObjectId },
        { $set }: { $set: Partial<UserDocument> },
      ) => {
        const user = users.find((storedUser) => storedUser._id.equals(_id));
        if (!user) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        Object.assign(user, $set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      },
    },
    sessions: {
      findOne: async ({ tokenHash }: { tokenHash: string }) =>
        sessions.find((session) => session.tokenHash === tokenHash) ?? null,
      insertOne: async (session: SessionDocument) => {
        sessions.push(session);
        return { acknowledged: true, insertedId: session._id };
      },
      deleteOne: async ({ _id }: { _id: ObjectId }) => {
        const index = sessions.findIndex((session) => session._id.equals(_id));
        if (index >= 0) sessions.splice(index, 1);
        return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
      },
      deleteMany: async ({ userId }: { userId: ObjectId }) => {
        const initialLength = sessions.length;
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          if (sessions[index]!.userId.equals(userId)) sessions.splice(index, 1);
        }
        return { acknowledged: true, deletedCount: initialLength - sessions.length };
      },
    },
    passwordResets: {
      findOne: async (filter: {
        tokenHash?: string;
        expiresAt?: { $gt?: Date };
      }) =>
        passwordResets.find(
          (reset) =>
            (filter.tokenHash === undefined || reset.tokenHash === filter.tokenHash) &&
            (filter.expiresAt?.$gt === undefined || reset.expiresAt > filter.expiresAt.$gt),
        ) ?? null,
      findOneAndDelete: async (filter: { tokenHash: string; expiresAt: { $gt: Date } }) => {
        const index = passwordResets.findIndex(
          (reset) => reset.tokenHash === filter.tokenHash && reset.expiresAt > filter.expiresAt.$gt,
        );
        if (index < 0) return null;
        return passwordResets.splice(index, 1)[0] ?? null;
      },
      insertOne: async (reset: PasswordResetDocument) => {
        if (passwordResets.some((storedReset) => storedReset.userId.equals(reset.userId))) {
          throw Object.assign(new Error("Duplicate reset per user index"), { code: 11000 });
        }
        passwordResets.push(reset);
        return { acknowledged: true, insertedId: reset._id };
      },
      deleteOne: async ({ _id }: { _id: ObjectId }) => {
        const index = passwordResets.findIndex((reset) => reset._id.equals(_id));
        if (index >= 0) passwordResets.splice(index, 1);
        return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
      },
      deleteMany: async ({ userId }: { userId: ObjectId }) => {
        const initialLength = passwordResets.length;
        for (let index = passwordResets.length - 1; index >= 0; index -= 1) {
          if (passwordResets[index]!.userId.equals(userId)) passwordResets.splice(index, 1);
        }
        return { acknowledged: true, deletedCount: initialLength - passwordResets.length };
      },
    },
    rateLimits: {
      updateOne: async (
        { _id, count: countFilter }: { _id: string; count?: { $gt: number } },
        update: {
          $inc?: { count: number };
          $setOnInsert?: Pick<RateLimitDocument, "createdAt" | "expiresAt">;
          $set?: Pick<RateLimitDocument, "count" | "createdAt" | "expiresAt">;
        },
        options?: { upsert?: boolean },
      ) => {
        const counter = rateLimits.find((storedCounter) => storedCounter._id === _id);
        if (counter) {
          if (countFilter && counter.count <= countFilter.$gt) {
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
          }
          if (update.$set) Object.assign(counter, update.$set);
          if (update.$inc) counter.count += update.$inc.count;
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (!options?.upsert) {
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }
        const insertedCounter: RateLimitDocument = {
          _id,
          count: update.$set?.count ?? update.$inc?.count ?? 0,
          createdAt: update.$set?.createdAt ?? update.$setOnInsert?.createdAt ?? new Date(0),
          expiresAt: update.$set?.expiresAt ?? update.$setOnInsert?.expiresAt ?? new Date(0),
        };
        rateLimits.push(insertedCounter);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      },
      findOne: async ({ _id }: { _id: string }) => rateLimits.find((counter) => counter._id === _id) ?? null,
    },
  };

  const db = {
    collection: (name: keyof typeof collections) => collections[name],
  } as unknown as Db;

  return { db, users, sessions, passwordResets, rateLimits };
}

function createTestApp(
  database: MemoryDatabase,
  overrides: Partial<AuthRouterDependencies> = {},
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      getDatabase: () => database.db,
      createSessionToken: () => "test-session-token",
      createPasswordResetToken: () => "test-password-reset-token",
      getPublicAppUrl: () => "http://localhost:5173",
      now: () => new Date("2026-09-30T00:00:00.000Z"),
      getAllowedOrigins: () => ["http://localhost:5173"],
      ...overrides,
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function addUser(
  database: MemoryDatabase,
  email = "member@example.com",
  password = "correct horse battery staple",
): Promise<UserDocument> {
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  const user: UserDocument = {
    _id: new ObjectId(),
    email,
    passwordHash: await hashPassword(password),
    displayName: "Member Example",
    bio: "",
    info: {},
    createdAt,
    updatedAt: createdAt,
  };
  database.users.push(user);
  return user;
}

test("registration normalizes email, stores an Argon2id hash, and returns only the public user", async () => {
  const database = createMemoryDatabase();
  const app = createTestApp(database);
  const password = "a long and private passphrase";

  const response = await request(app).post("/api/auth/register").set("Origin", "http://localhost:5173").send({
    email: "  Ada.Lovelace@Example.com  ",
    password,
    displayName: "  Ada Lovelace  ",
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, "ada.lovelace@example.com");
  assert.equal(response.body.user.displayName, "Ada Lovelace");
  assert.equal("password" in response.body.user, false);
  assert.equal("passwordHash" in response.body.user, false);
  assert.equal(database.users.length, 1);
  assert.equal(database.sessions.length, 1);

  const storedUser = database.users[0]!;
  assert.equal(storedUser.email, "ada.lovelace@example.com");
  assert.notEqual(storedUser.passwordHash, password);
  assert.equal(storedUser.passwordHash.includes(password), false);
  assert.equal(storedUser.displayName, "Ada Lovelace");
  assert.equal(storedUser.bio, "");
  assert.deepEqual(storedUser.info, {});
  assert.equal(await argon2.verify(storedUser.passwordHash, password), true);
  assert.match(storedUser.passwordHash, /^\$argon2id\$/);

  const storedSession = database.sessions[0]!;
  assert.equal(storedSession.userId.toHexString(), storedUser._id.toHexString());
  assert.equal(
    storedSession.tokenHash,
    createHash("sha256").update("test-session-token").digest("hex"),
  );
  assert.equal(storedSession.tokenHash.includes("test-session-token"), false);
  assert.equal(storedSession.expiresAt.toISOString(), "2026-10-07T00:00:00.000Z");

  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(cookie?.includes("senderi_session=test-session-token"));
  assert.ok(cookie?.includes("Path=/api"));
  assert.ok(cookie?.includes("HttpOnly"));
  assert.ok(cookie?.includes("SameSite=Lax"));
  assert.equal(response.headers["cache-control"], "private, no-store");
});

test("registration rejects a duplicate normalized email with a conflict response", async () => {
  const database = createMemoryDatabase();
  let hashCalls = 0;
  const app = createTestApp(database, {
    hashPassword: async () => {
      hashCalls += 1;
      return "$argon2id$test-hash";
    },
  });

  const first = await request(app).post("/api/auth/register").set("Origin", "http://localhost:5173").send({
    email: "Person@Example.com",
    password: "a valid passphrase",
    displayName: "Person One",
  });
  const duplicate = await request(app).post("/api/auth/register").set("Origin", "http://localhost:5173").send({
    email: "  PERSON@example.com ",
    password: "another valid passphrase",
    displayName: "Person Two",
  });

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, {
    error: {
      code: "email_already_exists",
      message: "An account with this email already exists.",
    },
  });
  assert.equal(database.users.length, 1);
  assert.equal(database.sessions.length, 1);
  assert.equal(hashCalls, 1);
});

test("registration rejects invalid email, display name, and password before hashing or storage", async () => {
  const database = createMemoryDatabase();
  let hashCalls = 0;
  const app = createTestApp(database, {
    hashPassword: async () => {
      hashCalls += 1;
      return "$argon2id$test-hash";
    },
  });
  const invalidInputs = [
    { email: "not-an-email", password: "long enough password", displayName: "Person" },
    { email: "person@example.com", password: "short", displayName: "Person" },
    { email: "person@example.com", password: "long enough password", displayName: "   " },
    { email: "person@example.com", password: "p".repeat(129), displayName: "Person" },
    { email: "person@example.com", password: "long enough password", displayName: "x".repeat(81) },
  ];

  for (const input of invalidInputs) {
    const response = await request(app)
      .post("/api/auth/register")
      .set("Origin", "http://localhost:5173")
      .send(input);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "validation_error");
  }

  assert.equal(hashCalls, 0);
  assert.equal(database.users.length, 0);
  assert.equal(database.sessions.length, 0);
});

test("registration rejects an origin outside the client allowlist", async () => {
  const database = createMemoryDatabase();
  let hashCalls = 0;
  const app = createTestApp(database, {
    hashPassword: async () => {
      hashCalls += 1;
      return "$argon2id$test-hash";
    },
  });

  const response = await request(app)
    .post("/api/auth/register")
    .set("Origin", "https://unexpected.example")
    .send({ email: "person@example.com", password: "long enough password", displayName: "Person" });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "origin_not_allowed");
  assert.equal(hashCalls, 0);
  assert.equal(database.users.length, 0);
});

test("login verifies a password and the session survives a separate request", async () => {
  const database = createMemoryDatabase();
  const user = await addUser(database);
  const app = createTestApp(database);
  const agent = request.agent(app);

  const login = await agent
    .post("/api/auth/login")
    .set("Origin", "http://localhost:5173")
    .send({ email: " MEMBER@Example.com ", password: "correct horse battery staple" });

  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, user._id.toHexString());
  assert.equal("passwordHash" in login.body.user, false);
  assert.equal(database.sessions.length, 1);
  assert.equal(database.sessions[0]!.tokenHash, hashSessionToken("test-session-token"));

  const currentUser = await agent.get("/api/auth/me");
  assert.equal(currentUser.status, 200);
  assert.equal(currentUser.body.user.email, "member@example.com");
  assert.equal(currentUser.body.user.displayName, "Member Example");
  assert.equal("passwordHash" in currentUser.body.user, false);
});

test("wrong and unknown login credentials return the same response without issuing a session", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  const app = createTestApp(database);

  const wrongPassword = await request(app)
    .post("/api/auth/login")
    .set("Origin", "http://localhost:5173")
    .send({ email: "member@example.com", password: "incorrect password" });
  const unknownEmail = await request(app)
    .post("/api/auth/login")
    .set("Origin", "http://localhost:5173")
    .send({ email: "unknown@example.com", password: "incorrect password" });

  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(wrongPassword.body, unknownEmail.body);
  assert.deepEqual(wrongPassword.body, {
    error: {
      code: "invalid_credentials",
      message: "Email or password is incorrect.",
    },
  });
  assert.equal(database.sessions.length, 0);
  assert.equal(wrongPassword.headers["set-cookie"], undefined);
});

test("login email failures are throttled before password verification and recover after cooldown", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  let currentTime = new Date("2026-09-30T00:00:00.000Z");
  let verificationCalls = 0;
  const app = createTestApp(database, {
    now: () => currentTime,
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    verifyPassword: async (password) => {
      verificationCalls += 1;
      return password === "correct horse battery staple";
    },
  });
  const login = (password: string, ip: string) =>
    request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:5173")
      .set("x-test-client-ip", ip)
      .send({ email: " MEMBER@Example.com ", password });

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await login("incorrect password", `email-test-ip-${index}`)).status, 401);
  }
  assert.equal(verificationCalls, 5);
  assert.ok(database.rateLimits.some((counter) => counter._id.startsWith("login:email:")));
  assert.ok(database.rateLimits.every((counter) => !counter._id.includes("member@example.com")));

  const blocked = await login("correct horse battery staple", "email-test-ip-after-limit");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "rate_limited");
  assert.equal(blocked.headers["retry-after"], "900");
  assert.equal(verificationCalls, 5);
  assert.equal(database.sessions.length, 0);

  currentTime = new Date("2026-09-30T00:15:00.000Z");
  const recovered = await login("correct horse battery staple", "email-test-ip-after-cooldown");
  assert.equal(recovered.status, 200);
  assert.equal(verificationCalls, 6);
  assert.equal(database.sessions.length, 1);
});

test("login source-IP failures are throttled across accounts and recover after cooldown", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  let currentTime = new Date("2026-09-30T00:00:00.000Z");
  let verificationCalls = 0;
  const app = createTestApp(database, {
    now: () => currentTime,
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    verifyPassword: async (password) => {
      verificationCalls += 1;
      return password === "correct horse battery staple";
    },
  });
  const login = (email: string, ip: string, password = "incorrect password") =>
    request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:5173")
      .set("x-test-client-ip", ip)
      .send({ email, password });

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await login(`unknown-${index}@example.com`, "shared-login-ip")).status, 401);
  }
  assert.ok(database.rateLimits.some((counter) => counter._id.startsWith("login:ip:")));
  assert.ok(database.rateLimits.every((counter) => !counter._id.includes("shared-login-ip")));

  const blocked = await login("member@example.com", "shared-login-ip", "correct horse battery staple");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "rate_limited");
  assert.equal(blocked.headers["retry-after"], "900");
  assert.equal(verificationCalls, 0);
  assert.equal(database.sessions.length, 0);

  currentTime = new Date("2026-09-30T00:15:00.000Z");
  const recovered = await login("member@example.com", "shared-login-ip", "correct horse battery staple");
  assert.equal(recovered.status, 200);
  assert.equal(verificationCalls, 1);
  assert.equal(database.sessions.length, 1);
});

test("expired sessions are denied even before MongoDB TTL cleanup", async () => {
  const database = createMemoryDatabase();
  const user = await addUser(database);
  const expiredToken = "expired-session-token";
  database.sessions.push({
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(expiredToken),
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    expiresAt: new Date("2026-09-28T00:00:00.000Z"),
  });
  const app = createTestApp(database);

  const response = await request(app)
    .get("/api/auth/me")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${expiredToken}`);

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "unauthorized");
});

test("logout deletes the session and clears its cookie", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  const agent = request.agent(createTestApp(database));
  const login = await agent
    .post("/api/auth/login")
    .set("Origin", "http://localhost:5173")
    .send({ email: "member@example.com", password: "correct horse battery staple" });
  assert.equal(login.status, 200);
  assert.equal(database.sessions.length, 1);

  const logout = await agent.post("/api/auth/logout").set("Origin", "http://localhost:5173");
  assert.equal(logout.status, 204);
  assert.equal(database.sessions.length, 0);
  const clearedCookie = logout.headers["set-cookie"];
  const cookie = Array.isArray(clearedCookie) ? clearedCookie[0] : clearedCookie;
  assert.ok(cookie?.includes(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cookie?.includes("Max-Age=0"));

  const afterLogout = await agent.get("/api/auth/me");
  assert.equal(afterLogout.status, 401);
});

test("forgot password gives known and unknown emails the same response and stores only a 15-minute token hash", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  const sentEmails: Array<{ email: string; resetUrl: string }> = [];
  const app = createTestApp(database, {
    sendPasswordResetEmail: async (email) => {
      sentEmails.push(email);
    },
  });

  const known = await request(app)
    .post("/api/auth/forgot-password")
    .set("Origin", "http://localhost:5173")
    .send({ email: " MEMBER@Example.com " });
  const unknown = await request(app)
    .post("/api/auth/forgot-password")
    .set("Origin", "http://localhost:5173")
    .send({ email: "nobody@example.com" });

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(known.headers["cache-control"], "private, no-store");
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0]!.email, "member@example.com");
  const resetUrl = new URL(sentEmails[0]!.resetUrl);
  assert.equal(resetUrl.origin, "http://localhost:5173");
  assert.equal(resetUrl.pathname, "/reset-password");
  assert.equal(resetUrl.searchParams.get("token"), "test-password-reset-token");

  assert.equal(database.passwordResets.length, 1);
  assert.equal(
    database.passwordResets[0]!.tokenHash,
    hashPasswordResetToken("test-password-reset-token"),
  );
  assert.equal(database.passwordResets[0]!.tokenHash.includes("test-password-reset-token"), false);
  assert.equal(database.passwordResets[0]!.expiresAt.toISOString(), "2026-09-30T00:15:00.000Z");
  assert.ok(database.rateLimits.every((counter) => !counter._id.includes("member@example.com")));
});

test("Brevo adapter sends the configured sender, template ID, and resetUrl parameter", async () => {
  let sentUrl: string | undefined;
  let sentHeaders: Headers | undefined;
  let sentPayload: unknown;

  await sendPasswordResetEmail(
    { email: "member@example.com", resetUrl: "https://senderi.example/reset-password?token=one-time" },
    {
      apiKey: "test-api-key",
      senderEmail: "verified@senderi.example",
      templateId: 42,
      fetch: async (input, init) => {
        sentUrl = String(input);
        sentHeaders = new Headers(init?.headers);
        sentPayload = JSON.parse(String(init?.body)) as unknown;
        return new Response(null, { status: 201 });
      },
    },
  );

  assert.equal(sentUrl, "https://api.brevo.com/v3/smtp/email");
  assert.equal(sentHeaders?.get("api-key"), "test-api-key");
  assert.deepEqual(sentPayload, {
    sender: { email: "verified@senderi.example", name: "Senderi" },
    to: [{ email: "member@example.com" }],
    templateId: 42,
    params: { resetUrl: "https://senderi.example/reset-password?token=one-time" },
  });
});

test("Brevo failure stays generic and removes the unsent reset token", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  const app = createTestApp(database, {
    sendPasswordResetEmail: async () => {
      throw new Error("provider rejected request");
    },
  });
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const known = await request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:5173")
      .send({ email: "member@example.com" });
    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:5173")
      .send({ email: "nobody@example.com" });

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(database.passwordResets.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("reset consumes a token once, changes the Argon2id hash, and invalidates every session", async () => {
  const database = createMemoryDatabase();
  const user = await addUser(database);
  const token = "single-use-password-reset-token";
  const sessionToken = "pre-reset-session-token";
  database.sessions.push({
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashSessionToken(sessionToken),
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    expiresAt: new Date("2026-10-06T00:00:00.000Z"),
  });
  await storePasswordResetToken(database.db, user._id, token, new Date("2026-09-30T00:00:00.000Z"));
  const app = createTestApp(database);

  const reset = await request(app)
    .post("/api/auth/reset-password")
    .set("Origin", "http://localhost:5173")
    .send({ token, newPassword: "brand new secure passphrase" });

  assert.equal(reset.status, 204);
  assert.match(user.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(user.passwordHash, "brand new secure passphrase"), true);
  assert.equal(await argon2.verify(user.passwordHash, "correct horse battery staple"), false);
  assert.equal(database.sessions.length, 0);
  assert.equal(database.passwordResets.length, 0);
  assert.equal(reset.headers["cache-control"], "private, no-store");
  const clearedCookie = reset.headers["set-cookie"];
  const cookie = Array.isArray(clearedCookie) ? clearedCookie[0] : clearedCookie;
  assert.ok(cookie?.includes(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cookie?.includes("Max-Age=0"));

  const oldSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", `${SESSION_COOKIE_NAME}=${sessionToken}`);
  assert.equal(oldSession.status, 401);

  const reused = await request(app)
    .post("/api/auth/reset-password")
    .set("Origin", "http://localhost:5173")
    .send({ token, newPassword: "another secure password" });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.error.code, "invalid_reset_token");
});

test("concurrent reset submissions atomically allow only one token consumer", async () => {
  const database = createMemoryDatabase();
  const user = await addUser(database);
  const token = "concurrent-single-use-reset-token";
  await storePasswordResetToken(database.db, user._id, token, new Date("2026-09-30T00:00:00.000Z"));
  const app = createTestApp(database);
  const submit = (newPassword: string) =>
    request(app)
      .post("/api/auth/reset-password")
      .set("Origin", "http://localhost:5173")
      .send({ token, newPassword });

  const results = await Promise.all([
    submit("first replacement passphrase"),
    submit("second replacement passphrase"),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [204, 400]);
  assert.equal(database.passwordResets.length, 0);
  const firstPasswordWasSet = await argon2.verify(user.passwordHash, "first replacement passphrase");
  const secondPasswordWasSet = await argon2.verify(user.passwordHash, "second replacement passphrase");
  assert.equal(firstPasswordWasSet || secondPasswordWasSet, true);
});

test("expired and invalid reset tokens are denied and failed checks are rate limited", async () => {
  const database = createMemoryDatabase();
  const user = await addUser(database);
  const expiredToken = "expired-password-reset-token";
  database.passwordResets.push({
    _id: new ObjectId(),
    userId: user._id,
    tokenHash: hashPasswordResetToken(expiredToken),
    createdAt: new Date("2026-09-29T23:00:00.000Z"),
    expiresAt: new Date("2026-09-29T23:15:00.000Z"),
  });
  const app = createTestApp(database, {
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    rateLimits: { resetFailuresPerIpPer15Minutes: 2 },
  });

  const firstFailure = await request(app)
    .post("/api/auth/reset-password")
    .set("Origin", "http://localhost:5173")
    .set("x-test-client-ip", "198.51.100.1")
    .send({ token: "invalid-but-well-formed-reset-token", newPassword: "new secure passphrase" });
  const blockedFailure = await request(app)
    .post("/api/auth/reset-password")
    .set("Origin", "http://localhost:5173")
    .set("x-test-client-ip", "198.51.100.1")
    .send({ token: expiredToken, newPassword: "new secure passphrase" });
  const rateLimitedFailure = await request(app)
    .post("/api/auth/reset-password")
    .set("Origin", "http://localhost:5173")
    .set("x-test-client-ip", "198.51.100.1")
    .send({ token: "another-invalid-reset-token-value", newPassword: "new secure passphrase" });

  assert.equal(firstFailure.status, 400);
  assert.equal(firstFailure.body.error.code, "invalid_reset_token");
  assert.equal(blockedFailure.status, 400);
  assert.deepEqual(blockedFailure.body, firstFailure.body);
  assert.equal(rateLimitedFailure.status, 429);
  assert.equal(rateLimitedFailure.body.error.code, "rate_limited");
  assert.equal(rateLimitedFailure.headers["retry-after"], "900");
  assert.equal(user.passwordHash.includes("new secure passphrase"), false);
  assert.equal(database.passwordResets.length, 1);
});

test("forgot-password email and IP limits apply before account lookup with consistent responses", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  const app = createTestApp(database, {
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    sendPasswordResetEmail: async () => undefined,
  });
  const forgot = (email: string, ip: string) =>
    request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:5173")
      .set("x-test-client-ip", ip)
      .send({ email });

  const knownAttempts = [];
  const unknownAttempts = [];
  for (let index = 0; index < 4; index += 1) {
    knownAttempts.push(await forgot("member@example.com", `known-ip-${index}`));
    unknownAttempts.push(await forgot("nobody@example.com", `unknown-ip-${index}`));
  }
  assert.deepEqual(knownAttempts.map((response) => response.status), [202, 202, 202, 429]);
  assert.deepEqual(unknownAttempts.map((response) => response.status), [202, 202, 202, 429]);
  assert.deepEqual(knownAttempts[3]!.body, unknownAttempts[3]!.body);
  assert.equal(knownAttempts[3]!.headers["retry-after"], unknownAttempts[3]!.headers["retry-after"]);

  const sharedIpResponses = [];
  for (let index = 0; index < 4; index += 1) {
    sharedIpResponses.push(await forgot(`other-${index}@example.com`, "shared-ip"));
  }
  assert.deepEqual(sharedIpResponses.map((response) => response.status), [202, 202, 202, 429]);
  assert.equal(sharedIpResponses[3]!.headers["retry-after"], "3600");
});

test("forgot-password email and IP counters expire at the next UTC-hour window", async () => {
  const database = createMemoryDatabase();
  await addUser(database);
  let currentTime = new Date("2026-09-30T00:00:00.000Z");
  const app = createTestApp(database, {
    now: () => currentTime,
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    sendPasswordResetEmail: async () => undefined,
  });
  const forgot = () =>
    request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:5173")
      .set("x-test-client-ip", "same-ip")
      .send({ email: "member@example.com" });

  for (let index = 0; index < 3; index += 1) assert.equal((await forgot()).status, 202);
  assert.equal((await forgot()).status, 429);
  currentTime = new Date("2026-09-30T01:00:00.000Z");
  assert.equal((await forgot()).status, 202);
});

test("development Brevo send cap applies across accounts without changing the generic response", async () => {
  const database = createMemoryDatabase();
  await addUser(database, "first@example.com");
  await addUser(database, "second@example.com");
  const sentEmails: string[] = [];
  const app = createTestApp(database, {
    getEnvironment: () => "development",
    getClientIp: (request) => request.get("x-test-client-ip") ?? "test-ip",
    rateLimits: { developmentBrevoSendsPerDay: 1 },
    sendPasswordResetEmail: async ({ email }) => {
      sentEmails.push(email);
    },
  });
  const forgot = (email: string, ip: string) =>
    request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:5173")
      .set("x-test-client-ip", ip)
      .send({ email });

  const first = await forgot("first@example.com", "first-ip");
  const cappedKnown = await forgot("second@example.com", "second-ip");
  const unknown = await forgot("unknown@example.com", "unknown-ip");

  assert.deepEqual([first.status, cappedKnown.status, unknown.status], [202, 202, 202]);
  assert.deepEqual(first.body, cappedKnown.body);
  assert.deepEqual(cappedKnown.body, unknown.body);
  assert.deepEqual(sentEmails, ["first@example.com"]);
  assert.equal(database.passwordResets.length, 1);
});
