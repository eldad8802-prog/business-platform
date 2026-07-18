/**
 * Tests for the authority connection status VIEW model.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-status-view.service.test.ts
 *
 * Covers the pure DTO mapping (status collapse, connect/reconnect gating,
 * connected-family date exposure), tenant isolation and NOT_CONFIGURED
 * degradation in the request orchestrator, and the guarantee that no secret /
 * token material can appear in the DTO.
 */

import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import type { AuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import type { AuthorityAppContext } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  resolveAuthorityStatusRequest,
  toAuthorityConnectionStatusDto,
  type AuthorityConnectionStatusDto,
  type AuthorityStatusDeps,
} from "@/lib/services/billing/authority/billing-authority-status-view.service";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const NOW = new Date("2026-07-19T12:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

function conn(
  overrides: Partial<AuthorityConnectionStatus> = {}
): AuthorityConnectionStatus {
  return {
    businessId: 1,
    environment: BillingAuthorityEnvironment.SANDBOX,
    connectionExists: true,
    status: BillingAuthorityConnectionStatus.CONNECTED,
    oauthAuthorizedAt: PAST,
    oauthAuthorizedByUserId: 5,
    lastValidatedAt: null,
    lastTokenRefreshAt: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    revokedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: PAST,
    updatedAt: PAST,
    hasAccessToken: true,
    hasRefreshToken: true,
    isConnected: true,
    isValidated: false,
    requiresAuthorization: false,
    isRevoked: false,
    isReadyForSubmission: false,
    ...overrides,
  };
}

function mapStatus(
  connection: AuthorityConnectionStatus | null,
  appConfigured = true
): AuthorityConnectionStatusDto {
  return toAuthorityConnectionStatusDto({
    environment: BillingAuthorityEnvironment.SANDBOX,
    appConfigured,
    connection,
    now: NOW,
  });
}

// ---- Mapper: status collapse ------------------------------------------------

{
  const dto = mapStatus(null, false);
  ok("not configured → NOT_CONFIGURED", dto.status === "NOT_CONFIGURED");
  ok("not configured → no connect", dto.canConnect === false);
  ok("not configured → no reconnect", dto.canReconnect === false);
  ok("not configured → no dates", dto.connectedAt === null && dto.expiresAt === null);
}

{
  const dto = mapStatus(null, true);
  ok("configured, no connection → DISCONNECTED", dto.status === "DISCONNECTED");
  ok("disconnected → canConnect", dto.canConnect === true);
  ok("disconnected → no reconnect", dto.canReconnect === false);
}

{
  const dto = mapStatus(
    conn({ status: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED })
  );
  ok("AUTHORIZATION_REQUIRED → DISCONNECTED", dto.status === "DISCONNECTED");
  ok("AUTHORIZATION_REQUIRED → canConnect", dto.canConnect === true);
}

{
  const dto = mapStatus(
    conn({
      status: BillingAuthorityConnectionStatus.CONNECTED,
      refreshTokenExpiresAt: FUTURE,
    })
  );
  ok("CONNECTED (refresh valid) → CONNECTED", dto.status === "CONNECTED");
  ok("connected → no connect", dto.canConnect === false);
  ok("connected → no reconnect", dto.canReconnect === false);
  ok("connected → connectedAt exposed", dto.connectedAt === PAST.toISOString());
  ok("connected → expiresAt exposed", dto.expiresAt === FUTURE.toISOString());
}

{
  const dto = mapStatus(
    conn({
      status: BillingAuthorityConnectionStatus.VALIDATED,
      accessTokenExpiresAt: PAST, // access expired but refresh still valid
      refreshTokenExpiresAt: FUTURE,
    })
  );
  ok("VALIDATED + access expired + refresh valid → CONNECTED", dto.status === "CONNECTED");
  ok("expiresAt prefers refresh token expiry", dto.expiresAt === FUTURE.toISOString());
}

{
  const dto = mapStatus(
    conn({
      status: BillingAuthorityConnectionStatus.CONNECTED,
      refreshTokenExpiresAt: PAST, // refresh token expired → truly needs reconnect
    })
  );
  ok("CONNECTED + refresh expired → EXPIRED", dto.status === "EXPIRED");
  ok("expired → canReconnect", dto.canReconnect === true);
  ok("expired → no plain connect", dto.canConnect === false);
  ok("expired → dates still exposed", dto.connectedAt === PAST.toISOString());
}

{
  const dto = mapStatus(conn({ status: BillingAuthorityConnectionStatus.REVOKED }));
  ok("REVOKED → REVOKED", dto.status === "REVOKED");
  ok("revoked → canReconnect", dto.canReconnect === true);
  ok("revoked → no connect", dto.canConnect === false);
  ok("revoked → no dates", dto.connectedAt === null && dto.expiresAt === null);
}

{
  const dto = mapStatus(conn({ status: BillingAuthorityConnectionStatus.ERROR }));
  ok("ERROR → ERROR", dto.status === "ERROR");
  ok("error → canReconnect", dto.canReconnect === true);
}

// ---- Mapper: no secret leakage ---------------------------------------------

{
  const dto = mapStatus(
    conn({
      status: BillingAuthorityConnectionStatus.CONNECTED,
      refreshTokenExpiresAt: FUTURE,
    })
  );
  const allowedKeys = [
    "environment",
    "status",
    "connectedAt",
    "expiresAt",
    "canConnect",
    "canReconnect",
  ].sort();
  ok(
    "DTO exposes only the safe key set",
    JSON.stringify(Object.keys(dto).sort()) === JSON.stringify(allowedKeys)
  );
  const forbidden = [
    "accessToken",
    "refreshToken",
    "accessTokenEncrypted",
    "refreshTokenEncrypted",
    "clientSecret",
    "encryptionKeyId",
    "authorization",
    "bearerToken",
    "oauthAuthorizedByUserId",
  ];
  const serialized = JSON.stringify(dto).toLowerCase();
  ok(
    "DTO serialization carries no secret field names",
    forbidden.every((k) => !(k in (dto as Record<string, unknown>))) &&
      !serialized.includes("token") &&
      !serialized.includes("secret")
  );
}

// ---- Orchestrator: tenant isolation + NOT_CONFIGURED degradation -----------

function deps(overrides: Partial<AuthorityStatusDeps> = {}): AuthorityStatusDeps {
  return {
    getActiveAuthorityApp: async () => ({} as AuthorityAppContext),
    getAuthorityConnectionStatus: async () =>
      conn({
        status: BillingAuthorityConnectionStatus.CONNECTED,
        refreshTokenExpiresAt: FUTURE,
      }),
    now: () => NOW,
    ...overrides,
  };
}

async function main() {
  // No tenant context → forbidden.
  {
    const res = await resolveAuthorityStatusRequest({
      actor: { id: 1, businessId: null },
      requestedBusinessId: null,
      environment: BillingAuthorityEnvironment.SANDBOX,
      deps: deps(),
    });
    ok("no businessId → forbidden", res.ok === false);
  }

  // Cross-tenant businessId → forbidden.
  {
    const res = await resolveAuthorityStatusRequest({
      actor: { id: 1, businessId: 10 },
      requestedBusinessId: "11",
      environment: BillingAuthorityEnvironment.SANDBOX,
      deps: deps(),
    });
    ok("requesting another business → forbidden", res.ok === false);
  }

  // Own businessId echoed → allowed.
  {
    const res = await resolveAuthorityStatusRequest({
      actor: { id: 1, businessId: 10 },
      requestedBusinessId: "10",
      environment: BillingAuthorityEnvironment.SANDBOX,
      deps: deps(),
    });
    ok("requesting own business → ok", res.ok === true);
    ok(
      "own business → CONNECTED dto",
      res.ok === true && res.dto.status === "CONNECTED"
    );
  }

  // Missing platform app → NOT_CONFIGURED (never a throw), and connection is not queried.
  {
    let connectionQueried = false;
    const res = await resolveAuthorityStatusRequest({
      actor: { id: 1, businessId: 10 },
      requestedBusinessId: null,
      environment: BillingAuthorityEnvironment.SANDBOX,
      deps: deps({
        getActiveAuthorityApp: async () => {
          throw new ServiceUnavailableError("no app");
        },
        getAuthorityConnectionStatus: async () => {
          connectionQueried = true;
          return conn();
        },
      }),
    });
    ok("missing app → ok resolution", res.ok === true);
    ok(
      "missing app → NOT_CONFIGURED",
      res.ok === true && res.dto.status === "NOT_CONFIGURED"
    );
    ok("missing app → connection not queried", connectionQueried === false);
  }

  // A disconnected connection surfaces canConnect.
  {
    const res = await resolveAuthorityStatusRequest({
      actor: { id: 1, businessId: 10 },
      requestedBusinessId: null,
      environment: BillingAuthorityEnvironment.SANDBOX,
      deps: deps({
        getAuthorityConnectionStatus: async () =>
          conn({
            connectionExists: false,
            status: BillingAuthorityConnectionStatus.DISCONNECTED,
          }),
      }),
    });
    ok(
      "disconnected connection → canConnect true",
      res.ok === true && res.dto.canConnect === true
    );
  }

  // A non-ServiceUnavailable error must propagate (not silently NOT_CONFIGURED).
  {
    let threw = false;
    try {
      await resolveAuthorityStatusRequest({
        actor: { id: 1, businessId: 10 },
        requestedBusinessId: null,
        environment: BillingAuthorityEnvironment.SANDBOX,
        deps: deps({
          getActiveAuthorityApp: async () => {
            throw new Error("db down");
          },
        }),
      });
    } catch {
      threw = true;
    }
    ok("unexpected error propagates", threw === true);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
