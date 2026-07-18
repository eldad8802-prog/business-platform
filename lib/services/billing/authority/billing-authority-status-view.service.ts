/**
 * Authority connection status VIEW model (UI-facing, read-only).
 *
 * Maps the internal `AuthorityConnectionStatus` domain read model
 * (billing-authority-status.service.ts) + platform-app configuration into a
 * small, safe DTO the Settings UI can render. This layer:
 *
 *   - never exposes tokens, ciphertext, client secret, or any OAuth material;
 *   - collapses the internal lifecycle statuses into a short operational set;
 *   - reports a quiet NOT_CONFIGURED state instead of surfacing a raw 500 when
 *     the platform app is absent for the environment;
 *   - enforces tenant isolation (a caller may only read its own business).
 *
 * Pure mapping (`toAuthorityConnectionStatusDto`) is separated from the request
 * orchestration (`resolveAuthorityStatusRequest`) so both are unit-testable
 * without HTTP. The OAuth mechanism itself is untouched — this only exposes it.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import type { AuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import type { AuthorityAppContext } from "@/lib/services/billing/authority/billing-authority-connection.types";

/** Operational connection state as shown to the business user. */
export type AuthorityConnectionUiStatus =
  | "NOT_CONFIGURED"
  | "DISCONNECTED"
  | "CONNECTED"
  | "EXPIRED"
  | "REVOKED"
  | "ERROR";

/**
 * Safe, UI-facing connection DTO. Contains only operational signals — no
 * tokens, no ciphertext, no client secret, no OAuth state.
 */
export type AuthorityConnectionStatusDto = {
  environment: BillingAuthorityEnvironment;
  status: AuthorityConnectionUiStatus;
  /** ISO timestamp of when OAuth was authorized (connected states only). */
  connectedAt: string | null;
  /** ISO timestamp the connection must be renewed by (connected states only). */
  expiresAt: string | null;
  /** A fresh connect is offered (never connected / disconnected). */
  canConnect: boolean;
  /** A reconnect is offered (expired / revoked / error). */
  canReconnect: boolean;
};

function isUsableDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Collapses the internal lifecycle status into the operational UI status.
 *
 * The connected family (CONNECTED / VALIDATED) is only surfaced as EXPIRED once
 * the REFRESH token has itself expired — an access-token-only expiry is
 * refreshable and stays CONNECTED. AUTHORIZATION_REQUIRED and a missing
 * connection both read as DISCONNECTED (a fresh connect is required).
 */
function deriveUiStatus(
  connection: AuthorityConnectionStatus | null,
  now: Date
): AuthorityConnectionUiStatus {
  if (!connection || !connection.connectionExists) {
    return "DISCONNECTED";
  }

  const S = BillingAuthorityConnectionStatus;
  switch (connection.status) {
    case S.REVOKED:
      return "REVOKED";
    case S.ERROR:
      return "ERROR";
    case S.CONNECTED:
    case S.VALIDATED: {
      const refreshExp = connection.refreshTokenExpiresAt;
      if (isUsableDate(refreshExp) && refreshExp.getTime() <= now.getTime()) {
        return "EXPIRED";
      }
      return "CONNECTED";
    }
    case S.DISCONNECTED:
    case S.AUTHORIZATION_REQUIRED:
    default:
      return "DISCONNECTED";
  }
}

/**
 * Pure mapper: internal status + app-configured flag → safe UI DTO.
 */
export function toAuthorityConnectionStatusDto(input: {
  environment: BillingAuthorityEnvironment;
  appConfigured: boolean;
  connection: AuthorityConnectionStatus | null;
  now: Date;
}): AuthorityConnectionStatusDto {
  const { environment, appConfigured, connection, now } = input;

  // System-side not configured (no active platform app / credentials) — a safe,
  // quiet state, never a raw error and never an actionable connect button.
  if (!appConfigured) {
    return {
      environment,
      status: "NOT_CONFIGURED",
      connectedAt: null,
      expiresAt: null,
      canConnect: false,
      canReconnect: false,
    };
  }

  const uiStatus = deriveUiStatus(connection, now);
  const isConnectedFamily = uiStatus === "CONNECTED" || uiStatus === "EXPIRED";

  const connectedAt =
    isConnectedFamily && isUsableDate(connection?.oauthAuthorizedAt)
      ? connection!.oauthAuthorizedAt!.toISOString()
      : null;

  // "Renew by" date = refresh token expiry (falls back to access token expiry).
  const expirySource =
    connection?.refreshTokenExpiresAt ?? connection?.accessTokenExpiresAt ?? null;
  const expiresAt =
    isConnectedFamily && isUsableDate(expirySource)
      ? expirySource.toISOString()
      : null;

  return {
    environment,
    status: uiStatus,
    connectedAt,
    expiresAt,
    canConnect: uiStatus === "DISCONNECTED",
    canReconnect:
      uiStatus === "EXPIRED" || uiStatus === "REVOKED" || uiStatus === "ERROR",
  };
}

/** Authenticated caller context (only tenant identity is needed to read status). */
export type AuthorityStatusActor = {
  id: number;
  businessId: number | null;
};

export type AuthorityStatusDeps = {
  getActiveAuthorityApp: (
    environment: BillingAuthorityEnvironment
  ) => Promise<AuthorityAppContext>;
  getAuthorityConnectionStatus: (input: {
    businessId: number;
    environment: BillingAuthorityEnvironment;
  }) => Promise<AuthorityConnectionStatus>;
  now: () => Date;
};

export type AuthorityStatusResolution =
  | { ok: true; dto: AuthorityConnectionStatusDto }
  | { ok: false; status: "forbidden" };

/**
 * Resolves the safe connection status for the authenticated caller's own
 * business. Enforces tenant isolation and degrades a missing platform app to
 * NOT_CONFIGURED (never a 500). Read-only — performs no mutations.
 */
export async function resolveAuthorityStatusRequest(input: {
  actor: AuthorityStatusActor;
  requestedBusinessId: string | null;
  environment: BillingAuthorityEnvironment;
  deps: AuthorityStatusDeps;
}): Promise<AuthorityStatusResolution> {
  const { actor, requestedBusinessId, environment, deps } = input;

  const businessId = actor.businessId;
  if (!Number.isInteger(businessId) || (businessId as number) <= 0) {
    // No tenant context — cannot expose any connection.
    return { ok: false, status: "forbidden" };
  }

  // Tenant isolation: never accept another business's id.
  if (requestedBusinessId != null && requestedBusinessId.trim() !== "") {
    const requested = Number(requestedBusinessId);
    if (!Number.isInteger(requested) || requested !== businessId) {
      return { ok: false, status: "forbidden" };
    }
  }

  let appConfigured = true;
  try {
    await deps.getActiveAuthorityApp(environment);
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      appConfigured = false;
    } else {
      throw error;
    }
  }

  const connection = appConfigured
    ? await deps.getAuthorityConnectionStatus({
        businessId: businessId as number,
        environment,
      })
    : null;

  const dto = toAuthorityConnectionStatusDto({
    environment,
    appConfigured,
    connection,
    now: deps.now(),
  });

  return { ok: true, dto };
}
