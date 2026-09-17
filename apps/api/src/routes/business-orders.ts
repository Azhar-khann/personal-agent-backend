import {
  acceptRequest,
  cancelOrderByBusiness,
  completeOrder,
  DEFAULT_QUOTE_VALID_DAYS,
  declineRequest,
  getDb,
  holdExpiresAt,
  markNoShow,
  schema,
  sendQuote,
  setFinalPrice,
} from "@personal-agent/core";
import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { currentBusiness } from "../business.js";
import { parse, uuidParam } from "../http.js";
import { loadOrders } from "../orders.js";
import { dateTime, timeRangeQuery } from "../validation.js";

/**
 * The calendar and order actions (§8). Staff can use all of these: §3 says
 * staff manage bookings, only owners change prices and hours.
 */
export const businessOrdersRouter = Router();

const { appointments, businessServices, orders, users } = schema;

/** GET /api/business/calendar?from=&to= — the main screen, held requests included. */
businessOrdersRouter.get("/calendar", async (req, res) => {
  const { from, to } = parse(timeRangeQuery(31), req.query);

  const rows = await getDb()
    .select({
      appointment: appointments,
      order: {
        id: orders.id,
        status: orders.status,
        serviceAddress: orders.serviceAddress,
        quantity: orders.quantity,
        details: orders.details,
        priceAed: orders.priceAed,
      },
      service: {
        displayName: businessServices.displayName,
        pricingMode: businessServices.pricingMode,
        unitLabel: businessServices.unitLabel,
      },
      customer: { name: users.name, phone: users.phone },
    })
    .from(appointments)
    .innerJoin(orders, eq(orders.id, appointments.orderId))
    .innerJoin(businessServices, eq(businessServices.id, orders.businessServiceId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(
      and(
        eq(appointments.businessId, currentBusiness(req).id),
        gte(appointments.scheduledAt, from),
        lt(appointments.scheduledAt, to),
        ne(appointments.status, "cancelled"),
      ),
    )
    .orderBy(asc(appointments.scheduledAt), asc(appointments.resourceIndex));

  res.json({
    appointments: rows.map(({ appointment, order, service, customer }) => ({
      id: appointment.id,
      kind: appointment.kind,
      // Which resource: the calendar is split by resource (§10).
      resourceIndex: appointment.resourceIndex,
      scheduledAt: appointment.scheduledAt,
      durationMin: appointment.durationMin,
      bufferMin: appointment.bufferMin,
      status: appointment.status,
      // A held appointment is a request to accept or decline by then.
      holdExpiresAt: appointment.status === "held" ? holdExpiresAt(appointment) : null,
      order: {
        ...order,
        quantity: order.quantity === null ? null : Number(order.quantity),
        priceAed: order.priceAed === null ? null : Number(order.priceAed),
      },
      serviceName: service.displayName,
      pricingMode: service.pricingMode,
      unitLabel: service.unitLabel,
      customer,
    })),
  });
});

/** Who is acting, for the order and the event it writes. */
function actor(req: Request) {
  return {
    orderId: uuidParam(req.params["id"]),
    businessId: currentBusiness(req).id,
    byUserId: currentUser(req).id,
  };
}

async function orderResponse(orderId: string) {
  const [order] = await loadOrders(eq(orders.id, orderId));
  return { order };
}

const money = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), "at most 2 decimal places");

const CancelBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

businessOrdersRouter.post("/orders/:id/cancel", async (req, res) => {
  const { reason } = parse(CancelBody, req.body ?? {});
  const who = actor(req);
  await cancelOrderByBusiness({ ...who, reason });
  res.json(await orderResponse(who.orderId));
});

/** A request the business confirms: its held times become booked. */
businessOrdersRouter.post("/orders/:id/accept", async (req, res) => {
  const who = actor(req);
  await acceptRequest(who);
  res.json(await orderResponse(who.orderId));
});

const DeclineBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** Turns down a request, or a quote request; the time is freed and the user told. */
businessOrdersRouter.post("/orders/:id/decline", async (req, res) => {
  const { reason } = parse(DeclineBody, req.body ?? {});
  const who = actor(req);
  await declineRequest({ ...who, reason: reason ?? null });
  res.json(await orderResponse(who.orderId));
});

const QuoteBody = z
  .object({
    amountAed: money,
    estDurationMin: z.number().int().min(15).max(7 * 24 * 60),
    lineItems: z
      .array(z.object({ description: z.string().trim().min(1).max(200), amountAed: money }).strict())
      .max(50)
      .default([]),
    // Defaults to a week.
    validUntil: dateTime.optional(),
  })
  .strict();

/** Sends a quote, replacing one already sent. */
businessOrdersRouter.post("/orders/:id/quote", async (req, res) => {
  const body = parse(QuoteBody, req.body ?? {});
  const who = actor(req);
  await sendQuote({
    ...who,
    ...body,
    validUntil: body.validUntil ?? new Date(Date.now() + DEFAULT_QUOTE_VALID_DAYS * 24 * 60 * 60_000),
  });
  res.json(await orderResponse(who.orderId));
});

businessOrdersRouter.post("/orders/:id/no-show", async (req, res) => {
  const who = actor(req);
  await markNoShow(who);
  res.json(await orderResponse(who.orderId));
});

const FinalPriceBody = z.object({ finalPriceAed: money, quantity: z.number().positive().max(99_999_999).optional() }).strict();

/**
 * A manual override: the worker normally completes orders (Stage 7). The
 * final price, and a per-unit order's actual quantity, can come with it.
 */
businessOrdersRouter.post("/orders/:id/complete", async (req, res) => {
  const body = parse(FinalPriceBody.partial({ finalPriceAed: true }), req.body ?? {});
  const who = actor(req);
  await completeOrder({
    ...who,
    price: body.finalPriceAed === undefined ? undefined : { finalPriceAed: body.finalPriceAed, quantity: body.quantity },
  });
  res.json(await orderResponse(who.orderId));
});

/** The final price for an order already completed, e.g. by the worker. */
businessOrdersRouter.post("/orders/:id/final-price", async (req, res) => {
  const price = parse(FinalPriceBody, req.body ?? {});
  const who = actor(req);
  await setFinalPrice({ ...who, price });
  res.json(await orderResponse(who.orderId));
});
