import { getDb, schema } from "@personal-agent/core";
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

export type SearchView = Awaited<ReturnType<typeof searchView>>;
export type SearchViewOption = SearchView["options"][number];
