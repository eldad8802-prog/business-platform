// W4E-B-1: the connect flow now mints a SIGNED state, and the signer fails
// closed without the canonical secret — set a synthetic one for this unit test.
process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "w4eb1_start_test_secret";

/**
 * Authority OAuth start (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-start.service.test.ts
 */
import {
  BillingAuthorityAppStatus,
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  assertActiveAuthorityApp,
  toAuthorityAppContext,
} from "@/lib/services/billing/authority/billing-authority-app.service";
import { resolveAuthorityEnvConfig } from "@/lib/services/billing/authority/billing-authority-env.service";
import { startAuthorityAuthorizationTx } from "@/lib/services/billing/authority/billing-authority-connection.service";
import {
  AUTHORITY_OAUTH_COOKIE_NAMES,
  buildAuthorityOAuthAuthorizeRedirectUrl,
  buildAuthorityOAuthStateCookies,
  buildRedirectUriFromBase,
  composeAuthorityOAuthStartResult,
  createAuthorityOAuthState,
  ITA_OAUTH_RESPONSE_TYPE,
  ITA_OAUTH_SCOPE,
  startAuthorityOAuth,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";

const ENV = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
  AUTHORITY_OAUTH_BASE_SANDBOX: "https://openapi.taxes.gov.il",
  AUTHORITY_API_BASE_SANDBOX: "https://ita-api.taxes.gov.il",
  AUTHORITY_OAUTH_PATH_SEGMENT_SANDBOX: "tsandbox",
  BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://app.dubiz.test",
  BILLING_AUTHORITY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const PROD_ENV = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION",
  AUTHORITY_OAUTH_BASE_PRODUCTION: "https://openapi.taxes.gov.il",
  AUTHORITY_API_BASE_PRODUCTION: "https://ita-api.taxes.gov.il",
  AUTHORITY_OAUTH_PATH_SEGMENT_PRODUCTION: "production",
  BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://prod.dubiz.test",
  BILLING_AUTHORITY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const originalEnv = { ...process.env };
const APP_ROW = {
  id: 1,
  environment: BillingAuthorityEnvironment.SANDBOX,
  status: BillingAuthorityAppStatus.ACTIVE,
  accountingSoftwareNumber: "12345678",
  itaClientId: "sandbox-client-id",
  clientSecretEncrypted: "cipher",
  clientSecretIv: "iv",
  clientSecretTag: "tag",
  encryptionKeyId: "authority_gcm_v1",
  portalOrganizationId: null,
  portalApplicationId: null,
  registeredAt: new Date("2026-06-01T12:00:00.000Z"),
  lastValidatedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: new Date("2026-06-01T12:00:00.000Z"),
  updatedAt: new Date("2026-06-01T12:00:00.000Z"),
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

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  process.env = { ...originalEnv, ...overrides };
  try {
    fn();
  } finally {
    process.env = { ...originalEnv };
  }
}

async function withEnvAsync(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
) {
  process.env = { ...originalEnv, ...overrides };
  try {
    await fn();
  } finally {
    process.env = { ...originalEnv };
  }
}

function expectError<T extends Error>(
  name: string,
  fn: () => unknown,
  ErrorClass: new (...args: never[]) => T
) {
  try {
    fn();
    console.error("FAIL:", name, `(expected ${ErrorClass.name})`);
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ErrorClass);
  }
}

const appContext = toAuthorityAppContext(assertActiveAuthorityApp(APP_ROW));
const redirectBaseUrl = "https://tenant.dubiz.test";
const redirectUri = buildRedirectUriFromBase(redirectBaseUrl);
const fixedState = "fixed-oauth-state-value-1234567890";

