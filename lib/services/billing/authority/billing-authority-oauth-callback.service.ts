/**
 * Authority OAuth callback and token exchange (D.2.5).
 *
 * Validates OAuth state cookies, exchanges authorization codes with ITA,
 * encrypts tokens, and transitions connections to CONNECTED. No validation
 * probe or token refresh.
 */

import { timingSafeEqual } from "node:crypto";
import { BillingAuthorityEnvironment } from "@prisma/client";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  assertActiveAuthorityApp,
} from "@/lib/services/billing/authority/billing-authority-app.service";
import {
  markAuthorityConnected,
  markAuthorityOAuthFailed,
  sanitizeAuthorityConnectionErrorMessage,
  type AuthorityConnectionTransitionResult,
} from "@/lib/services/billing/authority/billing-authority-connection.service";
import type {
  AuthorityConnectionEncryptedTokenFields,
  PublicAuthorityConnection,
} from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  AUTHORITY_OAUTH_COOKIE_NAMES,
  buildRedirectUriFromBase,
  ITA_OAUTH_SCOPE,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import {
  decryptAuthorityAppSecret,
  encryptAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

export const AUTHORITY_CONNECTION_ENCRYPTION_KEY_ID = "authority_gcm_v1" as const;

export const AUTHORITY_OAUTH_CALLBACK_ERROR_CODES = {
  STATE_MISMATCH: "AUTHORITY_OAUTH_STATE_MISMATCH",
  MISSING_COOKIE: "AUTHORITY_OAUTH_MISSING_COOKIE",
  MISSING_CODE: "AUTHORITY_OAUTH_MISSING_CODE",
  ITA_ERROR: "AUTHORITY_OAUTH_ITA_ERROR",
  TOKEN_EXCHANGE_FAILED: "AUTHORITY_OAUTH_TOKEN_EXCHANGE_FAILED",
  TOKEN_RESPONSE_INVALID: "AUTHORITY_OAUTH_TOKEN_RESPONSE_INVALID",
  APP_UNAVAILABLE: "AUTHORITY_OAUTH_APP_UNAVAILABLE",
} as const;

export type AuthorityOAuthCallbackQuery = {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
};

export type AuthorityOAuthCallbackCookies = {
  state?: string | null;
  businessId?: string | null;
  environment?: string | null;
};

export type AuthorityOAuthCookieClearSpec = {
  name: string;
  value: "";
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: 0;
};

export type HandleAuthorityOAuthCallbackInput = {
  query: AuthorityOAuthCallbackQuery;
  cookies: AuthorityOAuthCallbackCookies;
  redirectBaseUrl: string;
  actorUserId: number;
  secureCookies?: boolean;
  fetchImpl?: typeof fetch;
};

export type HandleAuthorityOAuthCallbackSuccess = {
  ok: true;
  connection: PublicAuthorityConnection;
  clearedCookies: AuthorityOAuthCookieClearSpec[];
};

export type HandleAuthorityOAuthCallbackFailure = {
  ok: false;
  errorCode: string;
  errorMessage: string;
  connection?: PublicAuthorityConnection;
  /** True when markAuthorityOAuthFailed completed and wrote OAUTH_FAILED audit. */
  oauthFailureRecorded: boolean;
  clearedCookies: AuthorityOAuthCookieClearSpec[];
};

export type HandleAuthorityOAuthCallbackResult =
  | HandleAuthorityOAuthCallbackSuccess
  | HandleAuthorityOAuthCallbackFailure;

export type AuthorityTokenExchangeResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

export type ParsedAuthorityOAuthCallbackContext = {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  queryState: string;
  cookieState: string;
  code: string;
};

type AuthorityAppCredentials = {
  clientId: string;
  clientSecret: string;
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function parseEnvironmentCookie(
  raw: string | undefined | null
): BillingAuthorityEnvironment | null {
  const normalized = raw?.trim().toUpperCase();
  if (normalized === "SANDBOX") return BillingAuthorityEnvironment.SANDBOX;
  if (normalized === "PRODUCTION") return BillingAuthorityEnvironment.PRODUCTION;
  return null;
}

function parseBusinessIdCookie(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const businessId = Number(raw);
  if (!Number.isInteger(businessId) || businessId <= 0) return null;
  return businessId;
}

export function statesMatch(cookieState: string, queryState: string): boolean {
  const a = Buffer.from(cookieState, "utf8");
  const b = Buffer.from(queryState, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildAuthorityOAuthBasicAuthHeader(
  clientId: string,
  clientSecret: string
): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

export function buildAuthorityOAuthCookieClearSpecs(input?: {
  secureCookies?: boolean;
}): AuthorityOAuthCookieClearSpec[] {
  const secure = input?.secureCookies ?? process.env.NODE_ENV === "production";
  const base = {
    value: "" as const,
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure,
    path: "/" as const,
    maxAge: 0 as const,
  };

  return [
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.STATE, ...base },
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.BUSINESS_ID, ...base },
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.ENVIRONMENT, ...base },
  ];
}

export function parseAuthorityOAuthCallbackCookies(
  cookies: AuthorityOAuthCallbackCookies
): {
  businessId: number | null;
  environment: BillingAuthorityEnvironment | null;
  cookieState: string | null;
} {
  return {
    businessId: parseBusinessIdCookie(cookies.businessId),
    environment: parseEnvironmentCookie(cookies.environment),
    cookieState: cookies.state?.trim() || null,
  };
}

export function validateAuthorityOAuthCallbackContext(input: {
  query: AuthorityOAuthCallbackQuery;
  cookies: AuthorityOAuthCallbackCookies;
}):
  | { ok: true; context: ParsedAuthorityOAuthCallbackContext }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      businessId?: number;
      environment?: BillingAuthorityEnvironment;
    } {
  const parsedCookies = parseAuthorityOAuthCallbackCookies(input.cookies);

  if (input.query.error) {
    const description = sanitizeAuthorityConnectionErrorMessage(
      input.query.errorDescription?.trim() || input.query.error
    );
    return {
      ok: false,
      errorCode: AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.ITA_ERROR,
      errorMessage: description,
      businessId: parsedCookies.businessId ?? undefined,
      environment: parsedCookies.environment ?? undefined,
    };
  }

  if (
    !parsedCookies.cookieState ||
    parsedCookies.businessId == null ||
    !parsedCookies.environment
  ) {
    return {
      ok: false,
      errorCode: AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_COOKIE,
      errorMessage: "OAuth callback cookies are missing or invalid",
      businessId: parsedCookies.businessId ?? undefined,
      environment: parsedCookies.environment ?? undefined,
    };
  }

  const queryState = input.query.state?.trim() || "";
  const code = input.query.code?.trim() || "";

  if (!queryState || !code) {
    return {
      ok: false,
      errorCode: code
        ? AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_COOKIE
        : AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_CODE,
      errorMessage: code
        ? "OAuth callback state is missing"
        : "OAuth authorization code is missing",
      businessId: parsedCookies.businessId,
      environment: parsedCookies.environment,
    };
  }

  if (!statesMatch(parsedCookies.cookieState, queryState)) {
    return {
      ok: false,
      errorCode: AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.STATE_MISMATCH,
      errorMessage: "OAuth callback state does not match",
      businessId: parsedCookies.businessId,
      environment: parsedCookies.environment,
    };
  }

  return {
    ok: true,
    context: {
      businessId: parsedCookies.businessId,
      environment: parsedCookies.environment,
      cookieState: parsedCookies.cookieState,
      queryState,
      code,
    },
  };
}

