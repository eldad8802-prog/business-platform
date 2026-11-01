/**
 * invoices_scope + sanitized 401 diagnostics (#36423501). Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-scope-diagnostic.verify.test.ts
 *
 * Source of the scope: Invoices-v2.json (portal download) — top-level
 * security oauth2 ["invoices_scope"], not overridden by POST /Invoices/v2/Approval.
 */
import {
  ITA_OAUTH_SCOPE,
  buildAuthorityOAuthAuthorizeRedirectUrl,
} from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import { exchangeAuthorityAuthorizationCode } from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import { exchangeAuthorityRefreshToken } from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import { assertAuthorityOAuthCodeExchangeOnly } from "@/lib/services/billing/authority/billing-authority-egress";
import { sendInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-client";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  extractProviderDiagnostic,
  providerDiagnosticMetadata,
  sanitizeProviderText,
} from "@/lib/services/billing/authority/billing-authority-provider-diagnostic";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const TOKEN_URL = "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";
const APPROVAL_CONFIG = { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000, scope: "" };
const ACCESS_TOKEN = "AAPK" + "x".repeat(150);
const GATEWAY_401 = {
  httpCode: "401",
  httpMessage: "Unauthorized",
  moreInformation: "Cannot pass the security checks that are required by the target API or operation, Enable debug headers for more details.",
};

