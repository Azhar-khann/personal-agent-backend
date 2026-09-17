import { getDb, schema, type Confirmation, type LocationMode, type PricingMode } from "@personal-agent/core";
import { CANONICAL_SERVICES, CATEGORIES, CATEGORY_SERVICE_DEFAULTS } from "@personal-agent/core/seed-data";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

export type CatalogueService = {
  id: string;
  categoryId: string;
  name: string;
  aliases: string[];
  defaultLocationMode: LocationMode;
  defaultPricingMode: PricingMode;
  /** per_unit: 'kg', 'item', ... */
  defaultUnitLabel: string | null;
  defaultConfirmation: Confirmation;
};

export type CatalogueCategory = {
  id: string;
  name: string;
  agentHints: string | null;
  /** From request_schema: what the agent must know before it can search. */
  required: string[];
  optional: string[];
  services: CatalogueService[];
};

export type Catalogue = {
  categories: CatalogueCategory[];
  category(id: string | null | undefined): CatalogueCategory | undefined;
  service(id: string | null | undefined): CatalogueService | undefined;
};

const RequestSchema = z.object({
  required: z.array(z.string()).default([]),
  optional: z.array(z.string()).default([]),
});

const CACHE_MS = 5 * 60_000;
let cached: { loadedAt: number; catalogue: Catalogue } | undefined;

/**
 * The active categories and services the agent can book. It changes only
 * when someone edits the seed, so it's cached for a few minutes.
 */
export async function loadCatalogue(): Promise<Catalogue> {
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.catalogue;

  const db = getDb();
  const { categories, canonicalServices } = schema;
  const [categoryRows, serviceRows] = await Promise.all([
    db.select().from(categories).where(eq(categories.active, true)).orderBy(asc(categories.id)),
    db.select().from(canonicalServices).where(eq(canonicalServices.active, true)).orderBy(asc(canonicalServices.id)),
  ]);

  const catalogue = buildCatalogue(
    categoryRows,
    serviceRows.map((row) => ({
      ...row,
      defaultLocationMode: row.defaultLocationMode as LocationMode,
      defaultPricingMode: row.defaultPricingMode as PricingMode,
      defaultConfirmation: row.defaultConfirmation as Confirmation,
    })),
  );
  cached = { loadedAt: Date.now(), catalogue };
  return catalogue;
}

/**
 * The catalogue straight from the seed file, with no database — for the
 * evals. Sorted by id as loadCatalogue's query is, so the model sees the same
 * prompt it gets in production.
 */
export function catalogueFromSeed(): Catalogue {
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  return buildCatalogue(
    [...CATEGORIES].sort(byId),
    [...CANONICAL_SERVICES].sort(byId).map((service) => {
      const defaults = CATEGORY_SERVICE_DEFAULTS[service.categoryId]!;
      return {
        ...service,
        defaultLocationMode: service.locationMode ?? defaults.locationMode,
        defaultPricingMode: service.pricingMode ?? defaults.pricingMode,
        defaultUnitLabel: service.unitLabel ?? null,
        defaultConfirmation: service.confirmation ?? defaults.confirmation,
      };
    }),
  );
}

function buildCatalogue(
  categoryRows: { id: string; name: string; agentHints: string | null; requestSchema: unknown }[],
  serviceRows: CatalogueService[],
): Catalogue {
  const services = new Map<string, CatalogueService>(
    serviceRows.map((row) => [
      row.id,
      {
        id: row.id,
        categoryId: row.categoryId,
        name: row.name,
        aliases: row.aliases,
        defaultLocationMode: row.defaultLocationMode,
        defaultPricingMode: row.defaultPricingMode,
        defaultUnitLabel: row.defaultUnitLabel,
        defaultConfirmation: row.defaultConfirmation,
      },
    ]),
  );

  const list: CatalogueCategory[] = categoryRows.map((row) => {
    const request = RequestSchema.safeParse(row.requestSchema);
    return {
      id: row.id,
      name: row.name,
      agentHints: row.agentHints,
      required: request.success ? request.data.required : ["service", "time_window"],
      optional: request.success ? request.data.optional : [],
      services: [...services.values()].filter((service) => service.categoryId === row.id),
    };
  });
  const byId = new Map(list.map((category) => [category.id, category]));

  return {
    categories: list,
    category: (id) => (id ? byId.get(id) : undefined),
    service: (id) => (id ? services.get(id) : undefined),
  };
}