withEnv(ENV, () => {
  const composed = composeAuthorityOAuthStartResult({
    app: appContext,
    oauthBase: "https://openapi.taxes.gov.il",
    oauthPathSegment: "tsandbox",
    redirectBaseUrl,
    businessId: 42,
    actorUserId: 7,
    environment: BillingAuthorityEnvironment.SANDBOX,
    state: fixedState,
    secureCookies: false,
  });

  const url = new URL(composed.authorizationUrl);
  ok("authorization URL generation", url.origin === "https://openapi.taxes.gov.il");
  ok(
    "correct client_id usage",
    url.searchParams.get("client_id") === "sandbox-client-id"
  );
  ok(
    "correct redirect_uri usage",
    url.searchParams.get("redirect_uri") === redirectUri
  );
  ok("state generated in result", composed.state === fixedState);
  ok(
    "oauth response_type is code",
    url.searchParams.get("response_type") === ITA_OAUTH_RESPONSE_TYPE
  );
  ok("oauth scope is literal scope", url.searchParams.get("scope") === ITA_OAUTH_SCOPE);
  ok(
    "sandbox authorization URL path",
    url.pathname === "/shaam/tsandbox/longtimetoken/oauth2/authorize"
  );
});

const stateA = createAuthorityOAuthState();
const stateB = createAuthorityOAuthState();
ok("state uniqueness", stateA !== stateB && stateA.length >= 32);

withEnv(PROD_ENV, () => {
  const composed = composeAuthorityOAuthStartResult({
    app: {
      ...appContext,
      environment: BillingAuthorityEnvironment.PRODUCTION,
      itaClientId: "production-client-id",
    },
    oauthBase: "https://openapi.taxes.gov.il",
    oauthPathSegment: "production",
    redirectBaseUrl: "https://prod.dubiz.test",
    businessId: 42,
    actorUserId: 7,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    state: fixedState,
    secureCookies: false,
  });
  const url = new URL(composed.authorizationUrl);
  ok(
    "production authorization URL path",
    url.pathname === "/shaam/production/longtimetoken/oauth2/authorize"
  );
  ok(
    "tenant isolation in authorize URL client_id",
    url.searchParams.get("client_id") === "production-client-id"
  );
});

const cookies = buildAuthorityOAuthStateCookies({
  state: fixedState,
  businessId: 42,
  actorUserId: 7,
  environment: BillingAuthorityEnvironment.SANDBOX,
  secureCookies: false,
});
ok(
  "state persistence cookies scoped to business and environment",
  cookies.length === 4 &&
    cookies[0].name === AUTHORITY_OAUTH_COOKIE_NAMES.STATE &&
    cookies[1].value === "42" &&
    cookies[2].value === "SANDBOX"
);
ok(
  "actor user id carried for callback audit",
  cookies[3].name === AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID &&
    cookies[3].value === "7"
);
ok(
  "state cookies are httpOnly with expiration",
  cookies.every((cookie) => cookie.httpOnly && cookie.maxAge === 10 * 60)
);

ok(
  "buildAuthorityOAuthAuthorizeRedirectUrl encodes parameters",
  buildAuthorityOAuthAuthorizeRedirectUrl({
    authorizeEndpoint:
      "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/authorize",
    clientId: "client",
    redirectUri: "https://app.example.com/api/taxes/oauth/callback",
    state: "abc",
  }).includes("state=abc")
);

expectError("invalid app configuration rejected", () => {
  assertActiveAuthorityApp({
    ...APP_ROW,
    itaClientId: null,
  });
}, ServiceUnavailableError);

expectError("disabled app rejected", () => {
  assertActiveAuthorityApp({
    ...APP_ROW,
    status: BillingAuthorityAppStatus.DISABLED,
  });
}, ServiceUnavailableError);

withEnv(
  {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://app.dubiz.test",
  },
  () => {
    expectError("missing OAuth base rejected", () => {
      resolveAuthorityEnvConfig(BillingAuthorityEnvironment.SANDBOX);
    }, ValidationError);
  }
);

type FakeAuditEvent = {
  eventType: string;
  metadata: Record<string, unknown> | null;
};

