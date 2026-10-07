/**
 * Who is a business's ACCOUNT OWNER — the user who opened it.
 *
 * Dubiz has no business-role model: signup creates a Business and exactly one
 * User, and there are no invitations. "Owner" is therefore not a new concept to
 * store but a fact already in the data: the business's first user. Resolved
 * from the database on every money-out action, never from a request, a token
 * claim or a client hint.
 *
 * `User` is not a tenant (RLS) table; the read is constrained to the actor's
 * own business by its predicate.
 */

import { prisma } from "@/lib/prisma";

export async function isBusinessAccountOwner(user: {
  id: number;
  businessId: number;
}): Promise<boolean> {
  if (!Number.isInteger(user.id) || user.id <= 0) return false;
  if (!Number.isInteger(user.businessId) || user.businessId <= 0) return false;
  const first = await prisma.user.findFirst({
    where: { businessId: user.businessId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return first?.id === user.id;
}
