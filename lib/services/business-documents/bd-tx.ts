/**
 * Business documents — a tenant transaction with an explicit isolation level. SERVER-ONLY.
 *
 * Same contract as lib/tenant/tenant-tx.ts (a server-derived business, the transaction-local
 * app.current_business_id GUC as the first statement), plus what the quote share copy needs:
 *   - repeatableRead: every statement of the transaction reads ONE snapshot (taken at the GUC statement), so a
 *     quote and its lines are never read half before and half after a concurrent edit;
 *   - readOnly: SET TRANSACTION READ ONLY right after the GUC — a write inside is refused by the database itself,
 *     which is what "no write in the billing mechanism" is proven against.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type BdTx = Prisma.TransactionClient;

export function bdTx<T>(
  businessId: number,
  fn: (tx: BdTx) => Promise<T>,
  options: { repeatableRead?: boolean; readOnly?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("bdTx: a positive, server-derived businessId is required");
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      if (options.readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx);
    },
    {
      ...(options.repeatableRead ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    }
  );
}
