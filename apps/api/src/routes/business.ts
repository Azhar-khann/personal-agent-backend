import { getDb, schema } from "@personal-agent/core";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { assertValidAttributes } from "../attributes.js";
import { currentUser } from "../auth.js";
import {
  assertNotInAnyBusiness,
  currentBusiness,
  requireBusinessMember,
  requireOwner,
  toBusinessResponse,
} from "../business.js";
import { HttpError, parse } from "../http.js";
import { phoneNumber, uaeLatitude, uaeLongitude } from "../validation.js";
import { businessOrdersRouter } from "./business-orders.js";
import { businessScheduleRouter } from "./business-schedule.js";
import { businessServicesRouter } from "./business-services.js";
import { businessStaffRouter } from "./business-staff.js";

/** The business app's endpoints (§8), all under /api/business. */
export const businessRouter = Router();

const { businesses, businessMembers, businessStats, categories } = schema;

/** The five scheduling rules (§3). */
const SchedulingRules = z.object({
  radiusKm: z.number().int().min(1).max(200).nullable(), // null = category default
  capacity: z.number().int().min(1).max(100),
  slotIntervalMin: z.number().int().min(5).max(240),
  bufferMin: z.number().int().min(0).max(240),
  leadTimeMin: z.number().int().min(0).max(7 * 24 * 60),
  maxAdvanceDays: z.number().int().min(1).max(365),
});

// ---------------------------------------------------------------------------
// Signup — the one business endpoint that needs no existing membership
// ---------------------------------------------------------------------------

const SignupBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    categoryId: z.string().min(1),
    // Straight from navigator.geolocation in the owner's browser.
    lat: uaeLatitude,
    lng: uaeLongitude,
    address: z.string().trim().min(1).max(500),
    city: z.string().trim().min(1).max(100),
    phone: phoneNumber,
    email: z.string().trim().email().max(254).optional(),
    attributes: z.record(z.unknown()).default({}),
  })
  .merge(SchedulingRules.partial())
  .strict();

/** POST /api/business/signup — creates the business as pending. */
businessRouter.post("/signup", async (req, res) => {
  const user = currentUser(req);
  const { lat, lng, attributes, ...fields } = parse(SignupBody, req.body ?? {});
  const db = getDb();

  const [category] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, fields.categoryId), eq(categories.active, true)))
    .limit(1);
  if (!category) {
    throw new HttpError(400, "invalid_request", "Request validation failed", [
      { path: "categoryId", message: "not an active category" },
    ]);
  }
  const answers = assertValidAttributes(category.onboardingSchema, attributes);

  const business = await db.transaction(async (tx) => {
    await assertNotInAnyBusiness(tx, user.id, "You already belong to a business");

    const [created] = await tx
      .insert(businesses)
      .values({ ...fields, lat: String(lat), lng: String(lng), attributes: answers })
      .returning();
    await tx
      .insert(businessMembers)
      .values({ businessId: created!.id, userId: user.id, role: "owner" });
    await tx.insert(businessStats).values({ businessId: created!.id });
    return created!;
  });

  res.status(201).json({ business: toBusinessResponse(business), role: "owner" });
});

// ---------------------------------------------------------------------------
// Everything below needs the signed-in user to work at a business
// ---------------------------------------------------------------------------

businessRouter.use(requireBusinessMember);

/** GET /api/business/me — profile and scheduling rules. */
businessRouter.get("/me", (req, res) => {
  res.json({ business: toBusinessResponse(currentBusiness(req)), role: req.memberRole });
});

const UpdateBusinessBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: phoneNumber,
    email: z.string().trim().email().max(254).nullable(),
    attributes: z.record(z.unknown()),
    lat: uaeLatitude,
    lng: uaeLongitude,
    address: z.string().trim().min(1).max(500),
    city: z.string().trim().min(1).max(100),
  })
  .merge(SchedulingRules)
  .partial()
  .strict()
  // A new pin must come with the address it belongs to.
  .refine(
    (body) =>
      (body.lat === undefined && body.lng === undefined) ||
      (body.lat !== undefined && body.lng !== undefined && body.address !== undefined),
    { message: "lat, lng and address must be sent together", path: ["lat"] },
  );

/** PATCH /api/business/me — owners only. */
businessRouter.patch("/me", requireOwner, async (req, res) => {
  const business = currentBusiness(req);
  const { attributes, lat, lng, ...fields } = parse(UpdateBusinessBody, req.body ?? {});
  const db = getDb();

  const changes: PgUpdateSetSource<typeof businesses> = { ...fields, updatedAt: new Date() };

  if (lat !== undefined && lng !== undefined) {
    changes.lat = String(lat);
    changes.lng = String(lng);

    // Compared at the column's precision, numeric(9,6).
    const moved =
      lat.toFixed(6) !== Number(business.lat).toFixed(6) ||
      lng.toFixed(6) !== Number(business.lng).toFixed(6);

    if (moved) {
      // The admin approved the old pin, so an active business goes back to
      // pending for re-approval. A suspended one stays suspended — moving is
      // no way out of a suspension — and a pending one stays pending. Decided
      // in SQL against the current status, not the one read earlier in this
      // request, so it can't race an admin approving at the same moment.
      changes.status = sql`CASE WHEN ${businesses.status} = 'active' THEN 'pending' ELSE ${businesses.status} END`;
    }
  }

  if (attributes !== undefined) {
    const [category] = await db
      .select({ onboardingSchema: categories.onboardingSchema })
      .from(categories)
      .where(eq(categories.id, business.categoryId))
      .limit(1);
    changes.attributes = assertValidAttributes(category!.onboardingSchema, attributes);
  }

  const [updated] = await db
    .update(businesses)
    .set(changes)
    .where(eq(businesses.id, business.id))
    .returning();

  res.json({ business: toBusinessResponse(updated!), role: req.memberRole });
});

/** GET /api/business/stats — shown, picked, bookings, cancellations. */
businessRouter.get("/stats", async (req, res) => {
  const [stats] = await getDb()
    .select()
    .from(businessStats)
    .where(eq(businessStats.businessId, currentBusiness(req).id))
    .limit(1);

  res.json({
    timesShown: stats?.timesShown ?? 0,
    timesSelected: stats?.timesSelected ?? 0,
    bookingsTotal: stats?.bookingsTotal ?? 0,
    bookingsCompleted: stats?.bookingsCompleted ?? 0,
    cancellationsByBusiness: stats?.cancellationsByBusiness ?? 0,
    noShows: stats?.noShows ?? 0,
  });
});

businessRouter.use("/services", businessServicesRouter);
businessRouter.use("/staff", businessStaffRouter);
businessRouter.use(businessScheduleRouter);
businessRouter.use(businessOrdersRouter);
