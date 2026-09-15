import { clerkClient, type User as ClerkUser } from "@clerk/express";
import { getDb, schema } from "@personal-agent/core";
import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { assertNotInAnyBusiness, currentBusiness, requireOwner } from "../business.js";
import { HttpError, parse, uuidParam } from "../http.js";

/**
 * GET POST DELETE /api/business/staff — owners only.
 *
 * Not in the spec's §8, which gives staff a role (§3) but no way to add them.
 * There is no invite flow: a person must have signed in once before an owner
 * can add them.
 */
export const businessStaffRouter = Router();

businessStaffRouter.use(requireOwner);

const { businessMembers, businessPushSubscriptions, users } = schema;

/**
 * Emails shown and matched here always come from Clerk, never users.email or
 * users.phone — those are whatever someone typed into PATCH /api/me.
 */
function verifiedPrimaryEmail(clerkUser: ClerkUser): string | null {
  const primary = clerkUser.primaryEmailAddress;
  return primary?.verification?.status === "verified" ? primary.emailAddress : null;
}

businessStaffRouter.get("/", async (req, res) => {
  const members = await getDb()
    .select({
      userId: users.id,
      clerkUserId: users.clerkUserId,
      name: users.name,
      role: businessMembers.role,
      addedAt: businessMembers.createdAt,
    })
    .from(businessMembers)
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(eq(businessMembers.businessId, currentBusiness(req).id))
    .orderBy(asc(businessMembers.createdAt));

  const { data: clerkUsers } = await clerkClient.users.getUserList({
    userId: members.map((member) => member.clerkUserId),
    limit: members.length,
  });
  const emailByClerkId = new Map(clerkUsers.map((u) => [u.id, verifiedPrimaryEmail(u)]));

  res.json({
    staff: members.map((member) => ({
      userId: member.userId,
      name: member.name,
      email: emailByClerkId.get(member.clerkUserId) ?? null,
      role: member.role,
      addedAt: member.addedAt,
    })),
  });
});

const AddStaffBody = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();

businessStaffRouter.post("/", async (req, res) => {
  const business = currentBusiness(req);
  const { email } = parse(AddStaffBody, req.body ?? {});
  const db = getDb();

  // Match only a *verified* Clerk address. Matching users.email would let
  // anyone put someone else's email on their own account and be added in
  // their place.
  const { data: candidates } = await clerkClient.users.getUserList({ emailAddress: [email] });
  const clerkUser = candidates.find((candidate) =>
    candidate.emailAddresses.some(
      (address) =>
        address.emailAddress.toLowerCase() === email &&
        address.verification?.status === "verified",
    ),
  );

  // One error for "no such account" and "never signed in", so an owner can't
  // use this endpoint to probe which emails have accounts.
  const [person] = clerkUser
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.clerkUserId, clerkUser.id))
        .limit(1)
    : [];
  if (!person) {
    throw new HttpError(
      404,
      "person_not_signed_in",
      "No one has signed in with that verified email yet. Ask them to sign in to the app once, then add them.",
    );
  }

  await db.transaction(async (tx) => {
    await assertNotInAnyBusiness(tx, person.id, "That person already belongs to a business");
    await tx
      .insert(businessMembers)
      .values({ businessId: business.id, userId: person.id, role: "staff" });
  });

  res.status(201).json({
    staff: { userId: person.id, name: person.name, email, role: "staff" },
  });
});

businessStaffRouter.delete("/:userId", async (req, res) => {
  const business = currentBusiness(req);
  const userId = uuidParam(req.params.userId);

  await getDb().transaction(async (tx) => {
    // Lock the owner rows so the last-owner check below can't race another removal.
    const owners = await tx
      .select({ userId: businessMembers.userId })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, business.id), eq(businessMembers.role, "owner")))
      .for("update");

    const [member] = await tx
      .select({ role: businessMembers.role })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, business.id), eq(businessMembers.userId, userId)))
      .limit(1);

    if (!member) {
      throw new HttpError(404, "member_not_found", "That person doesn't work at this business");
    }
    if (member.role === "owner" && owners.length <= 1) {
      throw new HttpError(409, "last_owner", "A business must keep at least one owner");
    }

    // So they stop getting this business's booking notifications.
    await tx
      .delete(businessPushSubscriptions)
      .where(
        and(
          eq(businessPushSubscriptions.businessId, business.id),
          eq(businessPushSubscriptions.userId, userId),
        ),
      );
    await tx
      .delete(businessMembers)
      .where(and(eq(businessMembers.businessId, business.id), eq(businessMembers.userId, userId)));
  });

  res.status(204).end();
});
