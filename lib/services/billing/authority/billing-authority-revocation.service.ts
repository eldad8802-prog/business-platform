/**
 * Authority connection revocation runtime (D.2.8).
 *
 * Safely disconnects authority connections by delegating credential cleanup
 * and lifecycle transitions to the D.2.3 connection service.
 */

import { BillingAuthorityConnectionStatus, BillingAuthorityEnvironment } from "@prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  findPublicAuthorityConnection,
  revokeAuthorityConnection as executeAuthorityConnectionRevoke,
} from "@/lib/services/billing/authority/billing-authority-connection.service";

export const AUTHORITY_REVOCATION_ERROR_CODES = {
  CONNECTION_NOT_FOUND: "AUTHORITY_CONNECTION_NOT_FOUND",
} as const;

export type RevokeAuthorityConnectionInput = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  actorUserId?: number | null;
  reason?: string | null;
  revokedAt?: Date;
};

export type RevokeAuthorityConnectionResult = {
  ok: boolean;
  revoked: boolean;
  revokedAt: Date;
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function resolveRevokedAt(
  connectionRevokedAt: Date | null | undefined,
  fallback: Date
): Date {
  if (connectionRevokedAt && !Number.isNaN(connectionRevokedAt.getTime())) {
    return connectionRevokedAt;
  }
  return fallback;
}

/**
 * Revokes an authority connection, clearing stored credentials and preventing
 * future API usage until re-authorization.
 */
export async function revokeAuthorityConnection(
  input: RevokeAuthorityConnectionInput
): Promise<RevokeAuthorityConnectionResult> {
  assertPositiveInteger(input.businessId, "businessId");

  const revokedAt = input.revokedAt ?? new Date();
  if (Number.isNaN(revokedAt.getTime())) {
    throw new ValidationError("revokedAt must be a valid Date");
  }

  const existing = await findPublicAuthorityConnection(
    input.businessId,
    input.environment
  );
  if (!existing) {
    throw new NotFoundError("Authority connection not found");
  }

  const transition = await executeAuthorityConnectionRevoke({
    businessId: input.businessId,
    environment: input.environment,
    actorUserId: input.actorUserId ?? null,
    reason: input.reason ?? null,
    occurredAt: revokedAt,
  });

  const effectiveRevokedAt = resolveRevokedAt(
    transition.connection.revokedAt,
    revokedAt
  );

  return {
    ok: true,
    revoked: transition.toStatus === BillingAuthorityConnectionStatus.REVOKED,
    revokedAt: effectiveRevokedAt,
  };
}
