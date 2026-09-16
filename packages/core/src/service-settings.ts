import { z } from "zod";

import {
  CONFIRMATIONS,
  LOCATION_MODES,
  PRICING_MODES,
  STEP_KINDS,
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

export const Steps = z
  .array(Step)
  .min(1)
  .refine((steps) => steps[0]?.after_hours === undefined, {
    message: "the first step cannot have after_hours",
    path: [0, "after_hours"],
  });

export type Step = StepShape;

/** A plain single-step service: one `job` of the given length. */
export function singleStep(durationMin: number): Step[] {
  return [{ kind: "job", duration_min: durationMin }];
}

/** What the API lets a business choose today. Stage 9 widens these. */
export const PHASE1 = {
  locationModes: ["at_business", "at_customer"],
  pricingModes: ["fixed", "from"],
  confirmations: ["instant"],
} as const;

// Keeps the Phase 1 lists honest: each must be a subset of the full vocabulary.
PHASE1.locationModes satisfies readonly (typeof LOCATION_MODES)[number][];
PHASE1.pricingModes satisfies readonly (typeof PRICING_MODES)[number][];
PHASE1.confirmations satisfies readonly (typeof CONFIRMATIONS)[number][];
