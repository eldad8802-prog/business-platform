/**
 * Sanitized OAuth callback diagnostics (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-diagnostics.test.ts
 *
 * Covers the token-exchange failure matrix (provider status + allowlisted OAuth
 * error + response-format tag), the guarantee that no provider body /
 * error_description / secret ever leaks into the thrown error or diagnostics,
 * and the failure-stage classifier used by the callback handler.
 */

import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import {
  AUTHORITY_OAUTH_CALLBACK_ERROR_CODES as CODES,
  AuthorityOAuthCallbackError,
  classifyTokenErrorBody,
  exchangeAuthorityAuthorizationCode,
  mapProviderOAuthError,
  resolveCallbackFailure,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

function fetchReturning(body: string, status: number): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

const BASE = {
  tokenEndpoint: "https://openapi.taxes.gov.il/token",
  clientId: "client-abc",
  clientSecret: "secret-xyz",
  code: "auth-code-123",
  redirectUri: "https://app.dubiz.test/api/taxes/oauth/callback",
};

async function expectFailure(
  name: string,
  fetchImpl: typeof fetch
): Promise<AuthorityOAuthCallbackError | null> {
  try {
    await exchangeAuthorityAuthorizationCode({ ...BASE, fetchImpl });
    ok(`${name} — threw`, false);
    return null;
  } catch (error) {
    const isTyped = error instanceof AuthorityOAuthCallbackError;
    ok(`${name} — threw AuthorityOAuthCallbackError`, isTyped);
    return isTyped ? (error as AuthorityOAuthCallbackError) : null;
  }
}

async function main() {
  // ---- Pure helpers --------------------------------------------------------
  ok("allowlist maps invalid_client", mapProviderOAuthError("invalid_client") === "invalid_client");
  ok("allowlist is case-insensitive", mapProviderOAuthError("INVALID_GRANT") === "invalid_grant");
  ok("non-allowlisted -> unknown", mapProviderOAuthError("weird_error") === "unknown");
  ok("non-string -> null", mapProviderOAuthError(42) === null);
  ok("empty -> null", mapProviderOAuthError("  ") === null);

  ok(
    "classify JSON error",
    (() => {
      const r = classifyTokenErrorBody('{"error":"invalid_client"}');
      return r.responseFormat === "JSON" && r.providerOAuthError === "invalid_client";
    })()
  );
  ok(
    "classify JSON ignores error_description",
    (() => {
      const r = classifyTokenErrorBody(
        '{"error":"invalid_grant","error_description":"SENSITIVE-TEXT"}'
      );
      return r.responseFormat === "JSON" && r.providerOAuthError === "invalid_grant";
    })()
  );
  ok("classify NON_JSON", classifyTokenErrorBody("<html>oops</html>").responseFormat === "NON_JSON");
  ok("classify EMPTY", classifyTokenErrorBody("   ").responseFormat === "EMPTY");
  ok("classify JSON w/o error -> null", classifyTokenErrorBody('{"x":1}').providerOAuthError === null);

  // ---- Exchange failure matrix --------------------------------------------
  {
    const e = await expectFailure(
      "400 invalid_client",
      fetchReturning('{"error":"invalid_client"}', 400)
    );
    ok("400 invalid_client -> REJECTED", e?.errorCode === CODES.TOKEN_EXCHANGE_REJECTED);
    ok("400 invalid_client -> stage TOKEN_EXCHANGE", e?.diagnostics.stage === "TOKEN_EXCHANGE");
    ok("400 invalid_client -> httpStatus 400", e?.diagnostics.providerHttpStatus === 400);
    ok("400 invalid_client -> oauthError invalid_client", e?.diagnostics.providerOAuthError === "invalid_client");
    ok("400 invalid_client -> format JSON", e?.diagnostics.providerResponseFormat === "JSON");
  }

  {
    const e = await expectFailure(
      "400 invalid_grant + description",
      fetchReturning('{"error":"invalid_grant","error_description":"SENSITIVE-TEXT-DO-NOT-LEAK"}', 400)
    );
    ok("400 invalid_grant -> oauthError invalid_grant", e?.diagnostics.providerOAuthError === "invalid_grant");
    const serialized = JSON.stringify({ msg: e?.message, diag: e?.diagnostics });
    ok("error_description NOT in error/diagnostics", !serialized.includes("SENSITIVE-TEXT-DO-NOT-LEAK"));
    ok("message is internal code only", e?.message === CODES.TOKEN_EXCHANGE_REJECTED);
  }

  {
    const e = await expectFailure(
      "unknown provider error",
      fetchReturning('{"error":"some_unmapped_error"}', 403)
    );
    ok("unknown provider error -> unknown", e?.diagnostics.providerOAuthError === "unknown");
    ok("unknown provider error -> httpStatus 403", e?.diagnostics.providerHttpStatus === 403);
  }

  {
    const e = await expectFailure(
      "HTML body non-2xx",
      fetchReturning("<html><body>Gateway Timeout</body></html>", 504)
    );
    ok("HTML body -> NON_JSON", e?.diagnostics.providerResponseFormat === "NON_JSON");
    ok("HTML body -> oauthError null", e?.diagnostics.providerOAuthError === null);
    ok("HTML body -> REJECTED (non-2xx)", e?.errorCode === CODES.TOKEN_EXCHANGE_REJECTED);
  }

  {
    const e = await expectFailure("empty body non-2xx", fetchReturning("", 500));
    ok("empty body -> EMPTY", e?.diagnostics.providerResponseFormat === "EMPTY");
    ok("empty body -> httpStatus 500", e?.diagnostics.providerHttpStatus === 500);
  }

  {
    const netFetch = (async () => {
      throw new Error("ECONNRESET connecting to openapi.taxes.gov.il");
    }) as typeof fetch;
    const e = await expectFailure("network failure", netFetch);
    ok("network -> NETWORK_ERROR", e?.diagnostics.providerResponseFormat === "NETWORK_ERROR");
    ok("network -> httpStatus null", e?.diagnostics.providerHttpStatus === null);
    ok("network -> FAILED (not rejected)", e?.errorCode === CODES.TOKEN_EXCHANGE_FAILED);
    const serialized = JSON.stringify({ msg: e?.message, diag: e?.diagnostics });
    ok("network host NOT leaked into diagnostics", !serialized.includes("openapi.taxes.gov.il"));
  }

  {
    const e = await expectFailure(
      "2xx missing access_token",
      fetchReturning('{"token_type":"Bearer"}', 200)
    );
    ok("2xx no access_token -> TOKEN_RESPONSE_INVALID", e?.errorCode === CODES.TOKEN_RESPONSE_INVALID);
    ok("2xx no access_token -> stage TOKEN_RESPONSE", e?.diagnostics.stage === "TOKEN_RESPONSE");
  }

  {
    const e = await expectFailure(
      "2xx non-JSON body",
      fetchReturning("not json at all", 200)
    );
    ok("2xx non-JSON -> FAILED", e?.errorCode === CODES.TOKEN_EXCHANGE_FAILED);
    ok("2xx non-JSON -> NON_JSON", e?.diagnostics.providerResponseFormat === "NON_JSON");
  }

  // Happy path still returns tokens.
  {
    const good = await exchangeAuthorityAuthorizationCode({
      ...BASE,
      fetchImpl: fetchReturning(
        '{"access_token":"AT","refresh_token":"RT","expires_in":3600}',
        200
      ),
    });
    ok("happy path returns access_token", good.access_token === "AT");
    ok("happy path returns refresh_token", good.refresh_token === "RT");
  }

  // ---- Failure classifier (used by the handler) ---------------------------
  {
    const encErr = new AuthorityOAuthCallbackError(CODES.TOKEN_ENCRYPTION_FAILED, {
      stage: "TOKEN_ENCRYPTION",
    });
    const r = resolveCallbackFailure(encErr);
    ok("classifier: encryption code", r.errorCode === CODES.TOKEN_ENCRYPTION_FAILED);
    ok("classifier: encryption stage", r.diagnostics.stage === "TOKEN_ENCRYPTION");
  }
  {
    const persistErr = new AuthorityOAuthCallbackError(CODES.CONNECTION_PERSIST_FAILED, {
      stage: "CONNECTION_PERSISTENCE",
    });
    const r = resolveCallbackFailure(persistErr);
    ok("classifier: persistence code", r.errorCode === CODES.CONNECTION_PERSIST_FAILED);
    ok("classifier: persistence stage", r.diagnostics.stage === "CONNECTION_PERSISTENCE");
  }
  {
    const r = resolveCallbackFailure(new ServiceUnavailableError("app down"));
    ok("classifier: app unavailable code", r.errorCode === CODES.APP_UNAVAILABLE);
    ok("classifier: app config stage", r.diagnostics.stage === "APP_CONFIGURATION");
  }
  {
    const r = resolveCallbackFailure(new ValidationError(CODES.TOKEN_RESPONSE_INVALID));
    ok("classifier: known ValidationError passthrough", r.errorCode === CODES.TOKEN_RESPONSE_INVALID);
    ok("classifier: known ValidationError stage", r.diagnostics.stage === "TOKEN_RESPONSE");
  }
  {
    const r = resolveCallbackFailure(new Error("connect https://host/secret leaked"));
    ok("classifier: generic -> FAILED", r.errorCode === CODES.TOKEN_EXCHANGE_FAILED);
    const serialized = JSON.stringify(r);
    ok("classifier: generic message not leaked", !serialized.includes("secret leaked"));
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
