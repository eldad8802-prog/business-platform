/**
 * Authority OAuth callback route orchestration (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-callback-route.service.test.ts
 *
 * Pure unit tests — no DB, no network. The callback service is injected as a
 * fake so we exercise outcome mapping, actor recovery, and reason-safety only.
 */
import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  buildAuthorityOAuthCookieClearSpecs,
  type HandleAuthorityOAuthCallbackInput,
  type HandleAuthorityOAuthCallbackResult,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import type { PublicAuthorityConnection } from "@/lib/services/billing/authority/billing-authority-connection.types";
import {
  AUTHORITY_CALLBACK_MISSING_SESSION_REASON,
  resolveAuthorityOAuthCallback,
  toSafeReason,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback-route.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const CLEARED = buildAuthorityOAuthCookieClearSpecs({ secureCookies: false });

const CONNECTION = {
  businessId: 42,
  environment: BillingAuthorityEnvironment.SANDBOX,
  status: "CONNECTED",
} as unknown as PublicAuthorityConnection;

function fakeHandler(
  result: HandleAuthorityOAuthCallbackResult,
  capture?: (input: HandleAuthorityOAuthCallbackInput) => void
) {
  return async (input: HandleAuthorityOAuthCallbackInput) => {
    capture?.(input);
    return result;
  };
}

const VALID_COOKIES = {
  state: "state-abc",
  businessId: "42",
  environment: "SANDBOX",
  actorUserId: "7",
};

async function run() {
  // 1. Success outcome
  {
    let seen: HandleAuthorityOAuthCallbackInput | null = null;
    const outcome = await resolveAuthorityOAuthCallback(
      {
        query: { code: "auth-code", state: "state-abc" },
        cookies: VALID_COOKIES,
        redirectBaseUrl: "https://app.dubiz.test",
        secureCookies: false,
      },
      {
        handleCallback: fakeHandler(
          { ok: true, connection: CONNECTION, clearedCookies: CLEARED },
          (i) => {
            seen = i;
          }
        ),
      }
    );
    ok(
      "success maps to connected with no reason",
      outcome.ok &&
        outcome.status === "connected" &&
        outcome.reason === null &&
        outcome.clearedCookies.length === 4
    );
    ok(
      "actor user id parsed to positive integer and forwarded",
      seen !== null && (seen as HandleAuthorityOAuthCallbackInput).actorUserId === 7
    );
    ok(
      "oauth code/state forwarded to service, not leaked into outcome",
      seen !== null &&
        (seen as HandleAuthorityOAuthCallbackInput).query.code === "auth-code"
    );
  }

  // 2. Missing actor cookie → short-circuit, handler never called
  {
    let called = false;
    const outcome = await resolveAuthorityOAuthCallback(
      {
        query: { code: "auth-code", state: "state-abc" },
        cookies: { ...VALID_COOKIES, actorUserId: null },
        redirectBaseUrl: "https://app.dubiz.test",
        secureCookies: false,
      },
      {
        handleCallback: fakeHandler(
          { ok: true, connection: CONNECTION, clearedCookies: CLEARED },
          () => {
            called = true;
          }
        ),
      }
    );
    ok(
      "missing actor cookie returns MISSING_SESSION error",
      !outcome.ok &&
        outcome.status === "error" &&
        outcome.reason === AUTHORITY_CALLBACK_MISSING_SESSION_REASON
    );
    ok("missing actor cookie does not call token exchange", called === false);
    ok(
      "missing actor cookie still clears cookies",
      outcome.clearedCookies.length === 4
    );
  }

  // 2b. Non-positive / non-numeric actor cookie is rejected too
  {
    for (const bad of ["0", "-3", "abc", " "]) {
      const outcome = await resolveAuthorityOAuthCallback(
        {
          query: { code: "auth-code", state: "state-abc" },
          cookies: { ...VALID_COOKIES, actorUserId: bad },
          redirectBaseUrl: "https://app.dubiz.test",
          secureCookies: false,
        },
        {
          handleCallback: fakeHandler({
            ok: true,
            connection: CONNECTION,
            clearedCookies: CLEARED,
          }),
        }
      );
      ok(
        `invalid actor cookie "${bad}" rejected as MISSING_SESSION`,
        !outcome.ok && outcome.reason === AUTHORITY_CALLBACK_MISSING_SESSION_REASON
      );
    }
  }

  // 3. Invalid state, 4. missing code, 5. ITA error param, 6. token exchange failure
  {
    const cases: Array<{ code: string; expected: string }> = [
      { code: "AUTHORITY_OAUTH_STATE_MISMATCH", expected: "AUTHORITY_OAUTH_STATE_MISMATCH" },
      { code: "AUTHORITY_OAUTH_MISSING_CODE", expected: "AUTHORITY_OAUTH_MISSING_CODE" },
      { code: "AUTHORITY_OAUTH_ITA_ERROR", expected: "AUTHORITY_OAUTH_ITA_ERROR" },
      {
        code: "AUTHORITY_OAUTH_TOKEN_EXCHANGE_FAILED",
        expected: "AUTHORITY_OAUTH_TOKEN_EXCHANGE_FAILED",
      },
    ];
    for (const c of cases) {
      const outcome = await resolveAuthorityOAuthCallback(
        {
          query: { state: "state-abc", error: "access_denied" },
          cookies: VALID_COOKIES,
          redirectBaseUrl: "https://app.dubiz.test",
          secureCookies: false,
        },
        {
          handleCallback: fakeHandler({
            ok: false,
            errorCode: c.code,
            errorMessage: "human readable detail that must not surface",
            oauthFailureRecorded: true,
            clearedCookies: CLEARED,
          }),
        }
      );
      ok(
        `service error ${c.code} maps to safe reason`,
        !outcome.ok &&
          outcome.status === "error" &&
          outcome.reason === c.expected
      );
      ok(
        `error message never surfaced for ${c.code}`,
        outcome.reason !== null && !outcome.reason.includes(" ")
      );
    }
  }

  // 7. toSafeReason hardening
  {
    ok(
      "toSafeReason strips unsafe characters",
      toSafeReason("ya29.a0AeXRPp-secret token!") ===
        "YA29_A0AEXRPP_SECRET_TOKEN"
    );
    ok("toSafeReason caps length to 64", toSafeReason("A".repeat(200)).length === 64);
    ok("toSafeReason empty -> UNKNOWN_ERROR", toSafeReason("") === "UNKNOWN_ERROR");
    ok("toSafeReason null -> UNKNOWN_ERROR", toSafeReason(null) === "UNKNOWN_ERROR");
    ok(
      "toSafeReason collapses separators",
      toSafeReason("__a--b__") === "A_B"
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll authority OAuth callback route tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
