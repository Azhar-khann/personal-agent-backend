/** SQLSTATE codes this codebase reacts to. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  /** Raised by the no_double_booking exclusion constraint. */
  EXCLUSION_VIOLATION: "23P01",
} as const;

type PgErrorFields = { code?: unknown; constraint_name?: unknown; cause?: unknown };

function findPgError(error: unknown): PgErrorFields | undefined {
  // Checks `cause` too, in case a wrapper sits between us and postgres.js.
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth++) {
    if (typeof current !== "object") return undefined;
    const fields = current as PgErrorFields;
    if (typeof fields.code === "string") return fields;
    current = fields.cause;
  }
  return undefined;
}

/** The SQLSTATE of a Postgres error, if that is what this is. */
export function pgErrorCode(error: unknown): string | undefined {
  const code = findPgError(error)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The name of the constraint a Postgres error was raised by, if any. */
export function pgConstraintName(error: unknown): string | undefined {
  const name = findPgError(error)?.constraint_name;
  return typeof name === "string" ? name : undefined;
}
