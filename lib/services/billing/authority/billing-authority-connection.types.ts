import type {
  BillingAuthorityAppStatus,
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";

/** Resolved ITA host configuration for one authority environment. */
export type AuthorityEnvConfig = {
  environment: BillingAuthorityEnvironment;
  oauthBase: string;
  apiBase: string;
  oauthPathSegment: string;
  redirectBaseUrl: string;
  /** Fully qualified OAuth callback registered with ITA. */
  redirectUri: string;
};

/**
 * Safe platform-app context for runtime callers. Never includes client secret
 * or decrypted credentials.
 */
export type AuthorityAppContext = {
  id: number;
  environment: BillingAuthorityEnvironment;
  status: Extract<BillingAuthorityAppStatus, "ACTIVE">;
  accountingSoftwareNumber: string;
  itaClientId: string;
  portalOrganizationId: string | null;
  portalApplicationId: string | null;
  registeredAt: Date | null;
  lastValidatedAt: Date | null;
};

/**
 * Public read model for per-business authority connections. Safe for HTTP APIs.
 * Token ciphertext columns are intentionally omitted.
 */
export type PublicAuthorityConnection = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  status: BillingAuthorityConnectionStatus;
  oauthAuthorizedAt: Date | null;
  oauthAuthorizedByUserId: number | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  lastTokenRefreshAt: Date | null;
  lastValidatedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const BILLING_AUTHORITY_OAUTH_CALLBACK_PATH =
  "/api/billing/authority/callback" as const;

/** Pre-encrypted token material written by OAuth callback (D.2.5+). */
export type AuthorityConnectionEncryptedTokenFields = {
  accessTokenEncrypted: string;
  accessTokenIv: string;
  accessTokenTag: string;
  refreshTokenEncrypted: string;
  refreshTokenIv: string;
  refreshTokenTag: string;
  encryptionKeyId: string;
};
