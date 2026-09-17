import { describe, expect, it } from "vitest";

import { belowMinimum, costPerThousand, percentile, tooManyErrors, type DatasetRun } from "./report.js";

describe("belowMinimum", () => {
  it("fails a score under its minimum, and nothing else", () => {
    expect(belowMinimum({ correct: 0.9, service: 0.99 }, { correct: 0.91, service: 0.96 })).toEqual([
      { key: "correct", score: 0.9, minimum: 0.91 },
    ]);
  });

  it("accepts a score exactly at its minimum, float division included", () => {
    expect(belowMinimum({ exact: 92 / 100 }, { exact: 0.92 })).toEqual([]);
    expect(belowMinimum({ exact: 0.1 + 0.82 }, { exact: 0.92 })).toEqual([]);
  });

  it("ignores scores with no minimum, or missing from the run", () => {
    expect(belowMinimum({ other: 0 }, { exact: 0.9 })).toEqual([]);
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
