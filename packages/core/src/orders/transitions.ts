/**
 * An order's life after booking (§6 "After booking"). Each change writes an
 * order_events row in the same transaction — the only source of notifications
 * — and asks for it to be delivered once the transaction commits.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb, type Transaction } from "../db/client.js";
import { appointments, businessServices, orders, quotes, type OrderStatus } from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import { openQuote } from "./booking.js";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  activeAppointments,
  holdExpiresAt,
  lockOrder,
  OrderError,
  recordEvent,
  settleAppointments,
  withEvents,
} from "./common.js";

type ByUser = { actor: "user"; userId: string };
type ByBusiness = { actor: "business"; businessId: string; byUserId: string };
type BySystem = { actor: "system" };

type BusinessInput = { orderId: string; businessId: string; byUserId: string; now?: Date };

const CANCELLABLE: string[] = ["requested", "quoted", "confirmed"] satisfies OrderStatus[];

const byBusiness = (input: BusinessInput): ByBusiness => ({
  actor: "business",
  businessId: input.businessId,
  byUserId: input.byUserId,
});

/** Who the event says acted: the business's staff member, if it was them. */
const actorPayload = (by: ByUser | ByBusiness | BySystem) => (by.actor === "business" ? { byUserId: by.byUserId } : {});

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
      // A confirmed order can't be cancelled once it's under way. One still
      // waiting on a quote can, even after its visit.
      const [first] = await activeAppointments(tx, order.id);
      if (order.status === "confirmed" && first && first.scheduledAt <= now) {
        throw new OrderError("invalid_status", "This appointment has already started");
      }

      await settleAppointments(tx, order.id, now);
      await tx
        .update(quotes)
        .set({ status: "declined" })
        .where(and(eq(quotes.orderId, order.id), eq(quotes.status, "sent")));

      const status = by.actor === "user" ? "cancelled_by_user" : "cancelled_by_business";
      await tx.update(orders).set({ status, updatedAt: now }).where(eq(orders.id, order.id));
      await recordEvent(tx, eventIds, {
        orderId: order.id,
        actor: by.actor,
        type: `order.${status}`,
        payload: { reason, ...actorPayload(by) },
      });

      // Held against the business in the ranking's reliability.
      if (by.actor === "business") {
        await incrementStats(tx, order.businessId, ["cancellationsByBusiness"], now);
      }
    }),
  );
}

/** The user cancels; for an order waiting on a quote, this is also declining it. */
export function cancelOrderByUser(input: { orderId: string; userId: string; reason?: string; now?: Date }) {
  return cancel(input.orderId, { actor: "user", userId: input.userId }, input.reason ?? null, input.now ?? new Date());
}

/** §6: the user is told and offered a rebooking — that happens in the worker, from the event. */
export function cancelOrderByBusiness(input: BusinessInput & { reason: string }) {
  return cancel(input.orderId, byBusiness(input), input.reason, input.now ?? new Date());
}

// --- requests the business confirms ---------------------------------------------

/** A requested order's held appointments, refusing if there are none or the hold has run out. */
async function heldAppointments(tx: Transaction, order: { id: string; status: string }, now: Date) {
  if (order.status !== "requested") throw new OrderError("invalid_status", `This order is ${order.status}`);
  const held = (await activeAppointments(tx, order.id)).filter((a) => a.status === "held");
  if (held.length === 0) throw new OrderError("invalid_status", "This request has already been answered");
  if (holdExpiresAt(held[0]!) <= now) throw new OrderError("invalid_status", "This request has expired");
  return held;
}

/**
 * The business accepts a request: its held times are confirmed. A quote order
 * then waits for its quote; anything else is booked.
 */
