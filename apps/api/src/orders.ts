import { getDb, holdExpiresAt, schema } from "@personal-agent/core";
import { asc, desc, eq, inArray, type SQL } from "drizzle-orm";

const { appointments, businesses, businessServices, orders, quotes } = schema;

const money = (value: string | null) => (value === null ? null : Number(value));

/** Orders as the apps show them: the business, the service, when, and any quote. */
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
        unitLabel: businessServices.unitLabel,
        confirmation: businessServices.confirmation,
      },
    })
    .from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .innerJoin(businessServices, eq(businessServices.id, orders.businessServiceId))
    .where(where)
    .orderBy(desc(orders.createdAt));
  if (rows.length === 0) return [];

  const orderIds = rows.map((row) => row.order.id);
  const [appointmentRows, quoteRows] = await Promise.all([
    db.select().from(appointments).where(inArray(appointments.orderId, orderIds)).orderBy(asc(appointments.scheduledAt)),
    db.select().from(quotes).where(inArray(quotes.orderId, orderIds)).orderBy(desc(quotes.createdAt)),
  ]);

  return rows.map(({ order, business, service }) => {
    const all = appointmentRows.filter((a) => a.orderId === order.id);
    // A reschedule leaves the old appointments behind as cancelled. Show only
    // the current ones — unless the order itself ended early, when the
    // cancelled times are what the user wants to see.
    const endedEarly = ["cancelled_by_user", "cancelled_by_business", "declined", "expired"].includes(order.status);
    const shown = endedEarly ? all : all.filter((a) => a.status !== "cancelled");
    const held = shown.find((a) => a.status === "held");
    // The latest quote: the one to accept, or the one that was.
    const quote = quoteRows.find((q) => q.orderId === order.id);

    return {
      id: order.id,
      status: order.status,
      business,
      service,
      serviceAddress: order.serviceAddress,
      quantity: order.quantity === null ? null : Number(order.quantity),
      details: order.details,
      // The agreed price: the price, the minimum, a per-unit estimate, or the accepted quote.
      priceAed: money(order.priceAed),
      finalPriceAed: money(order.finalPriceAed),
      // While the business hasn't answered a request: when it lapses.
      holdExpiresAt: order.status === "requested" && held ? holdExpiresAt(held) : null,
      quote: quote
        ? {
            id: quote.id,
            amountAed: Number(quote.amountAed),
            estDurationMin: quote.estDurationMin,
            lineItems: quote.lineItems,
            validUntil: quote.validUntil,
            status: quote.status,
          }
        : null,
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
