import { ObjectId, type Db } from "mongodb";
import { Router, type Request } from "express";
import { z } from "zod";
import { collectionNames, type UserDocument } from "../db/documents";
import { getDatabase as getConnectedDatabase } from "../db/client";
import { HttpError } from "../errors/http-error";
import { requireClientOrigin } from "../middleware/require-client-origin";
import { validateBody } from "../middleware/validate-body";
import { hashPassword as hashArgon2idPassword, verifyPassword as verifyArgon2idPassword } from "../auth/password";
import {
  clearSessionCookie,
  createSession,
  createSessionToken,
  requireSession,
  setSessionCookie,
  type AuthenticatedSessionContext,
} from "../auth/session";
import { toAuthUserResponse } from "../auth/user-response";
import { sendPasswordResetEmail } from "../auth/brevo";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  findUsablePasswordResetToken,
  storePasswordResetToken,
} from "../auth/password-reset";
import {
  createRateLimitId,
  createRateLimitKey,
  DAY_MS,
  FIFTEEN_MINUTES_MS,
  HOUR_MS,
  getRateLimitCooldownSeconds,
  incrementRateLimit,
  releaseRateLimitAttempt,
  startRateLimitCooldown,
} from "../auth/rate-limit";

const normalizedEmailSchema = z.string().trim().max(254).toLowerCase().pipe(z.email());

export const registrationSchema = z
  .object({
    email: normalizedEmailSchema,
    password: z.string().min(12).max(128),
    displayName: z.string().trim().min(1).max(80),
  })
  .strict();

export const loginSchema = z
  .object({
    email: normalizedEmailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export const forgotPasswordSchema = z.object({ email: normalizedEmailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/),
    newPassword: z.string().min(12).max(128),
  })
  .strict();

type RegistrationInput = z.infer<typeof registrationSchema>;
type LoginInput = z.infer<typeof loginSchema>;
type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export interface AuthRateLimits {
  loginFailuresPerEmailPer15Minutes: number;
  loginFailuresPerIpPer15Minutes: number;
  forgotPerEmailPerHour: number;
  forgotPerIpPerHour: number;
  developmentBrevoSendsPerDay: number;
  resetFailuresPerIpPer15Minutes: number;
}

const DEFAULT_RATE_LIMITS: AuthRateLimits = {
  loginFailuresPerEmailPer15Minutes: 5,
  loginFailuresPerIpPer15Minutes: 5,
  forgotPerEmailPerHour: 3,
  forgotPerIpPerHour: 3,
  developmentBrevoSendsPerDay: 100,
  resetFailuresPerIpPer15Minutes: 5,
};

export interface AuthRouterDependencies {
  getDatabase: () => Db;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, passwordHash: string) => Promise<boolean>;
  createSessionToken: () => string;
  createPasswordResetToken: () => string;
  sendPasswordResetEmail: (input: { email: string; resetUrl: string }) => Promise<void>;
  getPublicAppUrl: () => string;
  getEnvironment: () => string;
  getClientIp: (request: Request) => string;
  rateLimits: AuthRateLimits;
  now: () => Date;
  getAllowedOrigins: () => readonly string[];
}

