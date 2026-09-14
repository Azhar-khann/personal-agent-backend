import { clerkClient, getAuth } from "@clerk/express";
import { getDb, schema } from "@personal-agent/core";
import { eq } from "drizzle-orm";
import type { Request, RequestHandler } from "express";

import { HttpError } from "./http.js";

export type User = typeof schema.users.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      /** Set by requireUser: our users row for the signed-in person. */
      user?: User;
    }
  }
}

/**
 * For routes that need a signed-in user. Relies on clerkMiddleware() running
 * first (app.ts). Returns 401 rather than redirecting — this is a JSON API.
 */
export const requireUser: RequestHandler = async (req, _res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    throw new HttpError(401, "unauthenticated", "Sign in required");
  }
  req.user = await findOrCreateUser(userId);
  next();
};

/** The signed-in user. Only valid on routes mounted behind requireUser. */
export function currentUser(req: Request): User {
  if (!req.user) {
    throw new Error("currentUser() called on a route not mounted behind requireUser");
  }
  return req.user;
}

async function findOrCreateUser(clerkUserId: string): Promise<User> {
  const db = getDb();
  const { users } = schema;

  // Every request after someone's first: one read, no Clerk call, no write.
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing;

  // First request: copy name and email from Clerk (the spec's "our own copy").
  // Phone is not copied — it is UNIQUE here, and confirmed during onboarding.
  const clerkUser = await clerkClient.users.getUser(clerkUserId);

  // Returns the row whether this request created it or a concurrent first
  // request got there first.
  const [user] = await db
    .insert(users)
    .values({
      clerkUserId,
      name: clerkUser.fullName,
      email: clerkUser.primaryEmailAddress?.emailAddress ?? null,
    })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { clerkUserId } })
    .returning();
  return user!;
}
