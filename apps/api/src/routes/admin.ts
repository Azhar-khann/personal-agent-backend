import { getDb, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { toBusinessResponse } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/** Admin endpoints (§8), all under /api/admin. */
export const adminRouter = Router();

const { admins, businesses, businessMembers, users } = schema;

const requireAdmin: RequestHandler = async (req, _res, next) => {
  const [admin] = await getDb()
    .select({ userId: admins.userId })
    .from(admins)
    .where(eq(admins.userId, currentUser(req).id))
    .limit(1);
  if (!admin) throw new HttpError(403, "admin_only", "Admins only");
  next();
};

adminRouter.use(requireAdmin);

const ListQuery = z
  .object({ status: z.enum(["pending", "active", "suspended"]).optional() })
  .strict();

/**
 * GET /api/admin/businesses?status=pending — the approval queue, oldest first.
 * Includes the pin (lat/lng) next to the typed address: the coordinates came
 * from the owner's browser, so approval is where a wrong pin gets caught.
 */
adminRouter.get("/businesses", async (req, res) => {
  const { status } = parse(ListQuery, req.query);

  const rows = await getDb()
    .select({
      business: businesses,
      ownerName: users.name,
      ownerEmail: users.email,
      ownerPhone: users.phone,
    })
    .from(businesses)
    .leftJoin(
      businessMembers,
      and(eq(businessMembers.businessId, businesses.id), eq(businessMembers.role, "owner")),
    )
    .leftJoin(users, eq(users.id, businessMembers.userId))
    .where(status ? eq(businesses.status, status) : undefined)
    .orderBy(asc(businesses.createdAt));

  res.json({
    businesses: rows.map((row) => ({
      ...toBusinessResponse(row.business),
      owner: { name: row.ownerName, email: row.ownerEmail, phone: row.ownerPhone },
    })),
  });
});

const UpdateBusinessStatusBody = z
  .object({ status: z.enum(["active", "suspended"]) })
  .strict();

/**
 * PATCH /api/admin/businesses/:id — approve or suspend. Suspending hides a
 * business from new searches but keeps its existing bookings (§3).
 */
adminRouter.patch("/businesses/:id", async (req, res) => {
  const id = uuidParam(req.params.id);
  const { status } = parse(UpdateBusinessStatusBody, req.body ?? {});

  const [updated] = await getDb()
    .update(businesses)
    .set({ status, updatedAt: new Date() })
    .where(eq(businesses.id, id))
    .returning();
  if (!updated) throw new HttpError(404, "business_not_found", "No such business");

  res.json({ business: toBusinessResponse(updated) });
});
