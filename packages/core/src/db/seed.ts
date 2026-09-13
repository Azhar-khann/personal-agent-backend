/**
 * Seeds the catalogue and the first admin.
 *
 * Idempotent — safe to re-run. Categories and canonical services upsert on
 * their primary key, so editing seed-data.ts and re-running updates rows in
 * place rather than failing or duplicating.
 *
 * Run: pnpm --filter @personal-agent/core db:seed
 */

import { sql } from "drizzle-orm";

import { getDb, closeDb } from "./client.js";
import { canonicalServices, categories, admins, users } from "./schema.js";
import { CANONICAL_SERVICES, CATEGORIES } from "./seed-data.js";

async function seed(): Promise<void> {
  const db = getDb();

  // --- categories --------------------------------------------------------
  await db
    .insert(categories)
    .values(
      CATEGORIES.map((c) => ({
        id: c.id,
        name: c.name,
        groupName: c.groupName,
        onboardingSchema: c.onboardingSchema,
        requestSchema: c.requestSchema,
        agentHints: c.agentHints,
        defaultDurationMin: c.defaultDurationMin,
        defaultRadiusKm: c.defaultRadiusKm,
        recurringDefaultDays: c.recurringDefaultDays,
        active: true,
      })),
    )
    .onConflictDoUpdate({
      target: categories.id,
      set: {
        name: sql`excluded.name`,
        groupName: sql`excluded.group_name`,
        onboardingSchema: sql`excluded.onboarding_schema`,
        requestSchema: sql`excluded.request_schema`,
        agentHints: sql`excluded.agent_hints`,
        defaultDurationMin: sql`excluded.default_duration_min`,
        defaultRadiusKm: sql`excluded.default_radius_km`,
        recurringDefaultDays: sql`excluded.recurring_default_days`,
      },
    });
  console.log(`seeded ${CATEGORIES.length} categories`);

  // --- canonical services ------------------------------------------------
  await db
    .insert(canonicalServices)
    .values(
      CANONICAL_SERVICES.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        name: s.name,
        aliases: s.aliases,
        typicalDurationMin: s.typicalDurationMin,
        active: true,
      })),
    )
    .onConflictDoUpdate({
      target: canonicalServices.id,
      set: {
        categoryId: sql`excluded.category_id`,
        name: sql`excluded.name`,
        aliases: sql`excluded.aliases`,
        typicalDurationMin: sql`excluded.typical_duration_min`,
      },
    });
  console.log(`seeded ${CANONICAL_SERVICES.length} canonical services`);

  // --- the first admin ---------------------------------------------------
  // Without this nobody can reach the approval queue, and no business can ever
  // move from 'pending' to 'active'. The grant chain has to start somewhere.
  const bootstrapClerkId = process.env["ADMIN_BOOTSTRAP_CLERK_USER_ID"];

  if (!bootstrapClerkId) {
    console.log(
      "no ADMIN_BOOTSTRAP_CLERK_USER_ID set — skipping admin seed.\n" +
        "  Set it and re-run once you have a Clerk user, or no business can be approved.",
    );
  } else {
    const [user] = await db
      .insert(users)
      .values({ clerkUserId: bootstrapClerkId })
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: { updatedAt: sql`now()` },
      })
      .returning({ id: users.id });

    if (user) {
      await db
        .insert(admins)
        .values({ userId: user.id })
        .onConflictDoNothing();
      console.log(`seeded admin for clerk user ${bootstrapClerkId}`);
    }
  }
}

seed()
  .then(() => closeDb())
  .then(() => console.log("seed complete"))
  .catch(async (error: unknown) => {
    console.error("seed failed:");
    console.error(error);
    await closeDb().catch(() => {});
    process.exitCode = 1;
  });
