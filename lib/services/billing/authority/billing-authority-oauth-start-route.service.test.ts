/**
 * Authority OAuth START route orchestration (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-start-route.service.test.ts
 *
 * Pure unit tests — no DB, no network. `startAuthorityOAuth` is injected as a
 * fake so we exercise auth, tenant access, environment selection, and the
 * cookie/no-leak contract only.
 */
import { BillingAuthorityEnvironment, UserRole } from "@prisma/client";
import type {
  AuthorityOAuthCookieSpec,
  StartAuthorityOAuthInput,
  StartAuthorityOAuthResult,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import { AUTHORITY_OAUTH_COOKIE_NAMES } from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import {
  AUTHORITY_START_REASONS,
  parseStartEnvironment,
  resolveAuthorityOAuthStart,
} from "@/lib/services/billing/authority/billing-authority-oauth-start-route.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const REGULAR_USER = { id: 7, businessId: 42, role: UserRole.USER };
const ADMIN_USER = { id: 1, businessId: 9, role: UserRole.PLATFORM_ADMIN };

function fakeCookies(
  businessId: number,
  actorUserId: number,
  environment: BillingAuthorityEnvironment
): AuthorityOAuthCookieSpec[] {
  const base = {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: false,
    path: "/" as const,
    maxAge: 600,
  };
  return [
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.STATE, value: "state-xyz", ...base },
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.BUSINESS_ID, value: String(businessId), ...base },
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.ENVIRONMENT, value: environment, ...base },
    { name: AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID, value: String(actorUserId), ...base },
  ];
}

function fakeStart(capture?: (input: StartAuthorityOAuthInput) => void) {
  return async (input: StartAuthorityOAuthInput): Promise<StartAuthorityOAuthResult> => {
    capture?.(input);
    const authorizationUrl =
      `https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/authorize` +
      `?response_type=code&client_id=sandbox-client-id&scope=scope` +
      `&redirect_uri=${encodeURIComponent(input.redirectBaseUrl + "/api/taxes/oauth/callback")}` +
      `&state=state-xyz`;
    return {
      authorizationUrl,
      state: "state-xyz",
      cookies: fakeCookies(input.businessId, input.actorUserId, input.environment),
    };
  };
}

const BASE = "https://app.dubiz.test";

async function run() {
  // 1. Unauthenticated user — start service never called
  {
    let called = false;
    const outcome = await resolveAuthorityOAuthStart(
      { user: null, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart(() => { called = true; }) }
    );
    ok(
      "unauthenticated user rejected",
      !outcome.ok &&
        outcome.status === "unauthenticated" &&
        outcome.reason === AUTHORITY_START_REASONS.UNAUTHENTICATED
    );
    ok("unauthenticated never starts oauth", called === false);
  }

  // 2. Missing/invalid businessId param
  {
    const invalid = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, requestedBusinessId: "abc", redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "invalid businessId param rejected",
      !invalid.ok &&
        invalid.status === "error" &&
        invalid.reason === AUTHORITY_START_REASONS.INVALID_BUSINESS
    );

    const missing = await resolveAuthorityOAuthStart(
      { user: { ...REGULAR_USER, businessId: 0 }, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "actor without a valid business rejected",
      !missing.ok && missing.reason === AUTHORITY_START_REASONS.MISSING_BUSINESS
    );
  }

  // 3. Unauthorized business (non-admin targeting another business)
  {
    let called = false;
    const outcome = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, requestedBusinessId: 99, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart(() => { called = true; }) }
    );
    ok(
      "non-admin cannot target another business",
      !outcome.ok &&
        outcome.status === "forbidden" &&
        outcome.reason === AUTHORITY_START_REASONS.BUSINESS_FORBIDDEN
    );
    ok("forbidden never starts oauth", called === false);

    // Admin may target another business
    const adminOutcome = await resolveAuthorityOAuthStart(
      { user: ADMIN_USER, requestedBusinessId: 99, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "platform admin may target another business",
      adminOutcome.ok && adminOutcome.businessId === 99
    );
  }

  // 4 + 5. Successful redirect + cookies set correctly
  {
    let seen: StartAuthorityOAuthInput | null = null;
    const outcome = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart((i) => { seen = i; }) }
    );
    ok(
      "successful start returns authorize URL",
      outcome.ok &&
        outcome.authorizationUrl.startsWith("https://openapi.taxes.gov.il/") &&
        outcome.authorizationUrl.includes("response_type=code")
    );
    ok(
      "defaults to actor business when no param",
      outcome.ok && outcome.businessId === 42 &&
        seen !== null && (seen as StartAuthorityOAuthInput).businessId === 42
    );
    ok(
      "actor user id forwarded to start service",
      seen !== null && (seen as StartAuthorityOAuthInput).actorUserId === 7
    );
    ok(
      "all four oauth cookies present and scoped",
      outcome.ok &&
        outcome.cookies.length === 4 &&
        outcome.cookies.some((c) => c.name === AUTHORITY_OAUTH_COOKIE_NAMES.STATE) &&
        outcome.cookies.some(
          (c) => c.name === AUTHORITY_OAUTH_COOKIE_NAMES.BUSINESS_ID && c.value === "42"
        ) &&
        outcome.cookies.some(
          (c) => c.name === AUTHORITY_OAUTH_COOKIE_NAMES.ACTOR_USER_ID && c.value === "7"
        )
    );
    ok(
      "oauth cookies are httpOnly",
      outcome.ok && outcome.cookies.every((c) => c.httpOnly === true)
    );
  }

  // 6. No secret leakage in the authorize URL
  {
    const outcome = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "authorize URL carries no client secret",
      outcome.ok &&
        !/secret/i.test(outcome.authorizationUrl) &&
        !outcome.authorizationUrl.includes("client_secret") &&
        !/access_token|refresh_token/i.test(outcome.authorizationUrl)
    );
  }

  // 7. Sandbox environment selection
  {
    const def = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "environment defaults to SANDBOX",
      def.ok && def.environment === BillingAuthorityEnvironment.SANDBOX
    );

    const explicit = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, environment: "sandbox", redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "explicit sandbox honored",
      explicit.ok && explicit.environment === BillingAuthorityEnvironment.SANDBOX
    );

    const prod = await resolveAuthorityOAuthStart(
      { user: ADMIN_USER, environment: "production", redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "explicit production honored when requested",
      prod.ok && prod.environment === BillingAuthorityEnvironment.PRODUCTION
    );

    const bad = await resolveAuthorityOAuthStart(
      { user: REGULAR_USER, environment: "staging", redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    ok(
      "unknown environment rejected",
      !bad.ok && bad.reason === AUTHORITY_START_REASONS.INVALID_ENVIRONMENT
    );

    ok("parseStartEnvironment empty -> SANDBOX", parseStartEnvironment("") === BillingAuthorityEnvironment.SANDBOX);
    ok("parseStartEnvironment null -> SANDBOX", parseStartEnvironment(null) === BillingAuthorityEnvironment.SANDBOX);
    ok("parseStartEnvironment junk -> null", parseStartEnvironment("nope") === null);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll authority OAuth start route tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
