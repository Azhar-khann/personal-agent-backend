import { and, asc, eq, inArray } from "drizzle-orm";

import type { Executor, Transaction } from "../db/client.js";
import { appointments, businesses, orders } from "../db/schema.js";

/**
 * Why an order operation was refused. The API maps not_found to 404,
 * invalid_request to 400, and the rest to 409.
 */
export type OrderErrorCode = "not_found" | "invalid_request" | "invalid_status" | "slot_unavailable";

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export const slotUnavailable = () =>
  new OrderError("slot_unavailable", "That time is no longer available");

/** Appointment states that still hold time for their order. */
export const ACTIVE_APPOINTMENT_STATUSES = ["held", "confirmed"] as const;

/**
 * Locks an order for a state change, checking it belongs to whoever asks.
 * Someone else's order is simply not found.
 */
export async function lockOrder(
  tx: Transaction,
  orderId: string,
  owner: { userId: string } | { businessId: string },
) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  const owned =
    order !== undefined &&
    ("userId" in owner ? order.userId === owner.userId : order.businessId === owner.businessId);
  if (!owned) throw new OrderError("not_found", "No such order");
  return order;
}

/**
 * Makes transactions that give out a business's time queue up, and returns
 * the business as it is now that the lock is held.
 *
 * Without it, two bookings can pass the availability check at once and race
 * to insert. The no_double_booking constraint still keeps the data right, but
 * simultaneous inserts wait on each other's uncommitted index entries and can
 * deadlock (40P01) — seen with four bookings for one slot. Queued, each booking
 * recomputes after the previous one commits, so the check catches the clash.
 *
 * NO KEY UPDATE rather than UPDATE, so writes that merely reference the
 * business (a new closure, an order's foreign key) aren't blocked.
 */
export async function lockBusiness(tx: Transaction, businessId: string) {
  const [business] = await tx
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .for("no key update");
  return business;
}

/** A business that can be given new time: it exists and isn't pending or suspended. */
export function assertBookable(business: typeof businesses.$inferSelect | undefined) {
  if (business?.status !== "active") {
    throw new OrderError("invalid_status", "This business isn't taking new bookings");
  }
  return business;
}

/** An order's appointments that still hold time, earliest first. */
export function activeAppointments(db: Executor, orderId: string) {
  return db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.orderId, orderId),
        inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
      ),
    )
    .orderBy(asc(appointments.scheduledAt));
}
