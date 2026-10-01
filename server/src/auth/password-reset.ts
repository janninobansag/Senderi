import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type Db, type ObjectId as ObjectIdValue } from "mongodb";
import { collectionNames, type PasswordResetDocument } from "../db/documents";

export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1_000;

export function createPasswordResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function storePasswordResetToken(
  database: Db,
  userId: ObjectIdValue,
  token: string,
  now: Date,
): Promise<PasswordResetDocument> {
  const resets = database.collection<PasswordResetDocument>(collectionNames.passwordResets);
  const document: PasswordResetDocument = {
    _id: new ObjectId(),
    userId,
    tokenHash: hashPasswordResetToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  };

  await resets.deleteMany({ userId });
  await resets.insertOne(document);
  return document;
}

export async function findUsablePasswordResetToken(
  database: Db,
  token: string,
  now: Date,
): Promise<PasswordResetDocument | null> {
  return database.collection<PasswordResetDocument>(collectionNames.passwordResets).findOne({
    tokenHash: hashPasswordResetToken(token),
    expiresAt: { $gt: now },
  });
}

/** findOneAndDelete is the single-use claim: concurrent submissions can win only once. */
export async function consumePasswordResetToken(
  database: Db,
  token: string,
  now: Date,
): Promise<PasswordResetDocument | null> {
  return database.collection<PasswordResetDocument>(collectionNames.passwordResets).findOneAndDelete({
    tokenHash: hashPasswordResetToken(token),
    expiresAt: { $gt: now },
  });
}
