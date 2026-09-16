import { bookOption, getDb, OrderError, runSearch, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { HttpError, parse, uuidParam } from "../http.js";
import { loadOrders } from "../orders.js";
import { dateTime } from "../validation.js";

/** GET /api/searches/:id, POST /:id/book, POST /:id/abandon (§8). */
export const searchesRouter = Router();

const { businesses, businessServices, orders, searches, searchOptions } = schema;

/** A search and the options on screen for it. Someone else's search is not found. */
async function searchView(searchId: string, userId: string) {
  const db = getDb();

  const [search] = await db
    .select()
    .from(searches)
    .where(and(eq(searches.id, searchId), eq(searches.userId, userId)));
  if (!search) throw new HttpError(404, "search_not_found", "No such search");

  const rows = await db
    .select({
      option: searchOptions,
      business: { name: businesses.name, address: businesses.address, phone: businesses.phone },
      service: {
        displayName: businessServices.displayName,
        locationMode: businessServices.locationMode,
        pricingMode: businessServices.pricingMode,
        steps: businessServices.steps,
      },
    })
    .from(searchOptions)
    .innerJoin(businesses, eq(businesses.id, searchOptions.businessId))
    .innerJoin(businessServices, eq(businessServices.id, searchOptions.businessServiceId))
    .where(eq(searchOptions.searchId, search.id))
    .orderBy(asc(searchOptions.rank));

  return {
    search: {
      id: search.id,
      status: search.status,
      mode: search.mode,
      categoryId: search.categoryId,
      canonicalServiceId: search.canonicalServiceId,
      namedBusinessId: search.namedBusinessId,
      windowStart: search.windowStart,
      windowEnd: search.windowEnd,
      address: search.address,
      constraints: search.constraints,
    },
    options: rows.map(({ option, business, service }) => ({
      id: option.id,
      rank: option.rank,
      businessId: option.businessId,
      business,
      service: {
        displayName: service.displayName,
        locationMode: service.locationMode,
        pricingMode: service.pricingMode,
        durationMin: service.steps[0]?.duration_min ?? null,
      },
      priceAed: option.priceAed === null ? null : Number(option.priceAed),
      distanceKm: Number(option.distanceKm),
      offeredSlots: option.offeredSlots,
      selected: option.selectedAt !== null,
    })),
  };
}

searchesRouter.get("/:id", async (req, res) => {
  res.json(await searchView(uuidParam(req.params.id), currentUser(req).id));
});

const BookBody = z.object({ optionId: z.string().uuid(), slotAt: dateTime }).strict();

/** 201 with the order, or 409 with a fresh list if the time has gone (§6). */
searchesRouter.post("/:id/book", async (req, res) => {
  const user = currentUser(req);
  const searchId = uuidParam(req.params.id);
  const { optionId, slotAt } = parse(BookBody, req.body ?? {});

  try {
    const booking = await bookOption({ userId: user.id, searchId, optionId, slotAt });
    const [order] = await loadOrders(eq(orders.id, booking.orderId));

    res.status(201).json({
      order,
      // §7: overlapping bookings are allowed; the user is warned.
      warnings:
        booking.overlappingOrderIds.length > 0
          ? [
              {
                code: "overlaps_other_order",
                message: "You have another booking at this time",
                orderIds: booking.overlappingOrderIds,
              },
            ]
          : [],
    });
  } catch (error) {
    if (!(error instanceof OrderError) || error.code !== "slot_unavailable") throw error;

    // Search again and show a fresh list, rather than making the user start over.
    await runSearch(searchId);
    res.status(409).json({
      error: { code: error.code, message: error.message },
      ...(await searchView(searchId, user.id)),
    });
  }
});

/** The user walked away. Keeps the booking-rate numbers honest. */
searchesRouter.post("/:id/abandon", async (req, res) => {
  const searchId = uuidParam(req.params.id);
  const { search } = await searchView(searchId, currentUser(req).id);

  if (search.status === "booked") {
    throw new HttpError(409, "invalid_status", "This search is booked");
  }
  if (search.status !== "abandoned") {
    await getDb()
      .update(searches)
      .set({ status: "abandoned", updatedAt: new Date() })
      .where(eq(searches.id, searchId));
  }
  res.json({ search: { ...search, status: "abandoned" } });
});
