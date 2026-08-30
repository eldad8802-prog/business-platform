/**
 * Authority OAuth authorization start (D.2.4).
 *
 * Begins the ITA OAuth flow: connection transition, state issuance, and
 * authorize URL construction. Does not handle callback or token exchange.
 */

import { randomBytes } from "node:crypto";
import {
  createSignedAuthorityState,
  type AuthorityEnvironment,
} from "./billing-authority-signed-state.service";
import { BillingAuthorityEnvironment } from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { startAuthorityAuthorization } from "@/lib/services/billing/authority/billing-authority-connection.service";
import type { AuthorityAppContext } from "@/lib/services/billing/authority/billing-authority-connection.types";
import { BILLING_AUTHORITY_OAUTH_CALLBACK_PATH } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  buildAuthorityOAuthAuthorizeUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";

/** ITA example uses a literal scope value. */
export const ITA_OAUTH_SCOPE = "scope" as const;
export const ITA_OAUTH_RESPONSE_TYPE = "code" as const;

export const AUTHORITY_OAUTH_COOKIE_NAMES = {
  STATE: "authority_oauth_state",
  BUSINESS_ID: "authority_oauth_business_id",
  ENVIRONMENT: "authority_oauth_environment",
  ACTOR_USER_ID: "authority_oauth_actor_user_id",
} as const;

/** OAuth state cookie lifetime — matches Gmail connect pattern. */
export const AUTHORITY_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export type AuthorityOAuthCookieSpec = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

export type StartAuthorityOAuthInput = {
  businessId: number;
  actorUserId: number;
  environment: BillingAuthorityEnvironment;
  redirectBaseUrl: string;
  /** Defaults to true when NODE_ENV is production. */
  secureCookies?: boolean;
};

export type StartAuthorityOAuthResult = {
  authorizationUrl: string;
  state: string;
  cookies: AuthorityOAuthCookieSpec[];
};

export type BuildAuthorityOAuthAuthorizeUrlInput = {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
};

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function buildRedirectUriFromBase(redirectBaseUrl: string): string {
  const base = normalizeBaseUrl(redirectBaseUrl);
  if (!base) {
    throw new ValidationError("redirectBaseUrl is required");
  }
  return `${base}${BILLING_AUTHORITY_OAUTH_CALLBACK_PATH}`;
}

/** Cryptographically secure, URL-safe OAuth state (32 random bytes). */
export function createAuthorityOAuthState(): string {
  return base64Url(randomBytes(32));
}

export function buildAuthorityOAuthAuthorizeRedirectUrl(
  input: BuildAuthorityOAuthAuthorizeUrlInput
): string {
  const clientId = input.clientId.trim();
  const redirectUri = input.redirectUri.trim();
  const state = input.state.trim();

  if (!clientId) {
    throw new ValidationError("clientId is required");
  }
  if (!redirectUri) {
    throw new ValidationError("redirectUri is required");
  }
  if (!state) {
    throw new ValidationError("state is required");
  }

  const url = new URL(input.authorizeEndpoint);
  url.searchParams.set("response_type", ITA_OAUTH_RESPONSE_TYPE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", ITA_OAUTH_SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildAuthorityOAuthStateCookies(input: {
  state: string;
  businessId: number;
  actorUserId: number;
  environment: BillingAuthorityEnvironment;
  secureCookies?: boolean;
}): AuthorityOAuthCookieSpec[] {
  assertPositiveInteger(input.businessId, "businessId");
  assertPositiveInteger(input.actorUserId, "actorUserId");

  const secure = input.secureCookies ?? process.env.NODE_ENV === "production";

  const base = {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure,
    path: "/" as const,
    maxAge: AUTHORITY_OAUTH_STATE_MAX_AGE_SECONDS,
  };

  return [
    {
      name: AUTHORITY_OAUTH_COOKIE_NAMES.STATE,
      value: input.state,
      ...base,
    },
    {
      name: AUTHORITY_OAUTH_COOKIE_NAMES.BUSINESS_ID,
      value: String(input.businessId),
      ...base,
    },
    {
      name: AUTHORITY_OAUTH_COOKIE_NAMES.ENVIRONMENT,
      value: input.environment,
      ...base,
    },
    // Carries the authenticated actor across the ITA redirect: the browser
    // returns via a top-level GET with no Authorization header, so the actor
    // cannot be recovered from the session at callback time.
    {
      name: AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID,
      value: String(input.actorUserId),
      ...base,
    },
  ];
}

export function composeAuthorityOAuthStartResult(input: {
  app: AuthorityAppContext;
  oauthBase: string;
  oauthPathSegment: string;
  redirectBaseUrl: string;
  businessId: number;
  actorUserId: number;
  environment: BillingAuthorityEnvironment;
  state?: string;
  secureCookies?: boolean;
}): StartAuthorityOAuthResult {
  // D2/P7-W4E-B: the state is now a SIGNED envelope binding the tenant the
  // start route already authorized (own business, or any business for a
  // PLATFORM_ADMIN), the acting user, and the environment. Previously it was an
  // opaque random nonce and the callback learned the tenant from a separate
  // unsigned cookie — so whoever controlled that cookie chose the tenant the
  // ITA token was persisted onto. The cookie still ships as an unchanged
  // double-submit/CSRF value; it is simply no longer an identity claim.
  const state =
    input.state ??
    createSignedAuthorityState({
      businessId: input.businessId,
      userId: input.actorUserId,
      environment: input.environment as AuthorityEnvironment,
    });
  const redirectUri = buildRedirectUriFromBase(input.redirectBaseUrl);
  const authorizeEndpoint = buildAuthorityOAuthAuthorizeUrl({
    environment: input.environment,
    oauthBase: input.oauthBase,
    apiBase: "unused",
    oauthPathSegment: input.oauthPathSegment,
    redirectBaseUrl: normalizeBaseUrl(input.redirectBaseUrl),
    redirectUri,
  });

  return {
    authorizationUrl: buildAuthorityOAuthAuthorizeRedirectUrl({
      authorizeEndpoint,
      clientId: input.app.itaClientId,
      redirectUri,
      state,
    }),
    state,
    cookies: buildAuthorityOAuthStateCookies({
      state,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      environment: input.environment,
      secureCookies: input.secureCookies,
    }),
  };
}

/**
 * Starts ITA OAuth for a business: transitions connection state, emits audit,
 * and returns the authorize redirect URL plus cookie specs for the route layer.
 */
export async function startAuthorityOAuth(
  input: StartAuthorityOAuthInput
): Promise<StartAuthorityOAuthResult> {
  assertPositiveInteger(input.businessId, "businessId");
  assertPositiveInteger(input.actorUserId, "actorUserId");

  const redirectBaseUrl = normalizeBaseUrl(input.redirectBaseUrl);
  if (!redirectBaseUrl) {
    throw new ValidationError("redirectBaseUrl is required");
  }

  const envConfig = resolveAuthorityEnvConfig(input.environment);
  const app = await getActiveAuthorityApp(input.environment);

  await startAuthorityAuthorization({
    businessId: input.businessId,
    environment: input.environment,
    actorUserId: input.actorUserId,
  });

  return composeAuthorityOAuthStartResult({
    app,
    oauthBase: envConfig.oauthBase,
    oauthPathSegment: envConfig.oauthPathSegment,
    redirectBaseUrl,
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    environment: input.environment,
    secureCookies: input.secureCookies,
  });
}
