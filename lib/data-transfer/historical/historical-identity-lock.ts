/**
 * Mutual exclusion on one business's copy of one historical fiscal identity.
 *
 * # Why a lock, and not a unique index
 *
 * The obvious fix for "two executions both see no duplicate and both insert" is
 * a unique index on the fiscal identity. It is deliberately unavailable here,
 * and for a reason recorded back in I-8A: a corrected re-export, a numberless
 * document, and two prior systems both numbering an invoice 1001 are all
 * legitimate, and a database rule would turn each of them into an import
 * failure the owner cannot resolve. The owner's explicit CREATE_ANYWAY is a
 * decision they are entitled to make.
 *
 * So mutual exclusion is taken explicitly, with the same transaction-scoped
 * advisory lock this codebase already uses for the business lifecycle and for
 * document content. It needs no table privilege, releases at transaction end —
 * including on rollback — and it SERIALISES without FORBIDDING. An explicit
 * override still creates its second record; an accidental race cannot.
 *
 * # Why the revalidation must live inside the lock
 *
 * A duplicate check in its own transaction is a snapshot, not a guarantee. Two
 * executions of the same file could both read "nothing exists" and both insert.
 * Under this lock the second one waits, and then reads a world that already
 * contains the first one's record — which is exactly when its approved CREATE
 * stops being legal and the run must say so rather than quietly proceed.
 */

import { createHash } from "node:crypto";
import type { TenantTx } from "@/lib/tenant/transaction";
import type { FiscalIdentity } from "@/lib/data-transfer/historical/historical-duplicates";

/**
 * Advisory namespace for historical fiscal identity locks.
 *
 * Its own namespace, so these never serialise against the business lifecycle
 * lock ('AD') or document content ('DC'), which share the same two-integer lock
 * space. 'HF' for historical fiscal.
 */
export const HISTORICAL_IDENTITY_ADVISORY_NAMESPACE = 0x48_46;

/**
 * The lock key for one business's copy of one fiscal identity.
 *
 * The tenant AND the whole identity go into the key, so two businesses holding
 * the same document number never wait on each other. The key is a 32-bit fold,
 * so distinct pairs can collide — that costs a little serialisation and can
 * never cost correctness, because the query taken under the lock is still
 * scoped by businessId and by the full identity.
 */
export function historicalIdentityLockKey(
  businessId: number,
  identity: FiscalIdentity
): number {
  const digest = createHash("sha256")
    .update(
      [
        businessId,
        identity.sourceSystemCode,
        identity.documentTypeCode,
        identity.originalDocumentNumber,
        // Joined on a separator no fiscal field can contain, written as an
        // escape rather than as a raw byte: a literal NUL in the source makes
        // the file binary to git, and the firewall reads these files as text.
      ].join("\u0000")
    )
    .digest();
  // Signed 32-bit, because that is what `pg_advisory_xact_lock(int, int)` takes.
  return digest.readInt32BE(0);
}

/**
 * Take the lock for this identity, inside the caller's transaction.
 *
 * Every path that may INSERT a historical record takes it, including one acting
 * on an explicit override — an override means "create a second record on
 * purpose", not "skip the serialisation that makes the count reliable".
 */
export async function lockHistoricalIdentity(
  tx: TenantTx,
  businessId: number,
  identity: FiscalIdentity
): Promise<void> {
  const key = historicalIdentityLockKey(businessId, identity);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HISTORICAL_IDENTITY_ADVISORY_NAMESPACE}::int, ${key}::int)`;
}
