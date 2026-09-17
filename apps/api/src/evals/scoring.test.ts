import { describe, expect, it } from "vitest";

import { catalogueFromSeed } from "../agent/catalogue.js";
import type { Understanding } from "../agent/understand.js";
import {
  categoryOutcome,
  resolveName,
  scoreCategory,
  scoreName,
  scoreSlots,
  scoreTime,
  topConfusions,
  type FixtureBusiness,
} from "./scoring.js";

const catalogue = catalogueFromSeed();

const nothing: Understanding = {
  intent: "request",
  starts_new_request: true,
  category_id: null,
  category_candidates: [],
  service_id: null,
  business_name: null,
  choice_number: null,
  time_window: null,
  location: null,
  address: null,
  budget_max_aed: null,
  notes: null,
  details: [],
  option_number: null,
  option_time: null,
  order_number: null,
  booking_action: null,
  reply: null,
};

describe("scoreCategory", () => {
  it("counts a service as naming its category, as the agent does", () => {
    expect(scoreCategory({ ...nothing, service_id: "leak_repair" }, { category: "plumber" }, catalogue)).toBe(true);
  });

  it("counts a lone candidate as the category", () => {
    expect(scoreCategory({ ...nothing, category_candidates: ["plumber"] }, { category: "plumber" }, catalogue)).toBe(true);
  });

  it("wants a question offering the expected categories when it's ambiguous", () => {
    const asked = { ...nothing, category_candidates: ["plumber", "handyman", "ac_maintenance"] };
    expect(scoreCategory(asked, { ask: ["handyman", "plumber"] }, catalogue)).toBe(true);
    expect(scoreCategory({ ...nothing, category_id: "plumber" }, { ask: ["handyman", "plumber"] }, catalogue)).toBe(false);
  });

  it("wants nothing guessed when nothing fits", () => {
    expect(scoreCategory(nothing, { unsupported: true }, catalogue)).toBe(true);
    expect(scoreCategory({ ...nothing, category_candidates: ["handyman"] }, { unsupported: true }, catalogue)).toBe(false);
  });

  it("ignores ids that aren't in the catalogue", () => {
    expect(categoryOutcome({ ...nothing, category_id: "electrician" }, catalogue)).toBe("unsupported");
  });
});

describe("topConfusions", () => {
  it("counts only mistakes, most frequent first", () => {
    expect(
      topConfusions([
        { expected: "plumber", got: "handyman" },
        { expected: "plumber", got: "handyman" },
        { expected: "barber", got: "salon" },
        { expected: "dentist", got: "dentist" },
      ]),
    ).toEqual([
      { pair: "plumber → handyman", count: 2 },
      { pair: "barber → salon", count: 1 },
    ]);
  });
});

describe("scoreSlots", () => {
  const none = { service_id: null, window: null, location: null, has_address: false, budget_max_aed: null, has_notes: false, details: {} };

  it("scores each field on its own", () => {
    const scores = scoreSlots(
      { ...nothing, service_id: "manicure", budget_max_aed: 100, details: [{ key: "Gender_Preference", value: "Female " }] },
      { ...none, service_id: "manicure", location: "at_customer", budget_max_aed: 100, details: { gender_preference: "female" } },
    );
    expect(scores).toEqual({ service: true, window: true, location: false, address: true, budget: true, notes: true, details: true });
  });

  it("accepts any of a detail's listed values, and nothing invented", () => {
    const urgent = { ...none, details: { urgency: ["urgent", "emergency"] } };
    expect(scoreSlots({ ...nothing, details: [{ key: "urgency", value: "Emergency" }] }, urgent).details).toBe(true);
    expect(scoreSlots({ ...nothing, details: [{ key: "urgency", value: "soon" }] }, urgent).details).toBe(false);
    expect(scoreSlots({ ...nothing, details: [{ key: "urgency", value: "high" }] }, none).details).toBe(false);
  });
});

