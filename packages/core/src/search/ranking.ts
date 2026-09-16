/**
 * §5 Step 3 — puts the most suitable business first. Plain arithmetic on the
 * businesses that have free slots, with the spec's weights (§14.5).
 */

export const RANKING_WEIGHTS = {
  proximity: 0.25,
  selection: 0.25,
  reliability: 0.15,
  priceFit: 0.1,
  affinity: 0.15,
  exploration: 0.1,
} as const;

export type RankingSignals = {
  distanceKm: number;
  radiusKm: number;
  timesShown: number;
  timesSelected: number;
  bookingsTotal: number;
  cancellationsByBusiness: number;
  /** null for a quote-priced service. */
  priceAed: number | null;
  /** The user's stated budget, if any. */
  budgetMaxAed: number | null;
  /** The user has a completed order with this business. */
  visitedBefore: boolean;
};

export type RankingFactors = Record<keyof typeof RANKING_WEIGHTS, number>;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The spec defines price_fit only as "how well the price fits a stated budget,
 * 0.5 if none given". At or under budget scores 1, falling linearly to 0 at
 * twice the budget. A quote-priced service has no price to compare: 0.5.
 */
export function priceFit(priceAed: number | null, budgetMaxAed: number | null): number {
  if (budgetMaxAed === null || priceAed === null) return 0.5;
  if (priceAed <= budgetMaxAed) return 1;
  if (budgetMaxAed <= 0) return 0;
  return clamp01(1 - (priceAed - budgetMaxAed) / budgetMaxAed);
}

export function rankingFactors(s: RankingSignals): RankingFactors {
  return {
    // Closer is better.
    proximity: s.radiusKm > 0 ? clamp01(1 - s.distanceKm / s.radiusKm) : 0,
    // Do users pick them? +2 and +6 start a new business around 0.33 rather
    // than dividing by zero, and fade as real numbers build up.
    selection: (s.timesSelected + 2) / (s.timesShown + 6),
    // Do they cancel on people? With no bookings yet, nothing counts against them.
    reliability:
      s.bookingsTotal > 0 ? clamp01(1 - s.cancellationsByBusiness / s.bookingsTotal) : 1,
    priceFit: priceFit(s.priceAed, s.budgetMaxAed),
    affinity: s.visitedBefore ? 1 : 0,
    // Without this, whoever signs up first appears in every list forever.
    exploration: s.timesShown < 10 ? 0.5 : 0,
  };
}

export function rankingScore(signals: RankingSignals): number {
  const f = rankingFactors(signals);
  const w = RANKING_WEIGHTS;
  return (
    w.proximity * f.proximity +
    w.selection * f.selection +
    w.reliability * f.reliability +
    w.priceFit * f.priceFit +
    w.affinity * f.affinity +
    w.exploration * f.exploration
  );
}
