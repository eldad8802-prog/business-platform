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
import { tenantTx } from "@/lib/tenant/tenant-tx";

/**
 * CUTOVER-2A: the shape proven here has been promoted to the canonical `tenantTx`
 * helper, so this delegates rather than carrying a second copy of the same logic —
 * one implementation, one place for the fail-loud guard. The name is kept because
 * Billing's call sites read better with it and it marks the domain boundary.
 */
export function billingTenantTx<T>(
  businessId: number,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return tenantTx(businessId, fn);
}
