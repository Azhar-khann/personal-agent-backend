import { getDb, schema, type Transaction } from "@personal-agent/core";
import { asc, eq } from "drizzle-orm";
import type { Request, RequestHandler } from "express";

import { currentUser } from "./auth.js";
import { HttpError } from "./http.js";

export type Business = typeof schema.businesses.$inferSelect;
export type MemberRole = "owner" | "staff";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireBusinessMember: the business the signed-in user works at. */
      business?: Business;
      memberRole?: MemberRole;
    }
  }
}

/**
 * Loads the signed-in user's business. The /api/business/* endpoints carry no
 * business id, so each person belongs to one business; signup enforces that.
 *
 * Business status is deliberately not checked: a pending business sets up its
 * services and hours while awaiting approval, and a suspended one still
 * manages the bookings it already has (§3).
 */
export const requireBusinessMember: RequestHandler = async (req, _res, next) => {
  const { businesses, businessMembers } = schema;

  const [membership] = await getDb()
    .select({ business: businesses, role: businessMembers.role })
    .from(businessMembers)
    .innerJoin(businesses, eq(businesses.id, businessMembers.businessId))
    .where(eq(businessMembers.userId, currentUser(req).id))
    .orderBy(asc(businessMembers.createdAt))
    .limit(1);

  if (!membership) {
    throw new HttpError(404, "no_business", "You have not signed up a business");
  }

  req.business = membership.business;
  req.memberRole = membership.role as MemberRole;
  next();
};

/** §3: owners change prices, hours and settings; staff only manage bookings. */
export const requireOwner: RequestHandler = (req, _res, next) => {
  if (req.memberRole !== "owner") {
    throw new HttpError(403, "owner_only", "Only the business owner can do this");
  }
  next();
};

/**
 * One business per person (signup and adding staff both apply it). Locks the
 * person's users row first, so two concurrent requests — two signups, or a
 * signup racing a staff add — can't both pass the check.
 */
export async function assertNotInAnyBusiness(
  tx: Transaction,
  userId: string,
  conflictMessage: string,
): Promise<void> {
  const { users, businessMembers } = schema;

  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");

  const [membership] = await tx
    .select({ id: businessMembers.id })
    .from(businessMembers)
    .where(eq(businessMembers.userId, userId))
    .limit(1);
  if (membership) {
    throw new HttpError(409, "already_has_business", conflictMessage);
  }
}

/** The current business. Only valid on routes mounted behind requireBusinessMember. */
export function currentBusiness(req: Request): Business {
  if (!req.business) {
    throw new Error("currentBusiness() called on a route not mounted behind requireBusinessMember");
  }
  return req.business;
}

export function toBusinessResponse(business: Business) {
  return {
    id: business.id,
    name: business.name,
    categoryId: business.categoryId,
    status: business.status,
    lat: Number(business.lat),
    lng: Number(business.lng),
    address: business.address,
    city: business.city,
    phone: business.phone,
    email: business.email,
    attributes: business.attributes,
    radiusKm: business.radiusKm,
    capacity: business.capacity,
    slotIntervalMin: business.slotIntervalMin,
    bufferMin: business.bufferMin,
    leadTimeMin: business.leadTimeMin,
    maxAdvanceDays: business.maxAdvanceDays,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  };
}