type Captured = { url: string; headers: Record<string, string>; body: string };
function capturingFetch(status: number, body: unknown, headers: Record<string, string>, cap: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    cap.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

async function scopeTests() {
  ok("scope constant is invoices_scope (Invoices-v2.json security)", ITA_OAUTH_SCOPE === "invoices_scope");

  const url = new URL(buildAuthorityOAuthAuthorizeRedirectUrl({
    authorizeEndpoint: "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/authorize",
    clientId: "client-1",
    redirectUri: "https://app.test/api/taxes/oauth/callback",
    state: "state-1",
  }));
  ok("authorize: exactly one scope param = invoices_scope", url.searchParams.getAll("scope").join(",") === "invoices_scope");
  ok("authorize: host/path unchanged (openapi longtimetoken)", url.host === "openapi.taxes.gov.il" && url.pathname === "/shaam/tsandbox/longtimetoken/oauth2/authorize");

  const cap: Captured[] = [];
  await exchangeAuthorityAuthorizationCode({
    tokenEndpoint: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1", code: "code-1",
    redirectUri: "https://app.test/api/taxes/oauth/callback",
    fetchImpl: capturingFetch(200, { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer" }, { "content-type": "application/json" }, cap),
  });
  const body = new URLSearchParams(cap[0]?.body ?? "");
  ok("exchange: one request", cap.length === 1);
  ok("exchange: grant_type authorization_code", body.get("grant_type") === "authorization_code");
  ok("exchange: exactly one scope = invoices_scope", body.getAll("scope").join(",") === "invoices_scope");
  let admitted = true;
  try {
    assertAuthorityOAuthCodeExchangeOnly(new URL(TOKEN_URL), { method: "POST", body: cap[0]?.body }, "SANDBOX");
  } catch {
    admitted = false;
  }
  ok("exchange with invoices_scope still admitted by the OAuth-only egress block", admitted);

  const rcap: Captured[] = [];
  await exchangeAuthorityRefreshToken({
    tokenEndpoint: TOKEN_URL, clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1",
    fetchImpl: capturingFetch(200, { access_token: "a2", expires_in: 3600 }, { "content-type": "application/json" }, rcap),
  });
  ok("refresh body unchanged: no scope param", rcap.length === 1 && !new URLSearchParams(rcap[0].body).has("scope"));
}

async function approvalDiagnosticTests() {
  const cap: Captured[] = [];
  const r = await sendInvoiceApproval({
    accessToken: ACCESS_TOKEN,
    payload: {} as InvoiceApprovalRequest,
    config: APPROVAL_CONFIG,
    fetchImpl: capturingFetch(401, GATEWAY_401, {
      "content-type": "application/json",
      "x-global-transaction-id": "a1b2c3d4e5f60718",
      "www-authenticate": 'Bearer realm="tsandbox", error="insufficient_scope"',
    }, cap),
  });
  ok("approval request headers = Authorization, Content-Type, Accept only (no client id)",
    Object.keys(cap[0]?.headers ?? {}).sort().join(",") === "Accept,Authorization,Content-Type");
  ok("401 stays infrastructure_error / AUTHENTICATION / POSSIBLY_SENT",
    r.kind === "infrastructure_error" && r.classification === "AUTHENTICATION" && r.sendCertainty === "POSSIBLY_SENT" && r.failureKind === "HTTP_STATUS");
  const d = r.kind === "infrastructure_error" ? r.providerDiagnostic : null;
  ok("401: transaction id kept", d?.transactionId === "a1b2c3d4e5f60718", d);
  ok("401: OAuth error code kept", d?.authError === "insufficient_scope", d);
  ok("401: gateway text kept (bounded)", d?.gatewayMessage === GATEWAY_401.moreInformation, d);
  ok("401: result never contains the access token", !JSON.stringify(r).includes(ACCESS_TOKEN.slice(0, 20)));

  const leaky = await sendInvoiceApproval({
    accessToken: ACCESS_TOKEN, payload: {} as InvoiceApprovalRequest, config: APPROVAL_CONFIG,
    fetchImpl: capturingFetch(401, { moreInformation: `Token ${ACCESS_TOKEN} rejected`, httpMessage: `Bearer ${ACCESS_TOKEN}` }, {
      "x-global-transaction-id": `Bearer ${ACCESS_TOKEN}`, "www-authenticate": `Bearer error="${ACCESS_TOKEN}"`,
    }, []),
  });
  ok("token-like text / headers are dropped entirely",
    leaky.kind === "infrastructure_error" && (leaky.providerDiagnostic ?? null) === null && !JSON.stringify(leaky).includes("xxxxxxxxxx"), leaky);

  const empty = await sendInvoiceApproval({
    accessToken: ACCESS_TOKEN, payload: {} as InvoiceApprovalRequest, config: APPROVAL_CONFIG,
    fetchImpl: capturingFetch(403, undefined, {}, []),
  });
  ok("403 with empty body and no headers → no diagnostic", empty.kind === "infrastructure_error" && (empty.providerDiagnostic ?? null) === null);

  const documented = await sendInvoiceApproval({
    accessToken: ACCESS_TOKEN, payload: {} as InvoiceApprovalRequest, config: APPROVAL_CONFIG,
    fetchImpl: capturingFetch(406, { status: 406, message: "Not Acceptable", error_id: "e1" }, { "x-global-transaction-id": "abc" }, []),
  });
  ok("documented 406 path unchanged (no diagnostic field)", documented.kind === "not_acceptable" && !("providerDiagnostic" in documented));

  ok("text sanitizer bounds length", (sanitizeProviderText("a ".repeat(200)) ?? "").length <= 160);
  ok("text sanitizer rejects control/quote chars", sanitizeProviderText('bad "quoted" <html>') === null);
  ok("extract from bare headers object", extractProviderDiagnostic(new Headers({ "www-authenticate": 'Bearer error="invalid_token"' }), null)?.authError === "invalid_token");
  const meta = providerDiagnosticMetadata({ transactionId: "id-1", authError: "INVALID-x", gatewayMessage: `x ${ACCESS_TOKEN}` });
  ok("audit metadata re-sanitizes every field",
    meta.providerTransactionId === "id-1" && meta.providerAuthError === null && meta.providerGatewayMessage === null, meta);
  const none = providerDiagnosticMetadata(undefined);
  ok("audit metadata keys present and null when absent",
    Object.keys(none).sort().join(",") === "providerAuthError,providerGatewayMessage,providerTransactionId" && Object.values(none).every((v) => v === null));
}

(async () => {
  await scopeTests();
  await approvalDiagnosticTests();
  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
})();
