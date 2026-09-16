import {
  cancelOrderByUser,
  rescheduleOrder,
  rescheduleTimes,
  schema,
} from "@personal-agent/core";
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { parse, uuidParam } from "../http.js";
import { loadOrders } from "../orders.js";
import { dateTime, timeRangeQuery } from "../validation.js";

/** The user's orders — §8's /api/bookings, renamed. */
export const ordersRouter = Router();

const { orders } = schema;

const UPCOMING = ["requested", "quoted", "confirmed", "in_progress"];

/** Upcoming soonest first; past most recent first. */
ordersRouter.get("/", async (req, res) => {
  const all = await loadOrders(eq(orders.userId, currentUser(req).id));
  const firstTime = (order: (typeof all)[number]) =>
    order.appointments[0]?.scheduledAt.getTime() ?? Number.POSITIVE_INFINITY;

  res.json({
    upcoming: all
      .filter((order) => UPCOMING.includes(order.status))
      .sort((a, b) => firstTime(a) - firstTime(b)),
    past: all.filter((order) => !UPCOMING.includes(order.status)),
  });
});

async function oneOrder(orderId: string, userId: string) {
  const [order] = await loadOrders(and(eq(orders.id, orderId), eq(orders.userId, userId)));
  return order;
}

/**
 * GET /api/orders/:id/available-times?from=&to= — not in §8, but the
 * reschedule screen needs something to pick from.
 */
ordersRouter.get("/:id/available-times", async (req, res) => {
  const { from, to } = parse(timeRangeQuery(14), req.query);
  const times = await rescheduleTimes({
    userId: currentUser(req).id,
    orderId: uuidParam(req.params.id),
    window: { start: from, end: to },
  });
  res.json({ times });
});

const CancelBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** Frees the time at once. */
ordersRouter.post("/:id/cancel", async (req, res) => {
  const user = currentUser(req);
  const orderId = uuidParam(req.params.id);
  const { reason } = parse(CancelBody, req.body ?? {});

  await cancelOrderByUser({ orderId, userId: user.id, reason });
  res.json({ order: await oneOrder(orderId, user.id) });
});

const RescheduleBody = z.object({ slotAt: dateTime }).strict();

/** Same business, new time; the order and its price carry over. */
ordersRouter.post("/:id/reschedule", async (req, res) => {
  const user = currentUser(req);
  const orderId = uuidParam(req.params.id);
  const { slotAt } = parse(RescheduleBody, req.body ?? {});

  await rescheduleOrder({ orderId, userId: user.id, slotAt });
  res.json({ order: await oneOrder(orderId, user.id) });
});
