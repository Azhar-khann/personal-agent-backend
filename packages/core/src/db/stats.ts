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
 * Adds one to each counter. Creates the row if the business has none yet —
 * the §5 filter already treats a missing row as all zeros.
 */
export async function incrementStats(
  db: Executor,
  businessId: string,
  counters: StatsCounter[],
  now = new Date(),
): Promise<void> {
  const increments: Partial<Record<StatsCounter, SQL>> = {};
  const firstValues: Partial<Record<StatsCounter, number>> = {};
  for (const counter of counters) {
    increments[counter] = sql`${businessStats[counter]} + 1`;
    firstValues[counter] = 1;
  }

  await db
    .insert(businessStats)
    .values({ businessId, ...firstValues, updatedAt: now })
    .onConflictDoUpdate({
      target: businessStats.businessId,
      set: { ...increments, updatedAt: now },
    });
}
