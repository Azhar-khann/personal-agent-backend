import type { ErrorRequestHandler, RequestHandler } from "express";
import type { z } from "zod";

/**
 * Every error response has the same shape:
 *   { "error": { "code": "...", "message": "...", "details"?: ... } }
 * `code` is stable for the frontend to branch on; `message` is for humans.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Validates input against a Zod schema, or throws a 400 listing every problem. */
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_request",
      "Request validation failed",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route's :id, which must be a uuid. A malformed id is simply not found —
 * letting it reach Postgres would turn a bad URL into a 500.
 */
export function uuidParam(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(404, "not_found", "Not found");
  }
  return value;
}

export const notFound: RequestHandler = (req) => {
  throw new HttpError(404, "not_found", `No route for ${req.method} ${req.path}`);
};

/** Malformed JSON from express.json(). */
function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "entity.parse.failed"
  );
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  if (isBodyParseError(error)) {
    res.status(400).json({
      error: { code: "invalid_json", message: "Request body is not valid JSON" },
    });
    return;
  }

  req.log.error({ err: error }, "unhandled error");
  res.status(500).json({
    error: { code: "internal_error", message: "Something went wrong" },
  });
};
