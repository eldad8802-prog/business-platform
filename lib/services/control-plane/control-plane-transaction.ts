/**
 * D2 / PRIVILEGED-WRITE-2 — the ONLY sanctioned control-plane write primitive.
 *
 * It is the exact analogue of `lib/tenant/transaction.ts`, but for the narrow
 * privileged writer instead of the tenant runtime:
 *
 *   authorized PLATFORM_ADMIN (route boundary, CI-3)
 *     → server-resolved targetBusinessId
 *       → runTenantJob({ businessId: targetBusinessId })     (explicit, validated)
 *         → control-plane client interactive transaction
 *           → SELECT set_config('app.current_business_id', $1, true)
 *             → callback(tx)   — mutation AND audit, one connection, one tx
 *
 * Why the GUC matters here even though the caller is already privileged: the
 * `p7pw2_ctl_insert` / `p7pw2_ctl_update` policies are written against it, so a
 * write can only ever land on the business this transaction explicitly named.
 * An application bug that loses a `where` clause, or that passes the wrong id
 * to a nested query, cannot reach a second tenant — the database rejects it.
 * Possession of the control-plane credential alone permits nothing.
 *
 * Invariants:
 *  - `targetBusinessId` is REQUIRED and validated; it must be resolved
 *    server-side from an authorized platform-admin action, never accepted as a
 *    body/query authority (the route selector is an input, not an authority —
 *    authorization happens before this helper is ever called).
 *  - No silent tenant switch: `runTenantJob` refuses to enter a second tenant
 *    while another context is established.
 *  - The tenant Prisma singleton is NEVER used inside a control-plane
 *    transaction — this module deliberately does not import it, and CI enforces
 *    that for the whole `lib/services/control-plane/**` tree.
 *  - No nested transactions, no `Promise.all` sharing `tx` across independent
 *    statements, and no network I/O inside the transaction.
 *  - DB role is NOT proof of actor identity. This helper establishes a target,
 *    not an actor; actor authorization is and remains the route's job.
 */
import type { Prisma } from "@prisma/client";
import { getPrismaControlPlane } from "@/lib/prisma-control-plane";
import { getTenantContextOrThrow } from "@/lib/tenant/context";
import { runTenantJob } from "@/lib/tenant/job";

/** The interactive-transaction client handed to the callback. */
export type ControlPlaneTx = Prisma.TransactionClient;

/** Thrown for control-plane contract violations. Carries no sensitive data. */
export class ControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/**
 * Run `fn` inside a control-plane transaction whose transaction-local GUC
 * `app.current_business_id` is set to `targetBusinessId` BEFORE any query.
 *
 * Fail-closed: an invalid target throws before any connection is opened; a
 * missing `CONTROL_PLANE_DATABASE_URL` throws at client construction. On
 * callback error the transaction rolls back and the GUC — being
 * transaction-local — never persists on the pooled connection.
 */
export async function withControlPlaneTransaction<T>(
  targetBusinessId: number,
  fn: (tx: ControlPlaneTx) => Promise<T>
): Promise<T> {
  if (
    typeof targetBusinessId !== "number" ||
    !Number.isInteger(targetBusinessId) ||
    targetBusinessId <= 0
  ) {
    throw new ControlPlaneError(
      "withControlPlaneTransaction requires a positive integer targetBusinessId"
    );
  }

  return runTenantJob({ businessId: targetBusinessId }, async () => {
    // Re-read from the established context rather than trusting the argument
    // twice: if anything ever wraps this call in a different context,
    // runTenantJob has already refused, so these two values cannot diverge.
    const { businessId } = getTenantContextOrThrow();
    const client = getPrismaControlPlane();

    return client.$transaction(async (tx) => {
      // Transaction-local (is_local = true). Parameterized — never interpolated.
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(
        businessId
      )}, true)`;
      return fn(tx);
    });
  });
}

/**
 * Assert that a privileged write actually affected rows.
 *
 * Under FORCE RLS a write with a missing or wrong tenant context affects ZERO
 * rows *silently*. Left unchecked that produces the worst possible outcome: a
 * committed success audit describing a mutation that never happened. Every
 * control-plane mutation must pass its affected-row count through here.
 */
export function assertAffected(count: number, operation: string): void {
  if (count < 1) {
    throw new ControlPlaneError(
      `control-plane ${operation} affected 0 rows — refusing to record a success audit`
    );
  }
}
