/**
 * The worker's minute sweeps (§9 booking.reminder and booking.complete).
 *
 * The spec schedules a delayed job per booking. Instead, each minute reads the
 * database and acts on whatever is due: there are no jobs to replace when an
 * order is rescheduled or cancelled, and nothing is lost if Redis was down
 * when someone booked. Every step re-checks under a lock, so a sweep running
 * twice — or two workers at once — changes nothing extra.
 */

import { and, asc, eq, gt, isNull, lte, notExists, sql } from "drizzle-orm";

import { getDb } from "../db/client.js";
import { appointments, orderEvents, orders } from "../db/schema.js";
import { ACTIVE_APPOINTMENT_STATUSES, OrderError, recordEvent, withEvents } from "./common.js";
import { completeOrderAutomatically } from "./transitions.js";

const MINUTE_MS = 60_000;
const BATCH = 200;

/** §9: remind the user an hour before. */
export const REMINDER_LEAD_MIN = 60;

/**
 * Orders are completed this long after their appointment ends rather than
 * straight away: until then the business can still mark a no-show, which only
 * works on a confirmed order.
 */
export const COMPLETION_GRACE_MIN = 180;

/** An event still undelivered after this long lost its delivery job. */
export const EVENT_STALE_MIN = 1;

const REMINDER_EVENT = "appointment.reminder";

const appointmentEnd = sql`${appointments.scheduledAt} + make_interval(mins => ${appointments.durationMin})`;

/** The reminder event for the appointment in the outer query, if one exists. */
const reminderEventForAppointment = () =>
  getDb()
    .select({ one: sql`1` })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, appointments.orderId),
        eq(orderEvents.type, REMINDER_EVENT),
        sql`${orderEvents.payload}->>'appointmentId' = ${appointments.id}::text`,
      ),
    );

/**
 * Records an appointment.reminder event for each confirmed appointment that
 * starts within the hour; delivering it messages the user. Appointments booked
 * with less than an hour to go don't get one.
 */
export async function remindUpcomingAppointments(now = new Date()): Promise<number> {
  const db = getDb();
  const horizon = new Date(now.getTime() + REMINDER_LEAD_MIN * MINUTE_MS);

  const due = await db
    .select({ id: appointments.id, orderId: appointments.orderId, scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .innerJoin(orders, eq(orders.id, appointments.orderId))
    .where(
      and(
        eq(appointments.status, "confirmed"),
        eq(orders.status, "confirmed"),
        gt(appointments.scheduledAt, now),
        lte(appointments.scheduledAt, horizon),
        sql`${appointments.createdAt} <= ${appointments.scheduledAt} - make_interval(mins => ${REMINDER_LEAD_MIN})`,
        notExists(reminderEventForAppointment()),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
    .limit(BATCH);

  let reminded = 0;
  await withEvents(async (eventIds) => {
    for (const appointment of due) {
      await db.transaction(async (tx) => {
        // Locked, then re-checked: another sweep may have got here first.
        const [locked] = await tx
          .select({ status: appointments.status })
          .from(appointments)
          .where(eq(appointments.id, appointment.id))
          .for("update");
        if (locked?.status !== "confirmed") return;
        const [existing] = await tx
          .select({ id: orderEvents.id })
          .from(orderEvents)
          .where(
            and(
              eq(orderEvents.orderId, appointment.orderId),
              eq(orderEvents.type, REMINDER_EVENT),
              sql`${orderEvents.payload}->>'appointmentId' = ${appointment.id}::text`,
            ),
          )
          .limit(1);
        if (existing) return;

        await recordEvent(tx, eventIds, {
          orderId: appointment.orderId,
          actor: "system",
          type: REMINDER_EVENT,
          payload: { appointmentId: appointment.id, scheduledAt: appointment.scheduledAt },
        });
        reminded++;
      });
    }
  });
  return reminded;
}

/**
 * Completes confirmed orders whose last appointment ended more than the grace
 * period ago (§9 booking.complete).
 */
export async function completeFinishedOrders(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - COMPLETION_GRACE_MIN * MINUTE_MS);
  const later = sql`later`;

  const finished = await getDb()
    .selectDistinct({ orderId: appointments.orderId })
    .from(appointments)
    .innerJoin(orders, eq(orders.id, appointments.orderId))
    .where(
      and(
        eq(appointments.status, "confirmed"),
        eq(orders.status, "confirmed"),
        lte(appointments.scheduledAt, cutoff),
        sql`${appointmentEnd} <= ${cutoff.toISOString()}::timestamptz`,
        // Every step of the order has ended, not just this one.
        sql`NOT EXISTS (
          SELECT 1 FROM ${appointments} AS ${later}
           WHERE ${later}.order_id = ${appointments.orderId}
             AND ${later}.status IN (${sql.join(ACTIVE_APPOINTMENT_STATUSES.map((s) => sql`${s}`), sql`, `)})
             AND ${later}.scheduled_at + make_interval(mins => ${later}.duration_min) > ${cutoff.toISOString()}::timestamptz
        )`,
      ),
    )
    .limit(BATCH);

  let completed = 0;
  for (const { orderId } of finished) {
    try {
      await completeOrderAutomatically(orderId, now);
      completed++;
    } catch (error) {
      // The business completed it, or marked a no-show, in the meantime.
      if (!(error instanceof OrderError)) throw error;
    }
  }
  return completed;
}

/** Events that should have been delivered by now, oldest first. */
export async function staleUndeliveredEventIds(now = new Date()): Promise<string[]> {
  const rows = await getDb()
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        isNull(orderEvents.deliveredAt),
        lte(orderEvents.createdAt, new Date(now.getTime() - EVENT_STALE_MIN * MINUTE_MS)),
      ),
    )
    .orderBy(asc(orderEvents.createdAt))
    .limit(500);
  return rows.map((row) => row.id);
}
