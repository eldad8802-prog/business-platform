/**
 * Authority connection status read model (D.2.9).
 *
 * Provides a single operational view of authority connection state for UI,
 * submission gates, monitoring, and support. Read-only — no mutations.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { findPublicAuthorityConnection } from "@/lib/services/billing/authority/billing-authority-connection.service";
import type { PublicAuthorityConnection } from "@/lib/services/billing/authority/billing-authority-connection.types";

export type AuthorityConnectionStatusInput = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
};

export type AuthorityConnectionDerivedFlags = {
  /**
   * Encrypted credential material is inferred to exist at rest — not "currently
   * usable". Derived from D.2.3 lifecycle invariants (`oauthAuthorizedAt` set on
   * OAuth completion, cleared on revoke). Does not read ciphertext or check expiry.
   */
  hasAccessToken: boolean;
  /** Same semantics as `hasAccessToken` — both are written and cleared together. */
  hasRefreshToken: boolean;
  isConnected: boolean;
  isValidated: boolean;
  requiresAuthorization: boolean;
  isRevoked: boolean;
  isReadyForSubmission: boolean;
};

export type AuthorityConnectionStatus = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  connectionExists: boolean;
  status: BillingAuthorityConnectionStatus;
  oauthAuthorizedAt: Date | null;
  oauthAuthorizedByUserId: number | null;
  lastValidatedAt: Date | null;
  lastTokenRefreshAt: Date | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  revokedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
} & AuthorityConnectionDerivedFlags;

const SECRET_FIELD_NAMES = [
  "accessTokenEncrypted",
  "accessTokenIv",
  "accessTokenTag",
  "refreshTokenEncrypted",
  "refreshTokenIv",
  "refreshTokenTag",
  "encryptionKeyId",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "authorization",
  "bearerToken",
] as const;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

/**
 * Derives token-presence and lifecycle flags from public connection fields.
 *
 * `hasAccessToken` / `hasRefreshToken` mean **credential persisted at rest**
 * (operational inference), not "token currently usable". Usability for ITA calls
 * depends on status, expiry, and runtime refresh — use `isReadyForSubmission`
 * for the conservative submission gate.
 *
 * Inference (no ciphertext read): OAuth completed (`oauthAuthorizedAt` set) and
 * status is not REVOKED or DISCONNECTED. Matches D.2.3 — revoke clears both
 * `oauthAuthorizedAt` and ciphertext; refresh failure keeps both.
 */
export function deriveAuthorityConnectionFlags(input: {
  status: BillingAuthorityConnectionStatus;
  oauthAuthorizedAt: Date | null;
}): AuthorityConnectionDerivedFlags {
  const isRevoked = input.status === BillingAuthorityConnectionStatus.REVOKED;
  const isValidated = input.status === BillingAuthorityConnectionStatus.VALIDATED;
  const isConnected =
    input.status === BillingAuthorityConnectionStatus.CONNECTED || isValidated;

  const hasCredentialLifecycle =
    input.oauthAuthorizedAt != null &&
    !Number.isNaN(input.oauthAuthorizedAt.getTime()) &&
    input.status !== BillingAuthorityConnectionStatus.REVOKED &&
    input.status !== BillingAuthorityConnectionStatus.DISCONNECTED;

  const hasAccessToken = hasCredentialLifecycle;
  const hasRefreshToken = hasCredentialLifecycle;

  const requiresAuthorization =
    input.status === BillingAuthorityConnectionStatus.DISCONNECTED ||
    input.status === BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED ||
    input.status === BillingAuthorityConnectionStatus.REVOKED ||
    input.status === BillingAuthorityConnectionStatus.ERROR;

  const isReadyForSubmission =
    isValidated &&
    !isRevoked &&
    hasAccessToken &&
    hasRefreshToken;

  return {
    hasAccessToken,
    hasRefreshToken,
    isConnected,
    isValidated,
    requiresAuthorization,
    isRevoked,
    isReadyForSubmission,
  };
}

function buildStatusFromPublicConnection(
  connection: PublicAuthorityConnection
): AuthorityConnectionStatus {
  const flags = deriveAuthorityConnectionFlags({
    status: connection.status,
    oauthAuthorizedAt: connection.oauthAuthorizedAt,
  });

  return {
    businessId: connection.businessId,
    environment: connection.environment,
    connectionExists: true,
    status: connection.status,
    oauthAuthorizedAt: connection.oauthAuthorizedAt,
    oauthAuthorizedByUserId: connection.oauthAuthorizedByUserId,
    lastValidatedAt: connection.lastValidatedAt,
    lastTokenRefreshAt: connection.lastTokenRefreshAt,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    revokedAt: connection.revokedAt,
    lastErrorCode: connection.lastErrorCode,
    lastErrorMessage: connection.lastErrorMessage,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    ...flags,
  };
}

function buildAbsentConnectionStatus(
  businessId: number,
  environment: BillingAuthorityEnvironment
): AuthorityConnectionStatus {
  const flags = deriveAuthorityConnectionFlags({
    status: BillingAuthorityConnectionStatus.DISCONNECTED,
    oauthAuthorizedAt: null,
  });

  return {
    businessId,
    environment,
    connectionExists: false,
    status: BillingAuthorityConnectionStatus.DISCONNECTED,
    oauthAuthorizedAt: null,
    oauthAuthorizedByUserId: null,
    lastValidatedAt: null,
    lastTokenRefreshAt: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    revokedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: null,
    updatedAt: null,
    ...flags,
  };
}

/** Ensures a status payload never exposes secret material keys. */
export function assertAuthorityConnectionStatusIsPublic(
  status: AuthorityConnectionStatus
): void {
  for (const key of SECRET_FIELD_NAMES) {
    if (key in (status as Record<string, unknown>)) {
      throw new Error(`Authority connection status must not expose ${key}`);
    }
  }
}

/**
 * Returns the operational authority connection status for a business/environment.
 */
export async function getAuthorityConnectionStatus(
  input: AuthorityConnectionStatusInput
): Promise<AuthorityConnectionStatus> {
  assertPositiveInteger(input.businessId, "businessId");

  const connection = await findPublicAuthorityConnection(
    input.businessId,
    input.environment
  );

  const status = connection
    ? buildStatusFromPublicConnection(connection)
    : buildAbsentConnectionStatus(input.businessId, input.environment);

  assertAuthorityConnectionStatusIsPublic(status);
  return status;
}