async function loadAuthorityAppCredentials(
  environment: BillingAuthorityEnvironment
): Promise<AuthorityAppCredentials> {
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

export function encryptAuthorityOAuthTokens(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  accessToken: string;
  refreshToken: string;
}): AuthorityConnectionEncryptedTokenFields {
  const access = encryptAuthorityConnectionToken(
    input.accessToken,
    input.businessId,
    input.environment
  );
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

export function resolveTokenExpiryDate(expiresIn: unknown): Date | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  return new Date(Date.now() + expiresIn * 1000);
}

export async function exchangeAuthorityAuthorizationCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<AuthorityTokenExchangeResponse> {
  const fetchFn = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    scope: ITA_OAUTH_SCOPE,
  });

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
  });

  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    throw new ValidationError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED
    );
  }

  if (!response.ok) {
    throw new ValidationError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED
    );
  }

  const tokenResponse = parsed as Partial<AuthorityTokenExchangeResponse>;
  if (
    typeof tokenResponse.access_token !== "string" ||
    tokenResponse.access_token.length === 0
  ) {
    throw new ValidationError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_RESPONSE_INVALID
    );
  }

  return {
    access_token: tokenResponse.access_token,
    refresh_token:
      typeof tokenResponse.refresh_token === "string"
        ? tokenResponse.refresh_token
        : undefined,
    expires_in:
      typeof tokenResponse.expires_in === "number"
        ? tokenResponse.expires_in
        : undefined,
    token_type:
      typeof tokenResponse.token_type === "string"
        ? tokenResponse.token_type
        : undefined,
  };
}

