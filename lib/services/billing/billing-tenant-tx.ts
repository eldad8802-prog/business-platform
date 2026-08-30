/**
 * D2 / P7-W4E-B — the canonical tenant transaction entry point for Billing.
 *
 * Billing's services are already shaped as `xxxTx(tx, input)` primitives with
 * thin `prisma.$transaction((tx) => xxxTx(tx, input))` wrappers. Under FORCE
 * RLS those bare wrappers open a transaction with NO `app.current_business_id`
 * GUC, so every statement inside them is filtered to zero rows — reads return
 * nothing and writes are refused, silently in the read case. This helper is the
 * one-line replacement: it re-asserts the tenant context from the caller's own
 * server-derived businessId and then opens the tenant transaction.
 *
 * Re-asserting (rather than relying on an ambient context) is deliberate: these
 * services are called from routes, from post-commit hooks, and from background
 * paths, and a helper that only works under an ambient context would fail in
 * exactly the paths that are hardest to notice.
 */
import type { Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export function billingTenantTx<T>(
  businessId: number,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    // Fail loud: a billing transaction with no trusted tenant must never run.
    // Silently falling back to a context-less transaction is what W4E-B exists
    // to remove.
    throw new Error(
      "billingTenantTx: a positive, server-derived businessId is required"
    );
  }
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => fn(tx))
  );
}
