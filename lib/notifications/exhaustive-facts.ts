/**
 * Exhaustiveness — the difference between "not on the list" and "not true".
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Resolution used to be inferred from absence: any open notification whose key
 * was missing from the current snapshot was marked resolved. That is sound only
 * if the snapshot enumerates EVERY currently-true fact. The business-status
 * loaders do not — they are presentation queries with per-domain caps, because
 * Attention is a shortlist, not a register.
 *
 * So with thirteen conversations genuinely waiting and a cap of twelve, the
 * thirteenth was absent, and its notification was closed as though the customer
 * had been answered. The ranking is newest-first, which means the one silently
 * dropped was the person who had been waiting longest. The feature's whole
 * purpose, inverted, on the worst possible case.
 *
 * A UI may legitimately say "the twelve most pressing things". A persistence
 * engine may never conclude from that "the thirteenth was handled".
 *
 * WHAT THIS MODULE DOES
 *
 * It makes the claim explicit and greppable. A key set cannot reach the
 * absence-resolver unless someone has written `declareExhaustive` over it, so
 * the assumption is a named line of code rather than an invisible property of
 * whichever loader happened to be nearby.
 *
 * It is a guard rail, not a proof: `declareExhaustive` cannot verify the claim,
 * and a caller could still hand it a capped list. What it buys is that every
 * such claim is in one place, enumerable by a test, and impossible to make by
 * accident. The wiring test asserts the only callers are the selectors below.
 *
 * WHERE ABSENCE IS THE WRONG TOOL ENTIRELY
 *
 * When the caller already knows which entity changed, absence is not needed:
 * ask whether THAT entity still satisfies the condition and resolve it alone.
 * The inbox consumer does exactly that. This module serves the case where the
 * caller genuinely does not know — an inventory movement can touch several
 * items at once — and there the full set has to be cheap enough to enumerate.
 */
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

declare const EXHAUSTIVE: unique symbol;

/**
 * A set of dedupe keys asserted to cover every currently-true fact in its
 * scope. The brand is unforgeable outside `declareExhaustive`, so a plain
 * `string[]` from a capped loader cannot be passed to the resolver by mistake.
 */
export type ExhaustiveFactKeys = {
  readonly keys: readonly string[];
  readonly [EXHAUSTIVE]: true;
};

/**
 * Assert that `keys` enumerates every currently-true fact in its scope.
 *
 * Call this ONLY over an uncapped, unfiltered, unpaginated query result. If you
 * are looking at anything with a `take`, a `limit`, a slice, a top-N sort or a
 * time window, the honest answer is that you do not have an exhaustive set —
 * resolve the specific entity you changed instead.
 */
export function declareExhaustive(keys: readonly string[]): ExhaustiveFactKeys {
  // The brand is a compile-time-only symbol — `declare const` emits nothing —
  // so it must NOT be written into the object. Doing that threw a
  // ReferenceError at runtime, which the inventory integration run found the
  // first time this was called for real. The cast is the whole mechanism: the
  // shape carries only `keys`, and the brand exists solely in the type.
  return { keys } as unknown as ExhaustiveFactKeys;
}

async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() === undefined) {
    throw new Error(
      "exhaustive fact selectors require a tenant context — wrap the call in runWithTenantContext({ businessId })",
    );
  }
  return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
}

/** The three columns the inventory translator needs to derive an identity. */
export type InventoryAlertIdentity = {
  id: number;
  type: string;
  itemId: number | null;
};

/**
 * EVERY unresolved inventory alert for a business. No cap.
 *
 * This is the same predicate `loadInventoryAlertsUnresolved` uses, minus its
 * `take` and minus every column that exists only to render a card. Three
 * integers per row, covered by the existing `(businessId, isResolved)` index,
 * and bounded in practice by how many alerts a business can have open at once —
 * a number the inventory domain already caps by only ever holding one open
 * alert per item and type.
 *
 * No new index, and nothing here is presentation: if this ever needs a `take`,
 * that is the moment to stop resolving from absence, not the moment to add one.
 */
export async function loadAllUnresolvedInventoryAlertIdentities(
  businessId: number,
): Promise<InventoryAlertIdentity[]> {
  return dbStep((db) =>
    db.inventoryAlert.findMany({
      where: { businessId, isResolved: false },
      select: { id: true, type: true, itemId: true },
    }),
  );
}
