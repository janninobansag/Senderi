import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { ObjectId, type Db } from "mongodb";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { collectionNames, type SessionDocument, type UserDocument } from "../db/documents";
import { HttpError } from "../errors/http-error";

export const SESSION_COOKIE_NAME = "senderi_session";
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1_000;

export interface AuthenticatedSessionContext {
  sessionId: ObjectId;
  user: UserDocument;
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  database: Db,
  userId: ObjectId,
  createdAt: Date,
  tokenFactory: () => string = createSessionToken,
): Promise<{ token: string; document: SessionDocument }> {
  const token = tokenFactory();
  const document: SessionDocument = {
    _id: new ObjectId(),
    userId,
    tokenHash: hashSessionToken(token),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + SESSION_LIFETIME_MS),
  };

  await database.collection<SessionDocument>(collectionNames.sessions).insertOne(document);
  return { token, document };
}

function secureCookieAttribute(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

export function setSessionCookie(response: Response, token: string): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureCookieAttribute()}`,
  );
}

export function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureCookieAttribute()}`,
  );
}

function readSessionToken(request: Request): string | undefined {
  const cookieHeader = request.get("Cookie");
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;

    if (cookie.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const token = cookie.slice(separator + 1).trim();
      return token || undefined;
    }
  }

  return undefined;
}

export interface RequireSessionDependencies {
  getDatabase: () => Db;
  now: () => Date;
}

export function requireSession(
  overrides: Partial<RequireSessionDependencies> = {},
): RequestHandler {
  const getDatabase = overrides.getDatabase ?? getConnectedDatabase;
  const now = overrides.now ?? (() => new Date());

  return async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    const token = readSessionToken(request);
    if (!token) {
      next(new HttpError(401, "unauthorized", "Authentication is required."));
      return;
    }

    const database = getDatabase();
    const session = await database
      .collection<SessionDocument>(collectionNames.sessions)
      .findOne({ tokenHash: hashSessionToken(token) });
    const currentTime = now();

    if (!session || session.expiresAt.getTime() <= currentTime.getTime()) {
      next(new HttpError(401, "unauthorized", "Authentication is required."));
      return;
    }

    const user = await database
      .collection<UserDocument>(collectionNames.users)
      .findOne({ _id: session.userId });
    if (!user) {
      next(new HttpError(401, "unauthorized", "Authentication is required."));
      return;
    }

    response.locals.authenticatedSession = { sessionId: session._id, user } satisfies AuthenticatedSessionContext;
    next();
  };
}