async function recordOAuthCallbackFailure(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  actorUserId?: number | null;
  errorCode: string;
  errorMessage: string;
}): Promise<AuthorityConnectionTransitionResult | null> {
  try {
    return await markAuthorityOAuthFailed({
      businessId: input.businessId,
      environment: input.environment,
      actorUserId: input.actorUserId ?? null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  } catch {
    return null;
  }
}

/**
 * Handles the ITA OAuth callback: validates state, exchanges the code,
 * encrypts tokens, and marks the connection CONNECTED.
 */
export async function handleAuthorityOAuthCallback(
  input: HandleAuthorityOAuthCallbackInput
): Promise<HandleAuthorityOAuthCallbackResult> {
  assertPositiveInteger(input.actorUserId, "actorUserId");

  const redirectBaseUrl = normalizeBaseUrl(input.redirectBaseUrl);
  if (!redirectBaseUrl) {
    throw new ValidationError("redirectBaseUrl is required");
  }

  const clearedCookies = buildAuthorityOAuthCookieClearSpecs({
    secureCookies: input.secureCookies,
  });

  const validation = validateAuthorityOAuthCallbackContext({
    query: input.query,
    cookies: input.cookies,
  });

  if (!validation.ok) {
    const failureTransition =
      validation.businessId != null && validation.environment != null
        ? await recordOAuthCallbackFailure({
            businessId: validation.businessId,
            environment: validation.environment,
            actorUserId: input.actorUserId,
            errorCode: validation.errorCode,
            errorMessage: validation.errorMessage,
          })
        : null;

    return {
      ok: false,
      errorCode: validation.errorCode,
      errorMessage: validation.errorMessage,
      connection: failureTransition?.connection,
      oauthFailureRecorded: failureTransition?.auditWritten ?? false,
      clearedCookies,
    };
  }

  const { context } = validation;

  try {
    const envConfig = resolveAuthorityEnvConfig(context.environment);
    const tokenEndpoint = buildAuthorityOAuthTokenUrl(envConfig);
    const redirectUri = buildRedirectUriFromBase(redirectBaseUrl);
    const credentials = await loadAuthorityAppCredentials(context.environment);

    const tokenResponse = await exchangeAuthorityAuthorizationCode({
      tokenEndpoint,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      code: context.code,
      redirectUri,
      fetchImpl: input.fetchImpl,
    });

    if (
      typeof tokenResponse.refresh_token !== "string" ||
      tokenResponse.refresh_token.length === 0
    ) {
      throw new ValidationError(
        AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_RESPONSE_INVALID
      );
    }

    const encryptedTokens = encryptAuthorityOAuthTokens({
      businessId: context.businessId,
      environment: context.environment,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
    });

    const connected = await markAuthorityConnected({
      businessId: context.businessId,
      environment: context.environment,
      actorUserId: input.actorUserId,
      tokens: encryptedTokens,
      accessTokenExpiresAt: resolveTokenExpiryDate(tokenResponse.expires_in),
      refreshTokenExpiresAt: null,
      oauthAuthorizedAt: new Date(),
    });

    return {
      ok: true,
      connection: connected.connection,
      clearedCookies,
    };
  } catch (error) {
    const errorCode =
      error instanceof ServiceUnavailableError
        ? AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.APP_UNAVAILABLE
        : error instanceof ValidationError &&
            Object.values(AUTHORITY_OAUTH_CALLBACK_ERROR_CODES).includes(
              error.message as (typeof AUTHORITY_OAUTH_CALLBACK_ERROR_CODES)[keyof typeof AUTHORITY_OAUTH_CALLBACK_ERROR_CODES]
            )
          ? error.message
          : AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED;

    const errorMessage = sanitizeAuthorityConnectionErrorMessage(
      error instanceof Error ? error.message : "OAuth callback failed"
    );

    const failureTransition = await recordOAuthCallbackFailure({
      businessId: context.businessId,
      environment: context.environment,
      actorUserId: input.actorUserId,
      errorCode: errorCode.slice(0, 64),
      errorMessage,
    });

    return {
      ok: false,
      errorCode,
      errorMessage,
      connection: failureTransition?.connection,
      oauthFailureRecorded: failureTransition?.auditWritten ?? false,
      clearedCookies,
    };
  }
}
