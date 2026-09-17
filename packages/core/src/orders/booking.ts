import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { getDb, type Executor, type Transaction } from "../db/client.js";
import { PG_ERROR, pgErrorCode } from "../db/errors.js";
import {
  appointments,
  businesses,
  businessServices,
  orders,
  quotes,
  searches,
  searchOptions,
  type Step,
} from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import { freeChains, type ChainStep, type Interval } from "../search/availability.js";
import { chainReachMin, loadAvailability } from "../search/find-options.js";
import { constraintNumber } from "../search/run-search.js";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  activeAppointments,
  assertBookable,
  holdExpiresAt,
  lockBusiness,
  lockOrder,
  OrderError,
  recordEvent,
  releaseAppointments,
  settleAppointments,
  slotUnavailable,
  withEvents,
} from "./common.js";

type Business = typeof businesses.$inferSelect;
type Service = typeof businessServices.$inferSelect;

const MINUTE_MS = 60_000;

/** A time the user can pick, and the later steps' times that come with it. */
export type ChainTimes = { slotAt: Date; laterSlots: Date[] };

const toChainSteps = (steps: Step[]): ChainStep[] =>
  steps.map((step) => ({ durationMin: step.duration_min, afterHours: step.after_hours }));

/**
 * Free times at one business for a chain of steps, worked out from scratch.
 * An order being moved is left out, so it can move to a time that overlaps its own.
 */
async function businessChains(args: {
  business: Business;
  steps: ChainStep[];
  window: Interval;
  now: Date;
  excludeOrderId?: string;
}): Promise<ChainTimes[]> {
  const { business, steps, window, now, excludeOrderId } = args;
  const reach = chainReachMin(
    steps.map((step) => ({ kind: "job", duration_min: step.durationMin, after_hours: step.afterHours })),
    business.bufferMin,
  );
  const range = { start: window.start, end: new Date(window.end.getTime() + reach * MINUTE_MS) };
  const data = (await loadAvailability([business.id], range)).get(business.id)!;

  return freeChains({
    now,
    window,
    steps,
    rules: business,
    hours: data.hours,
    closures: data.closures,
    appointments: data.appointments.filter((a) => a.orderId !== excludeOrderId),
  }).map((chain) => ({
    slotAt: chain.slots[0]!.start,
    laterSlots: chain.slots.slice(1).map((slot) => slot.start),
  }));
}

/** The lowest free resource for one step at exactly `slotAt`, or null if that time can't be had. */
async function freeResourceAt(args: {
  business: Business;
  durationMin: number;
  slotAt: Date;
  now: Date;
  excludeOrderId?: string;
}): Promise<number | null> {
  const { business, durationMin, slotAt, now, excludeOrderId } = args;
  const window = { start: slotAt, end: new Date(slotAt.getTime() + 1) };
  const range = { start: slotAt, end: new Date(slotAt.getTime() + (durationMin + business.bufferMin) * MINUTE_MS) };
  const data = (await loadAvailability([business.id], range)).get(business.id)!;
  const [chain] = freeChains({
    now,
    window,
    steps: [{ durationMin }],
    rules: business,
    hours: data.hours,
    closures: data.closures,
    appointments: data.appointments.filter((a) => a.orderId !== excludeOrderId),
  });
  return chain?.slots[0]!.resourceIndex ?? null;
}

/**
 * Inserts one appointment per step at the given times, each on a resource free
 * at its time. The steps are spaced so none overlaps another, which is why each
 * can be checked on its own.
 */
