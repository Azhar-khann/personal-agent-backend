import { z } from "zod";

export const phoneNumber = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "must be in international format, e.g. +971501234567");

/**
 * A coarse box around the UAE, not a border check. Business coordinates come
 * straight from the owner's browser (navigator.geolocation), so this catches a
 * signup made from abroad or a badly wrong IP-based fix — a pin that would
 * otherwise sit silently outside every search radius.
 */
const UAE = { minLat: 22.5, maxLat: 26.5, minLng: 51.5, maxLng: 56.5 };
const outsideUae = "must be inside the UAE";

export const uaeLatitude = z.number().min(UAE.minLat, outsideUae).max(UAE.maxLat, outsideUae);
export const uaeLongitude = z.number().min(UAE.minLng, outsideUae).max(UAE.maxLng, outsideUae);

/** An ISO 8601 date-time that states its offset, e.g. 2030-01-07T15:00:00+04:00. */
export const dateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/** `?from=&to=` query parameters, no more than `maxDays` apart. */
export function timeRangeQuery(maxDays: number) {
  return z
    .object({ from: dateTime, to: dateTime })
    .strict()
    .refine((range) => range.to > range.from, { message: "to must be after from", path: ["to"] })
    .refine((range) => range.to.getTime() - range.from.getTime() <= maxDays * 24 * 60 * 60_000, {
      message: `from and to may be at most ${maxDays} days apart`,
      path: ["to"],
    });
}
