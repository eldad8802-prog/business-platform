/**
 * Unit tests for the Invoice-decision HTTP client + parser (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-decision-client.test.ts
 * fetch is always injected. Deterministic.
 */
import {
  buildInvoiceDecisionUrl,
  INVOICE_DECISION_API_VERSION,
  INVOICE_DECISION_PATH_SEGMENT,
  type AuthorityDecisionConfig,
} from "@/lib/services/billing/authority/billing-authority-decision-client.config";
import {
  parseDecisionResponse,
  sendInvoiceDecision,
} from "@/lib/services/billing/authority/billing-authority-decision-client";
import type { InvoiceDecisionRequest } from "@/lib/services/billing/authority/billing-authority-decision.types";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const CONFIG: AuthorityDecisionConfig = {
  apiBaseUrl: "https://t-ita-api.taxes.gov.il/shaam/tsandbox",
  apiVersion: INVOICE_DECISION_API_VERSION,
  timeoutMs: 15000,
};
const PAYLOAD: InvoiceDecisionRequest = {
  invoice_id: "42", vat_number: 515000123, accounting_software_number: 12345678, user_name: "דנה",
};

type Capture = { url: string; init: RequestInit };
function mockFetch(status: number, body: string, capture?: Capture): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) { capture.url = String(url); capture.init = init ?? {}; }
    return { status, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  // ---- URL: OFFICIAL contract path + version + PascalCase action (distinct from Approval) ----
  // Official published route (v2.0/7.2024, §4.2):
  //   https://ita-api.taxes.gov.il/shaam/{env}/InvoiceDecisionApi/v1/{Cancel|Continue|FurtherObjection}
  ok("segment is the official InvoiceDecisionApi", INVOICE_DECISION_PATH_SEGMENT === "InvoiceDecisionApi");
  ok("version is the official v1", INVOICE_DECISION_API_VERSION === "v1");
  ok("URL Cancel", buildInvoiceDecisionUrl(CONFIG, "Cancel") === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Cancel");
  ok("URL Continue", buildInvoiceDecisionUrl(CONFIG, "Continue") === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Continue");
  ok("URL FurtherObjection", buildInvoiceDecisionUrl(CONFIG, "FurtherObjection") === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/FurtherObjection");
  // Guard: the wrong (never-published) `Invoice-decision` segment must never reappear.
  ok("no legacy Invoice-decision segment", !buildInvoiceDecisionUrl(CONFIG, "Cancel").includes("/Invoice-decision/"));
  // Guard: the builder must NOT add a second `/shaam` — apiBaseUrl already carries exactly one.
  ok("exactly one /shaam segment", buildInvoiceDecisionUrl(CONFIG, "Cancel").split("/shaam/").length === 2);
  // Guard: trailing slash on the base must not double the separator.
  ok("trailing slash on base is trimmed", buildInvoiceDecisionUrl({ ...CONFIG, apiBaseUrl: CONFIG.apiBaseUrl + "/" }, "Cancel") === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Cancel");

  // ---- serialization: POST to the action URL, bearer, json body ----
  {
    const cap: Capture = { url: "", init: {} };
    await sendInvoiceDecision({ accessToken: "tkn", action: "Continue", payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(200, JSON.stringify({ status: 200, message: "Decision accepted" }), cap) });
    ok("POST to Continue URL", cap.url.endsWith("/InvoiceDecisionApi/v1/Continue") && cap.init.method === "POST");
    const h = cap.init.headers as Record<string, string>;
    ok("bearer + json", h.Authorization === "Bearer tkn" && h["Content-Type"] === "application/json");
    ok("body is the payload", cap.init.body === JSON.stringify(PAYLOAD));
  }

  // ---- accepted: HTTP 200 AND body.status === 200 ----
  ok("200 + status 200 → accepted", parseDecisionResponse(200, { status: 200, message: "Decision accepted" }).kind === "accepted");
  ok("200 but body.status not 200 → NOT accepted", parseDecisionResponse(200, { status: 463, message: "x" }).kind !== "accepted");

  // ---- 462 / 463 (accepted from HTTP status OR body status) ----
  ok("462 (http) → already_reported", parseDecisionResponse(462, { message: "already" }).kind === "already_reported");
  ok("462 (body) → already_reported", parseDecisionResponse(200, { status: 462, message: "already" }).kind === "already_reported");
  ok("463 (http) → no_matching_invoice", parseDecisionResponse(463, { message: "none" }).kind === "no_matching_invoice");
  ok("463 (body) → no_matching_invoice", parseDecisionResponse(200, { status: 463, message: "none" }).kind === "no_matching_invoice");

  // ---- validation / infra ----
  ok("400 → validation_error", parseDecisionResponse(400, { status: 400, message: "bad" }).kind === "validation_error");
  ok("401 → infrastructure/AUTHENTICATION", (() => { const r = parseDecisionResponse(401, {}); return r.kind === "infrastructure_error" && r.classification === "AUTHENTICATION"; })());
  ok("500 → infrastructure/SERVER", (() => { const r = parseDecisionResponse(500, {}); return r.kind === "infrastructure_error" && r.classification === "SERVER"; })());

  // ---- transport failures ----
  {
    const failing = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const r = await sendInvoiceDecision({ accessToken: "t", action: "Cancel", payload: PAYLOAD, config: CONFIG, fetchImpl: failing });
    ok("network → infrastructure/NETWORK", r.kind === "infrastructure_error" && r.classification === "NETWORK" && r.httpStatus === null);
  }
  {
    const r = await sendInvoiceDecision({ accessToken: "t", action: "Cancel", payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(200, "<html>not json</html>") });
    ok("non-JSON 200 → infrastructure (no false accept)", r.kind === "infrastructure_error");
  }
}

main().then(() => {
  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nAll decision client tests passed.");
}).catch((e) => { console.error(e); process.exit(1); });
