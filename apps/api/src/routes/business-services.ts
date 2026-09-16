import {
  getDb,
  PG_ERROR,
  PHASE1,
  pgErrorCode,
  schema,
  singleStep,
} from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentBusiness, requireOwner } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/**
 * GET POST PATCH DELETE /api/business/services — what they offer, how, and
 * at what price. The four settings default to the canonical service's and the
 * owner can override them; the API accepts only Phase 1 values for now.
 */
export const businessServicesRouter = Router();

const { businessServices, canonicalServices } = schema;

type ServiceRow = typeof businessServices.$inferSelect;

function toServiceResponse(service: ServiceRow, canonicalName: string) {
  return {
    id: service.id,
    canonicalServiceId: service.canonicalServiceId,
    canonicalName,
    displayName: service.displayName,
    locationMode: service.locationMode,
    pricingMode: service.pricingMode,
    unitLabel: service.unitLabel,
    confirmation: service.confirmation,
    // The single-step shorthand; steps is the full shape.
    durationMin: service.steps.length === 1 ? service.steps[0]!.duration_min : null,
    steps: service.steps,
    priceAed: service.priceAed === null ? null : Number(service.priceAed),
    active: service.active,
  };
}

const priceAed = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), "at most 2 decimal places");

const durationMin = z.number().int().min(5).max(24 * 60);

// Phase 1 only. The database accepts every value; Stage 9 widens the API.
const Phase1Settings = z.object({
  locationMode: z.enum(PHASE1.locationModes),
  pricingMode: z.enum(PHASE1.pricingModes),
  confirmation: z.enum(PHASE1.confirmations),
});

const serviceNotFound = () =>
  new HttpError(404, "service_not_found", "This business has no such service");

const serviceExists = () =>
  new HttpError(
    409,
    "service_exists",
    "This business already lists that service at that location",
  );

businessServicesRouter.get("/", async (req, res) => {
  const rows = await getDb()
    .select({ service: businessServices, canonicalName: canonicalServices.name })
    .from(businessServices)
    .innerJoin(canonicalServices, eq(canonicalServices.id, businessServices.canonicalServiceId))
    .where(eq(businessServices.businessId, currentBusiness(req).id))
    .orderBy(asc(businessServices.displayName));

  res.json({ services: rows.map((row) => toServiceResponse(row.service, row.canonicalName)) });
});

const CreateServiceBody = z
  .object({
    canonicalServiceId: z.string().min(1),
    displayName: z.string().trim().min(1).max(100),
    // Required while quote pricing isn't offered.
    priceAed,
    durationMin: durationMin.optional(),
    ...Phase1Settings.partial().shape,
    active: z.boolean().default(true),
  })
  .strict();

businessServicesRouter.post("/", requireOwner, async (req, res) => {
  const business = currentBusiness(req);
  const body = parse(CreateServiceBody, req.body ?? {});
  const db = getDb();

  // Businesses pick from their own category's canonical list (§3).
  const [canonical] = await db
    .select()
    .from(canonicalServices)
    .where(
      and(
        eq(canonicalServices.id, body.canonicalServiceId),
        eq(canonicalServices.categoryId, business.categoryId),
        eq(canonicalServices.active, true),
      ),
    )
    .limit(1);
  if (!canonical) {
    throw new HttpError(400, "invalid_request", "Request validation failed", [
      { path: "canonicalServiceId", message: "not a service in this business's category" },
    ]);
  }

  // Each setting falls back to the canonical default, and the result is held
  // to Phase 1 too — a default that isn't offered yet must be overridden.
  const settings = parse(Phase1Settings, {
    locationMode: body.locationMode ?? canonical.defaultLocationMode,
    pricingMode: body.pricingMode ?? canonical.defaultPricingMode,
    confirmation: body.confirmation ?? canonical.defaultConfirmation,
  });

  const defaultDuration =
    canonical.defaultSteps.length === 1 ? canonical.defaultSteps[0]!.duration_min : undefined;
  const duration = body.durationMin ?? defaultDuration;
  if (duration === undefined) {
    throw new HttpError(400, "invalid_request", "Request validation failed", [
      { path: "durationMin", message: "required" },
    ]);
  }

  try {
    const [created] = await db
      .insert(businessServices)
      .values({
        businessId: business.id,
        canonicalServiceId: body.canonicalServiceId,
        displayName: body.displayName,
        ...settings,
        unitLabel: null,
        steps: singleStep(duration),
        priceAed: String(body.priceAed),
        active: body.active,
      })
      .returning();
    res.status(201).json({ service: toServiceResponse(created!, canonical.name) });
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) throw serviceExists();
    throw error;
  }
});

const UpdateServiceBody = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    priceAed,
    durationMin,
    ...Phase1Settings.shape,
    active: z.boolean(),
  })
  .partial()
  .strict();

businessServicesRouter.patch("/:id", requireOwner, async (req, res) => {
  const id = uuidParam(req.params.id);
  const { priceAed: price, durationMin: duration, ...fields } = parse(UpdateServiceBody, req.body ?? {});
  const db = getDb();

  let updated: ServiceRow | undefined;
  try {
    // Changing a price never touches existing orders: they copied price_aed.
    // durationMin rewrites steps as a single job — the only shape Phase 1 makes.
    [updated] = await db
      .update(businessServices)
      .set({
        ...fields,
        ...(price === undefined ? {} : { priceAed: String(price) }),
        ...(duration === undefined ? {} : { steps: singleStep(duration) }),
      })
      .where(and(eq(businessServices.id, id), eq(businessServices.businessId, currentBusiness(req).id)))
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) throw serviceExists();
    throw error;
  }
  if (!updated) throw serviceNotFound();

  const [canonical] = await db
    .select({ name: canonicalServices.name })
    .from(canonicalServices)
    .where(eq(canonicalServices.id, updated.canonicalServiceId));

  res.json({ service: toServiceResponse(updated, canonical!.name) });
});

businessServicesRouter.delete("/:id", requireOwner, async (req, res) => {
  const id = uuidParam(req.params.id);

  try {
    const [deleted] = await getDb()
      .delete(businessServices)
      .where(and(eq(businessServices.id, id), eq(businessServices.businessId, currentBusiness(req).id)))
      .returning({ id: businessServices.id });
    if (!deleted) throw serviceNotFound();
  } catch (error) {
    // Orders and search options keep referencing the service they were for.
    if (pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION) {
      throw new HttpError(
        409,
        "service_in_use",
        "This service has orders. Set active to false to stop offering it instead.",
      );
    }
    throw error;
  }

  res.status(204).end();
});
