import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { getDb, type Executor } from "../db/client.js";
import { PG_ERROR, pgErrorCode } from "../db/errors.js";
import {
  appointments,
  businesses,
  businessServices,
  orderEvents,
  orders,
  searches,
  searchOptions,
} from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import { freeSlots, type FreeSlot, type Interval } from "../search/availability.js";
import { loadAvailability } from "../search/find-options.js";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  activeAppointments,
  assertBookable,
  lockBusiness,
  lockOrder,
  OrderError,
  slotUnavailable,
} from "./common.js";

type Business = typeof businesses.$inferSelect;

const MINUTE_MS = 60_000;

/**
 * Free start times at one business, worked out from scratch. An order being
 * rescheduled is left out, so it can move to a time that overlaps its own.
 */
async function businessSlots(args: {
  business: Business;
  durationMin: number;
  window: Interval;
  now: Date;
  excludeOrderId?: string;
}): Promise<FreeSlot[]> {
  const { business, durationMin, window, now, excludeOrderId } = args;
  const range = {
    start: window.start,
    end: new Date(window.end.getTime() + (durationMin + business.bufferMin) * MINUTE_MS),
  };
  const data = (await loadAvailability([business.id], range)).get(business.id)!;

  return freeSlots({
    now,
    window,
    durationMin,
    rules: business,
    hours: data.hours,
    closures: data.closures,
    appointments: data.appointments.filter((a) => a.orderId !== excludeOrderId),
  });
}

/** The lowest free chair at exactly `slotAt`, or null if that time can't be booked. */
async function freeChairAt(args: {
  business: Business;
  durationMin: number;
  slotAt: Date;
  now: Date;
  excludeOrderId?: string;
}): Promise<number | null> {
  const window = { start: args.slotAt, end: new Date(args.slotAt.getTime() + 1) };
  const [slot] = await businessSlots({ ...args, window });
  return slot?.resourceIndex ?? null;
}

/** The constraint refusing an insert is the same outcome as the check refusing it. */
async function withSlotGuard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.EXCLUSION_VIOLATION) throw slotUnavailable();
    throw error;
  }
}

export type BookingResult = {
  orderId: string;
  /** The user's other orders at an overlapping time: allowed, but worth a warning (§7). */
  overlappingOrderIds: string[];
};

/**
 * §6 — books a time the user picked from a search's options, as an order with
 * one appointment (Phase 1: instant, single-step).
 *
 * Availability is worked out again from scratch, because the list may be
 * minutes old. The no_double_booking constraint stays the last line of defence
 * for two bookings in the same instant. Either way the result is
 * slot_unavailable, and the caller re-runs the search for a fresh list.
 */
export function bookOption(input: {
  userId: string;
  searchId: string;
  optionId: string;
  slotAt: Date;
  now?: Date;
}): Promise<BookingResult> {
  const now = input.now ?? new Date();

  return withSlotGuard(() =>
    getDb().transaction(async (tx) => {
      // Locking the search makes a double tap book once: the second request
      // waits, then finds the search already booked.
      const [search] = await tx
        .select()
        .from(searches)
        .where(and(eq(searches.id, input.searchId), eq(searches.userId, input.userId)))
        .for("update");
      if (!search) throw new OrderError("not_found", "No such search");
      if (search.status !== "presenting") {
        throw new OrderError("invalid_status", `This search is ${search.status}`);
      }

      const [picked] = await tx
        .select({ option: searchOptions, service: businessServices })
        .from(searchOptions)
        .innerJoin(businessServices, eq(businessServices.id, searchOptions.businessServiceId))
        .where(and(eq(searchOptions.id, input.optionId), eq(searchOptions.searchId, search.id)));
      if (!picked) throw new OrderError("not_found", "No such option on this search");
      const { option, service } = picked;

      if (!option.offeredSlots.some((slot) => slot.getTime() === input.slotAt.getTime())) {
        throw new OrderError("invalid_request", "That time wasn't one of the times offered");
      }

      const business = await lockBusiness(tx, option.businessId);

      // Since the list was shown, the business may have been suspended or
      // changed the service. A different price counts too: the user agreed to
      // the one on screen.
      const [step] = service.steps;
      if (
        business?.status !== "active" ||
        !service.active ||
        service.priceAed !== option.priceAed ||
        service.steps.length !== 1 ||
        !step
      ) {
        throw slotUnavailable();
      }

      const resourceIndex = await freeChairAt({
        business,
        durationMin: step.duration_min,
        slotAt: input.slotAt,
        now,
      });
      if (resourceIndex === null) throw slotUnavailable();

      const atCustomer = service.locationMode === "at_customer";
      // What the agent collected is for the business to read — except the
      // budget, which only ranked the options.
      const { budget_max: _budget, ...details } = search.constraints as Record<string, unknown>;

      const [order] = await tx
        .insert(orders)
        .values({
          searchId: search.id,
          businessId: business.id,
          userId: input.userId,
          businessServiceId: service.id,
          status: "confirmed",
          serviceAddress: atCustomer ? search.address : null,
          serviceLat: atCustomer ? search.lat : null,
          serviceLng: atCustomer ? search.lng : null,
          details,
          // Copied, so a later price rise leaves this order as agreed.
          priceAed: service.priceAed,
        })
        .returning({ id: orders.id });

      const [appointment] = await tx
        .insert(appointments)
        .values({
          orderId: order!.id,
          businessId: business.id,
          kind: step.kind,
          resourceIndex,
          scheduledAt: input.slotAt,
          durationMin: step.duration_min,
          // Frozen at booking, like the price.
          bufferMin: business.bufferMin,
          status: "confirmed",
        })
        .returning({ id: appointments.id });

      await tx.insert(orderEvents).values({
        orderId: order!.id,
        actor: "user",
        type: "order.confirmed",
        payload: { appointmentId: appointment!.id, scheduledAt: input.slotAt },
      });
      await tx.update(searches).set({ status: "booked", updatedAt: now }).where(eq(searches.id, search.id));
      await tx.update(searchOptions).set({ selectedAt: now }).where(eq(searchOptions.id, option.id));
      await incrementStats(tx, business.id, ["timesSelected", "bookingsTotal"], now);

      const endsAt = new Date(input.slotAt.getTime() + step.duration_min * MINUTE_MS);
      const overlapping = await tx
        .selectDistinct({ orderId: appointments.orderId })
        .from(appointments)
        .innerJoin(orders, eq(orders.id, appointments.orderId))
        .where(
          and(
            eq(orders.userId, input.userId),
            ne(orders.id, order!.id),
            inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
            lt(appointments.scheduledAt, endsAt),
            // No column on the left to encode the Date, so it goes in as text.
            sql`${appointments.scheduledAt} + make_interval(mins => ${appointments.durationMin}) > ${input.slotAt.toISOString()}::timestamptz`,
          ),
        );

      return { orderId: order!.id, overlappingOrderIds: overlapping.map((row) => row.orderId) };
    }),
  );
}

