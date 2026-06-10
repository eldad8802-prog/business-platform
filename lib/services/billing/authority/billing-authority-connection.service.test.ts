/**
 * Authority connection service (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-connection.service.test.ts
 */
import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ForbiddenError } from "@/lib/errors";
import {
  ensureAuthorityConnectionTx,
  markAuthorityAuthFailureTx,
  markAuthorityConnectedTx,
  markAuthorityOAuthFailedTx,
  markAuthorityValidatedTx,
  revokeAuthorityConnectionTx,
  startAuthorityAuthorizationTx,
  toPublicAuthorityConnection,
  type AuthorityConnectionRow,
} from "@/lib/services/billing/authority/billing-authority-connection.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function expectForbidden(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.error("FAIL:", name, "(expected ForbiddenError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ForbiddenError);
  }
}

const NOW = new Date("2026-06-10T12:00:00.000Z");
const TOKENS = {
  accessTokenEncrypted: "access-cipher",
  accessTokenIv: "access-iv",
  accessTokenTag: "access-tag",
  refreshTokenEncrypted: "refresh-cipher",
  refreshTokenIv: "refresh-iv",
  refreshTokenTag: "refresh-tag",
  encryptionKeyId: "authority_gcm_v1",
};

type FakeAuditEvent = {
  eventType: string;
  businessId: number;
  actorUserId: number | null;
  metadata: Record<string, unknown> | null;
};

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
    oauthAuthorizedAt: overrides.oauthAuthorizedAt ?? null,
    oauthAuthorizedByUserId: overrides.oauthAuthorizedByUserId ?? null,
    accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: overrides.refreshTokenExpiresAt ?? null,
    lastTokenRefreshAt: overrides.lastTokenRefreshAt ?? null,
    lastValidatedAt: overrides.lastValidatedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null,
    accessTokenEncrypted: overrides.accessTokenEncrypted ?? null,
    accessTokenIv: overrides.accessTokenIv ?? null,
    accessTokenTag: overrides.accessTokenTag ?? null,
    refreshTokenEncrypted: overrides.refreshTokenEncrypted ?? null,
    refreshTokenIv: overrides.refreshTokenIv ?? null,
    refreshTokenTag: overrides.refreshTokenTag ?? null,
    encryptionKeyId: overrides.encryptionKeyId ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function applyConnectionUpdate(
  current: AuthorityConnectionRow,
  data: Prisma.BillingAuthorityConnectionUpdateInput
): AuthorityConnectionRow {
  const next: AuthorityConnectionRow = { ...current, updatedAt: NOW };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function scopeKey(businessId: number, environment: BillingAuthorityEnvironment): string {
  return `${businessId}:${environment}`;
}

function makeFakeConnectionDb(initial: AuthorityConnectionRow) {
  const rows = new Map<string, AuthorityConnectionRow>([
    [scopeKey(initial.businessId, initial.environment), { ...initial }],
  ]);
  const auditEvents: FakeAuditEvent[] = [];

  const tx = {
    billingAuthorityConnection: {
      async findUnique(args: {
        where: {
          businessId_environment?: {
            businessId: number;
            environment: BillingAuthorityEnvironment;
          };
        };
        select?: typeof initial;
      }) {
        const scope = args.where.businessId_environment;
        if (!scope) return null;
        const row = rows.get(scopeKey(scope.businessId, scope.environment));
        return row ? { ...row } : null;
      },
      async upsert(args: {
        where: {
          businessId_environment: {
            businessId: number;
            environment: BillingAuthorityEnvironment;
          };
        };
        create: {
          businessId: number;
          environment: BillingAuthorityEnvironment;
          status: BillingAuthorityConnectionStatus;
        };
        update: Prisma.BillingAuthorityConnectionUpdateInput;
        select: typeof initial;
      }) {
        const key = scopeKey(
          args.where.businessId_environment.businessId,
          args.where.businessId_environment.environment
        );
        const existing = rows.get(key);
        if (existing) {
          const updated = applyConnectionUpdate(existing, args.update);
          rows.set(key, updated);
          return { ...updated };
        }
        const created = makeConnection({
          id: rows.size + 1,
          businessId: args.create.businessId,
          environment: args.create.environment,
          status: args.create.status,
        });
        rows.set(key, created);
        return { ...created };
      },
      async update(args: {
        where: { id: number };
        data: Prisma.BillingAuthorityConnectionUpdateInput;
        select: typeof initial;
      }) {
        const entry = [...rows.entries()].find(([, row]) => row.id === args.where.id);
        if (!entry) throw new Error("connection not found");
        const [key, row] = entry;
        const updated = applyConnectionUpdate(row, args.data);
        rows.set(key, updated);
        return { ...updated };
      },
    },
    billingAuditEvent: {
      async create(args: {
        data: {
          businessId: number;
          actorUserId: number | null;
          eventType: string;
          metadata: Record<string, unknown> | null;
        };
      }) {
        auditEvents.push({
          eventType: args.data.eventType,
          businessId: args.data.businessId,
          actorUserId: args.data.actorUserId,
          metadata: args.data.metadata,
        });
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    getRow(businessId: number, environment: BillingAuthorityEnvironment) {
      return rows.get(scopeKey(businessId, environment)) ?? null;
    },
    auditEvents,
  };
}

async function runTests() {
const sandboxDisconnected = makeConnection({
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  status: BillingAuthorityConnectionStatus.DISCONNECTED,
});

const db = makeFakeConnectionDb(sandboxDisconnected);

const ensured = await ensureAuthorityConnectionTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
});
ok("create/upsert initial connection", ensured.status === "DISCONNECTED");

const publicView = toPublicAuthorityConnection(ensured);
ok(
  "public read model excludes secrets",
  !("accessTokenEncrypted" in publicView) &&
    !("refreshTokenEncrypted" in publicView) &&
    !("accessTokenIv" in publicView)
);

const started = await startAuthorityAuthorizationTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
});
ok(
  "start authorization legal transition",
  started.fromStatus === "DISCONNECTED" &&
    started.toStatus === "AUTHORIZATION_REQUIRED" &&
    started.auditWritten
);
ok(
  "start authorization audit emitted once",
  db.auditEvents.length === 1 &&
    db.auditEvents[0].eventType === "BILLING_AUTHORITY_OAUTH_STARTED"
);

const startedAgain = await startAuthorityAuthorizationTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
});
ok(
  "start authorization from AUTHORIZATION_REQUIRED is idempotent",
  startedAgain.auditWritten === false &&
    startedAgain.toStatus === "AUTHORIZATION_REQUIRED"
);
ok(
  "start authorization idempotent does not duplicate audit",
  db.auditEvents.length === 1
);

const connected = await markAuthorityConnectedTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
  tokens: TOKENS,
  oauthAuthorizedAt: NOW,
});
ok(
  "mark connected from AUTHORIZATION_REQUIRED",
  connected.toStatus === "CONNECTED" &&
    connected.connection.oauthAuthorizedAt?.toISOString() === NOW.toISOString()
);
ok(
  "mark connected audit emitted",
  db.auditEvents[db.auditEvents.length - 1].eventType ===
    "BILLING_AUTHORITY_OAUTH_COMPLETED"
);

const connectedRow = db.getRow(42, BillingAuthorityEnvironment.SANDBOX)!;
ok(
  "mark connected stores encrypted fields internally",
  connectedRow.accessTokenEncrypted === TOKENS.accessTokenEncrypted &&
    connectedRow.refreshTokenEncrypted === TOKENS.refreshTokenEncrypted
);

await expectForbidden(
  "mark connected rejects non AUTHORIZATION_REQUIRED",
  () =>
    markAuthorityConnectedTx(db.tx, {
      businessId: 42,
      environment: BillingAuthorityEnvironment.SANDBOX,
      actorUserId: 7,
      tokens: TOKENS,
    })
);

const oauthFailDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 50,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
  })
);
const oauthFailed = await markAuthorityOAuthFailedTx(oauthFailDb.tx, {
  businessId: 50,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
  errorCode: "OAUTH_EXCHANGE_FAILED",
  errorMessage: "Token exchange failed",
});
ok(
  "mark oauth failed",
  oauthFailed.toStatus === "ERROR" &&
    oauthFailed.connection.lastErrorCode === "OAUTH_EXCHANGE_FAILED"
);

const validated = await markAuthorityValidatedTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  validatedAt: NOW,
});
ok(
  "mark validated from CONNECTED",
  validated.fromStatus === "CONNECTED" &&
    validated.toStatus === "VALIDATED" &&
    validated.auditWritten
);

const validatedReplay = await markAuthorityValidatedTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  validatedAt: NOW,
});
ok(
  "mark validated replay from VALIDATED is idempotent",
  validatedReplay.auditWritten === false &&
    validatedReplay.toStatus === "VALIDATED"
);

const authFailureDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 60,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    status: BillingAuthorityConnectionStatus.CONNECTED,
    accessTokenEncrypted: TOKENS.accessTokenEncrypted,
    refreshTokenEncrypted: TOKENS.refreshTokenEncrypted,
  })
);
const authFailureConnected = await markAuthorityAuthFailureTx(authFailureDb.tx, {
  businessId: 60,
  environment: BillingAuthorityEnvironment.PRODUCTION,
  errorCode: "ITA_AUTH_REJECTED",
  errorMessage: "401 from ITA",
});
ok(
  "mark auth failure from CONNECTED",
  authFailureConnected.toStatus === "ERROR" &&
    authFailureConnected.connection.lastErrorCode === "ITA_AUTH_REJECTED"
);
ok(
  "mark auth failure keeps encrypted tokens",
  authFailureDb.getRow(60, BillingAuthorityEnvironment.PRODUCTION)!
    .accessTokenEncrypted === TOKENS.accessTokenEncrypted
);

const authFailureValidatedDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 61,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    status: BillingAuthorityConnectionStatus.VALIDATED,
    accessTokenEncrypted: TOKENS.accessTokenEncrypted,
    refreshTokenEncrypted: TOKENS.refreshTokenEncrypted,
  })
);
const authFailureValidated = await markAuthorityAuthFailureTx(
  authFailureValidatedDb.tx,
  {
    businessId: 61,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    errorCode: "ITA_AUTH_REJECTED",
    errorMessage: "403 from ITA",
  }
);
ok(
  "mark auth failure from VALIDATED",
  authFailureValidated.toStatus === "ERROR"
);

const revoked = await revokeAuthorityConnectionTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
  reason: "owner disconnect",
});
ok("revoke transitions to REVOKED", revoked.toStatus === "REVOKED");

const revokedRow = db.getRow(42, BillingAuthorityEnvironment.SANDBOX)!;
ok(
  "revoke wipes token fields",
  revokedRow.accessTokenEncrypted === null &&
    revokedRow.refreshTokenEncrypted === null &&
    revokedRow.accessTokenIv === null &&
    revokedRow.refreshTokenTag === null &&
    revokedRow.encryptionKeyId === null
);

const revokedAgain = await revokeAuthorityConnectionTx(db.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  actorUserId: 7,
});
ok(
  "revoke from REVOKED is idempotent",
  revokedAgain.auditWritten === false &&
    revokedAgain.toStatus === "REVOKED"
);

const invalidDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 70,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.DISCONNECTED,
  })
);
await expectForbidden("invalid DISCONNECTED to CONNECTED", () =>
  markAuthorityConnectedTx(invalidDb.tx, {
    businessId: 70,
    environment: BillingAuthorityEnvironment.SANDBOX,
    actorUserId: 7,
    tokens: TOKENS,
  })
);
await expectForbidden("invalid DISCONNECTED to VALIDATED", () =>
  markAuthorityValidatedTx(invalidDb.tx, {
    businessId: 70,
    environment: BillingAuthorityEnvironment.SANDBOX,
  })
);

const revokedInvalidDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 71,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.REVOKED,
  })
);
await expectForbidden("invalid REVOKED to CONNECTED", () =>
  markAuthorityConnectedTx(revokedInvalidDb.tx, {
    businessId: 71,
    environment: BillingAuthorityEnvironment.SANDBOX,
    actorUserId: 7,
    tokens: TOKENS,
  })
);
await expectForbidden("invalid REVOKED to VALIDATED", () =>
  markAuthorityValidatedTx(revokedInvalidDb.tx, {
    businessId: 71,
    environment: BillingAuthorityEnvironment.SANDBOX,
  })
);

const errorInvalidDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 72,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.ERROR,
  })
);
await expectForbidden("invalid ERROR to VALIDATED", () =>
  markAuthorityValidatedTx(errorInvalidDb.tx, {
    businessId: 72,
    environment: BillingAuthorityEnvironment.SANDBOX,
  })
);

const authRequiredInvalidDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 73,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
  })
);
await expectForbidden("invalid AUTHORIZATION_REQUIRED to VALIDATED", () =>
  markAuthorityValidatedTx(authRequiredInvalidDb.tx, {
    businessId: 73,
    environment: BillingAuthorityEnvironment.SANDBOX,
  })
);

const completedAudit = db.auditEvents.find(
  (event) => event.eventType === "BILLING_AUTHORITY_OAUTH_COMPLETED"
);
ok("audit emitted exactly once for oauth completed", completedAudit != null);
ok(
  "audit metadata does not contain tokens/secrets",
  completedAudit != null &&
    !("accessTokenEncrypted" in (completedAudit.metadata ?? {})) &&
    !("refreshTokenEncrypted" in (completedAudit.metadata ?? {})) &&
    !("accessToken" in (completedAudit.metadata ?? {}))
);

const productionDb = makeFakeConnectionDb(
  makeConnection({
    businessId: 42,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    status: BillingAuthorityConnectionStatus.DISCONNECTED,
  })
);
await startAuthorityAuthorizationTx(productionDb.tx, {
  businessId: 42,
  environment: BillingAuthorityEnvironment.PRODUCTION,
  actorUserId: 7,
});
ok(
  "tenant isolation by businessId + environment",
  db.getRow(42, BillingAuthorityEnvironment.SANDBOX)!.status === "REVOKED" &&
    productionDb.getRow(42, BillingAuthorityEnvironment.PRODUCTION)!.status ===
      "AUTHORIZATION_REQUIRED"
);
ok(
  "sandbox and production connections are independent",
  productionDb.auditEvents.length === 1 &&
    productionDb.auditEvents[0].eventType === "BILLING_AUTHORITY_OAUTH_STARTED"
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll authority connection service tests passed (${db.auditEvents.length} audits in primary flow).`);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
