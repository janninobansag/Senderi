import { ObjectId, type Db } from "mongodb";
import { collectionNames, type NotificationDocument } from "../db/documents";

export type CreateNotificationInput = Pick<NotificationDocument, "recipientId" | "actorId" | "type"> &
  Partial<Pick<NotificationDocument, "postId" | "shareId" | "friendRequestId">>;

export async function createNotification(database: Db, input: CreateNotificationInput): Promise<void> {
  if (input.recipientId.equals(input.actorId)) return;

  const notification: NotificationDocument = {
    _id: new ObjectId(),
    ...input,
    createdAt: new Date(),
  };
  await database.collection<NotificationDocument>(collectionNames.notifications).insertOne(notification);
}