/**
 * The order's single appointment, if it can still be moved. Phase 1 orders
 * have one; moving a chain of steps is Stage 9.
 */
async function movableAppointment(
  db: Executor,
  order: { id: string; status: string },
  now: Date,
) {
  if (order.status !== "confirmed") {
    throw new OrderError("invalid_status", `This order is ${order.status}`);
  }
  const [appointment, ...more] = await activeAppointments(db, order.id);
  if (!appointment || more.length > 0) {
    throw new OrderError("invalid_status", "This order can't be rescheduled");
  }
  if (appointment.scheduledAt <= now) {
    throw new OrderError("invalid_status", "This appointment has already started");
  }
  return appointment;
}

/** Free times an order could move to, at the same business, for the same length of job. */
export async function rescheduleTimes(input: {
  userId: string;
  orderId: string;
  window: Interval;
  now?: Date;
}): Promise<Date[]> {
  const now = input.now ?? new Date();
  const db = getDb();

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)));
  if (!order) throw new OrderError("not_found", "No such order");

  const appointment = await movableAppointment(db, order, now);
  const [row] = await db.select().from(businesses).where(eq(businesses.id, order.businessId));
  const business = assertBookable(row);
  const slots = await businessSlots({
    business,
    durationMin: appointment.durationMin,
    window: input.window,
    now,
    excludeOrderId: order.id,
  });
  return slots.map((slot) => slot.start);
}

/**
 * Moves an order to a new time at the same business. The order stays — only
 * its appointment is replaced, in one transaction — so the agreed price holds.
 */
export function rescheduleOrder(input: {
  userId: string;
  orderId: string;
  slotAt: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();

  return withSlotGuard(() =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId, { userId: input.userId });
      const current = await movableAppointment(tx, order, now);
      const business = assertBookable(await lockBusiness(tx, order.businessId));

      const resourceIndex = await freeChairAt({
        business,
        durationMin: current.durationMin,
        slotAt: input.slotAt,
        now,
        excludeOrderId: order.id,
      });
      if (resourceIndex === null) throw slotUnavailable();

      // Cancelled first, so the old time leaves the constraint's index before
      // the new appointment is checked against it.
      await tx
        .update(appointments)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(appointments.id, current.id));
      const [moved] = await tx
        .insert(appointments)
        .values({
          orderId: order.id,
          businessId: order.businessId,
          kind: current.kind,
          resourceIndex,
          scheduledAt: input.slotAt,
          durationMin: current.durationMin,
          bufferMin: business.bufferMin,
          status: "confirmed",
        })
        .returning({ id: appointments.id });

      await tx.update(orders).set({ updatedAt: now }).where(eq(orders.id, order.id));
      await tx.insert(orderEvents).values({
        orderId: order.id,
        actor: "user",
        type: "order.rescheduled",
        payload: { appointmentId: moved!.id, from: current.scheduledAt, to: input.slotAt },
      });
    }),
  );
}
