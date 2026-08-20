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
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { getTenantContextOrThrow } from "./context";

/** The Prisma interactive-transaction client handed to the callback. */
export type TenantTx = Prisma.TransactionClient;

/**
 * Run `fn` inside an interactive transaction whose transaction-local GUC
 * `app.current_business_id` is set to the ALS-derived tenant BEFORE any query.
 * Fail-closed: throws (before opening the transaction) when no tenant context
 * is in scope. On callback error the transaction rolls back and the GUC — being
 * transaction-local — never persists on the pooled connection.
 */
export async function withTenantTransaction<T>(
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  // Read the trusted, server-derived tenant BEFORE opening a transaction.
  const { businessId } = getTenantContextOrThrow();

  return prisma.$transaction(async (tx) => {
    // Transaction-local (is_local = true). Parameterized — never string-interpolated.
    await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
    return fn(tx);
  });
}
