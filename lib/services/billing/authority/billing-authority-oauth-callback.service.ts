/**
 * Authority OAuth callback and token exchange (D.2.5).
 *
 * Validates OAuth state cookies, exchanges authorization codes with ITA,
 * encrypts tokens, and transitions connections to CONNECTED. No validation
 * probe or token refresh.
 */

import { timingSafeEqual } from "node:crypto";
import { verifySignedAuthorityState } from "./billing-authority-signed-state.service";
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
  // Kept for backward compatibility: network / pre-response / unparseable-on-2xx
  // failures of the token exchange (no successful provider response was read).
  TOKEN_EXCHANGE_FAILED: "AUTHORITY_OAUTH_TOKEN_EXCHANGE_FAILED",
  // The provider (ITA) token endpoint answered with a non-2xx status.
  TOKEN_EXCHANGE_REJECTED: "AUTHORITY_OAUTH_TOKEN_EXCHANGE_REJECTED",
  TOKEN_RESPONSE_INVALID: "AUTHORITY_OAUTH_TOKEN_RESPONSE_INVALID",
  // Local, post-exchange failures — previously masked as TOKEN_EXCHANGE_FAILED.
  TOKEN_ENCRYPTION_FAILED: "AUTHORITY_OAUTH_TOKEN_ENCRYPTION_FAILED",
  CONNECTION_PERSIST_FAILED: "AUTHORITY_OAUTH_CONNECTION_PERSIST_FAILED",
  APP_UNAVAILABLE: "AUTHORITY_OAUTH_APP_UNAVAILABLE",
} as const;

/**
 * Closed allowlist of OAuth 2.0 error codes we are willing to persist from a
 * provider token response. Anything outside this set collapses to "unknown".
 * We never persist `error_description` or any other provider field.
 */
export const AUTHORITY_OAUTH_PROVIDER_ERROR_ALLOWLIST = [
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "temporarily_unavailable",
  "server_error",
  "access_denied",
] as const;

export type AuthorityOAuthProviderError =
  | (typeof AUTHORITY_OAUTH_PROVIDER_ERROR_ALLOWLIST)[number]
  | "unknown";

export type AuthorityOAuthResponseFormat =
  | "JSON"
  | "NON_JSON"
  | "EMPTY"
  | "NETWORK_ERROR";

/**
 * Coarse, sanitized class of a network-level fetch failure (no response). Derived
 * ONLY from safe technical codes (error.name / error.code / error.cause.code) —
 * never from the raw message, host, IP, URL, or stack.
 */
export type AuthorityOAuthNetworkErrorClass =
  | "DNS_ERROR"
  | "CONNECT_TIMEOUT"
  | "REQUEST_TIMEOUT"
  | "CONNECTION_REFUSED"
  | "CONNECTION_RESET"
  | "TLS_ERROR"
  | "CERTIFICATE_ERROR"
  | "ABORTED"
  | "FETCH_ERROR"
  | "OTHER";

/** Coarse request-duration bucket (avoids persisting a precise timing). */
export type AuthorityOAuthDurationBucket =
  | "<1s"
  | "1-5s"
  | "5-15s"
  | "15-30s"
  | "30s+";

export type AuthorityOAuthFailureStage =
  | "PROVIDER_ERROR"
  | "STATE_VALIDATION"
  | "APP_CONFIGURATION"
  | "TOKEN_EXCHANGE"
  | "TOKEN_RESPONSE"
  | "TOKEN_ENCRYPTION"
  | "CONNECTION_PERSISTENCE";

/**
 * Sanitized diagnostics attached to a callback failure. Contains ONLY a coarse
 * stage, the provider HTTP status, an allowlisted OAuth error enum, and a
 * response-format tag — never tokens, code, state, secrets, or free text.
 */
export type AuthorityOAuthFailureDiagnostics = {
  stage: AuthorityOAuthFailureStage;
  providerHttpStatus?: number | null;
  providerOAuthError?: AuthorityOAuthProviderError | null;
  providerResponseFormat?: AuthorityOAuthResponseFormat | null;
  /** Set only for a NETWORK_ERROR (fetch threw before any response). */
  networkErrorClass?: AuthorityOAuthNetworkErrorClass | null;
  /** Coarse duration of the failed request, when measured. */
  requestDurationBucket?: AuthorityOAuthDurationBucket | null;
};

/**
 * Internal callback failure carrying a safe internal error code plus sanitized
 * diagnostics. The Error `message` is set to the internal code ONLY — never a
 * provider body, error_description, URL, token, or any sensitive text.
 */
export class AuthorityOAuthCallbackError extends Error {
  readonly errorCode: string;
  readonly diagnostics: AuthorityOAuthFailureDiagnostics;

