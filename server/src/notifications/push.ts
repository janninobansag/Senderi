import { ObjectId, type Db } from "mongodb";
import webpush from "web-push";
import { collectionNames, type PushSubscriptionDocument } from "../db/documents";

export interface PushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

interface VapidConfiguration {
  subject: string;
  publicKey: string;
  privateKey: string;
}

function getVapidConfiguration(): VapidConfiguration | null {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

export function getPushPublicKey(): string | null {
  return getVapidConfiguration()?.publicKey ?? null;
}

function isExpiredSubscriptionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    ((error as { statusCode?: unknown }).statusCode === 404 ||
      (error as { statusCode?: unknown }).statusCode === 410);
}

/** Best-effort push delivery: a provider outage must never block app activity. */
export async function sendPushToUser(
  database: Db,
  userId: ObjectId,
  payload: PushNotificationPayload,
): Promise<void> {
  const configuration = getVapidConfiguration();
  if (!configuration) return;

  try {
    webpush.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
    const subscriptions = database.collection<PushSubscriptionDocument>(collectionNames.pushSubscriptions);
    const records = await subscriptions.find({ userId }).toArray();
    await Promise.all(records.map(async (record) => {
      try {
        await webpush.sendNotification({
          endpoint: record.endpoint,
          expirationTime: record.expirationTime ?? null,
          keys: record.keys,
        }, JSON.stringify(payload), { TTL: 60, urgency: "normal" });
      } catch (error) {
        if (isExpiredSubscriptionError(error)) {
          await subscriptions.deleteOne({ _id: record._id }).catch(() => undefined);
        }
      }
    }));
  } catch {
    // Push configuration and provider failures are intentionally non-fatal.
  }
}
