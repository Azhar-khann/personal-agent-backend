import { closesNextDay, getDb, schema } from "@personal-agent/core";
import { and, asc, eq, gt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentBusiness, requireOwner } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/** Weekly hours and one-off closures (§8). */
export const businessScheduleRouter = Router();

const { businessHours, businessClosures } = schema;

// ---------------------------------------------------------------------------
// GET PUT /api/business/hours
// ---------------------------------------------------------------------------

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, 24-hour");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// A closing time at or before the opening time means closing the next day
// (see closesNextDay), so 18:00–02:00 and 00:00–00:00 are both valid. Zero-
// padded HH:MM strings compare correctly as text.
const HoursBody = z
  .object({
    hours: z
      .array(
        z
          .object({ dayOfWeek: z.number().int().min(0).max(6), opensAt: clockTime, closesAt: clockTime })
          .strict(),
      )
      .superRefine((days, ctx) => {
        if (new Set(days.map((day) => day.dayOfWeek)).size !== days.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each dayOfWeek may appear only once" });
          return;
        }

        // A late night must end by the next day's opening. Saturday (6) runs into Sunday (0).
        const byDay = new Map(days.map((day) => [day.dayOfWeek, day]));
        days.forEach((day, index) => {
          if (!closesNextDay(day.opensAt, day.closesAt)) return;
          const next = byDay.get((day.dayOfWeek + 1) % 7);
          if (next && day.closesAt > next.opensAt) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "closesAt"],
              message: `runs past ${DAY_NAMES[next.dayOfWeek]}'s ${next.opensAt} opening`,
            });
          }
        });
      }),
  })
  .strict();

async function listHours(businessId: string) {
  const rows = await getDb()
    .select()
    .from(businessHours)
    .where(eq(businessHours.businessId, businessId))
    .orderBy(asc(businessHours.dayOfWeek));

  // Postgres returns time as HH:MM:SS; the API speaks HH:MM both ways.
  // closesNextDay is computed for the frontend, which then needn't know the rule.
  return rows.map((row) => ({
    dayOfWeek: row.dayOfWeek,
    opensAt: row.opensAt.slice(0, 5),
    closesAt: row.closesAt.slice(0, 5),
    closesNextDay: closesNextDay(row.opensAt, row.closesAt),
  }));
}

businessScheduleRouter.get("/hours", async (req, res) => {
  res.json({ hours: await listHours(currentBusiness(req).id) });
});

/** Replaces the whole week at once, since the UI is a grid. A missing day is closed. */
businessScheduleRouter.put("/hours", requireOwner, async (req, res) => {
  const business = currentBusiness(req);
  const { hours } = parse(HoursBody, req.body ?? {});

  await getDb().transaction(async (tx) => {
    await tx.delete(businessHours).where(eq(businessHours.businessId, business.id));
    if (hours.length > 0) {
      await tx.insert(businessHours).values(hours.map((day) => ({ ...day, businessId: business.id })));
    }
  });

  res.json({ hours: await listHours(business.id) });
});

// ---------------------------------------------------------------------------
// GET POST DELETE /api/business/closures
// ---------------------------------------------------------------------------

function toClosureResponse(closure: typeof businessClosures.$inferSelect) {
  return {
    id: closure.id,
    startsAt: closure.startsAt,
    endsAt: closure.endsAt,
    reason: closure.reason,
  };
}

const ClosureBody = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((body) => new Date(body.endsAt) > new Date(body.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine((body) => new Date(body.endsAt) > new Date(), {
    message: "endsAt must be in the future",
    path: ["endsAt"],
  });

/** Closures that haven't ended yet. */
businessScheduleRouter.get("/closures", async (req, res) => {
  const rows = await getDb()
    .select()
    .from(businessClosures)
    .where(and(eq(businessClosures.businessId, currentBusiness(req).id), gt(businessClosures.endsAt, new Date())))
    .orderBy(asc(businessClosures.startsAt));

  res.json({ closures: rows.map(toClosureResponse) });
});

businessScheduleRouter.post("/closures", requireOwner, async (req, res) => {
  const body = parse(ClosureBody, req.body ?? {});

  const [created] = await getDb()
    .insert(businessClosures)
    .values({
      businessId: currentBusiness(req).id,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      reason: body.reason ?? null,
    })
    .returning();

  res.status(201).json({ closure: toClosureResponse(created!) });
});

businessScheduleRouter.delete("/closures/:id", requireOwner, async (req, res) => {
  const id = uuidParam(req.params.id);

  const [deleted] = await getDb()
    .delete(businessClosures)
    .where(and(eq(businessClosures.id, id), eq(businessClosures.businessId, currentBusiness(req).id)))
    .returning({ id: businessClosures.id });
  if (!deleted) throw new HttpError(404, "closure_not_found", "This business has no such closure");

  res.status(204).end();
});
