/**
 * Recurring services (§3 recurring_reminders, §9 reminders.scan): things that
 * need doing every few months, whatever the category.
 */

import { eq, sql } from "drizzle-orm";

import { emptyState, saveState } from "./agent-state.js";
import { getDb } from "./db/client.js";
import { canonicalServices, conversations, messages, recurringReminders, users } from "./db/schema.js";
import { formatDate, toLocal } from "./time.js";

const DAY_MS = 24 * 60 * 60_000;

/** §14.7: at most once a week. */
export const NUDGE_EVERY_DAYS = 7;

/** A date column's value plus some days: "2026-10-12" + 120. */
export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** Today's date where the user is. */
export function localDate(now: Date, timeZone: string): string {
  return toLocal(now, timeZone).slice(0, 10);
}

function nudgeText(label: string, serviceName: string | null, nextDueAt: string, today: string): string {
  const what = serviceName ? `${label} is due for ${serviceName}` : `${label} is due`;
  const when = nextDueAt <= today ? "now" : `on ${formatDate(nextDueAt)}`;
  return `Reminder: ${what} ${when}. Want me to find someone to do it?`;
}

/**
 * §9 reminders.scan: finds active reminders coming due — next_due_at minus
 * lead_days is today or earlier where the user is — that haven't been nudged
 * in the last week, and nudges each one.
 *
 * A nudge starts a new conversation with the message, its agent state already
 * holding the category and service, so a plain "yes, Saturday morning" becomes
 * a normal search (§9). No push: users have no push subscriptions yet.
 *
 * A reminder already booked from an earlier nudge, and not yet done, is left
 * alone; completing that order moves its due date on.
 */
export async function nudgeDueReminders(now = new Date()): Promise<number> {
  const db = getDb();
  const at = now.toISOString();

  const due = await db.execute<{ id: string }>(sql`
    SELECT r.id
      FROM recurring_reminders r
      JOIN users u ON u.id = r.user_id
     WHERE r.status = 'active'
       AND r.next_due_at - r.lead_days <= (${at}::timestamptz AT TIME ZONE u.timezone)::date
       AND (r.last_nudged_at IS NULL
            OR r.last_nudged_at <= ${at}::timestamptz - make_interval(days => ${NUDGE_EVERY_DAYS}))
       AND NOT EXISTS (
             SELECT 1 FROM orders o JOIN searches s ON s.id = o.search_id
              WHERE o.user_id = r.user_id
                AND o.status IN ('requested', 'quoted', 'confirmed', 'in_progress')
                AND s.constraints->>'reminder_id' = r.id::text)
     ORDER BY r.next_due_at
     LIMIT 500
  `);

  let nudged = 0;
  for (const { id } of due) {
    const sent = await db.transaction(async (tx) => {
      const [reminder] = await tx
        .select()
        .from(recurringReminders)
        .where(eq(recurringReminders.id, id))
        .for("update");
      // Re-checked under the lock: another run may have nudged it meanwhile.
      if (reminder?.status !== "active") return false;
      if (reminder.lastNudgedAt && now.getTime() - reminder.lastNudgedAt.getTime() < NUDGE_EVERY_DAYS * DAY_MS) {
        return false;
      }

      const [user] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, reminder.userId));
      const [service] = reminder.canonicalServiceId
        ? await tx
            .select({ name: canonicalServices.name })
            .from(canonicalServices)
            .where(eq(canonicalServices.id, reminder.canonicalServiceId))
        : [];

      const [conversation] = await tx
        .insert(conversations)
        .values({ userId: reminder.userId, createdAt: now, updatedAt: now })
        .returning({ id: conversations.id });
      await tx.insert(messages).values({
        conversationId: conversation!.id,
        role: "assistant",
        content: nudgeText(reminder.label, service?.name ?? null, reminder.nextDueAt, localDate(now, user!.timezone)),
        createdAt: now,
        metadata: { kind: "reminder_nudge", reminder_id: reminder.id },
      });
      await saveState(
        conversation!.id,
        { ...emptyState(), categoryId: reminder.categoryId, serviceId: reminder.canonicalServiceId, reminderId: reminder.id },
        now,
        tx,
      );
      await tx
        .update(recurringReminders)
        .set({ lastNudgedAt: now, updatedAt: now })
        .where(eq(recurringReminders.id, reminder.id));
      return true;
    });
    if (sent) nudged++;
  }
  return nudged;
}
