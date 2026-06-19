import { BillingAuthorityEnvironment } from "@prisma/client";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import {
  AuthorityEnvConfig,
  BILLING_AUTHORITY_OAUTH_CALLBACK_PATH,
} from "@/lib/services/billing/authority/billing-authority-connection.types";

const RUNTIME_ENV_VAR = "BILLING_AUTHORITY_RUNTIME_ENVIRONMENT";
const REDIRECT_BASE_VAR = "BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL";

const OAUTH_BASE_PREFIX = "AUTHORITY_OAUTH_BASE";
const API_BASE_PREFIX = "AUTHORITY_API_BASE";
const PATH_SEGMENT_PREFIX = "AUTHORITY_OAUTH_PATH_SEGMENT";

const DEFAULT_OAUTH_PATH_SEGMENT: Record<BillingAuthorityEnvironment, string> = {
  SANDBOX: "tsandbox",
  PRODUCTION: "production",
};

function isProductionNodeEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function trimEnv(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuthorityEnvironment(
  raw: string | undefined,
  fieldName: string
): BillingAuthorityEnvironment {
  const normalized = trimEnv(raw)?.toUpperCase();
  if (normalized === "SANDBOX" || normalized === "PRODUCTION") {
    return normalized;
  }
  throw new ValidationError(
    `${fieldName} must be SANDBOX or PRODUCTION (got ${raw ?? "undefined"})`
  );
}

function envSuffix(environment: BillingAuthorityEnvironment): string {
  return environment;
}

/**
 * Reads the authority environment configured for this deployment instance.
 * Each deploy is expected to operate against a single ITA environment.
 */
export function resolveRuntimeAuthorityEnvironment(): BillingAuthorityEnvironment {
  return parseAuthorityEnvironment(
    process.env[RUNTIME_ENV_VAR],
    RUNTIME_ENV_VAR
  );
}

function readScopedEnv(
  prefix: string,
  environment: BillingAuthorityEnvironment
): string | null {
  const scoped = trimEnv(
    process.env[`${prefix}_${envSuffix(environment)}`]
  );
  if (scoped) return scoped;

  const runtime = trimEnv(process.env[RUNTIME_ENV_VAR]);
  if (runtime?.toUpperCase() === environment) {
    return trimEnv(process.env[prefix]);
  }

  return null;
}

function requireScopedEnv(
  prefix: string,
  environment: BillingAuthorityEnvironment,
  label: string
): string {
  const value = readScopedEnv(prefix, environment);
  if (value) return value;

  const message = `Missing ${label} for ${environment}. Set ${prefix}_${environment} or ${prefix} when ${RUNTIME_ENV_VAR}=${environment}.`;

  if (isProductionNodeEnv()) {
    throw new ServiceUnavailableError(message);
  }

  throw new ValidationError(message);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buildRedirectUri(redirectBaseUrl: string): string {
  const base = normalizeBaseUrl(redirectBaseUrl);
  return `${base}${BILLING_AUTHORITY_OAUTH_CALLBACK_PATH}`;
}

/**
 * Resolves ITA OAuth/API host configuration for the requested environment.
 * Fail-closed when required values are missing.
 */
export function resolveAuthorityEnvConfig(
  environment: BillingAuthorityEnvironment
): AuthorityEnvConfig {
  const oauthBase = normalizeBaseUrl(
    requireScopedEnv(OAUTH_BASE_PREFIX, environment, "OAuth base URL")
  );
  const apiBase = normalizeBaseUrl(
    requireScopedEnv(API_BASE_PREFIX, environment, "API base URL")
  );
  const oauthPathSegment =
    readScopedEnv(PATH_SEGMENT_PREFIX, environment) ??
    DEFAULT_OAUTH_PATH_SEGMENT[environment];

  const redirectBaseUrl = trimEnv(process.env[REDIRECT_BASE_VAR]);
  if (!redirectBaseUrl) {
    const message = `Missing ${REDIRECT_BASE_VAR}.`;
    if (isProductionNodeEnv()) {
      throw new ServiceUnavailableError(message);
    }
    throw new ValidationError(message);
  }

  return {
    environment,
    oauthBase,
    apiBase,
    oauthPathSegment,
    redirectBaseUrl: normalizeBaseUrl(redirectBaseUrl),
    redirectUri: buildRedirectUri(redirectBaseUrl),
  };
}

/** OAuth token endpoint for authorization_code / refresh_token exchange. */
export function buildAuthorityOAuthTokenUrl(config: AuthorityEnvConfig): string {
  return `${config.oauthBase}/shaam/${config.oauthPathSegment}/longtimetoken/oauth2/token`;
}

/** OAuth authorize endpoint for connection initiation (D.2.4+). */
export function buildAuthorityOAuthAuthorizeUrl(
  config: AuthorityEnvConfig
): string {
  return `${config.oauthBase}/shaam/${config.oauthPathSegment}/longtimetoken/oauth2/authorize`;
}

/** ITA API base including shaam path segment (D.2.7+ probes). */
export function buildAuthorityApiBaseUrl(config: AuthorityEnvConfig): string {
  return `${config.apiBase}/shaam/${config.oauthPathSegment}`;
}
