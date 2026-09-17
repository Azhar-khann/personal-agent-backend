/**
 * How each eval dataset is scored (§11). Pure: the model's structured output
 * and the reviewed answer in, scores out.
 *
 * Scores follow what the agent *does* with the output, as turn.ts does, not
 * the raw fields: a service implies its category, a lone candidate is taken as
 * the category, and a window that has already begun starts now. That's what
 * the user experiences.
 */

import { checkWindow } from "@personal-agent/core";
import { z } from "zod";

import type { Catalogue } from "../agent/catalogue.js";
import { nameMatches } from "../agent/names.js";
import type { Understanding } from "../agent/understand.js";

/** When and where every eval message is sent: a Thursday morning in Dubai. */
export const EVAL_NOW = new Date("2026-09-17T06:00:00Z");
export const EVAL_TIME_ZONE = "Asia/Dubai";

// --- category detection -------------------------------------------------------

export const CategoryExpected = z.union([
  z.object({ category: z.string() }).strict(),
  /** Too ambiguous to pick: the agent should ask, offering at least these. */
  z.object({ ask: z.array(z.string()).min(2) }).strict(),
  /** Nothing in the catalogue fits. */
  z.object({ unsupported: z.literal(true) }).strict(),
]);
export type CategoryExpected = z.infer<typeof CategoryExpected>;

/** The category from the service or category id — what turn.ts knows before looking up a business name. */
function statedCategory(u: Understanding, catalogue: Catalogue): string | null {
  return catalogue.service(u.service_id)?.categoryId ?? catalogue.category(u.category_id)?.id ?? null;
}

function validCandidates(u: Understanding, catalogue: Catalogue): string[] {
  return [...new Set(u.category_candidates.filter((id) => catalogue.category(id)))].sort();
}

/** The category the agent goes on with, or null when it asks or can't help. */
export function resolvedCategory(u: Understanding, catalogue: Catalogue): string | null {
  const candidates = validCandidates(u, catalogue);
  return statedCategory(u, catalogue) ?? (candidates.length === 1 ? candidates[0]! : null);
}

/** What the agent did, as a label for the confusion list: "plumber", "ask:handyman+plumber" or "unsupported". */
export function categoryOutcome(u: Understanding, catalogue: Catalogue): string {
  const category = resolvedCategory(u, catalogue);
  if (category) return category;
  const candidates = validCandidates(u, catalogue);
  return candidates.length > 1 ? `ask:${candidates.join("+")}` : "unsupported";
}

export function expectedCategoryLabel(expected: CategoryExpected): string {
  if ("category" in expected) return expected.category;
  if ("ask" in expected) return `ask:${[...expected.ask].sort().join("+")}`;
  return "unsupported";
}

export function scoreCategory(u: Understanding, expected: CategoryExpected, catalogue: Catalogue): boolean {
  const category = resolvedCategory(u, catalogue);
  if ("category" in expected) return category === expected.category;
  const candidates = validCandidates(u, catalogue);
  if ("ask" in expected) {
    return category === null && candidates.length > 1 && expected.ask.every((id) => candidates.includes(id));
  }
  return category === null && candidates.length === 0;
}