async function insertAppointments(
  tx: Transaction,
  args: {
    orderId: string;
    business: Business;
    steps: Step[];
    times: Date[];
    status: "held" | "confirmed";
    now: Date;
    excludeOrderId?: string;
  },
): Promise<{ id: string; kind: string; scheduledAt: Date }[]> {
  const inserted = [];
  for (const [i, step] of args.steps.entries()) {
    const slotAt = args.times[i]!;
    const resourceIndex = await freeResourceAt({
      business: args.business,
      durationMin: step.duration_min,
      slotAt,
      now: args.now,
      excludeOrderId: args.excludeOrderId,
    });
    if (resourceIndex === null) throw slotUnavailable();

    const [row] = await tx
      .insert(appointments)
      .values({
        orderId: args.orderId,
        businessId: args.business.id,
        kind: step.kind,
        resourceIndex,
        scheduledAt: slotAt,
        durationMin: step.duration_min,
        // Frozen at booking, like the price.
        bufferMin: args.business.bufferMin,
        status: args.status,
      })
      .returning({ id: appointments.id, kind: appointments.kind, scheduledAt: appointments.scheduledAt });
    inserted.push(row!);
  }
  return inserted;
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

/** The user's other orders with an appointment overlapping [start, end): allowed, but worth a warning (§7). */
async function overlappingOrders(tx: Transaction, userId: string, orderId: string, start: Date, end: Date) {
  const rows = await tx
    .selectDistinct({ orderId: appointments.orderId })
    .from(appointments)
    .innerJoin(orders, eq(orders.id, appointments.orderId))
    .where(
      and(
        eq(orders.userId, userId),
        ne(orders.id, orderId),
        inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
        lt(appointments.scheduledAt, end),
        // No column on the left to encode the Date, so it goes in as text.
        sql`${appointments.scheduledAt} + make_interval(mins => ${appointments.durationMin}) > ${start.toISOString()}::timestamptz`,
      ),
    );
  return rows.map((row) => row.orderId);
}

/** What the order is at booking, from the service's settings. */
function initialStatus(service: Service) {
  // A quote order waits for its quote; a request waits for the business.
  const order = service.pricingMode === "quote" || service.confirmation === "request" ? "requested" : "confirmed";
  const appointment = service.confirmation === "request" ? "held" : "confirmed";
  return { order, appointment } as const;
}

export type BookingResult = {
  orderId: string;
  /** confirmed, or requested when the business must confirm or quote first. */
  status: "confirmed" | "requested";
  /** The user's other orders at an overlapping time: allowed, but worth a warning (§7). */
  overlappingOrderIds: string[];
};

/**
 * §6 — books a time the user picked from a search's options: an order with an
 * appointment per step. The later steps take the times shown with the option.
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
    withEvents((eventIds) =>
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

        const offered = option.offeredSlots.findIndex((slot) => slot.getTime() === input.slotAt.getTime());
        if (offered === -1) {
          throw new OrderError("invalid_request", "That time wasn't one of the times offered");
        }
        const times = [input.slotAt, ...(option.laterSlots?.[offered] ?? []).map((time) => new Date(time))];

        const business = await lockBusiness(tx, option.businessId);

        // Since the list was shown, the business may have been suspended or
        // changed the service. A different price or different steps count too:
        // the user agreed to what was on screen.
        if (
          business?.status !== "active" ||
          !service.active ||
          service.priceAed !== option.priceAed ||
          service.steps.length !== times.length
        ) {
          throw slotUnavailable();
        }

        // The later times were worked out with the service's gaps then; a gap
        // widened since would put them too close together.
        for (const [i, step] of service.steps.entries()) {
          if (i === 0) continue;
          const previous = service.steps[i - 1]!;
          const earliest =
            times[i - 1]!.getTime() +
            (previous.duration_min + business.bufferMin) * MINUTE_MS +
            (step.after_hours ?? 0) * 60 * MINUTE_MS;
          if (times[i]!.getTime() < earliest) throw slotUnavailable();
        }

        const status = initialStatus(service);
        // What the agent collected is for the business to read — except the
        // budget, which only ranked the options, our own reminder link, and the
        // quantity, which has its own column.
        const {
          budget_max: _budget,
          reminder_id: _reminder,
          quantity: _quantity,
          ...details
        } = search.constraints as Record<string, unknown>;
        const quantity = service.pricingMode === "per_unit" ? constraintNumber(search.constraints, "quantity") : null;
        const unitPrice = service.priceAed === null ? null : Number(service.priceAed);
        const away = service.locationMode !== "at_business";

        const [order] = await tx
          .insert(orders)
          .values({
            searchId: search.id,
            businessId: business.id,
            userId: input.userId,
            businessServiceId: service.id,
            status: status.order,
            serviceAddress: away ? search.address : null,
            serviceLat: away ? search.lat : null,
            serviceLng: away ? search.lng : null,
            quantity: quantity === null ? null : String(quantity),
            details: {
              ...details,
              // A quote service's price is the visit's fee, not the job's.
              ...(service.pricingMode === "quote" && unitPrice !== null ? { visit_fee_aed: unitPrice } : {}),
            },
            // Copied, so a later price rise leaves this order as agreed. A
            // per-unit order holds the estimate; a quote order has no price
            // until its quote is accepted.
            priceAed:
              service.pricingMode === "quote"
                ? null
                : service.pricingMode === "per_unit"
                  ? quantity === null || unitPrice === null
                    ? null
                    : (unitPrice * quantity).toFixed(2)
                  : service.priceAed,
          })
          .returning({ id: orders.id });

        const booked = await insertAppointments(tx, {
          orderId: order!.id,
          business,
          steps: service.steps,
          times,
          status: status.appointment,
          now,
        });

        await recordEvent(tx, eventIds, {
          orderId: order!.id,
          actor: "user",
          type: status.order === "confirmed" ? "order.confirmed" : "order.requested",
          payload: {
            appointmentId: booked[0]!.id,
            scheduledAt: input.slotAt,
            appointments: booked.map(({ id, kind, scheduledAt }) => ({ id, kind, scheduledAt })),
            // Recorded now, so a late delivery still says when the request lapses.
            holdExpiresAt: status.appointment === "held" ? holdExpiresAt({ createdAt: now, scheduledAt: input.slotAt }) : null,
          },
        });
        await tx.update(searches).set({ status: "booked", updatedAt: now }).where(eq(searches.id, search.id));
        await tx.update(searchOptions).set({ selectedAt: now }).where(eq(searchOptions.id, option.id));
        await incrementStats(tx, business.id, ["timesSelected", "bookingsTotal"], now);

        const first = service.steps[0]!;
        const overlappingOrderIds = await overlappingOrders(
          tx,
          input.userId,
          order!.id,
          input.slotAt,
          new Date(input.slotAt.getTime() + first.duration_min * MINUTE_MS),
        );
        return { orderId: order!.id, status: status.order, overlappingOrderIds };
      }),
    ),
  );
}

// --- moving an order ----------------------------------------------------------

/**
 * What moving an order would move: its appointments that still hold time, as a
 * chain. Only a confirmed or requested order can move, and only before its
 * first appointment starts. A quote order's visit moves while the quote is
 * awaited; once the job is booked, the job moves.
 */
async function movable(db: Executor, order: typeof orders.$inferSelect, now: Date) {
  if (order.status !== "confirmed" && order.status !== "requested") {
    throw new OrderError("invalid_status", `This order is ${order.status}`);
  }
  const current = await activeAppointments(db, order.id);
  if (current.length === 0) throw new OrderError("invalid_status", "This order has nothing to move");
  if (current[0]!.scheduledAt <= now) {
    throw new OrderError("invalid_status", "This appointment has already started");
  }

  const [service] = await db.select().from(businessServices).where(eq(businessServices.id, order.businessServiceId));
  // Durations as booked; the gaps between steps as the service has them now.
  const steps: Step[] = current.map((appointment, i) => ({
    kind: appointment.kind as Step["kind"],
    duration_min: appointment.durationMin,
    ...(i > 0 ? { after_hours: service!.steps.find((step) => step.kind === appointment.kind)?.after_hours ?? 0 } : {}),
  }));
  return { current, service: service!, steps };
}

/** Whether a move needs the business to approve it again: a request service, unless a quote has already been agreed. */
async function moveNeedsApproval(db: Executor, order: { id: string }, service: Service): Promise<boolean> {
  if (service.confirmation !== "request") return false;
  const [agreed] = await db
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.orderId, order.id), eq(quotes.status, "accepted")))
    .limit(1);
  return !agreed;
}

