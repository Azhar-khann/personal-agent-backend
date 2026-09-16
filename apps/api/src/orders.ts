import { getDb, schema } from "@personal-agent/core";
import { asc, desc, eq, inArray, type SQL } from "drizzle-orm";

const { appointments, businesses, businessServices, orders } = schema;

/** Orders as the user app shows them: the business, the service, and when. */
export async function loadOrders(where: SQL | undefined) {
  const db = getDb();

  const rows = await db
    .select({
      order: orders,
      business: {
        id: businesses.id,
        name: businesses.name,
        address: businesses.address,
        phone: businesses.phone,
      },
      service: {
        displayName: businessServices.displayName,
        locationMode: businessServices.locationMode,
        pricingMode: businessServices.pricingMode,
      },
    })
    .from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .innerJoin(businessServices, eq(businessServices.id, orders.businessServiceId))
    .where(where)
    .orderBy(desc(orders.createdAt));
  if (rows.length === 0) return [];

  const appointmentRows = await db
    .select()
    .from(appointments)
    .where(inArray(appointments.orderId, rows.map((row) => row.order.id)))
    .orderBy(asc(appointments.scheduledAt));

  return rows.map(({ order, business, service }) => {
    const all = appointmentRows.filter((a) => a.orderId === order.id);
    // A reschedule leaves the old appointment behind as cancelled. Show only
    // the current ones — unless the whole order was cancelled, when the
    // cancelled times are what the user wants to see.
    const shown = order.status.startsWith("cancelled") ? all : all.filter((a) => a.status !== "cancelled");

    return {
      id: order.id,
      status: order.status,
      business,
      service,
      serviceAddress: order.serviceAddress,
      priceAed: order.priceAed === null ? null : Number(order.priceAed),
      finalPriceAed: order.finalPriceAed === null ? null : Number(order.finalPriceAed),
      appointments: shown.map((a) => ({
        id: a.id,
        kind: a.kind,
        scheduledAt: a.scheduledAt,
        durationMin: a.durationMin,
        status: a.status,
      })),
      createdAt: order.createdAt,
    };
  });
}
