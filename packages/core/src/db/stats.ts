import { sql, type SQL } from "drizzle-orm";

import type { Executor } from "./client.js";
import { businessStats } from "./schema.js";

export type StatsCounter =
  | "timesShown"
  | "timesSelected"
  | "bookingsTotal"
  | "bookingsCompleted"
  | "cancellationsByBusiness"
  | "noShows";

/**
 * Adds `by` (default one) to each counter, never going below zero. Creates the
 * row if the business has none yet — the §5 filter already treats a missing
 * row as all zeros.
 */
export async function incrementStats(
  db: Executor,
  businessId: string,
  counters: StatsCounter[],
  now = new Date(),
  by = 1,
): Promise<void> {
  const increments: Partial<Record<StatsCounter, SQL>> = {};
  const firstValues: Partial<Record<StatsCounter, number>> = {};
  for (const counter of counters) {
    increments[counter] = sql`GREATEST(0, ${businessStats[counter]} + ${by})`;
    firstValues[counter] = Math.max(0, by);
  }

  await db
    .insert(businessStats)
    .values({ businessId, ...firstValues, updatedAt: now })
    .onConflictDoUpdate({
      target: businessStats.businessId,
      set: { ...increments, updatedAt: now },
    });
}

/**
 * §9 stats.recompute: rebuilds every business's counters from the rows they
 * count, in case the live ones drifted. The live counters use the same
 * definitions, so on a healthy database this changes nothing:
 *
 * - times_shown: searches whose current option list includes the business
 * - times_selected: those options the user picked
 * - bookings_total, bookings_completed, cancellations_by_business, no_shows: orders
 *
 * Returns how many businesses' rows were written.
 */
export async function recomputeStats(db: Executor, now = new Date()): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO business_stats (business_id, times_shown, times_selected, bookings_total,
                                bookings_completed, cancellations_by_business, no_shows, updated_at)
    SELECT b.id,
           COALESCE(so.shown, 0), COALESCE(so.selected, 0),
           COALESCE(o.total, 0), COALESCE(o.completed, 0), COALESCE(o.cancelled, 0), COALESCE(o.no_shows, 0),
           ${now.toISOString()}::timestamptz
      FROM businesses b
      LEFT JOIN (SELECT business_id,
                        count(*)::int AS shown,
                        count(*) FILTER (WHERE selected_at IS NOT NULL)::int AS selected
                   FROM search_options GROUP BY business_id) so ON so.business_id = b.id
      LEFT JOIN (SELECT business_id,
                        count(*)::int AS total,
                        count(*) FILTER (WHERE status = 'completed')::int AS completed,
                        count(*) FILTER (WHERE status = 'cancelled_by_business')::int AS cancelled,
                        count(*) FILTER (WHERE status = 'no_show')::int AS no_shows
                   FROM orders GROUP BY business_id) o ON o.business_id = b.id
    ON CONFLICT (business_id) DO UPDATE SET
      times_shown = excluded.times_shown,
      times_selected = excluded.times_selected,
      bookings_total = excluded.bookings_total,
      bookings_completed = excluded.bookings_completed,
      cancellations_by_business = excluded.cancellations_by_business,
      no_shows = excluded.no_shows,
      updated_at = excluded.updated_at
    RETURNING business_id
  `);
  return rows.length;
}
