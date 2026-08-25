import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4C: run a single DB step on a short tenant transaction when a tenant
// context is established (all Gmail routes set one); outside a context the
// step runs directly (pure unit tests). Under an established context there is
// NO fallback to the global client. External Google calls NEVER run inside.
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}
import { decryptToken } from "./token-crypto.placeholder";
import { revokeGoogleGmailToken } from "./gmail-token-revoke.service";

export type DisconnectedGmailConnection = {
  id: number;
  emailAddress: string;
  status: string;
};

/**
* Owner-initiated disconnect of a single Gmail connection.
*
* Flips the connection's status to `revoked` and deletes its OAuthToken so the
* access/refresh tokens cannot be used again. The EmailConnection row and its
* EmailAttachmentImport history are intentionally preserved - disconnect is a
* revocation, not a deletion.
*
* Scoped by `businessId`, so a caller can only disconnect their own business's
* connection. Returns `null` when no matching connection exists (idempotent).
*/
export async function disconnectGmailConnection(params: {
  businessId: number;
  connectionId: number;
}): Promise<DisconnectedGmailConnection | null> {
  const { businessId, connectionId } = params;
  if (!Number.isInteger(connectionId) || connectionId <= 0) return null;

const existing = await dbStep((db) => db.emailConnection.findFirst({
  where: { id: connectionId, businessId, provider: "gmail" },
  select: { id: true },
}));
  if (!existing) return null;

// Best-effort revoke with Google before deleting our local copy. Prefer the
// refresh token (Google revokes the whole grant from either token - see
// gmail-token-revoke.service.ts), falling back to the access token. Any
// failure here is swallowed: it must never block or fail the local
// disconnect below, which is unchanged.
const tokenRow = await dbStep((db) => db.oAuthToken.findUnique({
  where: { connectionId: existing.id },
  select: { accessTokenEncrypted: true, refreshTokenEncrypted: true },
}));
  if (tokenRow) {
    const tokenToRevoke =
      decryptToken(tokenRow.refreshTokenEncrypted) ??
      decryptToken(tokenRow.accessTokenEncrypted);
    await revokeGoogleGmailToken(tokenToRevoke);
  }

// Delete the token first (deleteMany is a no-op if none exists), then revoke
// the connection. The row and import history stay intact.
// One atomic tenant transaction for the local disconnect (AFTER the external
// revoke attempt): token delete + tenant-scoped connection transition — the
// connection update carries the businessId predicate, no id-only mutation.
const updated = await dbStep(async (db) => {
  await db.oAuthToken.deleteMany({ where: { connectionId: existing.id } });
  await db.emailConnection.updateMany({
    where: { id: existing.id, businessId },
    data: { status: "revoked", lastError: null },
  });
  return db.emailConnection.findFirst({
    where: { id: existing.id, businessId },
    select: { id: true, emailAddress: true, status: true },
  });
});

return updated;
}

/**
* Ownership guard: true iff `connectionId` is a Gmail connection that belongs to
* `businessId`. Used by sync/import to validate a caller-supplied connectionId
* before selecting an account, so one business can never scan/import from
* another business's connection.
*/
export async function isGmailConnectionOwnedByBusiness(params: {
  businessId: number;
  connectionId: number;
}): Promise<boolean> {
  const { businessId, connectionId } = params;
  if (!Number.isInteger(connectionId) || connectionId <= 0) return false;
  const conn = await dbStep((db) => db.emailConnection.findFirst({
    where: { id: connectionId, businessId, provider: "gmail" },
    select: { id: true },
  }));
  return Boolean(conn);
}
