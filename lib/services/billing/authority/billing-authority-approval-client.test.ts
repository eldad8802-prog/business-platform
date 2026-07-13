/**
 * Unit tests for the ITA allocation HTTP client + parser (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-client.test.ts
 *
 * No real network: fetch is always injected. Deterministic.
 */
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  createAuthorityOAuthScopeProvider,
  buildInvoiceApprovalUrl,
  type AuthorityApprovalConfig,
} from "@/lib/services/billing/authority/billing-authority-approval-client.config";
import {
  sendInvoiceApproval,
  parseApprovalResponse,
  classifyHttpStatus,
} from "@/lib/services/billing/authority/billing-authority-approval-client";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const TEST_TOKEN = "test-access-token";
const CONFIG: AuthorityApprovalConfig = {
  apiBaseUrl: "https://t-ita-api.taxes.gov.il/shaam/tsandbox",
  apiVersion: "v2",
  timeoutMs: 15000,
  scope: "invoices_scope",
};

const PAYLOAD: InvoiceApprovalRequest = {
  invoice_id: "42",
  invoice_type: 305,
  vat_number: 515000123,
  invoice_reference_number: "000007",
  customer_vat_number: 514000000,
  invoice_date: "2026-06-15",
  invoice_issuance_date: "2026-06-15",
  accounting_software_number: 12345678,
  amount_before_discount: 100,
  discount: 0,
  payment_amount: 100,
  vat_amount: 17,
  payment_amount_including_vat: 117,
  customer_name: "לקוח",
  items: [
    { index: 0, description: "שירות", quantity: 1, price_per_unit: 100, discount: 0, total_amount: 100, vat_rate: 17, vat_amount: 17 },
  ],
};

