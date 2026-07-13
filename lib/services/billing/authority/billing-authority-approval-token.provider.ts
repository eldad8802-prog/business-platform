/**
 * AuthorityAccessTokenProvider — resolves a usable ITA access token for a
 * business+environment.
 *
 * Loads the connection, validates status, checks expiry, refreshes-before-use
 * when required (or when forceRefresh), reloads after refresh, and decrypts the
 * access token close to return. Returns an explicit Result; never throws for
 * business outcomes.
 *
 * Security: returns ONLY the access token (+ connectionId, expiry). It never
 * returns the refresh token, client secret, connection row, or encrypted
 * material, and never logs the token.
 *
 * NOTE: Concurrent refresh hardening (single-flight / lock) remains OUT OF
 * SCOPE for this PR — it is NOT solved here.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  BillingAuthorityTokenCryptoConfigError,
  decryptAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";
import {
  refreshAuthorityConnectionToken,
  type RefreshAuthorityConnectionTokenResult,
} from "@/lib/services/billing/authority/billing-authority-token-refresh.service";

export type AccessTokenErrorCode =
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_NOT_USABLE"
  | "TOKEN_MISSING"
  | "DECRYPTION_FAILED"
  | "ENCRYPTION_KEY_MISSING"
  | "TOKEN_REFRESH_FAILED"
  | "AUTHENTICATION";

export type AccessTokenResult =
  | {
      ok: true;
      accessToken: string;
      connectionId: number;
      accessTokenExpiresAt: Date | null;
    }
  | { ok: false; code: AccessTokenErrorCode; message: string };

/** Minimal connection projection needed for token use. Never carries refresh token. */
export type TokenConnectionRow = {
  id: number;
  status: BillingAuthorityConnectionStatus;
  accessTokenEncrypted: string | null;
  accessTokenIv: string | null;
  accessTokenTag: string | null;
  accessTokenExpiresAt: Date | null;
};

export type AccessTokenProviderDeps = {
  loadConnection: (
    businessId: number,
    environment: BillingAuthorityEnvironment
  ) => Promise<TokenConnectionRow | null>;
  decrypt: (
    stored: { encrypted: string; iv: string; tag: string },
    businessId: number,
    environment: BillingAuthorityEnvironment
  ) => string | null;
  refresh: (input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
  }) => Promise<RefreshAuthorityConnectionTokenResult>;
  now: () => Date;
  refreshSkewMs: number;
};

export const DEFAULT_REFRESH_SKEW_MS = 60_000;

const TOKEN_CONNECTION_SELECT = {
  id: true,
  status: true,
  accessTokenEncrypted: true,
  accessTokenIv: true,
  accessTokenTag: true,
  accessTokenExpiresAt: true,
} as const;

export const defaultAccessTokenProviderDeps: AccessTokenProviderDeps = {
  loadConnection: (businessId, environment) =>
    prisma.billingAuthorityConnection.findUnique({
      where: { businessId_environment: { businessId, environment } },
      select: TOKEN_CONNECTION_SELECT,
    }),
  decrypt: decryptAuthorityConnectionToken,
  refresh: (input) => refreshAuthorityConnectionToken(input),
  now: () => new Date(),
  refreshSkewMs: DEFAULT_REFRESH_SKEW_MS,
};

function isUsableStatus(status: BillingAuthorityConnectionStatus): boolean {
  return (
    status === BillingAuthorityConnectionStatus.CONNECTED ||
    status === BillingAuthorityConnectionStatus.VALIDATED
  );
}

function hasAccessToken(row: TokenConnectionRow): boolean {
  return Boolean(
    row.accessTokenEncrypted && row.accessTokenIv && row.accessTokenTag
  );
}

function decryptOrError(
  row: TokenConnectionRow,
  businessId: number,
  environment: BillingAuthorityEnvironment,
  deps: AccessTokenProviderDeps
): AccessTokenResult {
  let accessToken: string | null;
  try {
    accessToken = deps.decrypt(
      {
        encrypted: row.accessTokenEncrypted!,
        iv: row.accessTokenIv!,
        tag: row.accessTokenTag!,
      },
      businessId,
      environment
    );
  } catch (error) {
    if (error instanceof BillingAuthorityTokenCryptoConfigError) {
      return {
        ok: false,
        code: "ENCRYPTION_KEY_MISSING",
        message: "Authority encryption key is not configured",
      };
    }
    return {
      ok: false,
      code: "DECRYPTION_FAILED",
      message: "Authority access token could not be decrypted",
    };
  }
  if (!accessToken) {
    return {
      ok: false,
      code: "DECRYPTION_FAILED",
      message: "Authority access token could not be decrypted",
    };
  }
  return {
    ok: true,
    accessToken,
    connectionId: row.id,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

export async function resolveAccessToken(
  input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    forceRefresh?: boolean;
  },
  deps: AccessTokenProviderDeps = defaultAccessTokenProviderDeps
): Promise<AccessTokenResult> {
  let row = await deps.loadConnection(input.businessId, input.environment);
  if (!row) {
    return { ok: false, code: "CONNECTION_NOT_FOUND", message: "Authority connection not found" };
  }
  if (!isUsableStatus(row.status)) {
    return { ok: false, code: "CONNECTION_NOT_USABLE", message: "Authority connection is not usable" };
  }
  if (!hasAccessToken(row)) {
    return { ok: false, code: "TOKEN_MISSING", message: "Authority connection is missing an access token" };
  }

  const now = deps.now();
  const expiring =
    row.accessTokenExpiresAt != null &&
    row.accessTokenExpiresAt.getTime() <= now.getTime() + deps.refreshSkewMs;
  const needRefresh = input.forceRefresh === true || expiring;

  if (needRefresh) {
    const refreshResult = await deps.refresh({
      businessId: input.businessId,
      environment: input.environment,
    });
    if (!refreshResult.ok) {
      if (refreshResult.outcome === "AUTH_FAILURE") {
        return { ok: false, code: "AUTHENTICATION", message: "Authority rejected the token refresh" };
      }
      return { ok: false, code: "TOKEN_REFRESH_FAILED", message: "Authority token refresh failed" };
    }
    // Never trust the stale in-memory token: reload the refreshed connection.
    row = await deps.loadConnection(input.businessId, input.environment);
    if (!row) {
      return { ok: false, code: "CONNECTION_NOT_FOUND", message: "Authority connection not found after refresh" };
    }
    if (!hasAccessToken(row)) {
      return { ok: false, code: "TOKEN_MISSING", message: "Authority connection is missing an access token after refresh" };
    }
  }

  return decryptOrError(row, input.businessId, input.environment, deps);
}
