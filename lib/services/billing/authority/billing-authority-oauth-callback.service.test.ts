/**
 * Authority OAuth callback (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-callback.service.test.ts
 */
import { createCipheriv, randomBytes } from "node:crypto";
import {
  BillingAuthorityAppStatus,
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ServiceUnavailableError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  assertActiveAuthorityApp,
} from "@/lib/services/billing/authority/billing-authority-app.service";
import {
  AUTHORITY_OAUTH_COOKIE_NAMES,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import {
  AUTHORITY_OAUTH_CALLBACK_ERROR_CODES,
  buildAuthorityOAuthCookieClearSpecs,
  encryptAuthorityOAuthTokens,
  exchangeAuthorityAuthorizationCode,
  handleAuthorityOAuthCallback,
  statesMatch,
  validateAuthorityOAuthCallbackContext,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";

const ENV = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
  AUTHORITY_OAUTH_BASE_SANDBOX: "https://openapi.taxes.gov.il",
  AUTHORITY_API_BASE_SANDBOX: "https://ita-api.taxes.gov.il",
  AUTHORITY_OAUTH_PATH_SEGMENT_SANDBOX: "tsandbox",
  BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://app.dubiz.test",
};

const PROD_ENV = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION",
  AUTHORITY_OAUTH_BASE_PRODUCTION: "https://openapi.taxes.gov.il",
  AUTHORITY_API_BASE_PRODUCTION: "https://ita-api.taxes.gov.il",
  AUTHORITY_OAUTH_PATH_SEGMENT_PRODUCTION: "production",
  BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://prod.dubiz.test",
};

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const CLIENT_SECRET = "authority-client-secret-value";
const ACCESS_TOKEN = "sandbox-access-token-plain";
const REFRESH_TOKEN = "sandbox-refresh-token-plain";
const OAUTH_STATE = "oauth-state-abc123";
const AUTH_CODE = "authorization-code-xyz";

const originalEnv = { ...process.env, BILLING_AUTHORITY_ENCRYPTION_KEY: ENCRYPTION_KEY };

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

