import { getDb, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";

import { HttpError } from "../http.js";

/** Public catalogue endpoints (§8). No sign-in needed. */
export const categoriesRouter = Router();

const { categories, canonicalServices } = schema;

async function findActiveCategory(id: string) {
  const [category] = await getDb()
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.active, true)))
    .limit(1);

  if (!category) {
    throw new HttpError(404, "category_not_found", `No active category '${id}'`);
  }
  return category;
}

/** GET /api/categories — the business types, for the signup dropdown. */
categoriesRouter.get("/", async (_req, res) => {
  const rows = await getDb()
    .select({
      id: categories.id,
      name: categories.name,
      groupName: categories.groupName,
    })
    .from(categories)
    .where(eq(categories.active, true))
    .orderBy(asc(categories.groupName), asc(categories.name));

  res.json({ categories: rows });
});

/** GET /api/categories/:id/onboarding-schema — extra signup questions. */
categoriesRouter.get("/:id/onboarding-schema", async (req, res) => {
  const category = await findActiveCategory(req.params.id);
  res.json({
    categoryId: category.id,
    onboardingSchema: category.onboardingSchema,
  });
});

/** GET /api/categories/:id/services — what a business picks from. */
categoriesRouter.get("/:id/services", async (req, res) => {
  const category = await findActiveCategory(req.params.id);

  const services = await getDb()
    .select({
      id: canonicalServices.id,
      name: canonicalServices.name,
      typicalDurationMin: canonicalServices.typicalDurationMin,
    })
    .from(canonicalServices)
    .where(
      and(
        eq(canonicalServices.categoryId, category.id),
        eq(canonicalServices.active, true),
      ),
    )
    .orderBy(asc(canonicalServices.name));

  res.json({ categoryId: category.id, services });
});
