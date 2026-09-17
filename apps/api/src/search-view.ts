import { comparablePrice, constraintNumber, getDb, schema, type PricingMode } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";

import { HttpError } from "./http.js";

const { businesses, businessServices, searches, searchOptions } = schema;

/** A search and the options on screen for it. Someone else's search is not found. */
export async function searchView(searchId: string, userId: string) {
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
        unitLabel: businessServices.unitLabel,
        confirmation: businessServices.confirmation,
        steps: businessServices.steps,
      },
    })
    .from(searchOptions)
    .innerJoin(businesses, eq(businesses.id, searchOptions.businessId))
    .innerJoin(businessServices, eq(businessServices.id, searchOptions.businessServiceId))
    .where(eq(searchOptions.searchId, search.id))
    .orderBy(asc(searchOptions.rank));

  const quantity = constraintNumber(search.constraints, "quantity");

  return {
    search: {
      id: search.id,
      status: search.status,
      mode: search.mode,
      locationMode: search.locationMode,
      quantity,
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
        pricingMode: service.pricingMode as PricingMode,
        unitLabel: service.unitLabel,
        // request: the business confirms before it's booked.
        confirmation: service.confirmation,
        // Each step's kind and length: a job, a site visit, or a pickup and a delivery.
        steps: service.steps,
      },
      // The price, the minimum, the unit price, or a quote's visit fee.
      priceAed: option.priceAed === null ? null : Number(option.priceAed),
      // A per-unit price times the quantity, when the user gave one.
      estimateAed:
        service.pricingMode === "per_unit"
          ? comparablePrice("per_unit", option.priceAed === null ? null : Number(option.priceAed), quantity)
          : null,
      distanceKm: Number(option.distanceKm),
      offeredSlots: option.offeredSlots,
      // For each offered slot, the later steps' times (e.g. the delivery).
      laterSlots: option.laterSlots?.map((times) => times.map((time) => new Date(time))) ?? null,
      selected: option.selectedAt !== null,
    })),
  };
}

export type SearchView = Awaited<ReturnType<typeof searchView>>;
export type SearchViewOption = SearchView["options"][number];
