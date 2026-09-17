import { emptyState, getDb, loadState, saveState, schema, type Transaction } from "@personal-agent/core";
import { desc, eq } from "drizzle-orm";

import { deliveryFor } from "./delivery.js";
import type { PushSender } from "./push.js";

const { appointments, businesses, businessServices, conversations, messages, orderEvents, orders, searches, users } =
  schema;

export type DeliveryOutcome =
  | { result: "delivered"; pushed: Awaited<ReturnType<PushSender>> | null; messaged: boolean }
  | { result: "already_delivered" | "skipped" };

/** The order's own conversation, else the user's latest, else a new one. */
async function conversationFor(tx: Transaction, userId: string, fromSearch: string | null, now: Date) {
  if (fromSearch) return fromSearch;
  const [latest] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  if (latest) return latest.id;
  const [created] = await tx
    .insert(conversations)
    .values({ userId, createdAt: now, updatedAt: now })
    .returning({ id: conversations.id });
  return created!.id;
}

/**
 * Delivers one order event: a push to the business, a message to the user, or
 * neither (deliveryFor decides), then marks it delivered.
 *
 * The event row stays locked through the delivery and delivered_at is set in
 * the same transaction, so a retried or duplicated job delivers once. A row
 * another worker has locked is skipped: that worker is delivering it.
 */
export async function deliverEvent(eventId: string, sendPush: PushSender, now = new Date()): Promise<DeliveryOutcome> {
  return getDb().transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.id, eventId))
      .for("update", { skipLocked: true });
    if (!event) return { result: "skipped" };
    if (event.deliveredAt) return { result: "already_delivered" };

    const [context] = await tx
      .select({
        userId: orders.userId,
        businessId: orders.businessId,
        serviceAddress: orders.serviceAddress,
        quantity: orders.quantity,
        unitLabel: businessServices.unitLabel,
        businessName: businesses.name,
        businessPhone: businesses.phone,
        categoryId: businesses.categoryId,
        serviceName: businessServices.displayName,
        canonicalServiceId: businessServices.canonicalServiceId,
        customerName: users.name,
        userTimeZone: users.timezone,
        conversationId: searches.conversationId,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .innerJoin(businessServices, eq(businessServices.id, orders.businessServiceId))
      .innerJoin(users, eq(users.id, orders.userId))
      .leftJoin(searches, eq(searches.id, orders.searchId))
      .where(eq(orders.id, event.orderId));
    if (!context) return { result: "skipped" };

    const payload = event.payload as {
      appointmentId?: string | null;
      from?: string;
      to?: string;
      reason?: string | null;
      needsApproval?: boolean;
      holdExpiresAt?: string | null;
      amountAed?: number;
      finalPriceAed?: number;
      estDurationMin?: number;
      validUntil?: string;
      quantity?: number | null;
    };
    // The appointment the event names, else the order's most recent one.
    const [appointment] = await tx
      .select({
        scheduledAt: appointments.scheduledAt,
        kind: appointments.kind,
      })
      .from(appointments)
      .where(payload.appointmentId ? eq(appointments.id, payload.appointmentId) : eq(appointments.orderId, event.orderId))
      .orderBy(desc(appointments.createdAt))
      .limit(1);

    const delivery = deliveryFor(event.type, {
      businessName: context.businessName,
      businessPhone: context.businessPhone,
      serviceName: context.serviceName,
      customerName: context.customerName,
      scheduledAt: appointment?.scheduledAt ?? null,
      appointmentKind: appointment?.kind ?? null,
      from: payload.from ? new Date(payload.from) : null,
      to: payload.to ? new Date(payload.to) : null,
      serviceAddress: context.serviceAddress,
      reason: payload.reason ?? null,
      userTimeZone: context.userTimeZone,
      holdExpiresAt: payload.holdExpiresAt ? new Date(payload.holdExpiresAt) : null,
      needsApproval: payload.needsApproval ?? false,
      amountAed: payload.finalPriceAed ?? payload.amountAed ?? null,
      estDurationMin: payload.estDurationMin ?? null,
      validUntil: payload.validUntil ? new Date(payload.validUntil) : null,
      quantity: payload.quantity ?? (context.quantity === null ? null : Number(context.quantity)),
      unitLabel: context.unitLabel,
    });

    const pushed = delivery.push
      ? await sendPush(context.businessId, { ...delivery.push, orderId: event.orderId })
      : null;

    if (delivery.message) {
      const conversationId = await conversationFor(tx, context.userId, context.conversationId, now);
      await tx.insert(messages).values({
        conversationId,
        role: "assistant",
        content: delivery.message,
        createdAt: now,
        metadata: { kind: "notification", order_id: event.orderId, event_type: event.type },
      });
      await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversationId));

      if (delivery.offerRebooking) {
        // Only into a conversation with nothing under way: never overwrite a live request.
        const state = await loadState(conversationId);
        if (state.categoryId === null && state.pendingChoice === null) {
          await saveState(
            conversationId,
            { ...emptyState(), categoryId: context.categoryId, serviceId: context.canonicalServiceId },
            now,
            tx,
          );
        }
      }
    }

    await tx.update(orderEvents).set({ deliveredAt: now }).where(eq(orderEvents.id, event.id));
    return { result: "delivered", pushed, messaged: Boolean(delivery.message) };
  });
}
