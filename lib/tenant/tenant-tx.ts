/**
 * D2 — the canonical "re-assert the tenant, then open a tenant transaction" entry
 * point for ordinary request handlers and services.
 *
 * WHY THIS EXISTS
 * `withTenantTransaction` only works under an ambient `runWithTenantContext`. A lot
 * of tenant-owned code is not running under one: route handlers derive a trusted
 * `businessId` from the session and then read straight off the global Prisma client.
 * Today that works, because Production connects as an owner role that bypasses RLS.
 * Under the restricted runtime it would NOT fail loudly — a context-less SELECT
 * matches zero rows and returns an empty array, so "this tenant has data" silently
 * becomes "this tenant has no data". Writes do raise; reads do not. That asymmetry
 * is why this helper exists and why the fix cannot wait for the cutover.
 *
 * This is the generalisation of `billingTenantTx`, which proved the shape in
 * W4E-B-2; Billing now delegates here so there is one implementation, not two.
 *
 * The `businessId` passed in MUST be server-derived (session, verified provider
 * mapping, or an already-trusted service input). Never a request body, a query
 * parameter, a route id on its own, or anything an external caller controls.
 */
import type { Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export type TenantTxClient = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction that carries `app.current_business_id`.
 *
 * Re-asserting the context rather than requiring an ambient one is deliberate:
 * these callers run from routes, from post-commit hooks and from background paths,
 * and a helper that only worked under an ambient context would break in exactly the
 * places that are hardest to notice.
 */
export function tenantTx<T>(
  businessId: number,
  fn: (tx: TenantTxClient) => Promise<T>
): Promise<T> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    // Fail loud. A tenant transaction with no trusted tenant must never run:
    // falling back to a context-less transaction is the defect this removes.
    throw new Error("tenantTx: a positive, server-derived businessId is required");
  }
  return runWithTenantContext({ businessId }, () => withTenantTransaction(fn));
}
