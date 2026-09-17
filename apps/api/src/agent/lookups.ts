import { getDb, schema, type LocationMode } from "@personal-agent/core";
import { and, desc, eq, or, sql } from "drizzle-orm";

import { loadOrders } from "../orders.js";

const { businesses, businessServices, messages, orders } = schema;

/** The last few messages of a conversation, oldest first. */
export async function recentMessages(conversationId: string, limit: number) {
  const rows = await getDb()
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export type UpcomingOrder = Awaited<ReturnType<typeof loadOrders>>[number];

/** The user's confirmed orders that haven't started, soonest first. */
export async function upcomingOrders(userId: string, now: Date): Promise<UpcomingOrder[]> {
  const confirmed = await loadOrders(and(eq(orders.userId, userId), eq(orders.status, "confirmed")));
  return confirmed
    .filter((order) => order.appointments[0] && order.appointments[0].scheduledAt > now)
    .sort((a, b) => a.appointments[0]!.scheduledAt.getTime() - b.appointments[0]!.scheduledAt.getTime())
    .slice(0, 10);
}

export type NamedBusiness = { id: string; name: string; address: string; categoryId: string };

const lettersAndDigits = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Active businesses whose name matches what the user typed, ignoring case,
 * spaces and punctuation: "marina cuts" finds "Marina Cuts", and so does
 * "Marina Cuts Dubai". Pending and suspended businesses aren't matched, so the
 * user hears "not on the app" rather than learning about them.
 */
export async function businessesNamed(typed: string): Promise<NamedBusiness[]> {
  const key = lettersAndDigits(typed);
  if (key.length < 3) return [];

  const name = sql`regexp_replace(lower(${businesses.name}), '[^a-z0-9]', '', 'g')`;
  return getDb()
    .select({ id: businesses.id, name: businesses.name, address: businesses.address, categoryId: businesses.categoryId })
    .from(businesses)
    .where(
      and(
        eq(businesses.status, "active"),
        or(
          sql`${name} LIKE ${`%${key}%`}::text`,
          sql`length(${name}) >= 3 AND ${key}::text LIKE '%' || ${name} || '%'`,
        ),
      ),
    )
    .limit(6);
}

export async function businessById(id: string): Promise<NamedBusiness | undefined> {
  const [business] = await getDb()
    .select({ id: businesses.id, name: businesses.name, address: businesses.address, categoryId: businesses.categoryId })
    .from(businesses)
    .where(eq(businesses.id, id));
  return business;
}

/** Where a business offers a service: at_business, at_customer, or both. */
export async function serviceLocationModes(businessId: string, serviceId: string): Promise<LocationMode[]> {
  const rows = await getDb()
    .select({ locationMode: businessServices.locationMode })
    .from(businessServices)
    .where(
      and(
        eq(businessServices.businessId, businessId),
        eq(businessServices.canonicalServiceId, serviceId),
        eq(businessServices.active, true),
      ),
    );
  return rows.map((row) => row.locationMode as LocationMode);
}
