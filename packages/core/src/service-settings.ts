import { z } from "zod";

import {
  CONFIRMATIONS,
  LOCATION_MODES,
  PRICING_MODES,
  STEP_KINDS,
  type Confirmation,
  type LocationMode,
  type PricingMode,
  type Step as StepShape,
} from "./db/schema.js";

/**
 * The four settings that say how a service is delivered and sold. They live
 * on business_services, with defaults on canonical_services. The engine and
 * the agent read these — never the category id. The value lists themselves
 * are in db/schema.ts, next to the CHECK constraints that enforce them.
 */
export {
  CONFIRMATIONS,
  LOCATION_MODES,
  PRICING_MODES,
  STEP_KINDS,
  type Confirmation,
  type LocationMode,
  type PricingMode,
  type StepKind,
} from "./db/schema.js";

/** One appointment the service needs; the first step never waits on a previous one. */
export const Step = z
  .object({
    kind: z.enum(STEP_KINDS),
    duration_min: z.number().int().min(5).max(24 * 60),
    after_hours: z.number().min(0).max(24 * 14).optional(),
  })
  .strict() satisfies z.ZodType<StepShape>;

export type Step = StepShape;

/** A pickup_delivery service's return, when nothing says otherwise. */
export const DEFAULT_RETURN_AFTER_HOURS = 24;

/**
 * The steps a service's settings call for. They follow from the settings, so a
 * business only ever chooses durations:
 * - pickup_delivery: a pickup, then a delivery at least `afterHours` later
 * - quote: a site visit; the job's length comes from the quote
 * - anything else: one job
 */
export function stepsFor(
  settings: { locationMode: LocationMode; pricingMode: PricingMode },
  durationMin: number,
  afterHours = DEFAULT_RETURN_AFTER_HOURS,
): Step[] {
  if (settings.locationMode === "pickup_delivery") {
    return [
      { kind: "pickup", duration_min: durationMin },
      { kind: "delivery", duration_min: durationMin, after_hours: afterHours },
    ];
  }
  return [{ kind: settings.pricingMode === "quote" ? "visit" : "job", duration_min: durationMin }];
}

export type ServiceSettings = {
  locationMode: LocationMode;
  pricingMode: PricingMode;
  unitLabel: string | null;
  confirmation: Confirmation;
  steps: Step[];
  priceAed: number | null;
};

/**
 * What's wrong with a combination of settings, as field → message; empty when
 * it's valid. The database enforces the price and unit label rules too; the
 * step shapes and the combinations only here.
 */
export function serviceSettingsProblems(s: ServiceSettings): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const kinds = s.steps.map((step) => step.kind).join(",");

  if (s.locationMode === "pickup_delivery" && s.pricingMode === "quote") {
    problems.push({ path: "pricingMode", message: "quote isn't offered with pickup_delivery" });
  }
  const expected = stepsFor(s, 5).map((step) => step.kind).join(",");
  if (kinds !== expected) {
    problems.push({ path: "steps", message: `must be ${expected.replaceAll(",", " then ")} for these settings` });
  }
  if (s.steps[0]?.after_hours !== undefined) {
    problems.push({ path: "steps", message: "the first step cannot have after_hours" });
  }
  if (s.steps.slice(1).some((step) => step.after_hours === undefined)) {
    problems.push({ path: "steps", message: "every step after the first needs after_hours" });
  }
  if ((s.pricingMode === "per_unit") !== (s.unitLabel !== null)) {
    problems.push({ path: "unitLabel", message: "required for per_unit pricing, and only for it" });
  }
  if (s.priceAed === null && s.pricingMode !== "quote") {
    problems.push({ path: "priceAed", message: "required unless the price is on quote" });
  }
  return problems;
}
