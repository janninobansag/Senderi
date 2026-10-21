import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import {
  collectionNames,
  type SessionDocument,
  type SocketTicketDocument,
  type UserDocument,
} from "../db/documents";

export const SOCKET_TICKET_LIFETIME_MS = 60_000;
const SOCKET_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSocketTicketToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSocketTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export async function issueSocketTicket(
  database: Db,
  userId: ObjectId,
  sessionId: ObjectId,
  now: Date,
  tokenFactory: () => string = createSocketTicketToken,
): Promise<{ ticket: string; document: SocketTicketDocument }> {
  const ticket = tokenFactory();
  if (!SOCKET_TICKET_PATTERN.test(ticket)) {
    throw new Error("Socket ticket token factory returned an invalid token.");
  }

  const document: SocketTicketDocument = {
    _id: new ObjectId(),
    userId,
    sessionId,
    ticketHash: hashSocketTicket(ticket),
    createdAt: now,
    expiresAt: new Date(now.getTime() + SOCKET_TICKET_LIFETIME_MS),
  };

  await database.collection<SocketTicketDocument>(collectionNames.socketTickets).insertOne(document);
  return { ticket, document };
}

/** Atomically consumes a ticket and confirms its issuing session still exists. */
export async function consumeSocketTicket(
  database: Db,
  ticket: string,
  now: Date,
): Promise<SocketTicketDocument | null> {
  if (!SOCKET_TICKET_PATTERN.test(ticket)) return null;

  const ticketDocument = await database
    .collection<SocketTicketDocument>(collectionNames.socketTickets)
    .findOneAndDelete({ ticketHash: hashSocketTicket(ticket) });
  if (!ticketDocument || ticketDocument.expiresAt.getTime() <= now.getTime()) return null;

  const session = await database.collection<SessionDocument>(collectionNames.sessions).findOne({
    _id: ticketDocument.sessionId,
    userId: ticketDocument.userId,
    expiresAt: { $gt: now },
  });
  if (!session) return null;

  const user = await database.collection<UserDocument>(collectionNames.users).findOne({
    _id: ticketDocument.userId,
  });
  return user ? ticketDocument : null;
}
