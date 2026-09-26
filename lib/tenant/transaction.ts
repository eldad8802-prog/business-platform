/**
 * D2 / P5-2 — Tenant Transaction Wrapper (Prisma context injection).
 *
 * Bridges the P5-1 tenant context (ALS `businessId`) to a PostgreSQL
 * transaction-local GUC so the RLS backstop proven in P2 receives a trusted
 * tenant context from the application.
 *
 *   ALS businessId
 *     -> getTenantContextOrThrow()   (fail-closed, no client-supplied tenant)
 *     -> canonical prisma.$transaction (interactive)
 *     -> SELECT set_config('app.current_business_id', $1, true)   (transaction-local)
 *     -> callback(tx)                 (all tenant queries run on tx)
 *
 * Design: an EXPLICIT helper, deliberately NOT a `$extends` per-operation hook —
 * a per-op hook would (a) re-enter itself on the set_config query (recursion),
 * (b) force a transaction per query, and (c) collide with the existing
 * `$transaction` callsites. The explicit helper opens ONE interactive
 * transaction, sets the GUC as its first statement, and hands `tx` to the
 * caller. It does NOT modify the canonical singleton (`lib/prisma.ts`), add an
 * adapter, or change the datasource.
 *
 * Scope note (P5-2): this helper opens a top-level tenant transaction. Do NOT
 * nest it inside another interactive `$transaction`; pass the provided `tx`
 * down instead. Active-transaction reuse/propagation is a later increment.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { getTenantContextOrThrow } from "./context";
import { ADVISORY_NAMESPACE, assertTenantTxAcceptsWrites } from "./business-lifecycle";
import { holdsErasureAuthority } from "./erasure-authority";

/** The Prisma interactive-transaction client handed to the callback. */
export type TenantTx = Prisma.TransactionClient;

/**
 * SEC-E — nesting is refused LOUDLY. A withTenantTransaction called from inside another
 * one's callback used to open a SECOND interactive transaction on another pooled
 * connection, silently: its writes committed even when the outer one rolled back, and
 * under connection_limit=1 it waited on itself until the timeout. The rule was only a
 * comment ("do NOT nest; pass the tx down"); now it is enforced. The marker is closed in
 * a finally, so work merely scheduled from inside a transaction and run after it ended
 * is not mistaken for nesting.
 */
export class TenantTransactionNestingError extends Error {
  constructor() {
    super("withTenantTransaction called inside an open tenant transaction — pass the tx down instead of opening a second one");
    this.name = "TenantTransactionNestingError";
  }
}
const openTenantTx = new AsyncLocalStorage<{ open: boolean }>();

/**
 * Run `fn` inside an interactive transaction whose transaction-local GUC
 * `app.current_business_id` is set to the ALS-derived tenant BEFORE any query.
 * Fail-closed: throws (before opening the transaction) when no tenant context
 * is in scope. On callback error the transaction rolls back and the GUC — being
 * transaction-local — never persists on the pooled connection.
 */
export async function withTenantTransaction<T>(
  fn: (tx: TenantTx) => Promise<T>,
  options?: {
    /**
     * Interactive-transaction timeout override (ms). Only for operations that
     * legitimately hold non-DB I/O inside the tenant transaction (e.g. an
     * attachment upload writing object storage between tenant-scoped queries).
     * Defaults to Prisma's standard interactive-transaction timeout.
     */
    timeoutMs?: number;
  },
): Promise<T> {
  // Read the trusted, server-derived tenant BEFORE opening a transaction.
  const { businessId } = getTenantContextOrThrow();
  if (openTenantTx.getStore()?.open) {
    throw new TenantTransactionNestingError();
  }

  // SEC-E / M-12(c): decided BEFORE the transaction opens, from the ALS capability that
  // only `runTenantJob with the erasure quarantine policy` grants.
  const erasure = holdsErasureAuthority(businessId);

  return prisma.$transaction(
    async (tx) => {
      // Transaction-local (is_local = true). Parameterized — never string-interpolated.
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      if (!erasure) {
        // The SHARED lifecycle lock, taken before any tenant statement runs, so a
        // quarantine can never commit between "this transaction started" and "this
        // transaction checked the lifecycle". The quarantine takes it EXCLUSIVE.
        // The erasure worker skips both: it acts ON a quarantined business by design,
        // and its own finalisation takes this key exclusive.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(${ADVISORY_NAMESPACE}::int, ${businessId}::int)`;
        // NEW statement, new snapshot: fail closed for a business under erasure.
        await assertTenantTxAcceptsWrites(tx, businessId);
      }
      const marker = { open: true };
      try {
        return await openTenantTx.run(marker, () => fn(tx));
      } finally {
        marker.open = false;
      }
    },
    options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
  );
}
