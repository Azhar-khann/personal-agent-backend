/**
 * §5 Step 2 — when a business is actually free, worked out in memory.
 *
 * Pure functions of their inputs: the queries that feed them are in
 * find-options.ts, and these are unit-tested without a database.
 */

import { closesNextDay } from "../hours.js";

/**
 * Business hours are Dubai wall-clock times. The UAE is UTC+4 all year with no
 * daylight saving, so local time is a fixed offset from UTC and a local day is
 * always exactly 24 hours.
 */
const DUBAI_OFFSET_MS = 4 * 60 * 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A half-open time range: `start` is inside it, `end` is not. */
export type Interval = { start: Date; end: Date };

export type OpeningHours = { dayOfWeek: number; opensAt: string; closesAt: string };

export type BookingRules = {
  capacity: number;
  slotIntervalMin: number;
  bufferMin: number;
  leadTimeMin: number;
  maxAdvanceDays: number;
};

/** An appointment already holding time. `end` is its ends_at, buffer included. */
export type BusyAppointment = { resourceIndex: number; start: Date; end: Date };

/** A bookable start time, and the lowest resource free at that time. */
export type FreeSlot = { start: Date; resourceIndex: number };

export type AvailabilityInput = {
  now: Date;
  /** When the appointment may start. */
  window: Interval;
  durationMin: number;
  rules: BookingRules;
  hours: OpeningHours[];
  closures: Interval[];
  appointments: BusyAppointment[];
};

/** Days since 1970-01-01 on the Dubai calendar. */
function localDay(ms: number): number {
  return Math.floor((ms + DUBAI_OFFSET_MS) / DAY_MS);
}

/** The instant of local midnight at the start of a Dubai calendar day. */
function localMidnight(day: number): number {
  return day * DAY_MS - DUBAI_OFFSET_MS;
}

/** 0 = Sunday, as in business_hours.day_of_week. 1970-01-01 was a Thursday. */
function dayOfWeek(day: number): number {
  return (day + 4) % 7;
}

/** Minutes after midnight for HH:MM, or Postgres's HH:MM:SS. */
function clockMinutes(clock: string): number {
  const [hours = "0", minutes = "0"] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * The weekdays whose business_hours rows can matter for a window — the §5
 * Step 1 filter's $days_in_window. Includes the day before the window starts,
 * because a late night that day (Fri 18:00–02:00) covers the window's small
 * hours.
 */
export function daysOfWeekInWindow(window: Interval): number[] {
  const first = localDay(window.start.getTime()) - 1;
  const last = localDay(window.end.getTime() - 1);
  const days = new Set<number>();
  for (let day = first; day <= last && days.size < 7; day++) days.add(dayOfWeek(day));
  return [...days].sort((a, b) => a - b);
}

/**
 * Opening hours as real time ranges for local days firstDay..lastDay, reading
 * the day before (its late night can run into firstDay) and the day after (so
 * a range ending at midnight can join the next day's). A row closing at or
 * before it opens closes the next day. Touching ranges merge, so a business
 * open 00:00–00:00 every day is one continuous range and an appointment can
 * run across midnight.
 */
function openRanges(hours: OpeningHours[], firstDay: number, lastDay: number) {
  const byDay = new Map(hours.map((row) => [row.dayOfWeek, row]));
  const merged: { start: number; end: number }[] = [];

  // Day by day, so ranges arrive in start order.
  for (let day = firstDay - 1; day <= lastDay + 1; day++) {
    const row = byDay.get(dayOfWeek(day));
    if (!row) continue;

    const midnight = localMidnight(day);
    const start = midnight + clockMinutes(row.opensAt) * MINUTE_MS;
    const end =
      midnight +
      clockMinutes(row.closesAt) * MINUTE_MS +
      (closesNextDay(row.opensAt, row.closesAt) ? DAY_MS : 0);

    const previous = merged.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

/**
 * Every start time in the window when the business can take the appointment.
 *
 * - Starts sit on a grid that restarts at each local midnight, so an interval
 *   of 30 means on the hour and half hour (§3).
 * - The whole appointment must fit inside opening hours, not just its start.
 * - Nothing earlier than now + lead time, or later than now + max advance days.
 * - The appointment must not overlap a closure. Its buffer may: that's cleanup
 *   after the customer has gone.
 * - A resource is free when none of its appointments overlaps the appointment
 *   plus its buffer — the same range the no_double_booking constraint checks,
 *   so the engine never offers a time the database would refuse.
 */
export function freeSlots(input: AvailabilityInput): FreeSlot[] {
  const { now, window, rules } = input;
  const duration = input.durationMin * MINUTE_MS;
  const occupies = duration + rules.bufferMin * MINUTE_MS;

  const earliest = Math.max(window.start.getTime(), now.getTime() + rules.leadTimeMin * MINUTE_MS);
  const windowEnd = window.end.getTime();
  const furthest = now.getTime() + rules.maxAdvanceDays * DAY_MS;
  if (earliest >= windowEnd) return [];

  const firstDay = localDay(earliest);
  const lastDay = localDay(windowEnd - 1);
  const open = openRanges(input.hours, firstDay, lastDay);

  // Appointments by resource. One on a resource at or above the capacity stands
  // (the business reduced its capacity, §7) but doesn't block the resources that remain.
  const resources: BusyAppointment[][] = Array.from({ length: rules.capacity }, () => []);
  for (const appointment of input.appointments) resources[appointment.resourceIndex]?.push(appointment);

  const slots: FreeSlot[] = [];
  const step = rules.slotIntervalMin * MINUTE_MS;

  for (let day = firstDay; day <= lastDay; day++) {
    const nextMidnight = localMidnight(day + 1);

    for (let start = localMidnight(day); start < nextMidnight; start += step) {
      if (start < earliest || start >= windowEnd || start > furthest) continue;

      const end = start + duration;
      if (!open.some((range) => range.start <= start && end <= range.end)) continue;
      if (input.closures.some((c) => c.start.getTime() < end && c.end.getTime() > start)) continue;

      const busyUntil = start + occupies;
      const resourceIndex = resources.findIndex((appointments) =>
        appointments.every((a) => a.start.getTime() >= busyUntil || a.end.getTime() <= start),
      );
      if (resourceIndex === -1) continue;

      slots.push({ start: new Date(start), resourceIndex });
    }
  }

  return slots;
}

/**
 * §5 Step 3: "up to three free times, spread across the window rather than
 * three in a row" — the first, the last, and evenly between.
 */
export function spreadSlots<T>(slots: T[], count = 3): T[] {
  if (slots.length <= count) return slots;
  if (count <= 1) return slots.slice(0, count);
  return Array.from(
    { length: count },
    (_, i) => slots[Math.round((i * (slots.length - 1)) / (count - 1))]!,
  );
}
