/**
 * Authority token refresh runtime (D.2.7).
 *
 * Exchanges encrypted refresh tokens for new access tokens via ITA OAuth.
 * On auth failure moves connections to AUTHORIZATION_REQUIRED. Network failures
 * do not mutate connection state.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { assertActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import type { AuthorityConnectionEncryptedTokenFields } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  AUTHORITY_CONNECTION_ENCRYPTION_KEY_ID,
  buildAuthorityOAuthBasicAuthHeader,
  resolveTokenExpiryDate,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import {
  decryptAuthorityAppSecret,
  decryptAuthorityConnectionToken,
  encryptAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";
import {
  markAuthorityTokenRefreshed,
  markAuthorityTokenRefreshFailed,
  sanitizeAuthorityConnectionErrorMessage,
} from "@/lib/services/billing/authority/billing-authority-connection.service";

export const AUTHORITY_REFRESH_ERROR_CODES = {
  NOT_REFRESHABLE: "AUTHORITY_CONNECTION_NOT_REFRESHABLE",
  TOKEN_DECRYPT_FAILED: "TOKEN_DECRYPT_FAILED",
  EXCHANGE_FAILED: "AUTHORITY_TOKEN_REFRESH_EXCHANGE_FAILED",
  RESPONSE_INVALID: "AUTHORITY_TOKEN_REFRESH_RESPONSE_INVALID",
  AUTH_REJECTED: "ITA_REFRESH_REJECTED",
  INVALID_CLIENT: "ITA_INVALID_CLIENT",
  UPSTREAM_ERROR: "ITA_UPSTREAM_ERROR",
  REFRESH_TIMEOUT: "ITA_REFRESH_TIMEOUT",
  CONFIGURATION_ERROR: "AUTHORITY_REFRESH_CONFIG_ERROR",
  APP_UNAVAILABLE: "AUTHORITY_REFRESH_APP_UNAVAILABLE",
} as const;

export const DEFAULT_AUTHORITY_TOKEN_REFRESH_TIMEOUT_MS = 15_000;

export type AuthorityRefreshOutcome =
  | "REFRESHED"
  | "AUTH_FAILURE"
  | "NETWORK_FAILURE"
  | "CONFIGURATION_FAILURE";

export type RefreshAuthorityConnectionTokenInput = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  actorUserId?: number | null;
  fetchImpl?: typeof fetch;
  refreshTimeoutMs?: number;
};

export type RefreshAuthorityConnectionTokenResult = {
  ok: boolean;
  refreshed: boolean;
  refreshTimestamp: Date;
  outcome: AuthorityRefreshOutcome;
  errorCode?: string;
  errorMessage?: string;
};

export type AuthorityRefreshTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
};

type RefreshableConnectionRow = Prisma.BillingAuthorityConnectionGetPayload<{
  select: {
    id: true;
    businessId: true;
    environment: true;
    status: true;
    accessTokenEncrypted: true;
    accessTokenIv: true;
    accessTokenTag: true;
    refreshTokenEncrypted: true;
    refreshTokenIv: true;
    refreshTokenTag: true;
    encryptionKeyId: true;
  };
}>;

const OAUTH_AUTH_FAILURE_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "access_denied",
  "invalid_client",
]);

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function isRefreshableConnectionStatus(
  status: BillingAuthorityConnectionStatus
): boolean {
  return (
    status === BillingAuthorityConnectionStatus.CONNECTED ||
    status === BillingAuthorityConnectionStatus.VALIDATED
  );
}

function hasEncryptedRefreshToken(row: RefreshableConnectionRow): boolean {
  return (
    typeof row.refreshTokenEncrypted === "string" &&
    row.refreshTokenEncrypted.length > 0 &&
    typeof row.refreshTokenIv === "string" &&
    row.refreshTokenIv.length > 0 &&
    typeof row.refreshTokenTag === "string" &&
    row.refreshTokenTag.length > 0
  );
}

export function assessAuthorityConnectionRefreshability(
  row: RefreshableConnectionRow | null
):
  | { ok: true; connection: RefreshableConnectionRow }
  | { ok: false; errorCode: string; errorMessage: string } {
  if (!row) {
    return {
      ok: false,
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.NOT_REFRESHABLE,
      errorMessage: "Authority connection not found",
    };
  }

  if (!isRefreshableConnectionStatus(row.status)) {
    return {
      ok: false,
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.NOT_REFRESHABLE,
      errorMessage: `Authority connection status ${row.status} is not refreshable`,
    };
  }

  if (!hasEncryptedRefreshToken(row)) {
    return {
      ok: false,
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.NOT_REFRESHABLE,
      errorMessage: "Authority connection is missing encrypted refresh token",
    };
  }

  return { ok: true, connection: row };
}

export function classifyAuthorityRefreshHttpStatus(
  status: number
): AuthorityRefreshOutcome {
  if (status === 401 || status === 403) {
    return "AUTH_FAILURE";
  }
  if (status >= 500) {
    return "NETWORK_FAILURE";
  }
  if (status >= 400 && status < 500) {
    return "AUTH_FAILURE";
  }
  return "NETWORK_FAILURE";
}

export function classifyAuthorityRefreshOAuthError(
  error: string | undefined
): { outcome: AuthorityRefreshOutcome; errorCode: string } {
  const normalized = error?.trim().toLowerCase();
  if (normalized === "invalid_client") {
    return {
      outcome: "AUTH_FAILURE",
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.INVALID_CLIENT,
    };
  }
  if (normalized && OAUTH_AUTH_FAILURE_ERRORS.has(normalized)) {
    return {
      outcome: "AUTH_FAILURE",
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.AUTH_REJECTED,
    };
  }
  return {
    outcome: "AUTH_FAILURE",
    errorCode: AUTHORITY_REFRESH_ERROR_CODES.AUTH_REJECTED,
  };
}

function configurationFailureResult(
  refreshTimestamp: Date,
  errorCode: string,
  errorMessage: string
): RefreshAuthorityConnectionTokenResult {
  return {
    ok: false,
    refreshed: false,
    refreshTimestamp,
    outcome: "CONFIGURATION_FAILURE",
    errorCode,
    errorMessage: sanitizeAuthorityConnectionErrorMessage(errorMessage),
  };
}

function networkFailureResult(
  refreshTimestamp: Date,
  errorCode: string,
  errorMessage: string
): RefreshAuthorityConnectionTokenResult {
  return {
    ok: false,
    refreshed: false,
    refreshTimestamp,
    outcome: "NETWORK_FAILURE",
    errorCode,
    errorMessage: sanitizeAuthorityConnectionErrorMessage(errorMessage),
  };
}

function buildRefreshedTokenFields(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  existing: RefreshableConnectionRow;
  accessToken: string;
  refreshToken?: string;
}): AuthorityConnectionEncryptedTokenFields {
  const access = encryptAuthorityConnectionToken(
    input.accessToken,
    input.businessId,
    input.environment
  );

  if (typeof input.refreshToken === "string" && input.refreshToken.length > 0) {
    const refresh = encryptAuthorityConnectionToken(
      input.refreshToken,
      input.businessId,
      input.environment
    );
    return {
      accessTokenEncrypted: access.encrypted,
      accessTokenIv: access.iv,
      accessTokenTag: access.tag,
      refreshTokenEncrypted: refresh.encrypted,
      refreshTokenIv: refresh.iv,
      refreshTokenTag: refresh.tag,
      encryptionKeyId: AUTHORITY_CONNECTION_ENCRYPTION_KEY_ID,
    };
  }

  return {
    accessTokenEncrypted: access.encrypted,
    accessTokenIv: access.iv,
    accessTokenTag: access.tag,
    refreshTokenEncrypted: input.existing.refreshTokenEncrypted!,
    refreshTokenIv: input.existing.refreshTokenIv!,
    refreshTokenTag: input.existing.refreshTokenTag!,
    encryptionKeyId:
      input.existing.encryptionKeyId ?? AUTHORITY_CONNECTION_ENCRYPTION_KEY_ID,
  };
}

async function loadRefreshableAuthorityConnection(
  businessId: number,
  environment: BillingAuthorityEnvironment
): Promise<RefreshableConnectionRow | null> {
  return prisma.billingAuthorityConnection.findUnique({
    where: {
      businessId_environment: { businessId, environment },
    },
    select: {
      id: true,
      businessId: true,
      environment: true,
      status: true,
      accessTokenEncrypted: true,
      accessTokenIv: true,
      accessTokenTag: true,
      refreshTokenEncrypted: true,
      refreshTokenIv: true,
      refreshTokenTag: true,
      encryptionKeyId: true,
    },
  });
}

async function loadAuthorityAppCredentials(
  environment: BillingAuthorityEnvironment
): Promise<{ clientId: string; clientSecret: string }> {
  const row = await prisma.billingAuthorityApp.findUnique({
    where: { environment },
  });
  const active = assertActiveAuthorityApp(row);
  const clientSecret = decryptAuthorityAppSecret(
    {
      encrypted: active.clientSecretEncrypted!,
      iv: active.clientSecretIv!,
      tag: active.clientSecretTag!,
    },
    environment
  );

  if (!clientSecret) {
    throw new ServiceUnavailableError(
      "Tax authority platform app client secret could not be decrypted"
    );
  }

  return {
    clientId: active.itaClientId,
    clientSecret,
  };
}

export async function exchangeAuthorityRefreshToken(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  refreshTimeoutMs?: number;
}): Promise<{
  outcome: AuthorityRefreshOutcome;
  response?: AuthorityRefreshTokenResponse;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
}> {
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs =
    input.refreshTimeoutMs ?? DEFAULT_AUTHORITY_TOKEN_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });

  try {
    const response = await fetchFn(input.tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: buildAuthorityOAuthBasicAuthHeader(
          input.clientId,
          input.clientSecret
        ),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: unknown = null;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (!response.ok) {
          return {
            outcome: classifyAuthorityRefreshHttpStatus(response.status),
            httpStatus: response.status,
            errorCode: AUTHORITY_REFRESH_ERROR_CODES.EXCHANGE_FAILED,
            errorMessage: "Authority token refresh response was not valid JSON",
          };
        }
        return {
          outcome: "CONFIGURATION_FAILURE",
          httpStatus: response.status,
          errorCode: AUTHORITY_REFRESH_ERROR_CODES.RESPONSE_INVALID,
          errorMessage: "Authority token refresh response was not valid JSON",
        };
      }
    }

    if (!response.ok) {
      const oauthError = parsed as { error?: string; error_description?: string };
      const classified = classifyAuthorityRefreshOAuthError(oauthError.error);
      const outcome =
        response.status >= 500
          ? "NETWORK_FAILURE"
          : classified.outcome === "AUTH_FAILURE"
            ? "AUTH_FAILURE"
            : classifyAuthorityRefreshHttpStatus(response.status);

      if (outcome === "NETWORK_FAILURE") {
        return {
          outcome,
          httpStatus: response.status,
          errorCode: AUTHORITY_REFRESH_ERROR_CODES.UPSTREAM_ERROR,
          errorMessage: "Authority token refresh upstream error",
        };
      }

      return {
        outcome: "AUTH_FAILURE",
        httpStatus: response.status,
        errorCode: classified.errorCode,
        errorMessage: sanitizeAuthorityConnectionErrorMessage(
          oauthError.error_description?.trim() ||
            oauthError.error ||
            "Authority token refresh was rejected"
        ),
      };
    }

    const tokenResponse = parsed as Partial<AuthorityRefreshTokenResponse>;
    if (
      typeof tokenResponse.access_token !== "string" ||
      tokenResponse.access_token.length === 0
    ) {
      return {
        outcome: "CONFIGURATION_FAILURE",
        httpStatus: response.status,
        errorCode: AUTHORITY_REFRESH_ERROR_CODES.RESPONSE_INVALID,
        errorMessage: "Authority token refresh response is missing access_token",
      };
    }

    return {
      outcome: "REFRESHED",
      httpStatus: response.status,
      response: {
        access_token: tokenResponse.access_token,
        refresh_token:
          typeof tokenResponse.refresh_token === "string"
            ? tokenResponse.refresh_token
            : undefined,
        expires_in:
          typeof tokenResponse.expires_in === "number"
            ? tokenResponse.expires_in
            : undefined,
        refresh_expires_in:
          typeof tokenResponse.refresh_expires_in === "number"
            ? tokenResponse.refresh_expires_in
            : undefined,
        token_type:
          typeof tokenResponse.token_type === "string"
            ? tokenResponse.token_type
            : undefined,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        outcome: "NETWORK_FAILURE",
        errorCode: AUTHORITY_REFRESH_ERROR_CODES.REFRESH_TIMEOUT,
        errorMessage: "Authority token refresh timed out",
      };
    }

    return {
      outcome: "NETWORK_FAILURE",
      errorCode: AUTHORITY_REFRESH_ERROR_CODES.UPSTREAM_ERROR,
      errorMessage: sanitizeAuthorityConnectionErrorMessage(
        error instanceof Error ? error.message : "Authority token refresh failed"
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Refreshes authority OAuth tokens using the stored encrypted refresh token.
 */
