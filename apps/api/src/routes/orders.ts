import {
  acceptQuote,
  cancelOrderByUser,
  getDb,
  quoteJobTimes,
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
 * GET /api/orders/:id/available-times?from=&to= — not in §8. For a quoted
 * order, times for the quoted job; otherwise times to move the order to. For a
 * pickup and delivery, each time comes with its delivery.
 */
ordersRouter.get("/:id/available-times", async (req, res) => {
  const { from, to } = parse(timeRangeQuery(14), req.query);
  const input = { userId: currentUser(req).id, orderId: uuidParam(req.params.id), window: { start: from, end: to } };
  const [order] = await getDb()
    .select({ status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)));
  const times = order?.status === "quoted" ? await quoteJobTimes(input) : await rescheduleTimes(input);
  res.json({ times });
});

const CancelBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** Frees the time at once. For an order waiting on a quote, this declines it. */
ordersRouter.post("/:id/cancel", async (req, res) => {
  const user = currentUser(req);
  const orderId = uuidParam(req.params.id);
  const { reason } = parse(CancelBody, req.body ?? {});

  await cancelOrderByUser({ orderId, userId: user.id, reason });
  res.json({ order: await oneOrder(orderId, user.id) });
});

const SlotBody = z.object({ slotAt: dateTime }).strict();

/** Accepts the quote by booking its job at one of the available times. */
ordersRouter.post("/:id/quote/accept", async (req, res) => {
  const user = currentUser(req);
  const orderId = uuidParam(req.params.id);
  const { slotAt } = parse(SlotBody, req.body ?? {});

  const { overlappingOrderIds } = await acceptQuote({ orderId, userId: user.id, slotAt });
  res.json({
    order: await oneOrder(orderId, user.id),
    warnings:
      overlappingOrderIds.length > 0
        ? [{ code: "overlaps_other_order", message: "You have another booking at this time", orderIds: overlappingOrderIds }]
        : [],
  });
});

/**
 * Same business, new time; the order and its price carry over. A booking the
 * business confirms goes back to waiting for it.
 */
ordersRouter.post("/:id/reschedule", async (req, res) => {
  const user = currentUser(req);
  const orderId = uuidParam(req.params.id);
  const { slotAt } = parse(SlotBody, req.body ?? {});

  await rescheduleOrder({ orderId, userId: user.id, slotAt });
  res.json({ order: await oneOrder(orderId, user.id) });
});
