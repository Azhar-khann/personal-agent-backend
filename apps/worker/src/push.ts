import { getDb, schema } from "@personal-agent/core";
import { eq, gte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import webpush from "web-push";

import type { WorkerEnv } from "./env.js";

const { businessPushSubscriptions } = schema;

/** push.prune deletes a subscription that has failed this many times in a row. */
export const MAX_PUSH_FAILURES = 5;

export type PushMessage = { title: string; body: string; orderId: string };

export type PushSender = (businessId: string, message: PushMessage) => Promise<{ sent: number; removed: number; failed: number }>;

/**
 * Sends a push to every browser subscribed for a business — one row per
 * browser per staff member (§3). A browser that has unsubscribed (404/410) is
 * deleted at once; any other failure counts towards push.prune.
 */
export function createPushSender(env: WorkerEnv, log: Logger): PushSender {
  const vapidDetails = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  return async (businessId, message) => {
    const db = getDb();
    const subscriptions = await db
      .select()
      .from(businessPushSubscriptions)
      .where(eq(businessPushSubscriptions.businessId, businessId));

    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dhKey, auth: subscription.authKey } },
            JSON.stringify(message),
            { vapidDetails, TTL: 60 * 60, timeout: 10_000 },
          );
          if (subscription.failedCount > 0) {
            await db
              .update(businessPushSubscriptions)
              .set({ failedCount: 0 })
              .where(eq(businessPushSubscriptions.id, subscription.id));
          }
          return "sent" as const;
        } catch (error) {
          const status = error instanceof webpush.WebPushError ? error.statusCode : null;
          if (status === 404 || status === 410) {
            await db.delete(businessPushSubscriptions).where(eq(businessPushSubscriptions.id, subscription.id));
            return "removed" as const;
          }
          log.warn({ err: error, subscriptionId: subscription.id, status }, "push failed");
          await db
            .update(businessPushSubscriptions)
            .set({ failedCount: sql`${businessPushSubscriptions.failedCount} + 1` })
            .where(eq(businessPushSubscriptions.id, subscription.id));
          return "failed" as const;
        }
      }),
    );

    return {
      sent: results.filter((r) => r === "sent").length,
      removed: results.filter((r) => r === "removed").length,
      failed: results.filter((r) => r === "failed").length,
    };
  };
}

/** §9 push.prune: deletes subscriptions that keep failing. */
export async function prunePushSubscriptions(): Promise<number> {
  const deleted = await getDb()
    .delete(businessPushSubscriptions)
    .where(gte(businessPushSubscriptions.failedCount, MAX_PUSH_FAILURES))
    .returning({ id: businessPushSubscriptions.id });
  return deleted.length;
}
