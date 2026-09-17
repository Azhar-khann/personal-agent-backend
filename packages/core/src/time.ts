/**
 * Local wall-clock times in the user's time zone (users.timezone) and UTC.
 *
 * The model reads and writes local times like "2026-09-17T15:00"; converting
 * and checking them is done here, in code. §11: a wrong window doesn't throw,
 * it quietly searches the wrong day.
 */

/** Businesses are in the UAE (§ scope), so their times read in Dubai time. */
export const BUSINESS_TIME_ZONE = "Asia/Dubai";

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;
/** §4: reject anything more than two weeks long. */
const MAX_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;

const pad = (n: number) => String(n).padStart(2, "0");

function partsIn(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** An instant as local wall-clock time: "2026-09-17T15:00". */
export function toLocal(instant: Date, timeZone: string): string {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** How far ahead of UTC the zone's clocks are at an instant, in ms. */
function offsetMs(instant: number, timeZone: string): number {
  const floored = Math.floor(instant / MINUTE_MS) * MINUTE_MS;
  const p = partsIn(new Date(floored), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - floored;
}

/**
 * The instant a local wall-clock time names, or null when there's no such time
 * there: a malformed string, a day that doesn't exist, or a time skipped by a
 * daylight-saving jump.
 */
export function fromLocal(local: string, timeZone: string): Date | null {
  const match = LOCAL.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];

  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Guess with the offset at the wall time read as UTC, then correct once with
  // the offset at the guess — enough to cross a daylight-saving change.
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone);

  const result = new Date(instant);
  return toLocal(result, timeZone) === local ? result : null;
}

export type WindowProblem = "unreadable" | "ends_before_start" | "in_past" | "too_long";

export type CheckedWindow =
  | { ok: true; start: Date; end: Date }
  | { ok: false; problem: WindowProblem };

/**
 * §4's checks on the model's window: unreadable, ending before it starts,
 * already over, or longer than two weeks. A window already under way
 * ("this afternoon" at 14:00) starts now.
 */
export function checkWindow(startLocal: string, endLocal: string, timeZone: string, now: Date): CheckedWindow {
  const start = fromLocal(startLocal, timeZone);
  const end = fromLocal(endLocal, timeZone);
  if (!start || !end) return { ok: false, problem: "unreadable" };
  if (end <= start) return { ok: false, problem: "ends_before_start" };
  if (end <= now) return { ok: false, problem: "in_past" };
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) return { ok: false, problem: "too_long" };
  return { ok: true, start: start < now ? now : start, end };
}

/** "Thu 17 Sep" */
export function formatDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(instant);
}

/** "15:00" */
export function formatClock(instant: Date, timeZone: string): string {
  return toLocal(instant, timeZone).slice(11);
}

/** "Thu 17 Sep, 15:00" */
export function formatWhen(instant: Date, timeZone: string): string {
  return `${formatDay(instant, timeZone)}, ${formatClock(instant, timeZone)}`;
}

/** "Thu 17 Sep, 12:00–17:00", or "Thu 17 Sep 12:00 – Sun 20 Sep 23:59" across days. */
export function formatWindow(start: Date, end: Date, timeZone: string): string {
  const sameDay = toLocal(start, timeZone).slice(0, 10) === toLocal(end, timeZone).slice(0, 10);
  return sameDay
    ? `${formatWhen(start, timeZone)}–${formatClock(end, timeZone)}`
    : `${formatDay(start, timeZone)} ${formatClock(start, timeZone)} – ${formatDay(end, timeZone)} ${formatClock(end, timeZone)}`;
}

/** A calendar date ("2026-10-12", as Postgres returns a date column) as "Mon 12 Oct". */
export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** "Thursday 2026-09-17 15:04", for telling the model what "now" is. */
export function describeNow(now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now);
  return `${weekday} ${toLocal(now, timeZone).replace("T", " ")}`;
}
