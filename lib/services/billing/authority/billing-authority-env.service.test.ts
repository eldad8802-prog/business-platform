/**
 * Authority env resolver (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-env.service.test.ts
 */
import { BillingAuthorityEnvironment } from "@prisma/client";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import {
  buildAuthorityApiBaseUrl,
  buildAuthorityOAuthAuthorizeUrl,
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
  resolveRuntimeAuthorityEnvironment,
} from "@/lib/services/billing/authority/billing-authority-env.service";

let failed = 0;
const originalEnv = { ...process.env };

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
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

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void
) {
  process.env = { ...originalEnv, ...overrides };
  try {
    fn();
  } finally {
    process.env = { ...originalEnv };
  }
}

withEnv(
  {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    AUTHORITY_OAUTH_BASE_SANDBOX: "https://openapi.taxes.gov.il/",
    AUTHORITY_API_BASE_SANDBOX: "https://ita-api.taxes.gov.il",
    AUTHORITY_OAUTH_PATH_SEGMENT_SANDBOX: "tsandbox",
    BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://app.dubiz.test",
  },
  () => {
    ok(
      "resolveRuntimeAuthorityEnvironment reads SANDBOX",
      resolveRuntimeAuthorityEnvironment() === BillingAuthorityEnvironment.SANDBOX
    );

    const config = resolveAuthorityEnvConfig(BillingAuthorityEnvironment.SANDBOX);
    ok("oauth base is normalized", config.oauthBase === "https://openapi.taxes.gov.il");
    ok("api base is set", config.apiBase === "https://ita-api.taxes.gov.il");
    ok("path segment is scoped", config.oauthPathSegment === "tsandbox");
    ok(
      "redirect uri includes callback path",
      config.redirectUri ===
        "https://app.dubiz.test/api/taxes/oauth/callback"
    );

    ok(
      "token url uses oauth base and path segment",
      buildAuthorityOAuthTokenUrl(config) ===
        "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token"
    );
    ok(
      "authorize url uses oauth base and path segment",
      buildAuthorityOAuthAuthorizeUrl(config) ===
        "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/authorize"
    );
    ok(
      "api base url uses api host and path segment",
      buildAuthorityApiBaseUrl(config) ===
        "https://ita-api.taxes.gov.il/shaam/tsandbox"
    );
  }
);

withEnv(
  {
    NODE_ENV: "development",
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION",
    AUTHORITY_OAUTH_BASE: "https://openapi.taxes.gov.il",
    AUTHORITY_API_BASE: "https://ita-api.taxes.gov.il",
    BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL: "https://prod.dubiz.test",
  },
  () => {
    const config = resolveAuthorityEnvConfig(BillingAuthorityEnvironment.PRODUCTION);
    ok(
      "unsuffixed vars apply when runtime environment matches",
      config.oauthBase === "https://openapi.taxes.gov.il"
    );
    ok(
      "default production path segment",
      config.oauthPathSegment === "production"
    );
  }
);

withEnv(
  {
    NODE_ENV: "development",
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
  },
  () => {
    expectError(
      "missing oauth base throws ValidationError in development",
      () => resolveAuthorityEnvConfig(BillingAuthorityEnvironment.SANDBOX),
      ValidationError
    );
  }
);

withEnv(
  {
    NODE_ENV: "production",
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    AUTHORITY_OAUTH_BASE_SANDBOX: "https://openapi.taxes.gov.il",
    AUTHORITY_API_BASE_SANDBOX: "https://ita-api.taxes.gov.il",
  },
  () => {
    expectError(
      "missing redirect base throws ServiceUnavailableError in production",
      () => resolveAuthorityEnvConfig(BillingAuthorityEnvironment.SANDBOX),
      ServiceUnavailableError
    );
  }
);

withEnv(
  {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "invalid",
  },
  () => {
    expectError(
      "invalid runtime environment throws ValidationError",
      () => resolveRuntimeAuthorityEnvironment(),
      ValidationError
    );
  }
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log("\nAll authority env service tests passed.");
