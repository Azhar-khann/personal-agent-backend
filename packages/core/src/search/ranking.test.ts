import { describe, expect, it } from "vitest";

import {
  priceFit,
  RANKING_WEIGHTS,
  rankingFactors,
  rankingScore,
  type RankingSignals,
} from "./ranking.js";

const newBusiness: RankingSignals = {
  distanceKm: 0,
  radiusKm: 10,
  timesShown: 0,
  timesSelected: 0,
  bookingsTotal: 0,
  cancellationsByBusiness: 0,
  priceAed: 100,
  budgetMaxAed: null,
  visitedBefore: false,
};

describe("rankingFactors", () => {
  it("starts a brand-new business around 0.33 on selection", () => {
    const f = rankingFactors(newBusiness);
    expect(f.selection).toBeCloseTo(1 / 3);
    expect(f.reliability).toBe(1);
    expect(f.exploration).toBe(0.5);
  });

  it("lets selection approach the real rate as impressions build up", () => {
    const f = rankingFactors({ ...newBusiness, timesShown: 1000, timesSelected: 600 });
    expect(f.selection).toBeCloseTo(0.6, 2);
  });

  it("stops the exploration bonus at ten impressions", () => {
    expect(rankingFactors({ ...newBusiness, timesShown: 9 }).exploration).toBe(0.5);
    expect(rankingFactors({ ...newBusiness, timesShown: 10 }).exploration).toBe(0);
  });

  it("scores proximity against the business's radius", () => {
    expect(rankingFactors({ ...newBusiness, distanceKm: 5 }).proximity).toBe(0.5);
    expect(rankingFactors({ ...newBusiness, distanceKm: 12 }).proximity).toBe(0);
  });

  it("counts the business's own cancellations against its bookings", () => {
    const f = rankingFactors({ ...newBusiness, bookingsTotal: 10, cancellationsByBusiness: 2 });
    expect(f.reliability).toBeCloseTo(0.8);
  });
});

describe("priceFit", () => {
  it("is 0.5 with no budget, or no price to compare", () => {
    expect(priceFit(100, null)).toBe(0.5);
    expect(priceFit(null, 100)).toBe(0.5);
  });

  it("is 1 at or under budget, and falls to 0 at twice the budget", () => {
    expect(priceFit(80, 100)).toBe(1);
    expect(priceFit(100, 100)).toBe(1);
    expect(priceFit(150, 100)).toBe(0.5);
    expect(priceFit(250, 100)).toBe(0);
  });
});

describe("rankingScore", () => {
  it("uses weights that sum to 1", () => {
    const total = Object.values(RANKING_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1);
  });

  it("combines the factors with the spec's weights", () => {
    // proximity 0.5, selection 0.4, reliability 0.9, price_fit 0.8, affinity 1, exploration 0.5
    const score = rankingScore({
      distanceKm: 5,
      radiusKm: 10,
      timesShown: 4,
      timesSelected: 2,
      bookingsTotal: 10,
      cancellationsByBusiness: 1,
      priceAed: 120,
      budgetMaxAed: 100,
      visitedBefore: true,
    });
    expect(score).toBeCloseTo(0.25 * 0.5 + 0.25 * 0.4 + 0.15 * 0.9 + 0.1 * 0.8 + 0.15 + 0.1 * 0.5);
  });

  it("lifts a business the user has used before by the affinity weight", () => {
    const returning = rankingScore({ ...newBusiness, visitedBefore: true });
    expect(returning - rankingScore(newBusiness)).toBeCloseTo(0.15);
  });
});