export async function refreshAuthorityConnectionToken(
  input: RefreshAuthorityConnectionTokenInput
): Promise<RefreshAuthorityConnectionTokenResult> {
  assertPositiveInteger(input.businessId, "businessId");

  const refreshTimestamp = new Date();
  const row = await loadRefreshableAuthorityConnection(
    input.businessId,
    input.environment
  );
  const refreshability = assessAuthorityConnectionRefreshability(row);
  if (!refreshability.ok) {
    return configurationFailureResult(
      refreshTimestamp,
      refreshability.errorCode,
      refreshability.errorMessage
    );
  }

  const refreshToken = decryptAuthorityConnectionToken(
    {
      encrypted: refreshability.connection.refreshTokenEncrypted!,
      iv: refreshability.connection.refreshTokenIv!,
      tag: refreshability.connection.refreshTokenTag!,
    },
    input.businessId,
    input.environment
  );

  if (!refreshToken) {
    return configurationFailureResult(
      refreshTimestamp,
      AUTHORITY_REFRESH_ERROR_CODES.TOKEN_DECRYPT_FAILED,
      "Authority refresh token could not be decrypted"
    );
  }

  let tokenEndpoint: string;
  let credentials: { clientId: string; clientSecret: string };
  try {
    const envConfig = resolveAuthorityEnvConfig(input.environment);
    tokenEndpoint = buildAuthorityOAuthTokenUrl(envConfig);
    credentials = await loadAuthorityAppCredentials(input.environment);
  } catch (error) {
    const errorCode =
      error instanceof ServiceUnavailableError
        ? AUTHORITY_REFRESH_ERROR_CODES.APP_UNAVAILABLE
        : AUTHORITY_REFRESH_ERROR_CODES.CONFIGURATION_ERROR;
    const message =
      error instanceof Error
        ? error.message
        : "Authority token refresh configuration is unavailable";
    return configurationFailureResult(refreshTimestamp, errorCode, message);
  }

  const exchange = await exchangeAuthorityRefreshToken({
    tokenEndpoint,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken,
    fetchImpl: input.fetchImpl,
    refreshTimeoutMs: input.refreshTimeoutMs,
  });

  if (exchange.outcome === "NETWORK_FAILURE") {
    return networkFailureResult(
      refreshTimestamp,
      exchange.errorCode ?? AUTHORITY_REFRESH_ERROR_CODES.UPSTREAM_ERROR,
      exchange.errorMessage ?? "Authority token refresh failed"
    );
  }

  if (exchange.outcome === "CONFIGURATION_FAILURE") {
    return configurationFailureResult(
      refreshTimestamp,
      exchange.errorCode ?? AUTHORITY_REFRESH_ERROR_CODES.RESPONSE_INVALID,
      exchange.errorMessage ?? "Authority token refresh response was invalid"
    );
  }

  if (exchange.outcome === "AUTH_FAILURE") {
    await markAuthorityTokenRefreshFailed({
      businessId: input.businessId,
      environment: input.environment,
      actorUserId: input.actorUserId,
      errorCode:
        exchange.errorCode ?? AUTHORITY_REFRESH_ERROR_CODES.AUTH_REJECTED,
      errorMessage:
        exchange.errorMessage ?? "Authority token refresh was rejected",
      refreshAttemptAt: refreshTimestamp,
    });

    return {
      ok: false,
      refreshed: false,
      refreshTimestamp,
      outcome: "AUTH_FAILURE",
      errorCode: exchange.errorCode,
      errorMessage: exchange.errorMessage,
    };
  }

  const tokenResponse = exchange.response!;
  const refreshTokenRotated =
    typeof tokenResponse.refresh_token === "string" &&
    tokenResponse.refresh_token.length > 0;
  const encryptedTokens = buildRefreshedTokenFields({
    businessId: input.businessId,
    environment: input.environment,
    existing: refreshability.connection,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
  });

  await markAuthorityTokenRefreshed({
    businessId: input.businessId,
    environment: input.environment,
    actorUserId: input.actorUserId,
    tokens: encryptedTokens,
    refreshedAt: refreshTimestamp,
    accessTokenExpiresAt: resolveTokenExpiryDate(tokenResponse.expires_in),
    refreshTokenExpiresAt: resolveTokenExpiryDate(tokenResponse.refresh_expires_in),
    refreshTokenRotated,
  });

  return {
    ok: true,
    refreshed: true,
    refreshTimestamp,
    outcome: "REFRESHED",
  };
}
