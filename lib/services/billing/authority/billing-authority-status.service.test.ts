/**
 * Authority connection status read model (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-status.service.test.ts
 */
import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
} from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { PublicAuthorityConnection } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  assertAuthorityConnectionStatusIsPublic,
  deriveAuthorityConnectionFlags,
  getAuthorityConnectionStatus,
} from "@/lib/services/billing/authority/billing-authority-status.service";

const BUSINESS_ID = 42;
const OTHER_BUSINESS_ID = 99;
const NOW = new Date("2026-06-10T16:00:00.000Z");

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function publicConnection(
  overrides: Partial<PublicAuthorityConnection> & {
    status: BillingAuthorityConnectionStatus;
    environment?: BillingAuthorityEnvironment;
  }
): PublicAuthorityConnection {
  return {
    businessId: overrides.businessId ?? BUSINESS_ID,
    environment: overrides.environment ?? BillingAuthorityEnvironment.SANDBOX,
    status: overrides.status,
    oauthAuthorizedAt: overrides.oauthAuthorizedAt ?? null,
    oauthAuthorizedByUserId: overrides.oauthAuthorizedByUserId ?? null,
    accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: overrides.refreshTokenExpiresAt ?? null,
    lastTokenRefreshAt: overrides.lastTokenRefreshAt ?? null,
    lastValidatedAt: overrides.lastValidatedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

async function withConnection(
  connection: PublicAuthorityConnection | null,
  fn: () => Promise<void>
) {
  const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
    prisma.billingAuthorityConnection
  );
  prisma.billingAuthorityConnection.findUnique = (async () =>
    connection) as typeof prisma.billingAuthorityConnection.findUnique;

  try {
    await fn();
  } finally {
    prisma.billingAuthorityConnection.findUnique = originalFindUnique;
  }
}

function flagsFor(status: BillingAuthorityConnectionStatus, oauthAuthorizedAt: Date | null) {
  return deriveAuthorityConnectionFlags({ status, oauthAuthorizedAt });
}

ok(
  "DISCONNECTED requires authorization",
  flagsFor(BillingAuthorityConnectionStatus.DISCONNECTED, null).requiresAuthorization
);
ok(
  "DISCONNECTED has no tokens",
  !flagsFor(BillingAuthorityConnectionStatus.DISCONNECTED, null).hasAccessToken
);
ok(
  "AUTHORIZATION_REQUIRED requires authorization",
  flagsFor(BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED, null)
    .requiresAuthorization
);
ok(
  "AUTHORIZATION_REQUIRED after refresh failure may retain token signal",
  flagsFor(BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED, NOW).hasAccessToken
);
ok(
  "CONNECTED is connected but not ready",
  flagsFor(BillingAuthorityConnectionStatus.CONNECTED, NOW).isConnected &&
    !flagsFor(BillingAuthorityConnectionStatus.CONNECTED, NOW).isReadyForSubmission
);
ok(
  "VALIDATED is ready when tokens inferred",
  flagsFor(BillingAuthorityConnectionStatus.VALIDATED, NOW).isReadyForSubmission
);
ok(
  "ERROR requires authorization",
  flagsFor(BillingAuthorityConnectionStatus.ERROR, NOW).requiresAuthorization &&
    !flagsFor(BillingAuthorityConnectionStatus.ERROR, NOW).isReadyForSubmission
);
ok(
  "REVOKED clears readiness",
  flagsFor(BillingAuthorityConnectionStatus.REVOKED, null).isRevoked &&
    !flagsFor(BillingAuthorityConnectionStatus.REVOKED, null).hasAccessToken
);
ok(
  "oauth failure ERROR has no token signal",
  !flagsFor(BillingAuthorityConnectionStatus.ERROR, null).hasAccessToken
);

async function runAsyncTests() {
  await withConnection(null, async () => {
    const status = await getAuthorityConnectionStatus({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
    });
    ok("missing connection reports DISCONNECTED", status.status === "DISCONNECTED");
    ok("missing connection not exists", status.connectionExists === false);
    ok(
      "missing connection requires authorization",
      status.requiresAuthorization === true
    );
  });

  for (const status of [
    BillingAuthorityConnectionStatus.DISCONNECTED,
    BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    BillingAuthorityConnectionStatus.CONNECTED,
    BillingAuthorityConnectionStatus.VALIDATED,
    BillingAuthorityConnectionStatus.ERROR,
    BillingAuthorityConnectionStatus.REVOKED,
  ] as const) {
    const oauthAuthorizedAt =
      status === BillingAuthorityConnectionStatus.DISCONNECTED ||
      status === BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED ||
      status === BillingAuthorityConnectionStatus.REVOKED
        ? null
        : NOW;

    await withConnection(
      publicConnection({
        status,
        oauthAuthorizedAt,
        lastValidatedAt:
          status === BillingAuthorityConnectionStatus.VALIDATED ? NOW : null,
        revokedAt:
          status === BillingAuthorityConnectionStatus.REVOKED ? NOW : null,
        lastErrorCode:
          status === BillingAuthorityConnectionStatus.ERROR ? "ITA_AUTH_REJECTED" : null,
      }),
      async () => {
        const result = await getAuthorityConnectionStatus({
          businessId: BUSINESS_ID,
          environment: BillingAuthorityEnvironment.SANDBOX,
        });
        ok(`status read model for ${status}`, result.status === status);
        ok(
          `${status} connection exists`,
          result.connectionExists === true && result.businessId === BUSINESS_ID
        );
      }
    );
  }

  await withConnection(
    publicConnection({
      status: BillingAuthorityConnectionStatus.VALIDATED,
      oauthAuthorizedAt: NOW,
      lastValidatedAt: NOW,
      accessTokenExpiresAt: new Date("2026-06-11T16:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-12-10T16:00:00.000Z"),
      lastTokenRefreshAt: NOW,
    }),
    async () => {
      const result = await getAuthorityConnectionStatus({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok("VALIDATED readiness true", result.isReadyForSubmission === true);
      ok("VALIDATED has access token signal", result.hasAccessToken === true);
      ok("VALIDATED has refresh token signal", result.hasRefreshToken === true);
      ok("VALIDATED exposes operational timestamps", result.lastValidatedAt != null);
      assertAuthorityConnectionStatusIsPublic(result);
      ok("VALIDATED status payload is public-safe", true);
    }
  );

  await withConnection(
    publicConnection({
      status: BillingAuthorityConnectionStatus.CONNECTED,
      oauthAuthorizedAt: NOW,
    }),
    async () => {
      const result = await getAuthorityConnectionStatus({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok("CONNECTED not ready for submission", result.isReadyForSubmission === false);
      ok("CONNECTED is connected", result.isConnected === true);
    }
  );

  await withConnection(
    publicConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
      oauthAuthorizedAt: NOW,
      lastValidatedAt: NOW,
    }),
    async () => {
      const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
        prisma.billingAuthorityConnection
      );
      prisma.billingAuthorityConnection.findUnique = (async (args) => {
        const where = args?.where as {
          businessId_environment?: {
            businessId: number;
            environment: BillingAuthorityEnvironment;
          };
        };
        const scope = where?.businessId_environment;
        if (!scope) return null;
        if (
          scope.businessId === BUSINESS_ID &&
          scope.environment === BillingAuthorityEnvironment.SANDBOX
        ) {
          return publicConnection({
            status: BillingAuthorityConnectionStatus.VALIDATED,
            oauthAuthorizedAt: NOW,
            lastValidatedAt: NOW,
          });
        }
        if (
          scope.businessId === OTHER_BUSINESS_ID &&
          scope.environment === BillingAuthorityEnvironment.PRODUCTION
        ) {
          return publicConnection({
            businessId: OTHER_BUSINESS_ID,
            environment: BillingAuthorityEnvironment.PRODUCTION,
            status: BillingAuthorityConnectionStatus.CONNECTED,
            oauthAuthorizedAt: NOW,
          });
        }
        return null;
      }) as typeof prisma.billingAuthorityConnection.findUnique;

      try {
        const sandbox = await getAuthorityConnectionStatus({
          businessId: BUSINESS_ID,
          environment: BillingAuthorityEnvironment.SANDBOX,
        });
        const production = await getAuthorityConnectionStatus({
          businessId: OTHER_BUSINESS_ID,
          environment: BillingAuthorityEnvironment.PRODUCTION,
        });
        ok(
          "tenant isolation by business and environment",
          sandbox.businessId === BUSINESS_ID &&
            production.businessId === OTHER_BUSINESS_ID &&
            sandbox.environment === "SANDBOX" &&
            production.environment === "PRODUCTION"
        );
        ok(
          "sandbox and production statuses differ",
          sandbox.status === "VALIDATED" && production.status === "CONNECTED"
        );
      } finally {
        prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      }
    }
  );

  await withConnection(
    publicConnection({
      status: BillingAuthorityConnectionStatus.REVOKED,
      revokedAt: NOW,
      oauthAuthorizedAt: null,
    }),
    async () => {
      const result = await getAuthorityConnectionStatus({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok("revoked status flagged", result.isRevoked === true);
      ok("revoked not ready", result.isReadyForSubmission === false);
      ok("revoked requires authorization", result.requiresAuthorization === true);
    }
  );

  await withConnection(
    publicConnection({
      status: BillingAuthorityConnectionStatus.VALIDATED,
      oauthAuthorizedAt: NOW,
      lastValidatedAt: NOW,
    }),
    async () => {
      const result = await getAuthorityConnectionStatus({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      const serialized = JSON.stringify(result);
      ok(
        "status payload contains no secret field names",
        !serialized.includes("accessTokenEncrypted") &&
          !serialized.includes("refreshTokenEncrypted") &&
          !serialized.includes("clientSecret") &&
          !serialized.includes("encryptionKeyId")
      );
    }
  );

  try {
    await getAuthorityConnectionStatus({
      businessId: 0,
      environment: BillingAuthorityEnvironment.SANDBOX,
    });
    console.error("FAIL: invalid business id throws");
    failed += 1;
  } catch (error) {
    ok("invalid business id throws", error instanceof ValidationError);
  }
}

async function runTests() {
  await runAsyncTests();

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll authority connection status tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
