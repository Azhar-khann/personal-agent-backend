import { eq } from "drizzle-orm";

import { getDb } from "../db/client.js";
import { searches, searchOptions, type LocationMode } from "../db/schema.js";
import { incrementStats } from "../db/stats.js";
import { OrderError } from "../orders/common.js";
import { findOptions, type FindOptionsResult } from "./find-options.js";

/** A search can be (re)presented until it's booked or abandoned. */
const SEARCHABLE_STATUSES = ["gathering", "presenting", "no_results"];

/** A non-negative number the agent stored in a search's constraints, e.g. budget_max. */
export function constraintNumber(constraints: unknown, key: "budget_max" | "quantity"): number | null {
  const value = (constraints as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && value >= 0 ? value : null;
}

/**
 * Finds options for a search and puts them on screen: replaces the options
 * shown last time, counts an impression for each business shown, and moves the
 * search to presenting or no_results.
 *
 * Runs when the agent first searches, and again after a 409, so the user gets
 * a fresh list rather than starting over (§6).
 */
export async function runSearch(searchId: string, now = new Date()): Promise<FindOptionsResult> {
  const db = getDb();

  const [search] = await db.select().from(searches).where(eq(searches.id, searchId)).limit(1);
  if (!search) throw new OrderError("not_found", "No such search");
  if (!SEARCHABLE_STATUSES.includes(search.status)) {
    throw new OrderError("invalid_status", `This search is ${search.status}`);
  }
  if (search.canonicalServiceId === null) {
    throw new OrderError("invalid_request", "This search has no service yet");
  }

  const result = await findOptions({
    userId: search.userId,
    categoryId: search.categoryId,
    canonicalServiceId: search.canonicalServiceId,
    locationMode: search.locationMode as LocationMode,
    namedBusinessId: search.namedBusinessId,
    lat: Number(search.lat),
    lng: Number(search.lng),
    window: { start: search.windowStart, end: search.windowEnd },
    budgetMaxAed: constraintNumber(search.constraints, "budget_max"),
    quantity: constraintNumber(search.constraints, "quantity"),
    now,
  });

  await db.transaction(async (tx) => {
    // Re-checked under a lock: the search may have been booked meanwhile.
    const [locked] = await tx
      .select({ status: searches.status })
      .from(searches)
      .where(eq(searches.id, searchId))
      .for("update");
    if (!locked || !SEARCHABLE_STATUSES.includes(locked.status)) {
      throw new OrderError("invalid_status", `This search is ${locked?.status ?? "gone"}`);
    }

    const previous = await tx
      .select({ businessId: searchOptions.businessId })
      .from(searchOptions)
      .where(eq(searchOptions.searchId, searchId));
    await tx.delete(searchOptions).where(eq(searchOptions.searchId, searchId));

    // times_shown counts searches whose current list includes a business — the
    // definition stats.recompute rebuilds from search_options. So a refreshed
    // list counts only businesses new to it, and takes back businesses dropped:
    // someone dropped wasn't passed over in the list the user chose from.
    const before = new Set(previous.map((row) => row.businessId));
    const after = new Set(result.options.map((option) => option.businessId));
    for (const businessId of after) {
      if (!before.has(businessId)) await incrementStats(tx, businessId, ["timesShown"], now);
    }
    for (const businessId of before) {
      if (!after.has(businessId)) await incrementStats(tx, businessId, ["timesShown"], now, -1);
    }

    if (result.options.length > 0) {
      await tx.insert(searchOptions).values(
        result.options.map((option) => ({
          searchId,
          businessId: option.businessId,
          businessServiceId: option.businessServiceId,
          rank: option.rank,
          rankScore: option.rankScore.toFixed(4),
          priceAed: option.priceAed === null ? null : option.priceAed.toFixed(2),
          distanceKm: option.distanceKm.toFixed(2),
          offeredSlots: option.offeredSlots,
          laterSlots: option.laterSlots?.map((times) => times.map((time) => time.toISOString())) ?? null,
          presentedAt: now,
        })),
      );
    }

    await tx
      .update(searches)
      .set({
        status: result.options.length > 0 ? "presenting" : "no_results",
        businessesMatched: result.matched,
        updatedAt: now,
      })
      .where(eq(searches.id, searchId));
  });

  return result;
}