  constructor(errorCode: string, diagnostics: AuthorityOAuthFailureDiagnostics) {
    super(errorCode);
    this.name = "AuthorityOAuthCallbackError";
    this.errorCode = errorCode;
    this.diagnostics = diagnostics;
  }
}

/**
 * Classifies a thrown fetch error into a safe network-error class using ONLY
 * technical codes (error.code / error.cause.code / error.name). Never reads the
 * message, host, IP, URL, certificate details, or stack.
 */
export function mapNetworkErrorClass(
  error: unknown
): AuthorityOAuthNetworkErrorClass {
  const codes: string[] = [];
  const names: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const e = value as { name?: unknown; code?: unknown };
    if (typeof e.code === "string") codes.push(e.code.toUpperCase());
    if (typeof e.name === "string") names.push(e.name);
  };
  visit(error);
  if (error && typeof error === "object") {
    visit((error as { cause?: unknown }).cause);
  }
  const code = codes.join(" ");
  const name = names.join(" ");

  if (/\b(ENOTFOUND|EAI_AGAIN)\b/.test(code)) return "DNS_ERROR";
  if (
    /(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME|CERT)/.test(
      code
    )
  ) {
    return "CERTIFICATE_ERROR";
  }
  if (/(ERR_TLS|ERR_SSL|EPROTO)/.test(code)) return "TLS_ERROR";
  if (/\bECONNREFUSED\b/.test(code)) return "CONNECTION_REFUSED";
  if (/\bECONNRESET\b/.test(code)) return "CONNECTION_RESET";
  if (/(UND_ERR_CONNECT_TIMEOUT)/.test(code) || /\bETIMEDOUT\b/.test(code)) {
    return "CONNECT_TIMEOUT";
  }
  if (/(UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)/.test(code)) {
    return "REQUEST_TIMEOUT";
  }
  if (/(ABORT_ERR)/.test(code) || /AbortError/.test(name)) return "ABORTED";
  if (/TypeError/.test(name)) return "FETCH_ERROR";
  return "OTHER";
}

/** Buckets an elapsed-milliseconds value into a coarse duration band. */
export function toDurationBucket(ms: number): AuthorityOAuthDurationBucket {
  if (ms < 1000) return "<1s";
  if (ms < 5000) return "1-5s";
  if (ms < 15000) return "5-15s";
  if (ms < 30000) return "15-30s";
  return "30s+";
}

/** Maps a raw provider `error` value to the closed allowlist (or unknown/null). */
export function mapProviderOAuthError(
  raw: unknown
): AuthorityOAuthProviderError | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  return (AUTHORITY_OAUTH_PROVIDER_ERROR_ALLOWLIST as readonly string[]).includes(
    value
  )
    ? (value as AuthorityOAuthProviderError)
    : "unknown";
}

/**
 * Classifies a token-endpoint HTTP response body into a safe response-format tag
 * and, when JSON, an allowlisted provider OAuth error — reading ONLY the `error`
 * field. `error_description` and every other field are ignored entirely.
 */
