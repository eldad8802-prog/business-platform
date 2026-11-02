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
      `?response_type=code&client_id=sandbox-client-id&scope=invoices_scope` +
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

    // CASA 3.3.1 made the cross-tenant branch require the MFA elevation; this
    // suite predated it and still expected an UN-elevated admin to pass, so it was
    // red on main (unnoticed: no workflow ran it — sec/A F-9). Both halves now.
    let unelevatedCalled = false;
    const unelevated = await resolveAuthorityOAuthStart(
      { user: ADMIN_USER, requestedBusinessId: 99, redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart(() => { unelevatedCalled = true; }) }
    );
    ok(
      "platform admin WITHOUT MFA elevation cannot target another business",
      !unelevated.ok && unelevatedCalled === false
    );

    // Elevated admin may target another business
    const adminOutcome = await resolveAuthorityOAuthStart(
      { user: ADMIN_USER, requestedBusinessId: 99, redirectBaseUrl: BASE, secureCookies: false, adminElevated: true },
      { startOAuth: fakeStart() }
    );
    ok(
      "MFA-elevated platform admin may target another business",
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

    // Production pilot: the admin's business (9) and the admin user (1) are
    // admitted for this case only.
    process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = String(ADMIN_USER.businessId);
    process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(ADMIN_USER.id);
    const prod = await resolveAuthorityOAuthStart(
      { user: ADMIN_USER, environment: "production", redirectBaseUrl: BASE, secureCookies: false },
      { startOAuth: fakeStart() }
    );
    delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS;
    delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS;
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

  // 8. Production pilot actor gate: business AND user must both be admitted.
  {
    const BIZ = "BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS";
    const USERS = "BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS";
    const startProd = async (user: typeof REGULAR_USER, extra: Record<string, unknown> = {}) => {
      let called = false;
      const outcome = await resolveAuthorityOAuthStart(
        { user, environment: "PRODUCTION", redirectBaseUrl: BASE, secureCookies: false, ...extra },
        { startOAuth: fakeStart(() => { called = true; }) }
      );
      return { outcome, called };
    };
    const refusedPilot = (r: Awaited<ReturnType<typeof startProd>>) =>
      !r.outcome.ok &&
      r.outcome.status === "forbidden" &&
      r.outcome.reason === AUTHORITY_START_REASONS.PRODUCTION_PILOT_NOT_ENABLED &&
      r.called === false;

    try {
      process.env[BIZ] = "42";
      delete process.env[USERS];
      ok("admitted business + user list unset -> 403 PRODUCTION_PILOT_NOT_ENABLED", refusedPilot(await startProd(REGULAR_USER)));

      process.env[USERS] = "8";
      ok("admitted business + non-admitted user -> same 403 reason", refusedPilot(await startProd(REGULAR_USER)));

      process.env[USERS] = "7,x";
      ok("malformed user list closes the gate", refusedPilot(await startProd(REGULAR_USER)));

      process.env[BIZ] = "43";
      process.env[USERS] = "7";
      ok("admitted user + non-admitted business -> same 403 reason", refusedPilot(await startProd(REGULAR_USER)));

      process.env[BIZ] = "42";
      const both = await startProd(REGULAR_USER);
      ok(
        "business AND user admitted -> PRODUCTION start proceeds",
        both.outcome.ok && both.called && both.outcome.environment === BillingAuthorityEnvironment.PRODUCTION
      );

      // Admin cross-tenant: target business 42 admitted, admin user 1 not.
      const adminCross = { requestedBusinessId: 42, adminElevated: true };
      ok(
        "elevated admin cross-tenant -> refused unless the admin user is admitted",
        refusedPilot(await startProd(ADMIN_USER as typeof REGULAR_USER, adminCross))
      );
      process.env[USERS] = "1";
      const adminOk = await startProd(ADMIN_USER as typeof REGULAR_USER, adminCross);
      ok(
        "elevated admin cross-tenant with admin user admitted -> proceeds for the target",
        adminOk.outcome.ok && adminOk.outcome.businessId === 42
      );

      delete process.env[BIZ];
      delete process.env[USERS];
      const sandbox = await resolveAuthorityOAuthStart(
        { user: REGULAR_USER, redirectBaseUrl: BASE, secureCookies: false },
        { startOAuth: fakeStart() }
      );
      ok(
        "SANDBOX default unaffected with both lists unset",
        sandbox.ok && sandbox.environment === BillingAuthorityEnvironment.SANDBOX
      );
    } finally {
      delete process.env[BIZ];
      delete process.env[USERS];
    }
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
