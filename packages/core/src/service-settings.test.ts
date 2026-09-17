import { describe, expect, it } from "vitest";

import { holdExpiresAt } from "./orders/common.js";
import { serviceSettingsProblems, stepsFor, type ServiceSettings } from "./service-settings.js";

const plain: ServiceSettings = {
  locationMode: "at_business",
  pricingMode: "fixed",
  unitLabel: null,
  confirmation: "instant",
  steps: [{ kind: "job", duration_min: 30 }],
  priceAed: 50,
};

describe("stepsFor", () => {
  it("builds the steps the settings call for", () => {
    expect(stepsFor({ locationMode: "at_customer", pricingMode: "from" }, 60)).toEqual([{ kind: "job", duration_min: 60 }]);
    expect(stepsFor({ locationMode: "at_customer", pricingMode: "quote" }, 45)).toEqual([{ kind: "visit", duration_min: 45 }]);
    expect(stepsFor({ locationMode: "pickup_delivery", pricingMode: "per_unit" }, 15, 48)).toEqual([
      { kind: "pickup", duration_min: 15 },
      { kind: "delivery", duration_min: 15, after_hours: 48 },
    ]);
  });
});

describe("serviceSettingsProblems", () => {
  it("accepts every combination the categories use", () => {
    expect(serviceSettingsProblems(plain)).toEqual([]);
    const laundry = { locationMode: "pickup_delivery", pricingMode: "per_unit" } as const;
    expect(serviceSettingsProblems({ ...plain, ...laundry, unitLabel: "kg", steps: stepsFor(laundry, 15) })).toEqual([]);
    const movers = { locationMode: "at_customer", pricingMode: "quote" } as const;
    expect(
      serviceSettingsProblems({ ...plain, ...movers, confirmation: "request", priceAed: null, steps: stepsFor(movers, 60) }),
    ).toEqual([]);
  });

  it("refuses a quote collected and delivered, and steps that don't match the settings", () => {
    const paths = (s: ServiceSettings) => serviceSettingsProblems(s).map((problem) => problem.path);
    expect(paths({ ...plain, locationMode: "pickup_delivery", pricingMode: "quote", priceAed: null })).toEqual(["pricingMode", "steps"]);
    expect(paths({ ...plain, pricingMode: "quote", priceAed: null })).toEqual(["steps"]);
  });

  it("wants a unit label exactly for per-unit pricing, and a price unless it's quoted", () => {
    const paths = (s: ServiceSettings) => serviceSettingsProblems(s).map((problem) => problem.path);
    expect(paths({ ...plain, pricingMode: "per_unit" })).toEqual(["unitLabel"]);
    expect(paths({ ...plain, unitLabel: "kg" })).toEqual(["unitLabel"]);
    expect(paths({ ...plain, priceAed: null })).toEqual(["priceAed"]);
  });
});

describe("holdExpiresAt", () => {
  it("is two hours after the request, or the start if that's sooner", () => {
    const createdAt = new Date("2030-01-07T08:00:00Z");
    expect(holdExpiresAt({ createdAt, scheduledAt: new Date("2030-01-08T08:00:00Z") })).toEqual(new Date("2030-01-07T10:00:00Z"));
    expect(holdExpiresAt({ createdAt, scheduledAt: new Date("2030-01-07T09:00:00Z") })).toEqual(new Date("2030-01-07T09:00:00Z"));
  });
});