export function acceptRequest(input: BusinessInput) {
  const now = input.now ?? new Date();
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId, { businessId: input.businessId });
      const held = await heldAppointments(tx, order, now);

      await tx
        .update(appointments)
        .set({ status: "confirmed", updatedAt: now })
        .where(inArray(appointments.id, held.map((a) => a.id)));

      const [service] = await tx
        .select({ pricingMode: businessServices.pricingMode })
        .from(businessServices)
        .where(eq(businessServices.id, order.businessServiceId));
      const [agreed] = await tx
        .select({ id: quotes.id })
        .from(quotes)
        .where(and(eq(quotes.orderId, order.id), eq(quotes.status, "accepted")))
        .limit(1);
      const status = service!.pricingMode === "quote" && !agreed ? "requested" : "confirmed";

      await tx.update(orders).set({ status, updatedAt: now }).where(eq(orders.id, order.id));
      await recordEvent(tx, eventIds, {
        orderId: order.id,
        actor: "business",
        type: "order.accepted",
        payload: { appointmentId: held[0]!.id, scheduledAt: held[0]!.scheduledAt, ...actorPayload(byBusiness(input)) },
      });
    }),
  );
}

/** Ends a requested order that won't go ahead, freeing any time it holds. */
async function endRequest(
  tx: Transaction,
  eventIds: string[],
  order: { id: string },
  status: "declined" | "expired",
  event: { actor: "business" | "system"; type: string; payload: Record<string, unknown> },
  now: Date,
) {
  const [first] = await activeAppointments(tx, order.id);
  await settleAppointments(tx, order.id, now);
  await tx
    .update(quotes)
    .set({ status: status === "expired" ? "expired" : "declined" })
    .where(and(eq(quotes.orderId, order.id), eq(quotes.status, "sent")));
  await tx.update(orders).set({ status, updatedAt: now }).where(eq(orders.id, order.id));
  await recordEvent(tx, eventIds, {
    orderId: order.id,
    ...event,
    payload: { appointmentId: first?.id ?? null, scheduledAt: first?.scheduledAt ?? null, ...event.payload },
  });
}

/**
 * The business turns a request down — a time it can't do, or a quote it won't
 * give. Not held against its reliability: a request is the business's to decide.
 */
export function declineRequest(input: BusinessInput & { reason: string | null }) {
  const now = input.now ?? new Date();
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId, { businessId: input.businessId });
      if (order.status !== "requested" && order.status !== "quoted") {
        throw new OrderError("invalid_status", `This order is ${order.status}`);
      }
      await endRequest(
        tx,
        eventIds,
        order,
        "declined",
        { actor: "business", type: "order.declined", payload: { reason: input.reason, ...actorPayload(byBusiness(input)) } },
        now,
      );
    }),
  );
}

/** The worker's sweep: requests nobody answered in time expire and free their slot. */
export async function expireRequest(orderId: string, now = new Date()) {
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, orderId, null);
      if (order.status !== "requested") return false;
      const held = (await activeAppointments(tx, order.id)).filter((a) => a.status === "held");
      if (held.length === 0 || holdExpiresAt(held[0]!) > now) return false;

      await endRequest(tx, eventIds, order, "expired", { actor: "system", type: "order.expired", payload: {} }, now);
      return true;
    }),
  );
}

// --- quotes -------------------------------------------------------------------------

export const DEFAULT_QUOTE_VALID_DAYS = 7;

export type LineItem = { description: string; amountAed: number };

/**
 * The business sends a quote for a quote-priced order. Sending one also
 * accepts a visit still waiting on the business, and replaces a quote sent
 * earlier, which is marked expired.
 */