const defaultDependencies: AuthRouterDependencies = {
  getDatabase: getConnectedDatabase,
  hashPassword: hashArgon2idPassword,
  verifyPassword: verifyArgon2idPassword,
  createSessionToken,
  createPasswordResetToken,
  sendPasswordResetEmail,
  getPublicAppUrl: () => process.env.PUBLIC_APP_URL ?? "",
  getEnvironment: () => process.env.NODE_ENV ?? "development",
  getClientIp: (request) => request.ip || request.socket.remoteAddress || "unknown",
  rateLimits: DEFAULT_RATE_LIMITS,
  now: () => new Date(),
  getAllowedOrigins: () =>
    (process.env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
};

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export function createAuthRouter(
  overrides: Partial<AuthRouterDependencies> = {},
): Router {
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...overrides.rateLimits },
  };
  const router = Router();

  router.post(
    "/register",
    requireClientOrigin(dependencies.getAllowedOrigins),
    validateBody(registrationSchema),
    async (request, response) => {
      const { email, password, displayName } = request.body as RegistrationInput;
      const database = dependencies.getDatabase();
      const users = database.collection<UserDocument>(collectionNames.users);
      const createdAt = dependencies.now();
      const existingUser = await users.findOne({ email }, { projection: { _id: 1 } });
      if (existingUser) {
        throw new HttpError(409, "email_already_exists", "An account with this email already exists.");
      }

      const user: UserDocument = {
        _id: new ObjectId(),
        email,
        passwordHash: await dependencies.hashPassword(password),
        displayName,
        bio: "",
        info: {},
        createdAt,
        updatedAt: createdAt,
      };

      try {
        await users.insertOne(user);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new HttpError(409, "email_already_exists", "An account with this email already exists.");
        }
        throw error;
      }

      let sessionToken: string;
      try {
        const session = await createSession(
          database,
          user._id,
          createdAt,
          dependencies.createSessionToken,
        );
        sessionToken = session.token;
      } catch (error) {
        await users.deleteOne({ _id: user._id }).catch(() => undefined);
        throw error;
      }

      response.setHeader("Cache-Control", "private, no-store");
      setSessionCookie(response, sessionToken);
      response.status(201).json({ user: toAuthUserResponse(user) });
    },
  );

  router.post(
    "/login",
    requireClientOrigin(dependencies.getAllowedOrigins),
    validateBody(loginSchema),
    async (request, response) => {
      const { email, password } = request.body as LoginInput;
      const database = dependencies.getDatabase();
      const now = dependencies.now();
      const clientIp = dependencies.getClientIp(request);
      const emailCooldownId = createRateLimitId("login:cooldown:email", email);
      const ipCooldownId = createRateLimitId("login:cooldown:ip", clientIp);
      const emailKey = createRateLimitKey("login:email", email, now, FIFTEEN_MINUTES_MS);
      const ipKey = createRateLimitKey("login:ip", clientIp, now, FIFTEEN_MINUTES_MS);
      response.setHeader("Cache-Control", "private, no-store");

      const [emailCooldown, ipCooldown] = await Promise.all([
        getRateLimitCooldownSeconds(database, emailCooldownId, now),
        getRateLimitCooldownSeconds(database, ipCooldownId, now),
      ]);
      if (emailCooldown !== null || ipCooldown !== null) {
        response.setHeader(
          "Retry-After",
          String(Math.max(emailCooldown ?? 0, ipCooldown ?? 0)),
        );
        throw new HttpError(429, "rate_limited", "Too many login attempts. Please try again later.");
      }

      // Reserve both attempt slots before account lookup or Argon2 verification.
      const [emailAttempt, ipAttempt] = await Promise.all([
        incrementRateLimit(
          database,
          emailKey.id,
          emailKey.expiresAt,
          dependencies.rateLimits.loginFailuresPerEmailPer15Minutes,
          now,
        ),
        incrementRateLimit(
          database,
          ipKey.id,
          ipKey.expiresAt,
          dependencies.rateLimits.loginFailuresPerIpPer15Minutes,
          now,
        ),
      ]);

      if (!emailAttempt.allowed || !ipAttempt.allowed) {
        const releases = [];
        if (emailAttempt.allowed) releases.push(releaseRateLimitAttempt(database, emailKey.id));
        if (ipAttempt.allowed) releases.push(releaseRateLimitAttempt(database, ipKey.id));
        await Promise.all(releases);
        response.setHeader(
          "Retry-After",
          String(Math.max(emailAttempt.retryAfterSeconds, ipAttempt.retryAfterSeconds)),
        );
        throw new HttpError(429, "rate_limited", "Too many login attempts. Please try again later.");
      }

      let user: UserDocument | null;
      let passwordMatches: boolean;
      try {
        user = await database.collection<UserDocument>(collectionNames.users).findOne({ email });
        passwordMatches = user
          ? await dependencies.verifyPassword(password, user.passwordHash)
          : false;
      } catch (error) {
        await Promise.all([
          releaseRateLimitAttempt(database, emailKey.id),
          releaseRateLimitAttempt(database, ipKey.id),
        ]).catch(() => undefined);
        throw error;
      }

      if (!user || !passwordMatches) {
        const cooldowns = [];
        if (emailAttempt.count >= dependencies.rateLimits.loginFailuresPerEmailPer15Minutes) {
          cooldowns.push(
            startRateLimitCooldown(database, emailCooldownId, now, FIFTEEN_MINUTES_MS),
          );
        }
        if (ipAttempt.count >= dependencies.rateLimits.loginFailuresPerIpPer15Minutes) {
          cooldowns.push(startRateLimitCooldown(database, ipCooldownId, now, FIFTEEN_MINUTES_MS));
        }
        await Promise.all(cooldowns);
        throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
      }

      await Promise.all([
        releaseRateLimitAttempt(database, emailKey.id),
        releaseRateLimitAttempt(database, ipKey.id),
      ]);

      const session = await createSession(
        database,
        user._id,
        now,
        dependencies.createSessionToken,
      );
      setSessionCookie(response, session.token);
      response.status(200).json({ user: toAuthUserResponse(user) });
    },
  );

  router.post(
    "/forgot-password",
    requireClientOrigin(dependencies.getAllowedOrigins),
    validateBody(forgotPasswordSchema),
    async (request, response) => {
      const { email } = request.body as ForgotPasswordInput;
      const database = dependencies.getDatabase();
      const now = dependencies.now();
      const clientIp = dependencies.getClientIp(request);
      response.setHeader("Cache-Control", "private, no-store");

      // Apply both limits before looking up the account so the response cannot
      // reveal whether the submitted email belongs to a Senderi user.
      const emailKey = createRateLimitKey("forgot:email", email, now, HOUR_MS);
      const ipKey = createRateLimitKey("forgot:ip", clientIp, now, HOUR_MS);
      const [emailLimit, ipLimit] = await Promise.all([
        incrementRateLimit(
          database,
          emailKey.id,
          emailKey.expiresAt,
          dependencies.rateLimits.forgotPerEmailPerHour,
          now,
        ),
        incrementRateLimit(
          database,
          ipKey.id,
          ipKey.expiresAt,
          dependencies.rateLimits.forgotPerIpPerHour,
          now,
        ),
      ]);

      if (!emailLimit.allowed || !ipLimit.allowed) {
        response.setHeader(
          "Retry-After",
          String(Math.max(emailLimit.retryAfterSeconds, ipLimit.retryAfterSeconds)),
        );
        throw new HttpError(429, "rate_limited", "Please wait before requesting another password reset.");
      }

      const genericResponse = {
        message: "If an account exists for this email, a password reset link will be sent.",
      };
      const user = await database
        .collection<UserDocument>(collectionNames.users)
        .findOne({ email }, { projection: { _id: 1, email: 1 } });

      if (!user) {
        response.status(202).json(genericResponse);
        return;
      }

      if (dependencies.getEnvironment() === "development") {
        const dayKey = createRateLimitKey("forgot:global-development", "all", now, DAY_MS);
        const dailyLimit = await incrementRateLimit(
          database,
          dayKey.id,
          dayKey.expiresAt,
          dependencies.rateLimits.developmentBrevoSendsPerDay,
          now,
        );
        if (!dailyLimit.allowed) {
          response.status(202).json(genericResponse);
          return;
        }
      }

      const token = dependencies.createPasswordResetToken();
      let resetRecordId: ObjectId | undefined;
      try {
        const resetRecord = await storePasswordResetToken(database, user._id, token, now);
        resetRecordId = resetRecord._id;
        const resetUrl = new URL("/reset-password", dependencies.getPublicAppUrl());
        resetUrl.searchParams.set("token", token);
        await dependencies.sendPasswordResetEmail({ email: user.email, resetUrl: resetUrl.toString() });
      } catch {
        if (resetRecordId) {
          await database
            .collection(collectionNames.passwordResets)
            .deleteOne({ _id: resetRecordId })
            .catch(() => undefined);
        }
        // Provider/configuration errors must not reveal whether this email exists.
        console.error("Password reset email delivery failed.");
      }

      response.status(202).json(genericResponse);
    },
  );

  router.post(
    "/reset-password",
    requireClientOrigin(dependencies.getAllowedOrigins),
    validateBody(resetPasswordSchema),
    async (request, response) => {
      const { token, newPassword } = request.body as ResetPasswordInput;
      const database = dependencies.getDatabase();
      const now = dependencies.now();
      const clientIp = dependencies.getClientIp(request);
      const resetFailureKey = createRateLimitKey("reset:ip", clientIp, now, FIFTEEN_MINUTES_MS);
      const invalidToken = async (): Promise<never> => {
        const attempt = await incrementRateLimit(
          database,
          resetFailureKey.id,
          resetFailureKey.expiresAt,
          dependencies.rateLimits.resetFailuresPerIpPer15Minutes,
          now,
        );
        if (!attempt.allowed) {
          response.setHeader("Retry-After", String(attempt.retryAfterSeconds));
          throw new HttpError(429, "rate_limited", "Too many password reset attempts. Please try again later.");
        }
        throw new HttpError(400, "invalid_reset_token", "Reset token is invalid or expired.");
      };

      response.setHeader("Cache-Control", "private, no-store");
      const pendingReset = await findUsablePasswordResetToken(database, token, now);
      if (!pendingReset) await invalidToken();

      const passwordHash = await dependencies.hashPassword(newPassword);
      const consumedReset = await consumePasswordResetToken(database, token, now);
      if (!consumedReset) {
        await invalidToken();
        return;
      }

      const userUpdate = await database.collection<UserDocument>(collectionNames.users).updateOne(
        { _id: consumedReset.userId },
        { $set: { passwordHash, updatedAt: now } },
      );
      if (userUpdate.matchedCount !== 1) {
        await invalidToken();
        return;
      }

      await database.collection(collectionNames.sessions).deleteMany({ userId: consumedReset.userId });
      await database.collection(collectionNames.passwordResets).deleteMany({ userId: consumedReset.userId });
      clearSessionCookie(response);
      response.status(204).end();
    },
  );

  const requireAuthenticatedSession = requireSession({
    getDatabase: dependencies.getDatabase,
    now: dependencies.now,
  });

  router.get("/me", requireAuthenticatedSession, (_request, response) => {
    const context = response.locals.authenticatedSession as AuthenticatedSessionContext;
    response.json({ user: toAuthUserResponse(context.user) });
  });

  router.post(
    "/logout",
    requireClientOrigin(dependencies.getAllowedOrigins),
    requireAuthenticatedSession,
    async (_request, response) => {
      const context = response.locals.authenticatedSession as AuthenticatedSessionContext;
      await dependencies
        .getDatabase()
        .collection("sessions")
        .deleteOne({ _id: context.sessionId });
      clearSessionCookie(response);
      response.setHeader("Cache-Control", "private, no-store");
      response.status(204).end();
    },
  );

  return router;
}

export const authRouter = createAuthRouter();
