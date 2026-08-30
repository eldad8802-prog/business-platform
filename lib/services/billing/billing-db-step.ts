/**
 * D2 / P7-W4E-B-2 — context-aware single DB step for Billing reads.
 *
 * The counterpart to `billingTenantTx`: that helper is for work that must be
 * one atomic unit and always carries an explicit tenant; this one is for the
 * standalone reads scattered through the Billing services. Under an
 * established tenant context the read runs on a short tenant transaction so
 * FORCE RLS can see the GUC; with no context it runs directly, which is the
 * path pure unit tests and offline scripts take.
 *
 * There is deliberately NO global fallback under an established context: a read
 * that silently returns zero rows is the failure mode this whole programme
 * exists to remove, and it is invisible in exactly the places that matter.
 */
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function billingDbStep<T>(
  fn: (db: typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    // TransactionClient supports the query surface these callbacks use; the
    // cast preserves precise select/include payload types, which a union of
    // client types would collapse.
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
