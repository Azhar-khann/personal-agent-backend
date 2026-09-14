import { getDb, PG_ERROR, pgErrorCode, schema } from "@personal-agent/core";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentUser, type User } from "../auth.js";
import { HttpError, parse } from "../http.js";

/** GET PATCH /api/me — profile, home address and timezone (§8). */
export const meRouter = Router();

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(100).nullable(),
    email: z.string().trim().email().max(254).nullable(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/, "must be in international format, e.g. +971501234567")
      .nullable(),
    homeAddress: z.string().trim().min(1).max(500).nullable(),
    homeLat: z.number().min(-90).max(90).nullable(),
    homeLng: z.number().min(-180).max(180).nullable(),
    // Used to read "tomorrow" in the agent, so it must be a real IANA zone.
    timezone: z
      .string()
      .refine(isValidTimeZone, "must be an IANA time zone, e.g. Asia/Dubai"),
  })
  .partial()
  .strict()
  .refine(
    (body) =>
      (body.homeLat === undefined) === (body.homeLng === undefined) &&
      (body.homeLat === null) === (body.homeLng === null),
    { message: "homeLat and homeLng must be sent together", path: ["homeLat"] },
  );

function toResponse(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    homeAddress: user.homeAddress,
    homeLat: user.homeLat === null ? null : Number(user.homeLat),
    homeLng: user.homeLng === null ? null : Number(user.homeLng),
    timezone: user.timezone,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

meRouter.get("/", (req, res) => {
  res.json(toResponse(currentUser(req)));
});

meRouter.patch("/", async (req, res) => {
  const user = currentUser(req);
  const body = parse(UpdateMeBody, req.body ?? {});

  if (Object.keys(body).length === 0) {
    res.json(toResponse(user));
    return;
  }

  const { homeLat, homeLng, ...rest } = body;
  const changes: Partial<typeof schema.users.$inferInsert> = {
    ...rest,
    updatedAt: new Date(),
  };
  // numeric(9,6) columns take strings, which keeps the precision exact.
  if (homeLat !== undefined) changes.homeLat = homeLat === null ? null : String(homeLat);
  if (homeLng !== undefined) changes.homeLng = homeLng === null ? null : String(homeLng);

  try {
    const [updated] = await getDb()
      .update(schema.users)
      .set(changes)
      .where(eq(schema.users.id, user.id))
      .returning();

    if (!updated) throw new HttpError(404, "not_found", "User no longer exists");
    res.json(toResponse(updated));
  } catch (error) {
    // phone is the only UNIQUE column a PATCH can change.
    if (pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION) {
      throw new HttpError(
        409,
        "phone_taken",
        "That phone number is already registered to another account",
      );
    }
    throw error;
  }
});