type Capture = { url: string; init: RequestInit };
function mockFetch(status: number, body: string, capture?: Capture): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init ?? {};
    }
    return { status, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const SUCCESS_BODY = JSON.stringify({ status: 200, message: "Invoice approved", confirmation_number: "20240718181618323199093572", approved: true });

async function main(): Promise<void> {
  // ---- Config layer (no hardcoding) ----
  ok("scope provider returns configured scope", createAuthorityOAuthScopeProvider({ scope: "invoices_scope" }).resolveScope() === "invoices_scope");
  ok("scope provider returns alt scope", createAuthorityOAuthScopeProvider({ scope: "scope" }).resolveScope() === "scope");
  ok("URL built from config", buildInvoiceApprovalUrl(CONFIG) === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval");
  ok("URL normalizes trailing slash", buildInvoiceApprovalUrl({ apiBaseUrl: "https://x/shaam/tsandbox/", apiVersion: "v2" }) === "https://x/shaam/tsandbox/Invoices/v2/Approval");

  // ---- Serialization: URL, method, headers, body — no mutation, no added fields ----
  {
    const cap: Capture = { url: "", init: {} };
    const before = JSON.stringify(PAYLOAD);
    await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(200, SUCCESS_BODY, cap) });
    ok("POST to correct URL", cap.url === "https://t-ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval");
    ok("method POST", cap.init.method === "POST");
    const h = cap.init.headers as Record<string, string>;
    ok("Authorization Bearer", h.Authorization === "Bearer test-access-token");
    ok("Content-Type json", h["Content-Type"] === "application/json");
    ok("Accept json", h.Accept === "application/json");
    ok("body === JSON.stringify(payload) (no added fields)", cap.init.body === JSON.stringify(PAYLOAD));
    ok("input payload not mutated", JSON.stringify(PAYLOAD) === before);
  }

  // ---- Success 200 ----
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(200, SUCCESS_BODY) });
    ok("200 → success", r.kind === "success" && r.httpStatus === 200);
    ok("200 confirmation_number parsed", r.kind === "success" && r.response.confirmation_number === "20240718181618323199093572" && r.response.approved === true);
  }

  // ---- Validation 400 ----
  {
    const body = JSON.stringify({ status: 400, message: { errors: [{ code: 434, message: "Invoice date is too old for approval", param: "invoice_date", location: "request" }] }, confirmation_number: "0", approved: false });
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(400, body) });
    ok("400 → validation_error", r.kind === "validation_error" && r.classification === "BUSINESS_VALIDATION");
    ok("400 errors parsed (code number, param, location)", r.kind === "validation_error" && r.response.message.errors[0].code === 434 && r.response.message.errors[0].param === "invoice_date" && r.response.message.errors[0].location === "request");
    ok("400 confirmation_number + approved", r.kind === "validation_error" && r.response.confirmation_number === "0" && r.response.approved === false);
  }

  // ---- 406 / 500 ----
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(406, JSON.stringify({ status: 406, message: "Not Acceptable", error_id: "20240718181618323199093572" })) });
    ok("406 → not_acceptable + error_id", r.kind === "not_acceptable" && r.response.error_id === "20240718181618323199093572" && r.response.message === "Not Acceptable");
  }
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(500, JSON.stringify({ status: 500, message: "Internal error server", error_id: "abc" })) });
    ok("500 → server_error + SERVER class", r.kind === "server_error" && r.classification === "SERVER" && r.response.error_id === "abc");
  }

  // ---- Infrastructural statuses (undocumented) ----
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(401, "") });
    ok("401 → infrastructure/AUTHENTICATION", r.kind === "infrastructure_error" && r.classification === "AUTHENTICATION");
  }
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(403, "") });
    ok("403 → infrastructure/AUTHORIZATION", r.kind === "infrastructure_error" && r.classification === "AUTHORIZATION");
  }
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(418, "") });
    ok("unknown status (418) → infrastructure/UNKNOWN", r.kind === "infrastructure_error" && r.classification === "UNKNOWN" && r.httpStatus === 418);
  }

  // ---- Timeout & network failure ----
  {
    const abortingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: { ...CONFIG, timeoutMs: 20 }, fetchImpl: abortingFetch });
    ok("timeout → infrastructure/TIMEOUT", r.kind === "infrastructure_error" && r.classification === "TIMEOUT" && r.httpStatus === null);
  }
  {
    const failingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: failingFetch });
    ok("network failure → infrastructure/NETWORK", r.kind === "infrastructure_error" && r.classification === "NETWORK" && r.httpStatus === null);
  }

  // ---- Parser failure (non-JSON body) ----
  {
    const r = await sendInvoiceApproval({ accessToken: TEST_TOKEN, payload: PAYLOAD, config: CONFIG, fetchImpl: mockFetch(200, "<html>not json</html>") });
    ok("non-JSON body → infrastructure error", r.kind === "infrastructure_error" && r.message === "Response body was not valid JSON");
  }

  // ---- Pure parser + classification ----
  ok("parseApprovalResponse 200", parseApprovalResponse(200, { status: 200, message: "ok", confirmation_number: null, approved: false }).kind === "success");
  ok("parseApprovalResponse 400", parseApprovalResponse(400, { message: { errors: [] } }).kind === "validation_error");
  ok("classify 401 AUTHENTICATION", classifyHttpStatus(401) === "AUTHENTICATION");
  ok("classify 403 AUTHORIZATION", classifyHttpStatus(403) === "AUTHORIZATION");
  ok("classify 408 TIMEOUT", classifyHttpStatus(408) === "TIMEOUT");
  ok("classify 429 NETWORK", classifyHttpStatus(429) === "NETWORK");
  ok("classify 503 SERVER", classifyHttpStatus(503) === "SERVER");
  ok("classify 400 BUSINESS_VALIDATION", classifyHttpStatus(400) === "BUSINESS_VALIDATION");
  ok("classify 404 UNKNOWN", classifyHttpStatus(404) === "UNKNOWN");
}

main()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} test(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll approval HTTP client tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
