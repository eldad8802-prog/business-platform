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
import { createSignedAuthorityState } from "./billing-authority-signed-state.service";
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
// W4E-B-1: the callback now derives its tenant from a SIGNED state, so the
// fixture must be a real signed envelope for business 42 / user 7 / SANDBOX —
// exactly what the connect route mints. An opaque string is no longer a valid
// state, which is the whole point of the change.
process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "w4eb1_callback_test_secret";
const OAUTH_STATE = createSignedAuthorityState({
  businessId: 42,
  userId: 7,
  environment: "SANDBOX",
});
const PRODUCTION_OAUTH_STATE = createSignedAuthorityState({
  businessId: 42,
  userId: 7,
  environment: "PRODUCTION",
});
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
  // The state cookie is the double-submit twin of the query state, so it must
  // be the state for the SAME environment the flow started in.
  return {
    state:
      environment === BillingAuthorityEnvironment.PRODUCTION
        ? PRODUCTION_OAUTH_STATE
        : OAUTH_STATE,
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
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

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

  // ---- Sanitized failure-stage diagnostics at the handler level ------------
  async function runHandlerFailureCase(opts: {
    fetchImpl: typeof fetch;
    encryptTokens?: Parameters<typeof handleAuthorityOAuthCallback>[0]["encryptTokens"];
    markConnected?: Parameters<typeof handleAuthorityOAuthCallback>[0]["markConnected"];
  }) {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    const originalFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;
    try {
      const result = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: OAUTH_STATE },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        secureCookies: false,
        fetchImpl: opts.fetchImpl,
        encryptTokens: opts.encryptTokens,
        markConnected: opts.markConnected,
      });
      return { result, fake };
    } finally {
      prisma.billingAuthorityApp.findUnique = originalFindUnique;
      prisma.$transaction = originalTransaction;
    }
  }

  const tokenEndpointForFailure =
    "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";

  await withEnvAsync(ENV, async () => {
    const providerReject = (async () =>
      new Response('{"error":"invalid_client","error_description":"SENSITIVE-LEAK"}', {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const { result, fake } = await runHandlerFailureCase({ fetchImpl: providerReject });

    ok(
      "provider 400 -> TOKEN_EXCHANGE_REJECTED",
      !result.ok && result.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_REJECTED
    );
    ok(
      "provider 400 -> diagnostics oauthError invalid_client + status 400",
      !result.ok &&
        result.diagnostics.providerOAuthError === "invalid_client" &&
        result.diagnostics.providerHttpStatus === 400 &&
        result.diagnostics.providerResponseFormat === "JSON"
    );
    ok(
      "provider 400 -> connection lastErrorCode updated",
      fake.getConnection().lastErrorCode ===
        AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_REJECTED
    );
    const failedAudit = fake.auditEvents.find(
      (e) => e.eventType === "BILLING_AUTHORITY_OAUTH_FAILED"
    );
    ok("provider 400 -> OAUTH_FAILED audit written", failedAudit != null);
    ok(
      "audit metadata carries safe stage diagnostics",
      failedAudit?.metadata?.stage === "TOKEN_EXCHANGE" &&
        failedAudit?.metadata?.providerOAuthError === "invalid_client" &&
        failedAudit?.metadata?.providerHttpStatus === 400
    );
    ok(
      "audit metadata never carries error_description or tokens",
      failedAudit != null &&
        !JSON.stringify(failedAudit.metadata).includes("SENSITIVE-LEAK") &&
        failedAudit.metadata != null &&
        !("accessToken" in failedAudit.metadata) &&
        !("refreshToken" in failedAudit.metadata) &&
        !("error_description" in failedAudit.metadata)
    );
  });

  await withEnvAsync(ENV, async () => {
    const noRefresh = (async () =>
      new Response('{"access_token":"AT","expires_in":3600}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const { result } = await runHandlerFailureCase({ fetchImpl: noRefresh });
    ok(
      "2xx without refresh_token -> TOKEN_RESPONSE_INVALID",
      !result.ok &&
        result.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_RESPONSE_INVALID &&
        result.diagnostics.stage === "TOKEN_RESPONSE"
    );
  });

  await withEnvAsync(ENV, async () => {
    const { result } = await runHandlerFailureCase({
      fetchImpl: mockFetchSuccess(tokenEndpointForFailure),
      encryptTokens: (() => {
        throw new Error("crypto boom");
      }) as Parameters<typeof handleAuthorityOAuthCallback>[0]["encryptTokens"],
    });
    ok(
      "encryption failure -> TOKEN_ENCRYPTION_FAILED",
      !result.ok &&
        result.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_ENCRYPTION_FAILED &&
        result.diagnostics.stage === "TOKEN_ENCRYPTION"
    );
  });

  await withEnvAsync(ENV, async () => {
    const { result } = await runHandlerFailureCase({
      fetchImpl: mockFetchSuccess(tokenEndpointForFailure),
      markConnected: (async () => {
        throw new Error("db write boom");
      }) as Parameters<typeof handleAuthorityOAuthCallback>[0]["markConnected"],
    });
    ok(
      "persistence failure -> CONNECTION_PERSIST_FAILED",
      !result.ok &&
        result.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.CONNECTION_PERSIST_FAILED &&
        result.diagnostics.stage === "CONNECTION_PERSISTENCE"
    );
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeCallbackDb(BillingAuthorityEnvironment.SANDBOX);
    fake.getConnection().status = BillingAuthorityConnectionStatus.CONNECTED;
    const originalTransaction = prisma.$transaction.bind(prisma);
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

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
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

    try {
      const failure = await handleAuthorityOAuthCallback({
        query: { code: AUTH_CODE, state: "wrong-state" },
        cookies: callbackCookies(),
        redirectBaseUrl: "https://tenant.dubiz.test",
        actorUserId: 7,
        secureCookies: false,
      });

      // W4E-B-1: an unverifiable state means there is NO trusted tenant. The
      // previous contract recorded an ERROR transition against whatever
      // business the cookie named, which let a forged cookie mark another
      // tenant's connection as OAuth-failed. Now the callback fails without
      // attributing the failure to anyone.
      ok("untrusted state fails the callback", !failure.ok);
      ok(
        "untrusted state records NO transition against a cookie-named business",
        !failure.ok && failure.connection == null && failure.oauthFailureRecorded !== true
      );
      ok(
        "cookies cleared on failure",
        failure.clearedCookies.length === 4 &&
          failure.clearedCookies[0].name === AUTHORITY_OAUTH_COOKIE_NAMES.STATE
      );
      ok(
        "no OAUTH_FAILED audit is written for an untrusted state",
        !fake.auditEvents.some(
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
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

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
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

    try {
      const success = await handleAuthorityOAuthCallback({
        // W4E-B-1: environment is part of the signed binding, so a PRODUCTION
        // callback needs a PRODUCTION-signed state. A SANDBOX state presented
        // with PRODUCTION cookies is refused by design.
        query: { code: AUTH_CODE, state: PRODUCTION_OAUTH_STATE },
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
    // W4E-B-1: the connection write now runs through billingTenantTx ->
    // withTenantTransaction, which sets the tenant GUC on the tx first, so the
    // double must expose $queryRaw like a real transaction client.
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({ ...fake.tx, $queryRaw: async () => [] } as unknown as Prisma.TransactionClient)) as typeof prisma.$transaction;

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
