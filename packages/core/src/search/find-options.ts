/**
 * §5 — finding options. Three steps, no model calls, all in one request:
 * filter candidates in SQL, work out their free times in memory, rank.
 *
 * Reads only; saving the search and its options is the caller's job (Stage 5).
 */

import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { traceable } from "langsmith/traceable";

import { getDb, getSql } from "../db/client.js";
import {
  appointments,
  businessClosures,
  businessHours,
  orders,
  SLOT_HOLDING_STATUSES,
  type LocationMode,
  type PricingMode,
  type Step,
} from "../db/schema.js";
import {
  daysOfWeekInWindow,
  freeSlots,
  spreadSlots,
  type BusyAppointment,
  type FreeSlot,
  type Interval,
  type OpeningHours,
} from "./availability.js";
import { rankingScore } from "./ranking.js";

/** §5 Step 1's LIMIT. */
const MAX_CANDIDATES = 30;
/** §14.3: show 5 options, up to 3 times each. */
const MAX_OPTIONS = 5;
const SLOTS_PER_OPTION = 3;

export type FindOptionsParams = {
  userId: string;
  categoryId: string;
  canonicalServiceId: string;
  /**
   * A business can offer the same service at the shop and at the customer's,
   * as two rows, so a search must say which it wants.
   */
  locationMode: LocationMode;
  /** Direct mode: the business the user named. */
  namedBusinessId: string | null;
  lat: number;
  lng: number;
  window: Interval;
  budgetMaxAed: number | null;
  now?: Date;
};

export type SearchOption = {
  rank: number;
  rankScore: number;
  businessId: string;
  businessServiceId: string;
  pricingMode: PricingMode;
  priceAed: number | null;
  distanceKm: number;
  offeredSlots: Date[];
};

export type FindOptionsResult = {
  /**
   * Businesses that do the service within range. Zero means nobody does it at
   * all; options empty with this above zero means places do it but nothing is
   * free in the window — §7 says those get different replies.
   */
  matched: number;
  options: SearchOption[];
};

export type AvailabilityData = {
  hours: OpeningHours[];
  closures: Interval[];
  /** Carries the order, so a reschedule can leave its own appointment out. */
  appointments: (BusyAppointment & { orderId: string })[];
};

type CandidateRow = {
  id: string;
  capacity: number;
  slot_interval_min: number;
  buffer_min: number;
  lead_time_min: number;
  max_advance_days: number;
  radius_km: number;
  business_service_id: string;
  price_aed: string | null;
  pricing_mode: PricingMode;
  steps: Step[];
  shown: number;
  selected: number;
  bookings_total: number;
  cancellations: number;
  distance_km: number;
};

/**
 * §5 Step 1, as the spec wrote it, except where the approved schema forces a
 * change:
 * - `bs.steps` replaces `bs.duration_min` (migration 0002), and
 *   `bs.location_mode` picks one row where a business offers both modes.
 * - The radius falls back to the category default in SQL rather than
 *   afterwards, and the stats the ranking needs are selected alongside.
 * - acos is clamped to [-1, 1]: rounding can push its argument just past 1
 *   when the user stands on the business's exact pin, which returns NaN.
 * - $days_in_window includes the day before the window, for late nights.
 */
function findCandidates(p: FindOptionsParams): Promise<CandidateRow[]> {
  const sql = getSql();
  return sql<CandidateRow[]>`
    SELECT b.id, b.capacity, b.slot_interval_min, b.buffer_min,
           b.lead_time_min, b.max_advance_days,
           COALESCE(b.radius_km, c.default_radius_km) AS radius_km,
           bs.id AS business_service_id, bs.price_aed, bs.pricing_mode, bs.steps,
           COALESCE(st.times_shown, 0)               AS shown,
           COALESCE(st.times_selected, 0)            AS selected,
           COALESCE(st.bookings_total, 0)            AS bookings_total,
           COALESCE(st.cancellations_by_business, 0) AS cancellations,
           6371 * acos(LEAST(1, GREATEST(-1,
             cos(radians(${p.lat}::float8)) * cos(radians(b.lat)) *
             cos(radians(b.lng) - radians(${p.lng}::float8)) +
             sin(radians(${p.lat}::float8)) * sin(radians(b.lat))
           ))) AS distance_km
    FROM businesses b
    JOIN categories c ON c.id = b.category_id
    JOIN business_services bs
      ON bs.business_id = b.id
     AND bs.canonical_service_id = ${p.canonicalServiceId}
     AND bs.location_mode = ${p.locationMode}
     AND bs.active
    LEFT JOIN business_stats st ON st.business_id = b.id
    WHERE b.status = 'active'
      AND b.category_id = ${p.categoryId}
      AND (${p.namedBusinessId}::uuid IS NULL OR b.id = ${p.namedBusinessId}::uuid)
      AND EXISTS (
        SELECT 1 FROM business_hours h
         WHERE h.business_id = b.id
           AND h.day_of_week = ANY(${daysOfWeekInWindow(p.window)}::int[])
      )
    ORDER BY distance_km
    LIMIT ${MAX_CANDIDATES}
  `;
}

/**
 * What the slot walk needs for many businesses at once: three queries however
 * many businesses, never one per business per slot (§5 Step 2). `range` must
 * cover every moment a new appointment could occupy.
 */
