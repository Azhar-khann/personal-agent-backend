import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Environment is validated once, on demand — never at module load.
 *
 * Stage 4 builds the availability engine and ranking as pure functions with
 * unit tests. Those tests import from this package, and they must not need a
 * database URL to run. So nothing here runs until something actually asks for
 * it via `loadEnv()`.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "must be a postgres:// or postgresql:// connection string",
  });

const redisUrl = z
  .string()
  .min(1)
  .refine((value) => /^rediss?:\/\//.test(value), {
    message: "must be a redis:// or rediss:// connection string",
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Finds the repo-root `.env` by walking up from the current directory.
 *
 * Scripts run from wherever pnpm puts them — `packages/core` for a filtered
 * db:seed, the repo root for `pnpm check:db` — but there is one .env at the
 * root. Searching upward means neither has to care.
 */
function findDotenvFile(): string | undefined {
  let dir = process.cwd();
  const { root } = parse(dir);

  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/** Loads the repo-root .env into process.env, for a script that validates its own variables. */
export function loadDotenvFile(): void {
  const dotenvPath = findDotenvFile();
  if (dotenvPath) loadDotenv({ path: dotenvPath });
}

/**
 * Parses and caches process.env. Throws a readable, aggregated error listing
 * every missing or malformed variable at once, rather than failing on the
 * first one and making you re-run to find the next.
 */
export function loadEnv(): Env {
  if (cached) return cached;

  loadDotenvFile();

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: drop the memoised env so a test can swap process.env. */
export function resetEnvForTesting(): void {
  cached = undefined;
}
