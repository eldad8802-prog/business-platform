/**
 * Authority connection validation (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-validation.service.test.ts
 */
import {
  BillingAuthorityConnectionStatus,
  BillingAuthorityEnvironment,
  Prisma,
} from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  assessAuthorityConnectionValidatability,
  AUTHORITY_VALIDATION_ERROR_CODES,
  AUTHORITY_VALIDATION_PROBE_CONFIRMATION_NUMBER,
  AUTHORITY_VALIDATION_PROBE_VAT_SENTINEL,
  buildAuthorityValidationProbePayload,
  buildAuthorityValidationProbeUrl,
  classifyAuthorityValidationHttpStatus,
  executeAuthorityValidationProbe,
  validateAuthorityConnection,
} from "@/lib/services/billing/authority/billing-authority-validation.service";
import { resolveAuthorityEnvConfig } from "@/lib/services/billing/authority/billing-authority-env.service";
import {
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

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const ACCESS_TOKEN = "sandbox-access-token-plain";
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

function encryptedAccessToken(
  businessId: number,
  environment: BillingAuthorityEnvironment
) {
  return encryptAuthorityConnectionToken(ACCESS_TOKEN, businessId, environment);
}

type FakeAuditEvent = {
  eventType: string;
  metadata: Record<string, unknown> | null;
};

function makeFakeValidationDb(input: {
  businessId: number;
  environment: BillingAuthorityEnvironment;
  status: BillingAuthorityConnectionStatus;
  includeAccessToken?: boolean;
}) {
  const auditEvents: FakeAuditEvent[] = [];
  const access = encryptedAccessToken(input.businessId, input.environment);
  let connection = {
    id: 1,
    businessId: input.businessId,
    environment: input.environment,
    status: input.status,
    oauthAuthorizedAt: new Date("2026-06-10T10:00:00.000Z"),
    oauthAuthorizedByUserId: 7,
    accessTokenExpiresAt: new Date("2026-06-11T10:00:00.000Z"),
    refreshTokenExpiresAt: null,
    lastTokenRefreshAt: null,
    lastValidatedAt:
      input.status === BillingAuthorityConnectionStatus.VALIDATED
        ? new Date("2026-06-10T11:00:00.000Z")
        : null,
    revokedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    accessTokenEncrypted:
      input.includeAccessToken === false ? null : access.encrypted,
    accessTokenIv: input.includeAccessToken === false ? null : access.iv,
    accessTokenTag: input.includeAccessToken === false ? null : access.tag,
    refreshTokenEncrypted: "refresh-cipher",
    refreshTokenIv: "refresh-iv",
    refreshTokenTag: "refresh-tag",
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
        if (args.data.lastValidatedAt !== undefined) {
          connection.lastValidatedAt = args.data.lastValidatedAt as Date | null;
        }
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

function mockProbeFetch(input: {
  probeUrl: string;
  status: number;
  delayMs?: number;
  shouldThrow?: boolean;
}) {
  return (async (url: string, init?: RequestInit) => {
    ok("validation probe uses POST", init?.method === "POST");
    ok(
      "validation probe uses Bearer auth",
      typeof init?.headers === "object" &&
        init.headers !== null &&
        "Authorization" in init.headers &&
        String((init.headers as Record<string, string>).Authorization).startsWith(
          "Bearer "
        )
    );
    ok("validation probe hits configured endpoint", url === input.probeUrl);

    const body = init?.body ? JSON.parse(String(init.body)) : null;
    ok(
      "validation probe uses sentinel confirmation number",
      body?.confirmation_number === AUTHORITY_VALIDATION_PROBE_CONFIRMATION_NUMBER
    );

    if (input.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    }

    if (input.shouldThrow) {
      throw new TypeError("fetch failed");
    }

    return new Response(JSON.stringify({ message: "probe" }), {
      status: input.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

withEnv(ENV, () => {
  const config = resolveAuthorityEnvConfig(BillingAuthorityEnvironment.SANDBOX);
  ok(
    "sandbox validation probe url",
    buildAuthorityValidationProbeUrl(config) ===
      "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details"
  );
});

withEnv(PROD_ENV, () => {
  const config = resolveAuthorityEnvConfig(BillingAuthorityEnvironment.PRODUCTION);
  ok(
    "production validation probe url",
    buildAuthorityValidationProbeUrl(config) ===
      "https://ita-api.taxes.gov.il/shaam/production/invoice-information/v1/details"
  );
});

ok(
  "probe payload uses sentinel vat when unknown",
  buildAuthorityValidationProbePayload().customer_vat_number ===
    AUTHORITY_VALIDATION_PROBE_VAT_SENTINEL
);
ok(
  "probe payload uses business vat when provided",
  buildAuthorityValidationProbePayload({ customerVatNumber: "514444441" })
    .customer_vat_number === "514444441"
);

ok(
  "classify unauthorized as auth failure",
  classifyAuthorityValidationHttpStatus(401) === "AUTH_FAILURE"
);
ok(
  "classify forbidden as auth failure",
  classifyAuthorityValidationHttpStatus(403) === "AUTH_FAILURE"
);
ok(
  "classify 422 as valid auth",
  classifyAuthorityValidationHttpStatus(422) === "VALID"
);
ok(
  "classify 5xx as network failure",
  classifyAuthorityValidationHttpStatus(503) === "NETWORK_FAILURE"
);

async function runAsyncTests() {
  const sandboxProbeUrl =
    "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details";
  const prodProbeUrl =
    "https://ita-api.taxes.gov.il/shaam/production/invoice-information/v1/details";

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        actorUserId: 7,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 422 }),
      });

      ok("validate CONNECTED connection", result.ok && result.validated);
      ok(
        "successful probe transitions to VALIDATED",
        fake.getConnection().status === "VALIDATED"
      );
      ok(
        "success transition audit emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_CONNECTION_VALIDATED"
        )
      );
      ok(
        "stored access token remains encrypted only",
        fake.getConnection().accessTokenEncrypted !== ACCESS_TOKEN
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const first = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 400 }),
      });
      const second = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 400 }),
      });

      ok("validate already VALIDATED connection", first.ok && first.validated);
      ok(
        "validation replay remains safe",
        second.ok &&
          second.validated &&
          fake.getConnection().status === "VALIDATED"
      );
      ok(
        "validation replay does not duplicate success audit",
        fake.auditEvents.filter(
          (event) => event.eventType === "BILLING_AUTHORITY_CONNECTION_VALIDATED"
        ).length === 0
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
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
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok(
        "missing connection rejected",
        !result.ok &&
          result.outcome === "CONFIGURATION_FAILURE" &&
          result.errorCode === AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
      includeAccessToken: false,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
      });
      ok(
        "missing encrypted token rejected",
        !result.ok &&
          result.errorCode === AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 200 }),
      });
      ok("successful probe with 200", result.ok && result.outcome === "VALID");
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 401 }),
      });
      ok(
        "unauthorized response marks auth failure",
        !result.ok &&
          result.outcome === "AUTH_FAILURE" &&
          fake.getConnection().status === "ERROR"
      );
      ok(
        "auth failure transition audit emitted",
        fake.auditEvents.some(
          (event) => event.eventType === "BILLING_AUTHORITY_AUTH_FAILURE"
        )
      );
      ok(
        "auth failure keeps encrypted tokens",
        fake.getConnection().accessTokenEncrypted != null
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.VALIDATED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 403 }),
      });
      ok(
        "forbidden response marks auth failure from VALIDATED",
        !result.ok &&
          result.outcome === "AUTH_FAILURE" &&
          fake.getConnection().status === "ERROR"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 401 }),
      });
      ok(
        "expired token response treated as auth failure",
        result.outcome === "AUTH_FAILURE"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        probeTimeoutMs: 20,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          ok("validation probe uses POST", init?.method === "POST");
          ok("validation probe hits configured endpoint", url === sandboxProbeUrl);

          await new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(() => _resolve(), 50);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });

          return new Response(JSON.stringify({ message: "late" }), { status: 200 });
        }) as typeof fetch,
      });
      ok(
        "network timeout does not move to ERROR",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({
          probeUrl: sandboxProbeUrl,
          status: 200,
          shouldThrow: true,
        }),
      });
      ok(
        "network exception does not move to ERROR",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 503 }),
      });
      ok(
        "ITA 5xx does not move to ERROR",
        !result.ok &&
          result.outcome === "NETWORK_FAILURE" &&
          fake.getConnection().status === "CONNECTED"
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.SANDBOX,
        fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 422 }),
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
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(PROD_ENV, async () => {
    const fake = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.PRODUCTION,
      status: BillingAuthorityConnectionStatus.CONNECTED,
    });
    fake.getConnection().environment = BillingAuthorityEnvironment.PRODUCTION;

    const originalFindUnique = prisma.billingAuthorityConnection.findUnique.bind(
      prisma.billingAuthorityConnection
    );
    const originalProfileFindUnique = prisma.businessProfile.findUnique.bind(
      prisma.businessProfile
    );
    const originalTransaction = prisma.$transaction.bind(prisma);

    prisma.billingAuthorityConnection.findUnique = (async () =>
      fake.getConnection()) as typeof prisma.billingAuthorityConnection.findUnique;
    prisma.businessProfile.findUnique = (async () => null) as typeof prisma.businessProfile.findUnique;
    prisma.$transaction = (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn(fake.tx)) as typeof prisma.$transaction;

    try {
      const result = await validateAuthorityConnection({
        businessId: BUSINESS_ID,
        environment: BillingAuthorityEnvironment.PRODUCTION,
        fetchImpl: mockProbeFetch({ probeUrl: prodProbeUrl, status: 422 }),
      });
      ok(
        "production validation",
        result.ok && fake.getConnection().environment === "PRODUCTION"
      );
      ok(
        "tenant isolation",
        fake.getConnection().businessId === BUSINESS_ID
      );
    } finally {
      prisma.billingAuthorityConnection.findUnique = originalFindUnique;
      prisma.businessProfile.findUnique = originalProfileFindUnique;
      prisma.$transaction = originalTransaction;
    }
  });

  await withEnvAsync(ENV, async () => {
    const connected = makeFakeValidationDb({
      businessId: BUSINESS_ID,
      environment: BillingAuthorityEnvironment.SANDBOX,
      status: BillingAuthorityConnectionStatus.AUTHORIZATION_REQUIRED,
    });
    const assessment = assessAuthorityConnectionValidatability(
      connected.getConnection()
    );
    ok(
      "non-validatable status rejected",
      !assessment.ok &&
        assessment.errorCode === AUTHORITY_VALIDATION_ERROR_CODES.NOT_VALIDATABLE
    );
  });

  await withEnvAsync(ENV, async () => {
    const probe = await executeAuthorityValidationProbe({
      probeUrl: sandboxProbeUrl,
      accessToken: ACCESS_TOKEN,
      payload: buildAuthorityValidationProbePayload(),
      fetchImpl: mockProbeFetch({ probeUrl: sandboxProbeUrl, status: 422 }),
    });
    ok("execute probe helper success", probe.outcome === "VALID");
  });

  try {
    await validateAuthorityConnection({
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

  console.log("\nAll authority validation tests passed.");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