export function sendQuote(
  input: BusinessInput & { amountAed: number; estDurationMin: number; lineItems: LineItem[]; validUntil: Date },
) {
  const now = input.now ?? new Date();
  if (input.validUntil <= now) return Promise.reject(new OrderError("invalid_request", "validUntil must be in the future"));

  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId, { businessId: input.businessId });
      if (order.status !== "requested" && order.status !== "quoted") {
        throw new OrderError("invalid_status", `This order is ${order.status}`);
      }
      const [service] = await tx
        .select({ pricingMode: businessServices.pricingMode })
        .from(businessServices)
        .where(eq(businessServices.id, order.businessServiceId));
      if (service!.pricingMode !== "quote") {
        throw new OrderError("invalid_status", "This order's service isn't priced by quote");
      }

      await tx
        .update(appointments)
        .set({ status: "confirmed", updatedAt: now })
        .where(and(eq(appointments.orderId, order.id), eq(appointments.status, "held")));
      const replaced = await openQuote(tx, order.id);
      if (replaced) await tx.update(quotes).set({ status: "expired" }).where(eq(quotes.id, replaced.id));

      const [quote] = await tx
        .insert(quotes)
        .values({
          orderId: order.id,
          amountAed: input.amountAed.toFixed(2),
          estDurationMin: input.estDurationMin,
          lineItems: input.lineItems,
          validUntil: input.validUntil,
          status: "sent",
          createdAt: now,
        })
        .returning({ id: quotes.id });

      await tx.update(orders).set({ status: "quoted", updatedAt: now }).where(eq(orders.id, order.id));
      await recordEvent(tx, eventIds, {
        orderId: order.id,
        actor: "business",
        type: "quote.sent",
        payload: {
          quoteId: quote!.id,
          amountAed: input.amountAed,
          estDurationMin: input.estDurationMin,
          validUntil: input.validUntil,
          replacesQuoteId: replaced?.id ?? null,
          ...actorPayload(byBusiness(input)),
        },
      });
    }),
  );
}

/** The worker's sweep: a quote past its validUntil expires, and so does the order waiting on it. */
export async function expireQuote(orderId: string, now = new Date()) {
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, orderId, null);
      if (order.status !== "quoted") return false;
      const quote = await openQuote(tx, order.id);
      if (!quote || quote.validUntil > now) return false;

      await endRequest(
        tx,
        eventIds,
        order,
        "expired",
        { actor: "system", type: "quote.expired", payload: { quoteId: quote.id, amountAed: Number(quote.amountAed) } },
        now,
      );
      return true;
    }),
  );
}

// --- the end of an order ----------------------------------------------------------------

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

/** What was actually charged, and for a per-unit order how many units there turned out to be. */
export type FinalPrice = { finalPriceAed: number; quantity?: number };

async function recordFinalPrice(
  tx: Transaction,
  eventIds: string[],
  order: { id: string },
  price: FinalPrice,
  by: ByBusiness,
  now: Date,
) {
  await tx
    .update(orders)
    .set({
      finalPriceAed: price.finalPriceAed.toFixed(2),
      ...(price.quantity === undefined ? {} : { quantity: String(price.quantity) }),
      updatedAt: now,
    })
    .where(eq(orders.id, order.id));
  await recordEvent(tx, eventIds, {
    orderId: order.id,
    actor: "business",
    type: "order.final_price",
    payload: { finalPriceAed: price.finalPriceAed, quantity: price.quantity ?? null, ...actorPayload(by) },
  });
}

/**
 * Ends a confirmed order that has started, as completed or as a no-show. The
 * worker completes orders a while after they end (orders/sweeps.ts); a
 * business can complete one sooner, with its final price, or mark a no-show.
 */
function finish(
  orderId: string,
  by: ByBusiness | BySystem,
  outcome: "completed" | "no_show",
  now: Date,
  price?: FinalPrice,
) {
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
        payload: actorPayload(by),
      });
      if (price && by.actor === "business") await recordFinalPrice(tx, eventIds, order, price, by, now);
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

export function completeOrder(input: BusinessInput & { price?: FinalPrice }) {
  return finish(input.orderId, byBusiness(input), "completed", input.now ?? new Date(), input.price);
}

export function markNoShow(input: BusinessInput) {
  return finish(input.orderId, byBusiness(input), "no_show", input.now ?? new Date());
}

/** The worker's automatic completion (§9). */
export function completeOrderAutomatically(orderId: string, now = new Date()) {
  return finish(orderId, { actor: "system" }, "completed", now);
}

/**
 * Sets the final price after the job, for an order already completed — the
 * worker may have completed it before the business got round to it.
 */
export function setFinalPrice(input: BusinessInput & { price: FinalPrice }) {
  const now = input.now ?? new Date();
  return withEvents((eventIds) =>
    getDb().transaction(async (tx) => {
      const order = await lockOrder(tx, input.orderId, { businessId: input.businessId });
      if (order.status !== "completed") {
        throw new OrderError("invalid_status", "A final price is set once the order is completed");
      }
      await recordFinalPrice(tx, eventIds, order, input.price, byBusiness(input), now);
    }),
  );
}