/** The pairs mixed up most often — §11: they matter more than the overall score. */
export function topConfusions(pairs: { expected: string; got: string }[], limit = 5): { pair: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { expected, got } of pairs) {
    if (expected === got) continue;
    const pair = `${expected} → ${got}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
    .slice(0, limit);
}

// --- time windows -------------------------------------------------------------------

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "must be YYYY-MM-DDTHH:MM");
export const LocalWindow = z.object({ start: localTime, end: localTime }).strict();
export type LocalWindow = z.infer<typeof LocalWindow>;

/** §11 near misses: within this many minutes at both ends. */
export const NEAR_MISS_MIN = 60;

/** The window as the agent searches it, or null if it would be rejected. */
export function searchedWindow(window: LocalWindow, now = EVAL_NOW): { start: number; end: number } | null {
  const checked = checkWindow(window.start, window.end, EVAL_TIME_ZONE, now);
  return checked.ok ? { start: checked.start.getTime(), end: checked.end.getTime() } : null;
}

/**
 * `wanted` is the labelled window, plus any equally right readings of an
 * ambiguous phrase. Both sides go through the agent's own checks first, so
 * "today" read as 00:00 or as now scores the same.
 */
export function scoreWindow(got: LocalWindow | null, wanted: LocalWindow[] | null): { exact: boolean; near: boolean } {
  if (!wanted || !got) return { exact: !wanted && !got, near: !wanted && !got };
  const searched = searchedWindow(got);
  if (!searched) return { exact: false, near: false };

  const nearMs = NEAR_MISS_MIN * 60_000;
  const targets = wanted.flatMap((window) => searchedWindow(window) ?? []);
  return {
    exact: targets.some((t) => t.start === searched.start && t.end === searched.end),
    near: targets.some((t) => Math.abs(t.start - searched.start) <= nearMs && Math.abs(t.end - searched.end) <= nearMs),
  };
}

export const TimeExpected = z
  .object({
    window: LocalWindow.nullable(),
    /** Other readings that are just as right, for a phrase like "at 7". */
    alternatives: z.array(LocalWindow).optional(),
  })
  .strict();
export type TimeExpected = z.infer<typeof TimeExpected>;

export const wantedWindows = (expected: TimeExpected) =>
  expected.window ? [expected.window, ...(expected.alternatives ?? [])] : null;

export function scoreTime(u: Understanding, expected: TimeExpected) {
  return scoreWindow(u.time_window, wantedWindows(expected));
}

// --- slot extraction ----------------------------------------------------------------

export const SlotExpected = z
  .object({
    service_id: z.string().nullable(),
    window: LocalWindow.nullable(),
    location: z.enum(["at_business", "at_customer"]).nullable(),
    has_address: z.boolean(),
    budget_max_aed: z.number().nullable(),
    /** Whether the message carries an instruction for the business; the wording varies. */
    has_notes: z.boolean(),
    /**
     * Answers to the category's optional details. A list gives the values
     * that count as right, e.g. { "urgency": ["urgent", "emergency"] }.
     */
    details: z.record(z.union([z.string(), z.array(z.string()).min(1)])),
    /** How many units, for a service priced per unit; null for anything else. */
    quantity: z.number().nullable().default(null),
  })
  .strict();
export type SlotExpected = z.infer<typeof SlotExpected>;

const normalized = (text: string) => text.trim().toLowerCase();

export function scoreSlots(u: Understanding, expected: SlotExpected, catalogue: Catalogue) {
  // The agent keeps a quantity only for a per-unit service (turn.ts).
  const quantity = catalogue.service(u.service_id)?.defaultPricingMode === "per_unit" ? u.quantity : null;
  const given = new Map(u.details.map(({ key, value }) => [normalized(key), normalized(value)]));
  const wanted = Object.entries(expected.details);
  return {
    service: u.service_id === expected.service_id,
    window: scoreWindow(u.time_window, expected.window && [expected.window]).exact,
    location: u.location === expected.location,
    address: (u.address !== null) === expected.has_address,
    budget: u.budget_max_aed === expected.budget_max_aed,
    quantity: quantity === expected.quantity,
    notes: (u.notes !== null) === expected.has_notes,
    details:
      given.size === wanted.length &&
      wanted.every(([key, values]) => [values].flat().map(normalized).includes(given.get(normalized(key)) ?? "")),
  };
}

// --- direct name resolution ------------------------------------------------------------------

/** A business in the fixture directory the name evals resolve against. */
export const FixtureBusiness = z
  .object({ id: z.string(), name: z.string(), address: z.string(), category: z.string(), services: z.array(z.string()) })
  .strict();
export type FixtureBusiness = z.infer<typeof FixtureBusiness>;

export const NameOutcome = z.enum(["found", "branches", "not_signed_up", "doesnt_offer", "no_business_named"]);
export type NameOutcome = z.infer<typeof NameOutcome>;

export const NameExpected = z
  .object({
    outcome: NameOutcome,
    /** The fixture business, for "found" and "doesnt_offer". */
    business: z.string().optional(),
  })
  .strict()
  .refine(
    ({ outcome, business }) => (outcome === "found" || outcome === "doesnt_offer") === (business !== undefined),
    "business is given exactly for found and doesnt_offer",
  );
export type NameExpected = z.infer<typeof NameExpected>;

/** §4's four outcomes, resolved as turn.ts does — over the fixture list instead of the database. */
export function resolveName(
  u: Understanding,
  catalogue: Catalogue,
  directory: FixtureBusiness[],
): { outcome: NameOutcome; business?: string } {
  if (!u.business_name) return { outcome: "no_business_named" };

  const found = directory.filter((business) => nameMatches(u.business_name!, business.name));
  const category = statedCategory(u, catalogue);
  const sameCategory = found.filter((business) => business.category === category);
  const candidates = sameCategory.length > 0 ? sameCategory : found;

  if (candidates.length === 0) return { outcome: "not_signed_up" };
  if (candidates.length > 1) return { outcome: "branches" };

  const business = candidates[0]!;
  const service = catalogue.service(u.service_id);
  if (service && !business.services.includes(service.id)) return { outcome: "doesnt_offer", business: business.id };
  return { outcome: "found", business: business.id };
}

export function scoreName(u: Understanding, expected: NameExpected, catalogue: Catalogue, directory: FixtureBusiness[]) {
  const resolved = resolveName(u, catalogue, directory);
  return {
    outcome: resolved.outcome === expected.outcome && resolved.business === expected.business,
    named: (u.business_name !== null) === (expected.outcome !== "no_business_named"),
  };
}