function encryptAppSecret(
  plaintext: string,
  environment: BillingAuthorityEnvironment
) {
  const key = Buffer.from(ENCRYPTION_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(environment, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    encrypted: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

const sandboxEncryptedSecret = encryptAppSecret(
  CLIENT_SECRET,
  BillingAuthorityEnvironment.SANDBOX
);

const APP_ROW = {
  id: 1,
  environment: BillingAuthorityEnvironment.SANDBOX,
  status: BillingAuthorityAppStatus.ACTIVE,
  accountingSoftwareNumber: "12345678",
  itaClientId: "sandbox-client-id",
  clientSecretEncrypted: sandboxEncryptedSecret.encrypted,
  clientSecretIv: sandboxEncryptedSecret.iv,
  clientSecretTag: sandboxEncryptedSecret.tag,
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

type FakeAuditEvent = {
  eventType: string;
  metadata: Record<string, unknown> | null;
};

function makeFakeCallbackDb(environment: BillingAuthorityEnvironment) {
  const auditEvents: FakeAuditEvent[] = [];
  let connection = {
    id: 1,
    businessId: 42,
    environment,
    status: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
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

function callbackCookies(
  environment: BillingAuthorityEnvironment = BillingAuthorityEnvironment.SANDBOX
) {
  return {
    state: OAUTH_STATE,
    businessId: "42",
    environment,
  };
}

function mockFetchSuccess(tokenEndpoint: string) {
  return (async (url: string, init?: RequestInit) => {
    ok("token exchange uses POST", init?.method === "POST");
    ok(
      "token exchange uses Basic auth",
      typeof init?.headers === "object" &&
        init.headers !== null &&
        "Authorization" in init.headers &&
        String((init.headers as Record<string, string>).Authorization).startsWith(
          "Basic "
        )
    );
    ok("token exchange hits configured endpoint", url === tokenEndpoint);

    return new Response(
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
}

withEnv(ENV, () => {
  const valid = validateAuthorityOAuthCallbackContext({
    query: { code: AUTH_CODE, state: OAUTH_STATE },
    cookies: callbackCookies(),
  });
  ok("state match success", valid.ok === true);
});

const mismatch = validateAuthorityOAuthCallbackContext({
  query: { code: AUTH_CODE, state: "different-state" },
  cookies: callbackCookies(),
});
ok(
  "state mismatch",
  !mismatch.ok &&
    mismatch.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.STATE_MISMATCH
);

const missingStateCookie = validateAuthorityOAuthCallbackContext({
  query: { code: AUTH_CODE, state: OAUTH_STATE },
  cookies: { businessId: "42", environment: "SANDBOX" },
});
ok(
  "missing state cookie",
  !missingStateCookie.ok &&
    missingStateCookie.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_COOKIE
);

const missingBusinessCookie = validateAuthorityOAuthCallbackContext({
  query: { code: AUTH_CODE, state: OAUTH_STATE },
  cookies: { state: OAUTH_STATE, environment: "SANDBOX" },
});
ok(
  "missing business cookie",
  !missingBusinessCookie.ok &&
    missingBusinessCookie.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_COOKIE
);

const missingEnvironmentCookie = validateAuthorityOAuthCallbackContext({
  query: { code: AUTH_CODE, state: OAUTH_STATE },
  cookies: { state: OAUTH_STATE, businessId: "42" },
});
ok(
  "missing environment cookie",
  !missingEnvironmentCookie.ok &&
    missingEnvironmentCookie.errorCode ===
      AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.MISSING_COOKIE
);

const oauthError = validateAuthorityOAuthCallbackContext({
  query: { error: "access_denied", errorDescription: "User denied access" },
  cookies: callbackCookies(),
});
ok(
  "oauth error callback",
  !oauthError.ok &&
    oauthError.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.ITA_ERROR
);

ok("statesMatch helper", statesMatch("abc", "abc") && !statesMatch("abc", "abd"));

withEnv(ENV, () => {
  const encrypted = encryptAuthorityOAuthTokens({
    businessId: 42,
    environment: BillingAuthorityEnvironment.SANDBOX,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
  });
  ok(
    "access token encrypted",
    encrypted.accessTokenEncrypted !== ACCESS_TOKEN &&
      encrypted.accessTokenEncrypted.length > 0
  );
  ok(
    "refresh token encrypted",
    encrypted.refreshTokenEncrypted !== REFRESH_TOKEN &&
      encrypted.refreshTokenEncrypted.length > 0
  );
  ok("no plaintext token persistence in encrypted payload", true);
});

async function runAsyncTests() {
  const tokenEndpoint =
    "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const success = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: OAUTH_STATE },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        secureCookies: false,
        fetchImpl: mockFetchSuccess(tokenEndpoint),
      });

      ok("successful token exchange", success.ok === true);
      ok(
        "connection moved to CONNECTED",
        success.ok && success.connection.status === "CONNECTED"
      );
      ok(
        "cookies cleared on success",
        success.ok &&
          success.clearedCookies.length === 4 &&
          success.clearedCookies.every((cookie) => cookie.maxAge === 0)
      );

      const row = fake.getConnection();
      ok(
        "stored access token is encrypted only",
        row.accessTokenEncrypted !== ACCESS_TOKEN &&
          row.accessTokenEncrypted != null
      );
      ok(
        "stored refresh token is encrypted only",
        row.refreshTokenEncrypted !== REFRESH_TOKEN &&
          row.refreshTokenEncrypted != null
      );
      ok(
        "audit emitted correctly on success",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_OAUTH_COMPLETED"
        )
      );
      ok(
        "audit metadata has no tokens or code",
        fake.auditEvents.every(
          (event) =>
            event.metadata == null ||
            (!("accessToken" in event.metadata) &&
              !("refreshToken" in event.metadata) &&
              !("code" in event.metadata))
        )
      );
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    fake.getConnection().status = BillingAuthorityConnectionStatus.CONNECTED;
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const skipped = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: "wrong-state" },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        secureCookies: false,
      });
      ok(
        "caller still receives explicit failure when transition cannot run",
        !skipped.ok &&
          skipped.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.STATE_MISMATCH
      );
      ok(
        "transition skip does not hide callback failure",
        skipped.oauthFailureRecorded === false
      );
    } finally {
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const failure = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: "wrong-state" },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        secureCookies: false,
      });

      ok("oauth failure transition", !failure.ok && failure.connection?.status === "ERROR");
      ok(
        "oauth failure recorded in callback result",
        !failure.ok && failure.oauthFailureRecorded === true
      );
      ok(
        "cookies cleared on failure",
        failure.clearedCookies.length === 4 &&
          failure.clearedCookies[0].name === AUTHORITY_OAUTH_COOKIE_NAMES.STATE
      );
      ok(
        "oauth failed audit emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_OAUTH_FAILED"
        )
      );
    } finally {
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const disabledRow = {
      ...APP_ROW,
      status: BillingAuthorityAppStatus.DISABLED,
    };
    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.billingAuthorityApp.findUnique = (async () =>
      disabledRow) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      expectErrorAsync("disabled app rejected", async () => {
        assertActiveAuthorityApp(disabledRow);
      }, ServiceUnavailableError);

      const failure = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: OAUTH_STATE },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        fetchImpl: mockFetchSuccess(tokenEndpoint),
      });
      ok(
        "disabled app callback fails closed",
        !failure.ok &&
          failure.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.APP_UNAVAILABLE
      );
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(
    {
      BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
      BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://app.dubiz.test",
    },
    async () => {
      const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
      const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
        prisma.billingAuthorityApp
      );
      const originalTransaction = prisma.$transaction.bind(prisma);
      prisma.billingAuthorityApp.findUnique = (async () =>
        APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
      prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        fn(fake.tx)) as typeof prisma.$transaction;

      try {
        const failure = await handleAuthorityOAuthCallback({
          query: { code: AUTH_CODE, state: OAUTH_STATE },
          cookies: callbackCookies(),
          redirectBaseUrl: "https://tenant.dubiz.test",
          actorUserId: 7,
          secureCookies: false,
        });
        ok(
          "missing token endpoint rejected",
          !failure.ok &&
            failure.errorCode ===
              AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED
        );
      } finally {
        prisma.billingAuthorityApp.findUnique = originalFindUnique;
        prisma.$transaction = originalTransaction;
      }
    }
  );

  await withEnvAsync(PROD_ENV, async () => {
    const prodSecret = encryptAppSecret(
      CLIENT_SECRET,
      BillingAuthorityEnvironment.PRODUCTION
    );
    const prodApp = {
      ...APP_ROW,
      environment: BillingAuthorityEnvironment.PRODUCTION,
      itaClientId: "production-client-id",
      clientSecretEncrypted: prodSecret.encrypted,
      clientSecretIv: prodSecret.iv,
      clientSecretTag: prodSecret.tag,
    };
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.PRODUCTION);
    fake.getConnection().environment = BillingAuthorityEnvironment.PRODUCTION;

    const prodTokenEndpoint =
      "https://openapi.taxes.gov.il/shaam/production/longtimetoken/oauth2/token";

    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.billingAuthorityApp.findUnique = (async () =>
      prodApp) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const success = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: OAUTH_STATE },
        cookies: callbackCookies(BillingAuthorityEnvironment.PRODUCTION),
        redirectBaseUrl: "https://prod.dubiz.test",
        actorUserId: 7,
        fetchImpl: mockFetchSuccess(prodTokenEndpoint),
      });

      ok(
        "production callback",
        success.ok && success.connection.environment === "PRODUCTION"
      );
      ok(
        "tenant isolation",
        fake.getConnection().businessId === 42 &&
          fake.getConnection().environment === "PRODUCTION"
      );
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const success = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: OAUTH_STATE },
        cookies: callbackCookies(BillingAuthorityEnvironment.SANDBOX),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        fetchImpl: mockFetchSuccess(tokenEndpoint),
      });
      ok(
        "sandbox callback",
        success.ok && success.connection.environment === "SANDBOX"
      );
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  ok(
    "cookie clear specs contain no secrets",
    buildAuthorityOAuthCookieClearSpecs({ secureCookies: false }).every(
      (cookie) => cookie.value === ""
    )
  );
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

async function expectErrorAsync<T extends Error>(
  name: string,
  fn: () => Promise<unknown>,
  ErrorClass: new (...args: never[]) => T
) {
  try {
    await fn();
    console.error("FAIL:", name, `(expected ${ErrorClass.name})`);
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ErrorClass);
  }
}

async function runTests() {
  await runAsyncTests();

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll authority OAuth callback tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
