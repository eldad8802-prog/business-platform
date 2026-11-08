/**
 * Business documents — the canonical tenant transaction (lib/tenant/tenant-tx.ts) with what the quote share copy
 * needs on top. SERVER-ONLY.
 *   - repeatableRead: every statement of the transaction reads ONE snapshot (taken at the tenant GUC statement), so a
 *     quote and its lines are never read half before and half after a concurrent edit;
 *   - readOnly: SET TRANSACTION READ ONLY right after the GUC — a write inside is refused by the database itself,
 *     which is what "no write in the billing mechanism" is proven against.
 */
import { Prisma } from "@prisma/client";

import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";

export type BdTx = TenantTxClient;

export function bdTx<T>(
  businessId: number,
  fn: (tx: BdTx) => Promise<T>,
  options: { repeatableRead?: boolean; readOnly?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  return tenantTx(
    businessId,
    async (tx) => {
      if (options.readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx);
    },
    {
      ...(options.repeatableRead ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }
  );
}