/** Free times an order could move to, at the same business, for the same steps. */
export async function rescheduleTimes(input: {
  userId: string;
  orderId: string;
  window: Interval;
  now?: Date;
}): Promise<ChainTimes[]> {
  const now = input.now ?? new Date();
  const db = getDb();

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)));
  if (!order) throw new OrderError("not_found", "No such order");

  const { steps } = await movable(db, order, now);
  const [row] = await db.select().from(businesses).where(eq(businesses.id, order.businessId));
  return businessChains({
    business: assertBookable(row),
    steps: toChainSteps(steps),
    window: input.window,
    now,
    excludeOrderId: order.id,
  });
}

/**
 * Moves an order to a new time at the same business. The order stays — only
 * its appointments are replaced, in one transaction — so the agreed price
 * holds. Later steps take the earliest free times after the new first one.
 * A request service's order goes back to waiting for the business.
 */
export function rescheduleOrder(input: {
  userId: string;
  orderId: string;
  slotAt: Date;
  now?: Date;
}): Promise<{ status: "confirmed" | "requested" }> {
  const now = input.now ?? new Date();

  return withSlotGuard(() =>
    withEvents((eventIds) =>
      getDb().transaction(async (tx) => {
        const order = await lockOrder(tx, input.orderId, { userId: input.userId });
        const { current, service, steps } = await movable(tx, order, now);
        const business = assertBookable(await lockBusiness(tx, order.businessId));

        const [chain] = await businessChains({
          business,
          steps: toChainSteps(steps),
          window: { start: input.slotAt, end: new Date(input.slotAt.getTime() + 1) },
          now,
          excludeOrderId: order.id,
        });
        if (!chain) throw slotUnavailable();

        const approval = await moveNeedsApproval(tx, order, service);
        // A request still waiting stays waiting; a confirmed one waits again.
        const status = approval ? "requested" : order.status === "requested" ? "requested" : "confirmed";
        const appointmentStatus = approval ? "held" : current[0]!.status === "held" ? "held" : "confirmed";

        // Released first, so the old times leave the constraint's index before
        // the new appointments are checked against it.
        await releaseAppointments(tx, order.id, now);
        const moved = await insertAppointments(tx, {
          orderId: order.id,
          business,
          steps,
          times: [chain.slotAt, ...chain.laterSlots],
          status: appointmentStatus,
          now,
          excludeOrderId: order.id,
        });

        await tx.update(orders).set({ status, updatedAt: now }).where(eq(orders.id, order.id));
        await recordEvent(tx, eventIds, {
          orderId: order.id,
          actor: "user",
          type: "order.rescheduled",
          payload: {
            appointmentId: moved[0]!.id,
            from: current[0]!.scheduledAt,
            to: input.slotAt,
            needsApproval: approval,
            holdExpiresAt: appointmentStatus === "held" ? holdExpiresAt({ createdAt: now, scheduledAt: input.slotAt }) : null,
            appointments: moved.map(({ id, kind, scheduledAt }) => ({ id, kind, scheduledAt })),
          },
        });
        return { status };
      }),
    ),
  );
}

