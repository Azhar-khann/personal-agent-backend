import { addDays, getDb, localDate, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth.js";
import { HttpError, parse, uuidParam } from "../http.js";

/**
 * GET POST PATCH DELETE /api/reminders (§8) — recurring services, for the
 * settings screen. Nudging users about them is the worker's reminders.scan.
 */
export const remindersRouter = Router();

const { canonicalServices, categories, recurringReminders } = schema;

type ReminderRow = typeof recurringReminders.$inferSelect;

function toReminderResponse(reminder: ReminderRow) {
  return {
    id: reminder.id,
    categoryId: reminder.categoryId,
    canonicalServiceId: reminder.canonicalServiceId,
    label: reminder.label,
    lastDoneAt: reminder.lastDoneAt,
    intervalDays: reminder.intervalDays,
    nextDueAt: reminder.nextDueAt,
    leadDays: reminder.leadDays,
    status: reminder.status,
    lastNudgedAt: reminder.lastNudgedAt,
  };
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date, YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && addDays(value, 0) === value, "not a real date");

const intervalDays = z.number().int().min(1).max(3650);
const leadDays = z.number().int().min(0).max(365);

/**
 * When it's next due: interval days after it was last done, or today if the
 * user doesn't know — they're adding it because it needs doing.
 */
function nextDue(lastDoneAt: string | null, days: number, today: string): string {
  return lastDoneAt ? addDays(lastDoneAt, days) : today;
}

function assertNotFuture(lastDoneAt: string | null | undefined, today: string) {
  if (lastDoneAt && lastDoneAt > today) {
    throw new HttpError(400, "invalid_request", "Request validation failed", [
      { path: "lastDoneAt", message: "can't be in the future" },
    ]);
  }
}

remindersRouter.get("/", async (req, res) => {
  const rows = await getDb()
    .select()
    .from(recurringReminders)
    .where(eq(recurringReminders.userId, currentUser(req).id))
    .orderBy(asc(recurringReminders.nextDueAt));
  res.json({ reminders: rows.map(toReminderResponse) });
});

const CreateBody = z
  .object({
    categoryId: z.string().min(1),
    canonicalServiceId: z.string().min(1).nullable().optional(),
    label: z.string().trim().min(1).max(100),
    lastDoneAt: calendarDate.nullable().optional(),
    /** Defaults to the category's recurring_default_days. */
    intervalDays: intervalDays.optional(),
    leadDays: leadDays.default(14),
  })
  .strict();

remindersRouter.post("/", async (req, res) => {
  const user = currentUser(req);
  const body = parse(CreateBody, req.body ?? {});
  const db = getDb();
  const today = localDate(new Date(), user.timezone);
  assertNotFuture(body.lastDoneAt, today);

  const [category] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, body.categoryId), eq(categories.active, true)));
  const problems: { path: string; message: string }[] = [];
  if (!category) problems.push({ path: "categoryId", message: "not an active category" });

  if (category && body.canonicalServiceId) {
    const [service] = await db
      .select({ id: canonicalServices.id })
      .from(canonicalServices)
      .where(and(eq(canonicalServices.id, body.canonicalServiceId), eq(canonicalServices.categoryId, category.id)));
    if (!service) problems.push({ path: "canonicalServiceId", message: "not a service in this category" });
  }

  const days = body.intervalDays ?? category?.recurringDefaultDays ?? null;
  if (category && days === null) {
    problems.push({ path: "intervalDays", message: "required: this category has no default interval" });
  }
  if (problems.length > 0 || !category || days === null) {
    throw new HttpError(400, "invalid_request", "Request validation failed", problems);
  }

  const [created] = await db
    .insert(recurringReminders)
    .values({
      userId: user.id,
      categoryId: category.id,
      canonicalServiceId: body.canonicalServiceId ?? null,
      label: body.label,
      lastDoneAt: body.lastDoneAt ?? null,
      intervalDays: days,
      nextDueAt: nextDue(body.lastDoneAt ?? null, days, today),
      leadDays: body.leadDays,
    })
    .returning();
  res.status(201).json({ reminder: toReminderResponse(created!) });
});

const UpdateBody = z
  .object({
    label: z.string().trim().min(1).max(100),
    lastDoneAt: calendarDate.nullable(),
    intervalDays,
    leadDays,
    // Snoozed reminders aren't nudged until set back to active.
    status: z.enum(["active", "snoozed", "cancelled"]),
  })
  .partial()
  .strict();

remindersRouter.patch("/:id", async (req, res) => {
  const user = currentUser(req);
  const id = uuidParam(req.params.id);
  const body = parse(UpdateBody, req.body ?? {});
  const db = getDb();
  const today = localDate(new Date(), user.timezone);
  assertNotFuture(body.lastDoneAt, today);

  const [existing] = await db
    .select()
    .from(recurringReminders)
    .where(and(eq(recurringReminders.id, id), eq(recurringReminders.userId, user.id)));
  if (!existing) throw new HttpError(404, "reminder_not_found", "No such reminder");

  const changes: Partial<typeof recurringReminders.$inferInsert> = { ...body, updatedAt: new Date() };
  if (body.lastDoneAt !== undefined || body.intervalDays !== undefined) {
    const lastDoneAt = body.lastDoneAt !== undefined ? body.lastDoneAt : existing.lastDoneAt;
    changes.nextDueAt = nextDue(lastDoneAt, body.intervalDays ?? existing.intervalDays, today);
    // A new due date is a fresh start for nudging.
    changes.lastNudgedAt = null;
  }

  const [updated] = await db.update(recurringReminders).set(changes).where(eq(recurringReminders.id, id)).returning();
  res.json({ reminder: toReminderResponse(updated!) });
});

remindersRouter.delete("/:id", async (req, res) => {
  const deleted = await getDb()
    .delete(recurringReminders)
    .where(and(eq(recurringReminders.id, uuidParam(req.params.id)), eq(recurringReminders.userId, currentUser(req).id)))
    .returning({ id: recurringReminders.id });
  if (deleted.length === 0) throw new HttpError(404, "reminder_not_found", "No such reminder");
  res.status(204).end();
});
