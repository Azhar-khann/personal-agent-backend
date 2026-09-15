/**
 * A business_hours row belongs to the day it opens. When closes_at is at or
 * before opens_at, the business closes on the following day:
 *
 *   10:00–00:00       10am to midnight
 *   Fri 18:00–02:00   Friday 6pm to Saturday 2am
 *   00:00–00:00       open 24 hours
 *
 * Always derived from the two times, never stored — a stored flag could
 * disagree with them. Accepts HH:MM or Postgres's HH:MM:SS.
 */
export function closesNextDay(opensAt: string, closesAt: string): boolean {
  return closesAt.slice(0, 5) <= opensAt.slice(0, 5);
}
