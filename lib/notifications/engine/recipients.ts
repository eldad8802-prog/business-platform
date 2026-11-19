/**
 * WHO may receive a notification of a business — the ONE place that decides it (notifications track spec).
 *
 * Today every User has exactly one business and there is no roles / membership model (UserRole is USER |
 * PLATFORM_ADMIN), so "the authorised users of a business" = every user whose businessId is that business, and
 * `canUserSee` is true. A future roles model plugs in HERE and nowhere else. No role is invented.
 */
import type { Prisma } from "@prisma/client";

import type { CategoryDefinition } from "../catalog";

type Tx = Prisma.TransactionClient;

/** May this user see a notification of this category? (No roles model yet: yes.) */
export function canUserSee(_user: { id: number; businessId: number }, _cat: CategoryDefinition | null): boolean {
  return true;
}

/**
 * The users an owed push of a business goes to: the notification's own user when it names one (and that user is
 * still the business's), else every user of the business. Inside the business's tenant transaction.
 */
export async function recipientUsers(
  tx: Tx,
  businessId: number,
  cat: CategoryDefinition | null,
  notificationUserId: number | null,
): Promise<number[]> {
  const users = await tx.user.findMany({
    where: { businessId, ...(notificationUserId !== null ? { id: notificationUserId } : {}) },
    select: { id: true, businessId: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  return users.filter((u) => canUserSee(u, cat)).map((u) => u.id);
}
