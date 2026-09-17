import { getDb, schema, type LocationMode } from "@personal-agent/core";
import { CANONICAL_SERVICES, CATEGORIES, CATEGORY_SERVICE_DEFAULTS } from "@personal-agent/core/seed-data";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

export type CatalogueService = {
  id: string;
  categoryId: string;
  name: string;
  aliases: string[];
  defaultLocationMode: LocationMode;
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
    serviceRows.map((row) => ({ ...row, defaultLocationMode: row.defaultLocationMode as LocationMode })),
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
    [...CANONICAL_SERVICES].sort(byId).map((service) => ({
      ...service,
      defaultLocationMode: service.locationMode ?? CATEGORY_SERVICE_DEFAULTS[service.categoryId]!.locationMode,
    })),
  );
}

function buildCatalogue(
  categoryRows: { id: string; name: string; agentHints: string | null; requestSchema: unknown }[],
  serviceRows: CatalogueService[],
): Catalogue {
  const services = new Map<string, CatalogueService>(
    serviceRows.map(({ id, categoryId, name, aliases, defaultLocationMode }) => [
      id,
      { id, categoryId, name, aliases, defaultLocationMode },
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
