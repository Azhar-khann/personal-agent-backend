/**
 * An order's life after booking (§6 "After booking"). Each change writes an
 * order_events row in the same transaction — the only source of notifications
 * — and asks for it to be delivered once the transaction commits.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb, type Transaction } from "../db/client.js";
import { appointments, orders, type OrderStatus } from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  activeAppointments,
  lockOrder,
  OrderError,
  recordEvent,
  withEvents,
} from "./common.js";

type ByUser = { actor: "user"; userId: string };
type ByBusiness = { actor: "business"; businessId: string; byUserId: string };
type BySystem = { actor: "system" };

const CANCELLABLE: string[] = ["requested", "quoted", "confirmed"] satisfies OrderStatus[];

function cancel(orderId: string, by: ByUser | ByBusiness, reason: string | null, now: Date) {
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
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
      await recordEvent(tx, eventIds, {
        orderId: order.id,
        actor: by.actor,
        type: `order.${status}`,
        payload: { reason, ...(by.actor === "business" ? { byUserId: by.byUserId } : {}) },
      });

      // Held against the business in the ranking's reliability.
      if (by.actor === "business") {
        await incrementStats(tx, order.businessId, ["cancellationsByBusiness"], now);
      }
    }),
  );
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
 * A recurring reminder whose nudge led to this order is done for this round:
 * its next due date moves on from the day the work was done.
 */
async function moveReminderOn(tx: Transaction, order: { searchId: string | null; userId: string }, doneAt: Date) {
  if (!order.searchId) return;
  await tx.execute(sql`
    UPDATE recurring_reminders r
       SET last_done_at = (${doneAt.toISOString()}::timestamptz AT TIME ZONE u.timezone)::date,
           next_due_at = (${doneAt.toISOString()}::timestamptz AT TIME ZONE u.timezone)::date + r.interval_days,
           last_nudged_at = NULL,
           updated_at = now()
      FROM searches s, users u
     WHERE s.id = ${order.searchId}::uuid
       AND r.id::text = s.constraints->>'reminder_id'
       AND r.user_id = ${order.userId}::uuid
       AND u.id = r.user_id
  `);
}

/**
 * Ends a confirmed order that has started, as completed or as a no-show. The
 * worker completes orders a while after they end (orders/sweeps.ts); a
 * business can complete one sooner, or mark a no-show.
 */
function finish(orderId: string, by: ByBusiness | BySystem, outcome: "completed" | "no_show", now: Date) {
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, orderId, by.actor === "business" ? { businessId: by.businessId } : null);
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
      await recordEvent(tx, eventIds, {
        orderId: order.id,
        actor: by.actor,
        type: `order.${outcome}`,
        payload: by.actor === "business" ? { byUserId: by.byUserId } : {},
      });
      await incrementStats(
        tx,
        order.businessId,
        [outcome === "completed" ? "bookingsCompleted" : "noShows"],
        now,
      );
      if (outcome === "completed") await moveReminderOn(tx, order, first.scheduledAt);
    }),
  );
}

export function completeOrder(input: { orderId: string; businessId: string; byUserId: string; now?: Date }) {
  return finish(input.orderId, { actor: "business", businessId: input.businessId, byUserId: input.byUserId }, "completed", input.now ?? new Date());
}

export function markNoShow(input: { orderId: string; businessId: string; byUserId: string; now?: Date }) {
  return finish(input.orderId, { actor: "business", businessId: input.businessId, byUserId: input.byUserId }, "no_show", input.now ?? new Date());
}

/** The worker's automatic completion (§9). */
export function completeOrderAutomatically(orderId: string, now = new Date()) {
  return finish(orderId, { actor: "system" }, "completed", now);
}
