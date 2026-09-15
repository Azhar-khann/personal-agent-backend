import { getDb, PG_ERROR, pgErrorCode, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentBusiness, requireOwner } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/** GET POST PATCH DELETE /api/business/services — what they offer and charge. */
export const businessServicesRouter = Router();

const { businessServices, canonicalServices } = schema;

type ServiceRow = typeof businessServices.$inferSelect;

function toServiceResponse(service: ServiceRow, canonicalName: string) {
  return {
    id: service.id,
    canonicalServiceId: service.canonicalServiceId,
    canonicalName,
    displayName: service.displayName,
    priceAed: Number(service.priceAed),
    durationMin: service.durationMin,
    active: service.active,
  };
}

const priceAed = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), "at most 2 decimal places");

const durationMin = z.number().int().min(5).max(24 * 60);

const serviceNotFound = () =>
  new HttpError(404, "service_not_found", "This business has no such service");

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
    priceAed,
    durationMin,
    active: z.boolean().default(true),
  })
  .strict();

businessServicesRouter.post("/", requireOwner, async (req, res) => {
  const business = currentBusiness(req);
  const body = parse(CreateServiceBody, req.body ?? {});
  const db = getDb();

  // Businesses pick from their own category's canonical list (§3).
  const [canonical] = await db
    .select({ name: canonicalServices.name })
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

  try {
    const [created] = await db
      .insert(businessServices)
      .values({ ...body, businessId: business.id, priceAed: String(body.priceAed) })
      .returning();
    res.status(201).json({ service: toServiceResponse(created!, canonical.name) });
  } catch (error) {
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) {
      throw new HttpError(409, "service_exists", "This business already lists that service");
    }
    throw error;
  }
});

const UpdateServiceBody = z
  .object({ displayName: z.string().trim().min(1).max(100), priceAed, durationMin, active: z.boolean() })
  .partial()
  .strict();

businessServicesRouter.patch("/:id", requireOwner, async (req, res) => {
  const id = uuidParam(req.params.id);
  const { priceAed: price, ...fields } = parse(UpdateServiceBody, req.body ?? {});
  const db = getDb();

  // Changing a price never touches existing bookings: they copied price_aed (§3).
  const [updated] = await db
    .update(businessServices)
    .set({ ...fields, ...(price === undefined ? {} : { priceAed: String(price) }) })
    .where(and(eq(businessServices.id, id), eq(businessServices.businessId, currentBusiness(req).id)))
    .returning();
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
    // Bookings and search options keep referencing the service they were for.
    if (pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION) {
      throw new HttpError(
        409,
        "service_in_use",
        "This service has bookings. Set active to false to stop offering it instead.",
      );
    }
    throw error;
  }

  res.status(204).end();
});
