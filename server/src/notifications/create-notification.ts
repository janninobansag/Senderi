import { ObjectId, type Db } from "mongodb";
import { collectionNames, type NotificationDocument } from "../db/documents";
import { sendPushToUser } from "./push";

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

  const body = notificationPushMessage(notification.type);
  const url = notification.type === "friend_request" || notification.type === "friend_accepted"
    ? "/friends"
    : notification.postId
      ? `/posts/${notification.postId.toHexString()}${notification.type === "post_comment" || notification.type === "post_mention" ? "?comments=1" : ""}`
      : "/";
  void sendPushToUser(database, notification.recipientId, {
    title: "Senderi",
    body,
    url,
    tag: `activity-${notification._id.toHexString()}`,
  });
}

function notificationPushMessage(type: NotificationDocument["type"]): string {
  switch (type) {
    case "post_like": return "Someone liked your post.";
    case "share_like": return "Someone liked your shared post.";
    case "post_comment": return "Someone commented on your post.";
    case "post_mention": return "Someone mentioned you in a comment.";
    case "post_share": return "Someone shared your post.";
    case "friend_request": return "You have a new friend request.";
    case "friend_accepted": return "Your friend request was accepted.";
  }
}
