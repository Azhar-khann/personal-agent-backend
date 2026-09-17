import {
  CONFIRMATIONS,
  getDb,
  LOCATION_MODES,
  PG_ERROR,
  pgErrorCode,
  PRICING_MODES,
  schema,
  serviceSettingsProblems,
  stepsFor,
  type ServiceSettings,
} from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentBusiness, requireOwner } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/**
 * GET POST PATCH DELETE /api/business/services — what they offer, how, and
 * at what price. The four settings default to the canonical service's and the
 * owner can override them. A business chooses durations; the steps follow from
 * the settings (service-settings.ts).
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
    // Every step lasts this long: the job, the site visit, or the pickup and the delivery.
    durationMin: service.steps[0]!.duration_min,
    // pickup_delivery: the least time between pickup and delivery.
    returnAfterHours: service.steps[1]?.after_hours ?? null,
    steps: service.steps,
    // fixed: the price. from: the minimum. per_unit: per unitLabel. quote: a visit fee, or null.
    priceAed: service.priceAed === null ? null : Number(service.priceAed),
    active: service.active,
  };
}

const priceAed = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), "at most 2 decimal places");

const Fields = z.object({
  displayName: z.string().trim().min(1).max(100),
  priceAed: priceAed.nullable(),
  durationMin: z.number().int().min(5).max(24 * 60),
  returnAfterHours: z.number().min(0).max(24 * 14),
  locationMode: z.enum(LOCATION_MODES),
  pricingMode: z.enum(PRICING_MODES),
  unitLabel: z.string().trim().min(1).max(20).nullable(),
  confirmation: z.enum(CONFIRMATIONS),
  active: z.boolean(),
});

const serviceNotFound = () =>
  new HttpError(404, "service_not_found", "This business has no such service");

const serviceExists = () =>
  new HttpError(
    409,
    "service_exists",
    "This business already lists that service at that location",
  );

/**
 * The settings a service ends up with: what the request says, else what it
 * had, else the canonical default — with its steps rebuilt from them and the
 * whole combination checked.
 */
function resolveSettings(
  body: Partial<z.infer<typeof Fields>>,
  base: ServiceSettings,
): ServiceSettings {
  const locationMode = body.locationMode ?? base.locationMode;
  const pricingMode = body.pricingMode ?? base.pricingMode;
  const settings: ServiceSettings = {
    locationMode,
    pricingMode,
    // A unit belongs to per-unit pricing; switching away drops it.
    unitLabel: body.unitLabel !== undefined ? body.unitLabel : pricingMode === "per_unit" ? base.unitLabel : null,
    confirmation: body.confirmation ?? base.confirmation,
    steps: stepsFor(
      { locationMode, pricingMode },
      body.durationMin ?? base.steps[0]!.duration_min,
      body.returnAfterHours ?? base.steps[1]?.after_hours,
    ),
    priceAed: body.priceAed !== undefined ? body.priceAed : base.priceAed,
  };

  const problems = serviceSettingsProblems(settings);
  if (problems.length > 0) {
    throw new HttpError(400, "invalid_request", "Request validation failed", problems);
  }
  return settings;
}

const settingsColumns = (settings: ServiceSettings) => ({
  ...settings,
  priceAed: settings.priceAed === null ? null : String(settings.priceAed),
});

businessServicesRouter.get("/", async (req, res) => {
  const rows = await getDb()
    .select({ service: businessServices, canonicalName: canonicalServices.name })
    .from(businessServices)
    .innerJoin(canonicalServices, eq(canonicalServices.id, businessServices.canonicalServiceId))
    .where(eq(businessServices.businessId, currentBusiness(req).id))
    .orderBy(asc(businessServices.displayName));

  res.json({ services: rows.map((row) => toServiceResponse(row.service, row.canonicalName)) });
});

const CreateServiceBody = Fields.partial()
  .extend({ canonicalServiceId: z.string().min(1), displayName: Fields.shape.displayName })
  .strict();

businessServicesRouter.post("/", requireOwner, async (req, res) => {
  const business = currentBusiness(req);
  const { canonicalServiceId, displayName, active, ...body } = parse(CreateServiceBody, req.body ?? {});
  const db = getDb();

  // Businesses pick from their own category's canonical list (§3).
  const [canonical] = await db
    .select()
    .from(canonicalServices)
    .where(
      and(
        eq(canonicalServices.id, canonicalServiceId),
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

  const settings = resolveSettings(body, {
    locationMode: canonical.defaultLocationMode as ServiceSettings["locationMode"],
    pricingMode: canonical.defaultPricingMode as ServiceSettings["pricingMode"],
    unitLabel: canonical.defaultUnitLabel,
    confirmation: canonical.defaultConfirmation as ServiceSettings["confirmation"],
    steps: canonical.defaultSteps,
    // The canonical list has no prices: the business must give one, unless it quotes.
    priceAed: null,
  });

  try {
    const [created] = await db
      .insert(businessServices)
      .values({
        businessId: business.id,
        canonicalServiceId,
        displayName,
        ...settingsColumns(settings),
        active: active ?? true,
      })
      .returning();
    res.status(201).json({ service: toServiceResponse(created!, canonical.name) });
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) throw serviceExists();
    throw error;
  }
});

const UpdateServiceBody = Fields.partial().strict();

businessServicesRouter.patch("/:id", requireOwner, async (req, res) => {
  const id = uuidParam(req.params.id);
  const { displayName, active, ...body } = parse(UpdateServiceBody, req.body ?? {});
  const db = getDb();

  const [current] = await db
    .select({ service: businessServices, canonicalName: canonicalServices.name })
    .from(businessServices)
    .innerJoin(canonicalServices, eq(canonicalServices.id, businessServices.canonicalServiceId))
    .where(and(eq(businessServices.id, id), eq(businessServices.businessId, currentBusiness(req).id)));
  if (!current) throw serviceNotFound();

  const { service } = current;
  const settings = resolveSettings(body, {
    locationMode: service.locationMode as ServiceSettings["locationMode"],
    pricingMode: service.pricingMode as ServiceSettings["pricingMode"],
    unitLabel: service.unitLabel,
    confirmation: service.confirmation as ServiceSettings["confirmation"],
    steps: service.steps,
    priceAed: service.priceAed === null ? null : Number(service.priceAed),
  });

  let updated: ServiceRow | undefined;
  try {
    // Changing a price or duration never touches existing orders: they copied
    // the price, and their appointments keep the length they were booked with.
    [updated] = await db
      .update(businessServices)
      .set({
        ...settingsColumns(settings),
        ...(displayName === undefined ? {} : { displayName }),
        ...(active === undefined ? {} : { active }),
      })
      .where(eq(businessServices.id, id))
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) throw serviceExists();
    throw error;
  }

  res.json({ service: toServiceResponse(updated!, current.canonicalName) });
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