export function classifyTokenErrorBody(rawBody: string): {
  responseFormat: AuthorityOAuthResponseFormat;
  providerOAuthError: AuthorityOAuthProviderError | null;
} {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return { responseFormat: "EMPTY", providerOAuthError: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { responseFormat: "NON_JSON", providerOAuthError: null };
  }
  const errorField =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).error
      : undefined;
  return {
    responseFormat: "JSON",
    providerOAuthError: mapProviderOAuthError(errorField),
  };
}

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
  /**
   * Injectable local steps — used to unit-test the encryption/persistence stage
   * classification without a live crypto key or database. Default to the real
   * implementations in production.
   */
  encryptTokens?: typeof encryptAuthorityOAuthTokens;
  markConnected?: typeof markAuthorityConnected;
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
  /** Sanitized diagnostics — never leaves the server; not surfaced in the URL/UI. */
  diagnostics: AuthorityOAuthFailureDiagnostics;
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
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID, ...base },
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

  // D2/P7-W4E-B — TENANT AUTHORITY. Everything above is CSRF/shape checking on
  // caller-controlled cookies; none of it establishes WHO this authorization
  // belongs to. The identity comes from the SIGNED state and nowhere else: the
  // cookie businessId/environment are now only cross-checked against it, never
  // trusted on their own. A caller who rewrites their cookies can at worst
  // cause a rejection — they can no longer nominate a tenant and have ITA token
  // material persisted onto it.
  const verified = verifySignedAuthorityState(queryState);
  if (!verified.ok) {
    return {
      ok: false,
      errorCode: AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.STATE_MISMATCH,
      errorMessage: `OAuth state is not trusted: ${verified.reason}`,
      // Deliberately NOT reporting the cookie's businessId here: at this point
      // no trusted tenant exists, and echoing the untrusted one back would be
      // the same mistake in a smaller place.
    };
  }

  // Defence in depth: the cookies must AGREE with the signed state. They carry
  // no authority, but a disagreement means the flow was tampered with, and a
  // tampered flow must not proceed.
  if (
    parsedCookies.businessId !== verified.state.businessId ||
    parsedCookies.environment !== verified.state.environment
  ) {
    return {
      ok: false,
      errorCode: AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.STATE_MISMATCH,
      errorMessage: "OAuth callback cookies disagree with the signed state",
    };
  }

  return {
    ok: true,
    context: {
      businessId: verified.state.businessId,
      environment: verified.state
        .environment as unknown as BillingAuthorityEnvironment,
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

  // Network / timeout: no provider response was ever read. Capture only the safe
  // network-error class + a coarse duration bucket — never the message/host/URL.
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchFn(input.tokenEndpoint, {
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
  } catch (error) {
    throw new AuthorityOAuthCallbackError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
      {
        stage: "TOKEN_EXCHANGE",
        providerHttpStatus: null,
        providerOAuthError: null,
        providerResponseFormat: "NETWORK_ERROR",
        networkErrorClass: mapNetworkErrorClass(error),
        requestDurationBucket: toDurationBucket(Date.now() - startedAt),
      }
    );
  }

  const raw = await response.text();

  // Provider answered with a non-2xx status: this is a provider REJECTION.
  // Read only the safe `error` enum + response shape — never the body/description.
  if (!response.ok) {
    const { responseFormat, providerOAuthError } = classifyTokenErrorBody(raw);
    throw new AuthorityOAuthCallbackError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_REJECTED,
      {
        stage: "TOKEN_EXCHANGE",
        providerHttpStatus: response.status,
        providerOAuthError,
        providerResponseFormat: responseFormat,
      }
    );
  }

  // 2xx but the body is not parseable JSON — treat as a failed exchange (not a
  // rejection): we have no valid token response to work with.
  let parsed: unknown;
  try {
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch {
    throw new AuthorityOAuthCallbackError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
      {
        stage: "TOKEN_EXCHANGE",
        providerHttpStatus: response.status,
        providerOAuthError: null,
        providerResponseFormat: "NON_JSON",
      }
    );
  }

  const tokenResponse = (parsed ?? {}) as Partial<AuthorityTokenExchangeResponse>;
  if (
    typeof tokenResponse.access_token !== "string" ||
    tokenResponse.access_token.length === 0
  ) {
    throw new AuthorityOAuthCallbackError(
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_RESPONSE_INVALID,
      {
        stage: "TOKEN_RESPONSE",
        providerHttpStatus: response.status,
        providerOAuthError: null,
        providerResponseFormat: parsed === null ? "EMPTY" : "JSON",
      }
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

const CODES = AUTHORITY_OAUTH_CALLBACK_ERROR_CODES;

/** Maps a validation-context error code to its coarse failure stage. */
function stageForValidationCode(errorCode: string): AuthorityOAuthFailureStage {
  if (errorCode === CODES.ITA_ERROR) return "PROVIDER_ERROR";
  return "STATE_VALIDATION";
}

function isKnownCallbackErrorCode(value: string): boolean {
  return (Object.values(CODES) as string[]).includes(value);
}

/**
 * Classifies a thrown error from the exchange/encrypt/persist steps into a safe
 * internal error code + sanitized diagnostics. Never reads a provider body or
 * free-text message beyond our own internal codes.
 */
export function resolveCallbackFailure(error: unknown): {
  errorCode: string;
  diagnostics: AuthorityOAuthFailureDiagnostics;
} {
  if (error instanceof AuthorityOAuthCallbackError) {
    return { errorCode: error.errorCode, diagnostics: error.diagnostics };
  }
  if (error instanceof ServiceUnavailableError) {
    return {
      errorCode: CODES.APP_UNAVAILABLE,
      diagnostics: { stage: "APP_CONFIGURATION" },
    };
  }
  if (error instanceof ValidationError && isKnownCallbackErrorCode(error.message)) {
    return {
      errorCode: error.message,
      diagnostics: {
        stage:
          error.message === CODES.TOKEN_RESPONSE_INVALID
            ? "TOKEN_RESPONSE"
            : "TOKEN_EXCHANGE",
      },
    };
  }
  // Unknown/untagged: do NOT surface the raw message (may carry a URL/host).
  return {
    errorCode: CODES.TOKEN_EXCHANGE_FAILED,
    diagnostics: { stage: "TOKEN_EXCHANGE" },
  };
}

/** Builds sanitized audit metadata from failure diagnostics (safe keys only). */
function diagnosticsToAuditMetadata(
  diagnostics: AuthorityOAuthFailureDiagnostics
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { stage: diagnostics.stage };
  if (diagnostics.providerHttpStatus != null) {
    metadata.providerHttpStatus = diagnostics.providerHttpStatus;
  }
  if (diagnostics.providerOAuthError != null) {
    metadata.providerOAuthError = diagnostics.providerOAuthError;
  }
  if (diagnostics.providerResponseFormat != null) {
    metadata.providerResponseFormat = diagnostics.providerResponseFormat;
  }
  if (diagnostics.networkErrorClass != null) {
    metadata.networkErrorClass = diagnostics.networkErrorClass;
  }
  if (diagnostics.requestDurationBucket != null) {
    metadata.requestDurationBucket = diagnostics.requestDurationBucket;
  }
  return metadata;
}

async function recordOAuthCallbackFailure(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  actorUserId?: number | null;
  errorCode: string;
  errorMessage: string;
  diagnostics: AuthorityOAuthFailureDiagnostics;
}): Promise<AuthorityConnectionTransitionResult | null> {
  try {
    return await markAuthorityOAuthFailed({
      businessId: input.businessId,
      environment: input.environment,
      actorUserId: input.actorUserId ?? null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      diagnostics: diagnosticsToAuditMetadata(input.diagnostics),
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
    const diagnostics: AuthorityOAuthFailureDiagnostics = {
      stage: stageForValidationCode(validation.errorCode),
    };
    const failureTransition =
      validation.businessId != null && validation.environment != null
        ? await recordOAuthCallbackFailure({
            businessId: validation.businessId,
            environment: validation.environment,
            actorUserId: input.actorUserId,
            errorCode: validation.errorCode,
            errorMessage: validation.errorCode,
            diagnostics,
          })
        : null;

    return {
      ok: false,
      errorCode: validation.errorCode,
      errorMessage: validation.errorCode,
      diagnostics,
      connection: failureTransition?.connection,
      oauthFailureRecorded: failureTransition?.auditWritten ?? false,
      clearedCookies,
    };
  }

  const { context } = validation;
  const encryptTokens = input.encryptTokens ?? encryptAuthorityOAuthTokens;
  const markConnected = input.markConnected ?? markAuthorityConnected;

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
      throw new AuthorityOAuthCallbackError(CODES.TOKEN_RESPONSE_INVALID, {
        stage: "TOKEN_RESPONSE",
        providerHttpStatus: null,
        providerOAuthError: null,
        providerResponseFormat: "JSON",
      });
    }

    // Local encryption — a failure here is NOT a provider rejection.
    let encryptedTokens;
    try {
      encryptedTokens = encryptTokens({
        businessId: context.businessId,
        environment: context.environment,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
      });
    } catch {
      throw new AuthorityOAuthCallbackError(CODES.TOKEN_ENCRYPTION_FAILED, {
        stage: "TOKEN_ENCRYPTION",
      });
    }

    // Local persistence — a failure here is NOT a provider rejection.
    let connected;
    try {
      connected = await markConnected({
        businessId: context.businessId,
        environment: context.environment,
        actorUserId: input.actorUserId,
        tokens: encryptedTokens,
        accessTokenExpiresAt: resolveTokenExpiryDate(tokenResponse.expires_in),
        refreshTokenExpiresAt: null,
        oauthAuthorizedAt: new Date(),
      });
    } catch {
      throw new AuthorityOAuthCallbackError(CODES.CONNECTION_PERSIST_FAILED, {
        stage: "CONNECTION_PERSISTENCE",
      });
    }

    return {
      ok: true,
      connection: connected.connection,
      clearedCookies,
    };
  } catch (error) {
    const { errorCode, diagnostics } = resolveCallbackFailure(error);

    // errorMessage is the internal code ONLY — never the thrown message (which,
    // for an unexpected error, could carry a URL/host or other sensitive text).
    const errorMessage = errorCode;

    const failureTransition = await recordOAuthCallbackFailure({
      businessId: context.businessId,
      environment: context.environment,
      actorUserId: input.actorUserId,
      errorCode: errorCode.slice(0, 64),
      errorMessage,
      diagnostics,
    });

    return {
      ok: false,
      errorCode,
      errorMessage,
      diagnostics,
      connection: failureTransition?.connection,
      oauthFailureRecorded: failureTransition?.auditWritten ?? false,
      clearedCookies,
    };
  }
}
