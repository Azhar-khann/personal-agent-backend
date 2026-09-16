import {
  cancelOrderByBusiness,
  completeOrder,
  getDb,
  markNoShow,
  schema,
} from "@personal-agent/core";
import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { currentBusiness } from "../business.js";
import { parse, uuidParam } from "../http.js";
import { loadOrders } from "../orders.js";
import { timeRangeQuery } from "../validation.js";

/**
 * The calendar and booking actions (§8). Staff can use all of these: §3 says
 * staff manage bookings, only owners change prices and hours.
 */
export const businessOrdersRouter = Router();

const { appointments, businessServices, orders, users } = schema;

/** GET /api/business/calendar?from=&to= — the main screen. */
businessOrdersRouter.get("/calendar", async (req, res) => {
  const { from, to } = parse(timeRangeQuery(31), req.query);

  const rows = await getDb()
    .select({
      appointment: appointments,
      order: {
        id: orders.id,
        status: orders.status,
        serviceAddress: orders.serviceAddress,
        details: orders.details,
        priceAed: orders.priceAed,
      },
      serviceName: businessServices.displayName,
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
    appointments: rows.map(({ appointment, order, serviceName, customer }) => ({
      id: appointment.id,
      kind: appointment.kind,
      // Which chair: the calendar is split by chair (§10).
      resourceIndex: appointment.resourceIndex,
      scheduledAt: appointment.scheduledAt,
      durationMin: appointment.durationMin,
      bufferMin: appointment.bufferMin,
      status: appointment.status,
      order: { ...order, priceAed: order.priceAed === null ? null : Number(order.priceAed) },
      serviceName,
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

const CancelBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

businessOrdersRouter.post("/orders/:id/cancel", async (req, res) => {
  const { reason } = parse(CancelBody, req.body ?? {});
  const who = actor(req);
  await cancelOrderByBusiness({ ...who, reason });
  res.json(await orderResponse(who.orderId));
});

businessOrdersRouter.post("/orders/:id/no-show", async (req, res) => {
  const who = actor(req);
  await markNoShow(who);
  res.json(await orderResponse(who.orderId));
});

/** A manual override: the worker normally completes orders (Stage 7). */
businessOrdersRouter.post("/orders/:id/complete", async (req, res) => {
  const who = actor(req);
  await completeOrder(who);
  res.json(await orderResponse(who.orderId));
});