// --- booking the job a quote priced ---------------------------------------------

/** The quote an order is waiting on: the latest sent one. */
export async function openQuote(db: Executor, orderId: string) {
  const [quote] = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.orderId, orderId), eq(quotes.status, "sent")))
    .limit(1);
  return quote;
}

/** Free times for the job a quote priced, at the quote's estimated length. */
export async function quoteJobTimes(input: {
  userId: string;
  orderId: string;
  window: Interval;
  now?: Date;
}): Promise<ChainTimes[]> {
  const now = input.now ?? new Date();
  const db = getDb();

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)));
  if (!order) throw new OrderError("not_found", "No such order");
  if (order.status !== "quoted") throw new OrderError("invalid_status", `This order is ${order.status}`);
  const quote = await openQuote(db, order.id);
  if (!quote || quote.validUntil <= now) throw new OrderError("invalid_status", "This quote has expired");

  const [row] = await db.select().from(businesses).where(eq(businesses.id, order.businessId));
  return businessChains({
    business: assertBookable(row),
    steps: [{ durationMin: quote.estDurationMin }],
    window: input.window,
    now,
  });
}

/**
 * The user accepts a quote by picking a time for the job. The job is booked
 * confirmed at the quoted price — the quote is the business's agreement — and
 * a visit that hasn't happened yet is no longer needed.
 */
export function acceptQuote(input: {
  userId: string;
  orderId: string;
  slotAt: Date;
  now?: Date;
}): Promise<{ overlappingOrderIds: string[] }> {
  const now = input.now ?? new Date();

  return withSlotGuard(() =>
    withEvents((eventIds) =>
      getDb().transaction(async (tx) => {
        const order = await lockOrder(tx, input.orderId, { userId: input.userId });
        if (order.status !== "quoted") throw new OrderError("invalid_status", `This order is ${order.status}`);
        const quote = await openQuote(tx, order.id);
        if (!quote || quote.validUntil <= now) throw new OrderError("invalid_status", "This quote has expired");
        const business = assertBookable(await lockBusiness(tx, order.businessId));

        // A visit already under way or done counts as done; one still to come is dropped.
        await settleAppointments(tx, order.id, now);

        const [job] = await insertAppointments(tx, {
          orderId: order.id,
          business,
          steps: [{ kind: "job", duration_min: quote.estDurationMin }],
          times: [input.slotAt],
          status: "confirmed",
          now,
        });

        await tx.update(quotes).set({ status: "accepted" }).where(eq(quotes.id, quote.id));
        await tx
          .update(orders)
          .set({ status: "confirmed", priceAed: quote.amountAed, updatedAt: now })
          .where(eq(orders.id, order.id));
        await recordEvent(tx, eventIds, {
          orderId: order.id,
          actor: "user",
          type: "quote.accepted",
          payload: { quoteId: quote.id, appointmentId: job!.id, scheduledAt: input.slotAt, amountAed: Number(quote.amountAed) },
        });

        const overlappingOrderIds = await overlappingOrders(
          tx,
          input.userId,
          order.id,
          input.slotAt,
          new Date(input.slotAt.getTime() + quote.estDurationMin * MINUTE_MS),
        );
        return { overlappingOrderIds };
      }),
    ),
  );
}
