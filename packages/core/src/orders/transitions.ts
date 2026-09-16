/**
 * An order's life after booking (§6 "After booking"). Each change writes an
 * order_events row in the same transaction — the only source of notifications.
 */

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client.js";
import { appointments, orderEvents, orders, type OrderStatus } from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  activeAppointments,
  lockOrder,
  OrderError,
} from "./common.js";

type ByUser = { actor: "user"; userId: string };
type ByBusiness = { actor: "business"; businessId: string; byUserId: string };

const CANCELLABLE: string[] = ["requested", "quoted", "confirmed"] satisfies OrderStatus[];

async function cancel(orderId: string, by: ByUser | ByBusiness, reason: string | null, now: Date) {
  await getDb().transaction(async (tx) => {
    const order = await lockOrder(
      tx,
      orderId,
      by.actor === "user" ? { userId: by.userId } : { businessId: by.businessId },
    );
    if (!CANCELLABLE.includes(order.status)) {
      throw new OrderError("invalid_status", `This order is already ${order.status}`);
    }
    const [first] = await activeAppointments(tx, order.id);
    if (first && first.scheduledAt <= now) {
      throw new OrderError("invalid_status", "This appointment has already started");
    }

    // Cancelled appointments leave the no_double_booking index, so the time
    // is bookable again at once.
    await tx
      .update(appointments)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(appointments.orderId, order.id),
          inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
        ),
      );

    const status = by.actor === "user" ? "cancelled_by_user" : "cancelled_by_business";
    await tx.update(orders).set({ status, updatedAt: now }).where(eq(orders.id, order.id));
    await tx.insert(orderEvents).values({
      orderId: order.id,
      actor: by.actor,
      type: `order.${status}`,
      payload: { reason, ...(by.actor === "business" ? { byUserId: by.byUserId } : {}) },
    });

    // Held against the business in the ranking's reliability.
    if (by.actor === "business") {
      await incrementStats(tx, order.businessId, ["cancellationsByBusiness"], now);
    }
  });
}

export function cancelOrderByUser(input: { orderId: string; userId: string; reason?: string; now?: Date }) {
  return cancel(input.orderId, { actor: "user", userId: input.userId }, input.reason ?? null, input.now ?? new Date());
}

/** §6: the user is told and offered a rebooking — that happens in the worker, from the event. */
export function cancelOrderByBusiness(input: {
  orderId: string;
  businessId: string;
  byUserId: string;
  reason: string;
  now?: Date;
}) {
  return cancel(
    input.orderId,
    { actor: "business", businessId: input.businessId, byUserId: input.byUserId },
    input.reason,
    input.now ?? new Date(),
  );
}

/**
 * Ends a confirmed order that has started, as completed or as a no-show.
 * Completion is normally the worker's job (Stage 7); this is the business's
 * manual override.
 */
async function finish(
  input: { orderId: string; businessId: string; byUserId: string; now?: Date },
  outcome: "completed" | "no_show",
) {
  const now = input.now ?? new Date();

  await getDb().transaction(async (tx) => {
    const order = await lockOrder(tx, input.orderId, { businessId: input.businessId });
    if (order.status !== "confirmed") {
      throw new OrderError("invalid_status", `This order is ${order.status}`);
    }
    const [first] = await activeAppointments(tx, order.id);
    if (!first || first.scheduledAt > now) {
      throw new OrderError("invalid_status", "This appointment hasn't started yet");
    }

    await tx
      .update(appointments)
      .set({ status: outcome, updatedAt: now })
      .where(
        and(
          eq(appointments.orderId, order.id),
          inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
        ),
      );
    await tx.update(orders).set({ status: outcome, updatedAt: now }).where(eq(orders.id, order.id));
    await tx.insert(orderEvents).values({
      orderId: order.id,
      actor: "business",
      type: `order.${outcome}`,
      payload: { byUserId: input.byUserId },
    });
    await incrementStats(
      tx,
      order.businessId,
      [outcome === "completed" ? "bookingsCompleted" : "noShows"],
      now,
    );
  });
}

export function completeOrder(input: { orderId: string; businessId: string; byUserId: string; now?: Date }) {
  return finish(input, "completed");
}

export function markNoShow(input: { orderId: string; businessId: string; byUserId: string; now?: Date }) {
  return finish(input, "no_show");
}