function makeFakeOAuthDb() {
  const auditEvents: FakeAuditEvent[] = [];
  let connection = {
    id: 1,
    businessId: 42,
    environment: BillingAuthorityEnvironment.SANDBOX,
    status: BillingAuthorityConnectionStatus.DISCONNECTED,
    oauthAuthorizedAt: null,
    oauthAuthorizedByUserId: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    lastTokenRefreshAt: null,
    lastValidatedAt: null,
    revokedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    accessTokenEncrypted: null,
    accessTokenIv: null,
    accessTokenTag: null,
    refreshTokenEncrypted: null,
    refreshTokenIv: null,
    refreshTokenTag: null,
    encryptionKeyId: null,
    createdAt: new Date("2026-06-10T12:00:00.000Z"),
    updatedAt: new Date("2026-06-10T12:00:00.000Z"),
  };

  const tx = {
    billingAuthorityConnection: {
      async upsert() {
        return { ...connection };
      },
      async findUnique() {
        return { ...connection };
      },
      async update(args: {
        data: Prisma.BillingAuthorityConnectionUpdateInput;
      }) {
        connection = {
          ...connection,
          ...Object.fromEntries(
            Object.entries(args.data).filter(([, value]) => value !== undefined)
          ),
        } as typeof connection;
        connection.status =
          (args.data.status as BillingAuthorityConnectionStatus | undefined) ??
          connection.status;
        return { ...connection };
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
    getConnection: () => connection,
  };
}

async function runAsyncTests() {
  const fake = makeFakeOAuthDb();
  const started = await startAuthorityAuthorizationTx(fake.tx, {
    businessId: 42,
    environment: BillingAuthorityEnvironment.SANDBOX,
    actorUserId: 7,
  });
  ok(
    "start authorization transition to AUTHORIZATION_REQUIRED",
    started.toStatus === "AUTHORIZATION_REQUIRED" && started.auditWritten
  );
  ok(
    "audit emitted once for oauth started",
    fake.auditEvents.length === 1 &&
      fake.auditEvents[0].eventType === "BILLING_AUTHORITY_OAUTH_STARTED"
  );
  ok(
    "no secrets in audit metadata",
    fake.auditEvents[0].metadata != null &&
      !("state" in fake.auditEvents[0].metadata!) &&
      !("clientSecretEncrypted" in fake.auditEvents[0].metadata!) &&
      !("accessTokenEncrypted" in fake.auditEvents[0].metadata!)
  );

  const idempotent = await startAuthorityAuthorizationTx(fake.tx, {
    businessId: 42,
    environment: BillingAuthorityEnvironment.SANDBOX,
    actorUserId: 7,
  });
  ok(
    "AUTHORIZATION_REQUIRED start is idempotent",
    idempotent.auditWritten === false &&
      idempotent.toStatus === "AUTHORIZATION_REQUIRED"
  );
  ok(
    "idempotent start does not duplicate audit",
    fake.auditEvents.length === 1
  );

  const sandboxFake = makeFakeOAuthDb();
  const productionFake = makeFakeOAuthDb();
  productionFake.getConnection().environment = BillingAuthorityEnvironment.PRODUCTION;
  productionFake.getConnection().businessId = 42;

  await startAuthorityAuthorizationTx(sandboxFake.tx, {
    businessId: 42,
    environment: BillingAuthorityEnvironment.SANDBOX,
    actorUserId: 7,
  });
  await startAuthorityAuthorizationTx(productionFake.tx, {
    businessId: 42,
    environment: BillingAuthorityEnvironment.PRODUCTION,
    actorUserId: 7,
  });
  ok(
    "sandbox and production authorizations are independent",
    sandboxFake.getConnection().environment === "SANDBOX" &&
      productionFake.getConnection().environment === "PRODUCTION"
  );

  await withEnvAsync(ENV, async () => {
    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;

    const liveFake = makeFakeOAuthDb();
    // W4E-B-1: billingTenantTx opens the transaction through
    // withTenantTransaction, which sets the tenant GUC on the tx before running
    // the callback — so the double must expose $queryRaw like a real one.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({
        ...liveFake.tx,
        $queryRaw: async () => [],
      } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

    try {
      const result = await startAuthorityOAuth({
        businessId: 42,
        actorUserId: 7,
        environment: BillingAuthorityEnvironment.SANDBOX,
        redirectBaseUrl,
        secureCookies: false,
      });

      ok(
        "startAuthorityOAuth returns authorization URL and state",
        result.authorizationUrl.includes("client_id=sandbox-client-id") &&
          result.state.length > 0
      );
      ok(
        "startAuthorityOAuth wires connection transition audit",
        liveFake.auditEvents.length === 1
      );
      ok(
        "startAuthorityOAuth cookies prepared for callback",
        result.cookies.some(
          (cookie) => cookie.name === AUTHORITY_OAUTH_COOKIE_NAMES.STATE
        )
      );
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });
}

async function runTests() {
  await runAsyncTests();

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll authority OAuth start tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