export async function loadAvailability(
  businessIds: string[],
  range: Interval,
): Promise<Map<string, AvailabilityData>> {
  const data = new Map<string, AvailabilityData>(
    businessIds.map((id) => [id, { hours: [], closures: [], appointments: [] }]),
  );
  if (businessIds.length === 0) return data;

  const db = getDb();
  const [hourRows, closureRows, appointmentRows] = await Promise.all([
    db
      .select({
        businessId: businessHours.businessId,
        dayOfWeek: businessHours.dayOfWeek,
        opensAt: businessHours.opensAt,
        closesAt: businessHours.closesAt,
      })
      .from(businessHours)
      .where(inArray(businessHours.businessId, businessIds)),
    db
      .select({
        businessId: businessClosures.businessId,
        start: businessClosures.startsAt,
        end: businessClosures.endsAt,
      })
      .from(businessClosures)
      .where(
        and(
          inArray(businessClosures.businessId, businessIds),
          gt(businessClosures.endsAt, range.start),
          lt(businessClosures.startsAt, range.end),
        ),
      ),
    db
      .select({
        businessId: appointments.businessId,
        orderId: appointments.orderId,
        resourceIndex: appointments.resourceIndex,
        start: appointments.scheduledAt,
        end: appointments.endsAt,
      })
      .from(appointments)
      .where(
        and(
          inArray(appointments.businessId, businessIds),
          inArray(appointments.status, [...SLOT_HOLDING_STATUSES]),
          gt(appointments.endsAt, range.start),
          lt(appointments.scheduledAt, range.end),
        ),
      ),
  ]);

  for (const { businessId, ...row } of hourRows) data.get(businessId)!.hours.push(row);
  for (const { businessId, ...row } of closureRows) data.get(businessId)!.closures.push(row);
  for (const { businessId, ...row } of appointmentRows) data.get(businessId)!.appointments.push(row);
  return data;
}

/** Businesses the user has a completed order with — the ranking's affinity. */
async function visitedBusinesses(userId: string, businessIds: string[]): Promise<Set<string>> {
  const rows = await getDb()
    .selectDistinct({ businessId: orders.businessId })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.status, "completed"),
        inArray(orders.businessId, businessIds),
      ),
    );
  return new Set(rows.map((row) => row.businessId));
}

// The three §5 steps, each a span in the chat turn's LangSmith trace. With
// tracing off (LANGSMITH_TRACING unset), traceable just calls through.

/** Step 1: businesses that could possibly do this job. */
const filterStep = traceable(
  async (p: FindOptionsParams) =>
    (await findCandidates(p))
      // §5: drop any row further away than that business's radius.
      .filter((c) => c.distance_km <= c.radius_km)
      // Phase 1 books single-step services; chaining steps is Stage 9.
      .filter((c) => c.steps.length === 1),
  { name: "filter", run_type: "retriever" },
);

/** Step 2: the free times at each, dropping businesses with none. */
const availabilityStep = traceable(
  async (candidates: CandidateRow[], window: Interval, now: Date) => {
    // A slot starts before the window ends, then holds its duration and buffer.
    const longestMin = Math.max(...candidates.map((c) => c.steps[0]!.duration_min + c.buffer_min));
    const range = { start: window.start, end: new Date(window.end.getTime() + longestMin * 60_000) };
    const availability = await loadAvailability(candidates.map((c) => c.id), range);

    return candidates.flatMap((candidate) => {
      const slots = freeSlots({
        now,
        window,
        durationMin: candidate.steps[0]!.duration_min,
        rules: {
          capacity: candidate.capacity,
          slotIntervalMin: candidate.slot_interval_min,
          bufferMin: candidate.buffer_min,
          leadTimeMin: candidate.lead_time_min,
          maxAdvanceDays: candidate.max_advance_days,
        },
        ...availability.get(candidate.id)!,
      });
      // §5: a business with no free slots in the window is dropped entirely.
      return slots.length > 0 ? [{ candidate, slots }] : [];
    });
  },
  { name: "availability" },
);

/** Step 3: score, sort, keep the top five with three spread times each. */
const rankStep = traceable(
  async (available: { candidate: CandidateRow; slots: FreeSlot[] }[], p: FindOptionsParams): Promise<SearchOption[]> => {
    const visited = await visitedBusinesses(p.userId, available.map(({ candidate }) => candidate.id));

    const scored = available.map(({ candidate: c, slots }) => {
      const priceAed = c.price_aed === null ? null : Number(c.price_aed);
      const score = rankingScore({
        distanceKm: c.distance_km,
        radiusKm: c.radius_km,
        timesShown: c.shown,
        timesSelected: c.selected,
        bookingsTotal: c.bookings_total,
        cancellationsByBusiness: c.cancellations,
        priceAed,
        budgetMaxAed: p.budgetMaxAed,
        visitedBefore: visited.has(c.id),
      });
      return { c, slots, priceAed, score };
    });

    // Highest score first; nearer wins a tie, so the order is stable.
    scored.sort((a, b) => b.score - a.score || a.c.distance_km - b.c.distance_km);

    // Fewer than five is shown as it is, never padded (§7).
    return scored.slice(0, MAX_OPTIONS).map(({ c, slots, priceAed, score }, i) => ({
      rank: i + 1,
      rankScore: score,
      businessId: c.id,
      businessServiceId: c.business_service_id,
      pricingMode: c.pricing_mode,
      priceAed,
      distanceKm: c.distance_km,
      offeredSlots: spreadSlots(slots, SLOTS_PER_OPTION).map((slot) => slot.start),
    }));
  },
  { name: "rank" },
);

export async function findOptions(p: FindOptionsParams): Promise<FindOptionsResult> {
  const now = p.now ?? new Date();

  const candidates = await filterStep(p);
  if (candidates.length === 0) return { matched: 0, options: [] };

  const available = await availabilityStep(candidates, p.window, now);
  if (available.length === 0) return { matched: candidates.length, options: [] };

  return { matched: candidates.length, options: await rankStep(available, p) };
}