describe("scoreTime", () => {
  const want = { window: { start: "2026-09-18T12:00", end: "2026-09-18T17:00" } };
  const at = (start: string, end: string) => ({ ...nothing, time_window: { start, end } });

  it("separates exact matches from near misses", () => {
    expect(scoreTime(at("2026-09-18T12:00", "2026-09-18T17:00"), want)).toEqual({ exact: true, near: true });
    expect(scoreTime(at("2026-09-18T13:00", "2026-09-18T17:00"), want)).toEqual({ exact: false, near: true });
    expect(scoreTime(at("2026-09-19T12:00", "2026-09-19T17:00"), want)).toEqual({ exact: false, near: false });
  });

  it("wants null when no time was mentioned, and nothing else", () => {
    expect(scoreTime(nothing, { window: null })).toEqual({ exact: true, near: true });
    expect(scoreTime(nothing, want)).toEqual({ exact: false, near: false });
    expect(scoreTime(at("2026-09-18T12:00", "2026-09-18T17:00"), { window: null })).toEqual({ exact: false, near: false });
  });

  it("compares windows as searched, so one that has begun starts now", () => {
    // Now is 10:00 on the 17th.
    const today = { window: { start: "2026-09-17T00:00", end: "2026-09-17T23:59" } };
    expect(scoreTime(at("2026-09-17T10:00", "2026-09-17T23:59"), today)).toEqual({ exact: true, near: true });
  });

  it("accepts an alternative reading, and never a window the agent would reject", () => {
    const seven = {
      window: { start: "2026-09-18T18:45", end: "2026-09-18T19:15" },
      alternatives: [{ start: "2026-09-18T06:45", end: "2026-09-18T07:15" }],
    };
    expect(scoreTime(at("2026-09-18T06:45", "2026-09-18T07:15"), seven).exact).toBe(true);
    expect(scoreTime(at("2026-09-18T19:15", "2026-09-18T18:45"), seven)).toEqual({ exact: false, near: false });
  });
});

describe("resolveName", () => {
  const directory: FixtureBusiness[] = [
    { id: "kings-jbr", name: "Kings Barbers", address: "JBR", category: "barber", services: ["mens_haircut"] },
    { id: "kings-barsha", name: "Kings Barbers", address: "Al Barsha", category: "barber", services: ["mens_haircut"] },
    { id: "kings-auto", name: "Kings Auto Garage", address: "Al Quoz", category: "car_service", services: ["oil_change"] },
    { id: "coolair", name: "CoolAir Services", address: "Al Quoz", category: "ac_maintenance", services: ["ac_servicing"] },
  ];

  it("gives §4's four outcomes", () => {
    expect(resolveName({ ...nothing, business_name: "coolair services", service_id: "ac_servicing" }, catalogue, directory)).toEqual({ outcome: "found", business: "coolair" });
    expect(resolveName({ ...nothing, business_name: "Kings Barbers" }, catalogue, directory)).toEqual({ outcome: "branches" });
    expect(resolveName({ ...nothing, business_name: "Frosty AC" }, catalogue, directory)).toEqual({ outcome: "not_signed_up" });
    expect(resolveName({ ...nothing, business_name: "CoolAir", service_id: "duct_cleaning" }, catalogue, directory)).toEqual({ outcome: "doesnt_offer", business: "coolair" });
  });

  it("prefers a match in the stated category, but not one only guessed from candidates", () => {
    expect(resolveName({ ...nothing, business_name: "Kings", service_id: "oil_change" }, catalogue, directory)).toEqual({ outcome: "found", business: "kings-auto" });
    expect(resolveName({ ...nothing, business_name: "Kings", category_candidates: ["car_service"] }, catalogue, directory)).toEqual({ outcome: "branches" });
  });

  it("scores the outcome and whether a business was noticed at all", () => {
    expect(scoreName({ ...nothing, business_name: "CoolAir" }, { outcome: "found", business: "coolair" }, catalogue, directory)).toEqual({ outcome: true, named: true });
    expect(scoreName(nothing, { outcome: "found", business: "coolair" }, catalogue, directory)).toEqual({ outcome: false, named: false });
  });
});
