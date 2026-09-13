import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { loadEnv } from "../env.js";

/**
 * One postgres.js pool per process, created on first use.
 *
 * Both programs import this: the API books, the worker completes and reminds.
 * Lazy construction keeps `import`ing this module free of side effects so the
 * pure-logic tests in Stage 4 never open a socket.
 */

export type Sql = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof drizzle>;

let sqlClient: Sql | undefined;
let dbClient: Database | undefined;

export function getSql(): Sql {
  if (sqlClient) return sqlClient;

  const env = loadEnv();

  sqlClient = postgres(env.DATABASE_URL, {
    // The booking transaction in §6 is short and hot; the worker's jobs are
    // long and infrequent. A small pool suits both — raise per-app later if
    // the API needs it.
    max: 10,
    // Return numeric/timestamptz as-is; Drizzle handles the mapping.
    prepare: false,
    onnotice: () => {},
  });

  return sqlClient;
}

export function getDb(): Database {
  if (dbClient) return dbClient;
  dbClient = drizzle(getSql());
  return dbClient;
}

/** Close the pool. Call on shutdown so the worker exits cleanly. */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    dbClient = undefined;
  }
}
