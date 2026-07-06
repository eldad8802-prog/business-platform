import { prisma } from "@/lib/prisma";

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
 * EmailAttachmentImport history are intentionally preserved — disconnect is a
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

  const existing = await prisma.emailConnection.findFirst({
    where: { id: connectionId, businessId, provider: "gmail" },
    select: { id: true },
  });
  if (!existing) return null;

  // Delete the token first (deleteMany is a no-op if none exists), then revoke
  // the connection. The row and import history stay intact.
  await prisma.oAuthToken.deleteMany({ where: { connectionId: existing.id } });

  const updated = await prisma.emailConnection.update({
    where: { id: existing.id },
    data: { status: "revoked", lastError: null },
    select: { id: true, emailAddress: true, status: true },
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
  const conn = await prisma.emailConnection.findFirst({
    where: { id: connectionId, businessId, provider: "gmail" },
    select: { id: true },
  });
  return Boolean(conn);
}
