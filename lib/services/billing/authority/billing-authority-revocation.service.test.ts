/**
 * Authority connection revocation (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-revocation.service.test.ts
 */
import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  startAuthorityAuthorizationTx,
  type AuthorityConnectionRow,
} from "@/lib/services/billing/authority/billing-authority-connection.service";
import { revokeAuthorityConnection } from "@/lib/services/billing/authority/billing-authority-revocation.service";

const BUSINESS_ID = 42;
const OTHER_BUSINESS_ID = 99;
const NOW = new Date("2026-06-10T14:00:00.000Z");

const TOKENS = {
  accessTokenEncrypted: "access-cipher",
  accessTokenIv: "access-iv",
  accessTokenTag: "access-tag",
  refreshTokenEncrypted: "refresh-cipher",
  refreshTokenIv: "refresh-iv",
  refreshTokenTag: "refresh-tag",
  encryptionKeyId: "authority_gcm_v1",
};

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function makeConnection(
  overrides: Partial<AuthorityConnectionRow> & {
    businessId: number;
    environment: BillingAuthorityEnvironment;
    status: BillingAuthorityConnectionStatus;
  }
): AuthorityConnectionRow {
  return {
    id: overrides.id ?? 1,
    businessId: overrides.businessId,
    environment: overrides.environment,
    status: overrides.status,
    oauthAuthorizedAt: overrides.oauthAuthorizedAt ?? NOW,
    oauthAuthorizedByUserId: overrides.oauthAuthorizedByUserId ?? 7,
    accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? NOW,
    refreshTokenExpiresAt: overrides.refreshTokenExpiresAt ?? NOW,
    lastTokenRefreshAt: overrides.lastTokenRefreshAt ?? NOW,
    lastValidatedAt: overrides.lastValidatedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null,
    accessTokenEncrypted: overrides.accessTokenEncrypted ?? TOKENS.accessTokenEncrypted,
    accessTokenIv: overrides.accessTokenIv ?? TOKENS.accessTokenIv,
    accessTokenTag: overrides.accessTokenTag ?? TOKENS.accessTokenTag,
    refreshTokenEncrypted:
      overrides.refreshTokenEncrypted ?? TOKENS.refreshTokenEncrypted,
    refreshTokenIv: overrides.refreshTokenIv ?? TOKENS.refreshTokenIv,
    refreshTokenTag: overrides.refreshTokenTag ?? TOKENS.refreshTokenTag,
    encryptionKeyId: overrides.encryptionKeyId ?? TOKENS.encryptionKeyId,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

type FakeAuditEvent = {
  eventType: string;
  metadata: Record<string, unknown> | null;
};

function scopeKey(businessId: number, environment: BillingAuthorityEnvironment) {
  return `${businessId}:${environment}`;
}

function makeFakeRevocationDb(initial: AuthorityConnectionRow) {
  const rows = new Map<string, AuthorityConnectionRow>([
    [scopeKey(initial.businessId, initial.environment), { ...initial }],
  ]);
  const auditEvents: FakeAuditEvent[] = [];

  const tx = {
    billingAuthorityConnection: {
      async findUnique(args: {
        where: {
          businessId_environment: {
            businessId: number;
            environment: BillingAuthorityEnvironment;
          };
        };
      }) {
        const key = scopeKey(
          args.where.businessId_environment.businessId,
          args.where.businessId_environment.environment
        );
        const row = rows.get(key);
        return row ? { ...row } : null;
      },
      async upsert(args: {
        where: {
          businessId_environment: {
            businessId: number;
            environment: BillingAuthorityEnvironment;
          };
        };
        create: AuthorityConnectionRow;
        update: Record<string, never>;
      }) {
        const key = scopeKey(
          args.where.businessId_environment.businessId,
          args.where.businessId_environment.environment
        );
        if (!rows.has(key)) {
          rows.set(key, { ...args.create });
        }
        return { ...rows.get(key)! };
      },
      async update(args: {
        where: { id: number };
        data: Prisma.BillingAuthorityConnectionUpdateInput;
      }) {
        for (const [key, row] of rows.entries()) {
          if (row.id !== args.where.id) continue;
          const next = {
            ...row,
            ...Object.fromEntries(
              Object.entries(args.data).filter(([, value]) => value !== undefined)
            ),
          } as AuthorityConnectionRow;
          next.status =
            (args.data.status as BillingAuthorityConnectionStatus | undefined) ??
            next.status;
          rows.set(key, next);
          return { ...next };
        }
        throw new Error("connection not found");
      },
    },
    billingAuditEvent: {
      async create(args: {
        data: {
          eventType: string;
          metadata: Record<string, unknown> | null;
        };
      }) {
        auditEvents.push({
          eventType: args.data.eventType,
          metadata: args.data.metadata,
        });
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    auditEvents,
    getRow: (businessId: number, environment: BillingAuthorityEnvironment) =>
      rows.get(scopeKey(businessId, environment)) ?? null,
    setRow: (row: AuthorityConnectionRow) => {
      rows.set(scopeKey(row.businessId, row.environment), { ...row });
    },
  };
}

async function withFakeDb(
  row: AuthorityConnectionRow,
  fn: (fake: ReturnType<typeof makeFakeRevocationDb>) => Promise<void>
) {
  const fake = makeFakeRevocationDb(row);
  const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
    prisma.billingAuthorityConnection
  );
  const originalTransaction = prisma.$transaction.bind(prisma);

  prisma.billingAuthorityConnection.findUnique = (async (args) => {
    const where = args?.where as {
      businessId_environment?: { businessId: number; environment: BillingAuthorityEnvironment };
    };
    if (!where?.businessId_environment) return null;
    return fake.getRow(
      where.businessId_environment.businessId,
      where.businessId_environment.environment
    );
  }) as typeof prisma.billingAuthorityConnection.findUnique;

  prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

  try {
    await fn(fake);
  } finally {
    prisma.billingAuthorityConnection.findUnique = originalFindUnique;
    prisma.$transaction = originalTransaction;
  }
}

async function runTests() {
  for (const status of [
    BillingAuthorityConnectionStatus.CONNECTED,
    BillingAuthorityConnectionStatus.VALIDATED,
    BillingAuthorityConnectionStatus.ERROR,
    BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
  ] as const) {
    await withFakeDb(
      makeConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        status,
      }),
      async (fake) => {
        const result = await revokeAuthorityConnection({
          businessId: BUSINESS_ID,
          environment: BillingAuthorityEnvironment.SANDBOX,
          actorUserId: 7,
          reason: `revoke from ${status}`,
          revokedAt: NOW,
        });
        const row = fake.getRow(BUSINESS_ID, BillingAuthorityEnvironment.SANDBOX)!;
        ok(`revoke ${status}`, result.ok && result.revoked && row.status === "REVOKED");
      }
    );
  }

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    }),
    async (fake) => {
      await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
        revokedAt: NOW,
      });
      const row = fake.getRow(BUSINESS_ID, BillingAuthorityEnvironment.SANDBOX)!;
      ok("access token fields cleared", row.accessTokenEncrypted === null);
      ok("refresh token fields cleared", row.refreshTokenEncrypted === null);
      ok("expiry fields cleared", row.accessTokenExpiresAt === null);
      ok("last token refresh cleared", row.lastTokenRefreshAt === null);
      ok("revokedAt populated", row.revokedAt?.toISOString() === NOW.toISOString());
      ok("status becomes REVOKED", row.status === "REVOKED");
      ok(
        "audit emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_CONNECTION_REVOKED"
        )
      );
      ok(
        "audit contains no secrets",
        fake.auditEvents.every(
          (event) =>
            event.metadata == null ||
            (!("accessToken" in event.metadata) &&
              !("refreshToken" in event.metadata) &&
              !("accessTokenEncrypted" in event.metadata) &&
              !("refreshTokenEncrypted" in event.metadata))
        )
      );
    }
  );

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.REVOKED,
      revokedAt: NOW,
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
    }),
    async (fake) => {
      const first = await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
      });
      const second = await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
      });
      ok("revoke already REVOKED", first.ok && first.revoked);
      ok(
        "idempotent revoke behavior",
        second.ok &&
          second.revoked &&
          fake.auditEvents.filter(
            (event) => event.eventType === "BILLING_AUTHORITY_CONNECTION_REVOKED"
          ).length === 0
      );
    }
  );

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.REVOKED,
      revokedAt: NOW,
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
    }),
    async (fake) => {
      const restarted = await startAuthorityAuthorizationTx(fake.tx, {
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
      });
      ok(
        "reauthorization still possible after revoke",
        restarted.toStatus === "AUTHORIZATION_REQUIRED"
      );
    }
  );

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    }),
    async (fake) => {
      fake.setRow(
        makeConnection({
          businessId: OTHER_BUSINESS_ID,
          environment: BillingAuthorityEnvironment.PRODUCTION,
          status: BillingAuthorityConnectionStatus.CONNECTED,
        })
      );
      await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
      });
      ok(
        "tenant isolation revokes only target business",
        fake.getRow(BUSINESS_ID, BillingAuthorityEnvironment.SANDBOX)!.status ===
          "REVOKED" &&
          fake.getRow(OTHER_BUSINESS_ID, BillingAuthorityEnvironment.PRODUCTION)!
            .status === "CONNECTED"
      );
    }
  );

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
    }),
    async (fake) => {
      const result = await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
        revokedAt: NOW,
      });
      ok(
        "sandbox revoke",
        result.ok && fake.getRow(BUSINESS_ID, BillingAuthorityEnvironment.SANDBOX)!.environment === "SANDBOX"
      );
    }
  );

  await withFakeDb(
    makeConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.PRODUCTION,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    }),
    async (fake) => {
      const result = await revokeAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.PRODUCTION,
        actorUserId: 7,
        revokedAt: NOW,
      });
      ok(
        "production revoke",
        result.ok &&
          fake.getRow(BUSINESS_ID, BillingAuthorityEnvironment.PRODUCTION)!.environment ===
            "PRODUCTION"
      );
    }
  );

  const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
    prisma.billingAuthorityConnection
  );
  prisma.billingAuthorityConnection.findUnique = (async () =>
    null) as typeof prisma.billingAuthorityConnection.findUnique;
  try {
    await revokeAuthorityConnection({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
    });
    console.error("FAIL: missing connection throws");
    failed += 1;
  } catch (error) {
    ok("missing connection throws", error instanceof NotFoundError);
  } finally {
    prisma.billingAuthorityConnection.findUnique = originalFindUnique;
  }

  try {
    await revokeAuthorityConnection({
      businessId: 0,
      environment: BillingAuthorityEnvironment.SANDBOX,
    });
    console.error("FAIL: invalid business id throws");
    failed += 1;
  } catch (error) {
    ok("invalid business id throws", error instanceof ValidationError);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll authority revocation tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
