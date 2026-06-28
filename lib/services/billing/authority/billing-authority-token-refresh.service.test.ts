/**
 * Authority token refresh (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-token-refresh.service.test.ts
 */
import { createCipheriv, randomBytes } from "node:crypto";
import {
  BillingAuthorityAppStatus,
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { assertActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { buildAuthorityOAuthTokenUrl } from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  AUTHORITY_REFRESH_ERROR_CODES,
  classifyAuthorityRefreshHttpStatus,
  classifyAuthorityRefreshOAuthError,
  exchangeAuthorityRefreshToken,
  refreshAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import {
  decryptAuthorityConnectionToken,
  encryptAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-crypto.service";

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
const OLD_ACCESS_TOKEN = "old-access-token-plain";
const OLD_REFRESH_TOKEN = "old-refresh-token-plain";
const NEW_ACCESS_TOKEN = "new-access-token-plain";
const NEW_REFRESH_TOKEN = "new-refresh-token-plain";
const BUSINESS_ID = 42;

const originalEnv = {
  ...process.env,
  BILLING_AUTHORITY_ENCRYPTION_KEY: ENCRYPTION_KEY,
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

function encryptedTokens(
  businessId: number,
  environment: BillingAuthorityEnvironment,
  accessToken = OLD_ACCESS_TOKEN,
  refreshToken = OLD_REFRESH_TOKEN
) {
  const access = encryptAuthorityConnectionToken(accessToken, businessId, environment);
  const refresh = encryptAuthorityConnectionToken(
    refreshToken,
    businessId,
    environment
  );
  return { access, refresh };
}

function makeFakeRefreshDb(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  status: BillingAuthorityConnectionStatus;
  includeRefreshToken?: boolean;
  accessToken?: string;
  refreshToken?: string;
}) {
  const auditEvents: FakeAuditEvent[] = [];
  const tokens = encryptedTokens(
    input.businessId,
    input.environment,
    input.accessToken ?? OLD_ACCESS_TOKEN,
    input.refreshToken ?? OLD_REFRESH_TOKEN
  );

  let connection = {
    id: 1,
    businessId: input.businessId,
    environment: input.environment,
    status: input.status,
    oauthAuthorizedAt: new Date("2026-06-10T10:00:00.000Z"),
    oauthAuthorizedByUserId: 7,
    accessTokenExpiresAt: new Date("2026-06-10T11:00:00.000Z"),
    refreshTokenExpiresAt: null,
    lastTokenRefreshAt: null,
    lastValidatedAt:
      input.status === BillingAuthorityConnectionStatus.VALIDATED
        ? new Date("2026-06-10T11:30:00.000Z")
        : null,
    revokedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    accessTokenEncrypted: tokens.access.encrypted,
    accessTokenIv: tokens.access.iv,
    accessTokenTag: tokens.access.tag,
    refreshTokenEncrypted:
      input.includeRefreshToken === false ? null : tokens.refresh.encrypted,
    refreshTokenIv:
      input.includeRefreshToken === false ? null : tokens.refresh.iv,
    refreshTokenTag:
      input.includeRefreshToken === false ? null : tokens.refresh.tag,
    encryptionKeyId: "authority_gcm_v1",
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    updatedAt: new Date("2026-06-10T09:00:00.000Z"),
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
    originalRefreshCipher: tokens.refresh.encrypted,
  };
}

function mockRefreshFetch(input: {
  tokenEndpoint: string;
  status: number;
  body?: Record<string, unknown>;
  delayMs?: number;
  shouldThrow?: boolean;
}) {
  return (async (url: string, init?: RequestInit) => {
    ok("refresh exchange uses POST", init?.method === "POST");
    ok(
      "refresh exchange uses Basic auth",
      typeof init?.headers === "object" &&
        init.headers !== null &&
        "Authorization" in init.headers &&
        String((init.headers as Record<string, string>).Authorization).startsWith(
          "Basic "
        )
    );
    ok("refresh exchange hits configured endpoint", url === input.tokenEndpoint);

    const body = init?.body ? new URLSearchParams(String(init.body)) : null;
    ok(
      "refresh exchange uses refresh_token grant",
      body?.get("grant_type") === "refresh_token"
    );

    if (input.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    }

    if (input.shouldThrow) {
      throw new TypeError("fetch failed");
    }

    return new Response(JSON.stringify(input.body ?? {}), {
      status: input.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

withEnv(ENV, () => {
  ok(
    "classify unauthorized refresh as auth failure",
    classifyAuthorityRefreshHttpStatus(401) === "AUTH_FAILURE"
  );
  ok(
    "classify 5xx refresh as network failure",
    classifyAuthorityRefreshHttpStatus(503) === "NETWORK_FAILURE"
  );
  ok(
    "classify invalid_client oauth error",
    classifyAuthorityRefreshOAuthError("invalid_client").errorCode ===
      AUTHORITY_REFRESH_ERROR_CODES.INVALID_CLIENT
  );
  ok(
    "classify invalid_grant oauth error",
    classifyAuthorityRefreshOAuthError("invalid_grant").outcome === "AUTH_FAILURE"
  );
});

async function runAsyncTests() {
  const sandboxTokenEndpoint =
    "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";
  const prodTokenEndpoint =
    "https://openapi.taxes.gov.il/shaam/production/longtimetoken/oauth2/token";

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: {
            access_token: NEW_ACCESS_TOKEN,
            expires_in: 3600,
            token_type: "Bearer",
          },
        }),
      });

      ok("refresh CONNECTED connection", result.ok && result.refreshed);
      ok(
        "successful refresh keeps CONNECTED status",
        fake.getConnection().status === "CONNECTED"
      );
      ok(
        "audit refresh success emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_TOKEN_REFRESHED"
        )
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
        }),
      });
      ok(
        "refresh VALIDATED connection",
        result.ok && fake.getConnection().status === "VALIDATED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    prisma.billingAuthorityConnection.findUnique = (async () =>
      null) as typeof prisma.billingAuthorityConnection.findUnique;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok(
        "missing connection rejected",
        !result.ok &&
          result.outcome === "CONFIGURATION_FAILURE" &&
          result.errorCode === AUTHORITY_REFRESH_ERROR_CODES.NOT_REFRESHABLE
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
      includeRefreshToken: false,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok(
        "missing refresh token rejected",
        !result.ok &&
          result.errorCode === AUTHORITY_REFRESH_ERROR_CODES.NOT_REFRESHABLE
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const beforeAccess = fake.getConnection().accessTokenEncrypted;
      await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
        }),
      });
      ok(
        "access token replaced",
        fake.getConnection().accessTokenEncrypted !== beforeAccess
      );
      ok(
        "stored access token is encrypted only",
        fake.getConnection().accessTokenEncrypted !== NEW_ACCESS_TOKEN
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: {
            access_token: NEW_ACCESS_TOKEN,
            refresh_token: NEW_REFRESH_TOKEN,
            expires_in: 3600,
          },
        }),
      });
      ok(
        "refresh token rotation updates ciphertext",
        fake.getConnection().refreshTokenEncrypted !== fake.originalRefreshCipher
      );
      const decrypted = decryptAuthorityConnectionToken(
        {
          encrypted: fake.getConnection().refreshTokenEncrypted!,
          iv: fake.getConnection().refreshTokenIv!,
          tag: fake.getConnection().refreshTokenTag!,
        },
        BUSINESS_ID,
        BillingAuthorityEnvironment.SANDBOX
      );
      ok("rotated refresh token decrypts to new value", decrypted === NEW_REFRESH_TOKEN);
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
        }),
      });
      ok(
        "refresh token preserved when absent",
        fake.getConnection().refreshTokenEncrypted === fake.originalRefreshCipher
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 401,
          body: { error: "invalid_grant", error_description: "Token expired" },
        }),
      });
      ok(
        "unauthorized refresh marks auth failure",
        !result.ok &&
          result.outcome === "AUTH_FAILURE" &&
          fake.getConnection().status === "AUTHORIZATION_REQUIRED"
      );
      ok(
        "auth failure transition audit emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_TOKEN_REFRESH_FAILED"
        )
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 400,
          body: { error: "invalid_grant", error_description: "Invalid refresh token" },
        }),
      });
      ok(
        "invalid refresh token marks auth failure",
        result.outcome === "AUTH_FAILURE"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 401,
          body: { error: "invalid_client", error_description: "Bad client" },
        }),
      });
      ok(
        "invalid client marks auth failure",
        result.outcome === "AUTH_FAILURE" &&
          result.errorCode === AUTHORITY_REFRESH_ERROR_CODES.INVALID_CLIENT &&
          fake.getConnection().status === "AUTHORIZATION_REQUIRED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        refreshTimeoutMs: 20,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          ok("refresh exchange hits configured endpoint", url === sandboxTokenEndpoint);
          await new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(() => _resolve(), 50);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
          return new Response(JSON.stringify({ access_token: NEW_ACCESS_TOKEN }), {
            status: 200,
          });
        }) as typeof fetch,
      });
      ok(
        "network timeout does not change status",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
      ok(
        "network timeout emits no auth failure audit",
        !fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_TOKEN_REFRESH_FAILED"
        )
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          shouldThrow: true,
        }),
      });
      ok(
        "network exception does not change status",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 503,
          body: { error: "server_error" },
        }),
      });
      ok(
        "ITA 5xx does not change status",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      APP_ROW) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: sandboxTokenEndpoint,
          status: 200,
          body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
        }),
      });
      ok(
        "audit contains no tokens",
        fake.auditEvents.every(
          (event) =>
            event.metadata == null ||
            (!("accessToken" in event.metadata) &&
              !("refreshToken" in event.metadata) &&
              !("authorization" in event.metadata) &&
              !("bearerToken" in event.metadata))
        )
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

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
    const fake = makeFakeRefreshDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.PRODUCTION,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    fake.getConnection().environment = BillingAuthorityEnvironment.PRODUCTION;

    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalAppFindUnique = prisma.billingAuthorityApp.findUnique.bind(
      prisma.billingAuthorityApp
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.billingAuthorityApp.findUnique = (async () =>
      prodApp) as typeof prisma.billingAuthorityApp.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await refreshAuthorityConnectionToken({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.PRODUCTION,
        fetchImpl: mockRefreshFetch({
          tokenEndpoint: prodTokenEndpoint,
          status: 200,
          body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
        }),
      });
      ok(
        "production refresh",
        result.ok && fake.getConnection().environment === "PRODUCTION"
      );
      ok("tenant isolation", fake.getConnection().businessId === BUSINESS_ID);
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.billingAuthorityApp.findUnique = originalAppFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const exchange = await exchangeAuthorityRefreshToken({
      tokenEndpoint: sandboxTokenEndpoint,
      clientId: "sandbox-client-id",
      clientSecret: CLIENT_SECRET,
      refreshToken: OLD_REFRESH_TOKEN,
      fetchImpl: mockRefreshFetch({
        tokenEndpoint: sandboxTokenEndpoint,
        status: 200,
        body: { access_token: NEW_ACCESS_TOKEN, expires_in: 3600 },
      }),
    });
    ok("successful refresh exchange helper", exchange.outcome === "REFRESHED");
  });

  withEnv(ENV, () => {
    ok(
      "sandbox token endpoint from env",
      buildAuthorityOAuthTokenUrl({
        environment: BillingAuthorityEnvironment.SANDBOX,
        oauthBase: "https://openapi.taxes.gov.il",
        apiBase: "https://ita-api.taxes.gov.il",
        oauthPathSegment: "tsandbox",
        redirectBaseUrl: "https://app.dubiz.test",
        redirectUri: "https://app.dubiz.test/api/taxes/oauth/callback",
      }) === sandboxTokenEndpoint
    );
  });

  try {
    await refreshAuthorityConnectionToken({
      businessId: 0,
      environment: BillingAuthorityEnvironment.SANDBOX,
    });
    console.error("FAIL: invalid business id throws");
    failed += 1;
  } catch (error) {
    ok("invalid business id throws", error instanceof ValidationError);
  }

  try {
    assertActiveAuthorityApp({ ...APP_ROW, status: BillingAuthorityAppStatus.DISABLED });
    console.error("FAIL: disabled app rejected");
    failed += 1;
  } catch {
    ok("disabled app rejected before exchange", true);
  }
}

async function runTests() {
  await runAsyncTests();

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll authority token refresh tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
