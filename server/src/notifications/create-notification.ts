import { ObjectId, type Db } from "mongodb";
import { collectionNames, type NotificationDocument } from "../db/documents";
import { sendPushToUser } from "./push";

export type CreateNotificationInput = Pick<NotificationDocument, "recipientId" | "actorId" | "type"> &
  Partial<Pick<NotificationDocument, "postId" | "shareId" | "friendRequestId">>;

function notificationUrl(notification: Pick<NotificationDocument, "type" | "postId" | "shareId">): string {
  if (notification.type === "friend_request" || notification.type === "friend_accepted") return "/friends";
  if (!notification.postId) return "/";

  const query = new URLSearchParams();
  if (notification.shareId) query.set("shareId", notification.shareId.toHexString());
  if (notification.type === "post_comment" || notification.type === "post_mention") query.set("comments", "1");
  const queryString = query.toString();
  return `/posts/${notification.postId.toHexString()}${queryString ? `?${queryString}` : ""}`;
}

export async function createNotification(database: Db, input: CreateNotificationInput): Promise<void> {
  if (input.recipientId.equals(input.actorId)) return;

  const notification: NotificationDocument = {
    _id: new ObjectId(),
    ...input,
    createdAt: new Date(),
  };
  await database.collection<NotificationDocument>(collectionNames.notifications).insertOne(notification);

  const body = notificationPushMessage(notification);
  void sendPushToUser(database, notification.recipientId, {
    title: "Senderi",
    body,
    url: notificationUrl(notification),
    tag: `activity-${notification._id.toHexString()}`,
  });
}

function notificationPushMessage(notification: Pick<NotificationDocument, "type" | "shareId">): string {
  switch (notification.type) {
    case "post_like": return "Someone liked your post.";
    case "share_like": return "Someone liked a post you shared.";
    case "post_comment": return notification.shareId ? "Someone commented on a shared post." : "Someone commented on your post.";
    case "post_mention": return notification.shareId
      ? "Someone mentioned you in a comment on a shared post."
      : "Someone mentioned you in a comment.";
    case "post_body_mention": return "Someone mentioned you in a post.";
    case "post_share": return notification.shareId ? "Someone reshared a post you shared." : "Someone shared your post.";
    case "friend_request": return "You have a new friend request.";
    case "friend_accepted": return "Your friend request was accepted.";
  }
}
