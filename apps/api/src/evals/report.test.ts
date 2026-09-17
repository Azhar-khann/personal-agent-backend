import { describe, expect, it } from "vitest";

import { costPerThousand, drops, percentile, tooManyErrors, type DatasetRun } from "./report.js";

describe("drops", () => {
  it("fails a score that fell more than 3 points, and nothing else", () => {
    expect(drops({ correct: 0.88, service: 0.95 }, { correct: 0.92, service: 0.97 })).toEqual([
      { key: "correct", points: expect.closeTo(4, 5) },
    ]);
  });

  it("allows a drop of exactly 3 points", () => {
    expect(drops({ exact: 0.87 }, { exact: 0.9 })).toEqual([]);
  });

  it("ignores scores the baseline had but this run doesn't", () => {
    expect(drops({}, { exact: 0.9 })).toEqual([]);
  });
});

describe("tooManyErrors", () => {
  it("allows up to 2% of examples to error", () => {
    expect(tooManyErrors({ scored: 196, errors: 4 })).toBe(false);
    expect(tooManyErrors({ scored: 195, errors: 5 })).toBe(true);
  });
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    expect(percentile([400, 100, 300, 200], 50)).toBe(200);
    expect(percentile([400, 100, 300, 200], 95)).toBe(400);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("costPerThousand", () => {
  const run = (scored: number, costUsd: number | null) => ({ scored, costUsd }) as DatasetRun;

  it("averages cost over every scored call", () => {
    expect(costPerThousand([run(100, 0.5), run(300, 1.5)])).toBeCloseTo(5);
  });

  it("is unknown when any model's price is", () => {
    expect(costPerThousand([run(100, 0.5), run(100, null)])).toBeNull();
  });
});
