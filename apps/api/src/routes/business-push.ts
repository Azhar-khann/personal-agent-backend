import { getDb, schema } from "@personal-agent/core";
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { currentBusiness } from "../business.js";
import type { ApiEnv } from "../env.js";
import { parse } from "../http.js";

const { businessPushSubscriptions } = schema;

/**
 * The worker sends a request to whatever endpoint is stored here. Browser push
 * services are always https, and web-push only speaks https, so nothing else
 * is accepted — which also stops staff pointing the worker at plain-http
 * internal addresses.
 */
const pushEndpoint = z
  .string()
  .url()
  .max(2000)
  .refine((url) => url.startsWith("https://"), "must be an https URL");

/** The shape of a browser's PushSubscription.toJSON(). */
const SubscribeBody = z
  .object({
    endpoint: pushEndpoint,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
  })
  .strict();

const UnsubscribeBody = z.object({ endpoint: z.string().min(1).max(2000) }).strict();

/** Push notifications for a business's staff browsers (§8 POST DELETE /api/business/push/subscribe). */
export function businessPushRouter(env: ApiEnv) {
  const router = Router();

  /** Not in §8: a browser needs the public key before it can subscribe. */
  router.get("/public-key", (_req, res) => {
    res.json({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  /** Registers this browser, or refreshes it if it re-subscribes. */
  router.post("/subscribe", async (req, res) => {
    const { endpoint, keys } = parse(SubscribeBody, req.body ?? {});
    const now = new Date();
    const values = {
      businessId: currentBusiness(req).id,
      userId: currentUser(req).id,
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
      failedCount: 0,
      lastSeenAt: now,
    };

    await getDb()
      .insert(businessPushSubscriptions)
      .values({ ...values, endpoint })
      .onConflictDoUpdate({ target: businessPushSubscriptions.endpoint, set: values });
    res.status(201).json({ subscribed: true });
  });

  router.delete("/subscribe", async (req, res) => {
    const { endpoint } = parse(UnsubscribeBody, req.body ?? {});
    await getDb()
      .delete(businessPushSubscriptions)
      .where(and(eq(businessPushSubscriptions.endpoint, endpoint), eq(businessPushSubscriptions.userId, currentUser(req).id)));
    res.status(204).end();
  });

  return router;
}
