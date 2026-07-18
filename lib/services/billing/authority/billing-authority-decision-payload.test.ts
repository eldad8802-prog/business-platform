/**
 * Unit tests for the Invoice-decision DTO builder (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-decision-payload.test.ts
 * Pure — no DB, no network.
 */
import { buildInvoiceDecisionPayload } from "@/lib/services/billing/authority/billing-authority-decision-payload";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const base = {
  billingDocumentId: 42,
  issuerVatNumber: "515000123",
  accountingSoftwareNumber: "12345678",
};

// Shared required fields present for all three actions (the DTO is action-agnostic).
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "דנה כהן" });
  ok("required fields built", r.ok === true && r.payload.invoice_id === "42" && r.payload.vat_number === 515000123 && r.payload.accounting_software_number === 12345678);
}

// user_name path (no national id) + A25 truncation.
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "A very long operator display name exceeding twenty-five chars" });
  ok("user_name used when no national id", r.ok === true && typeof r.payload.user_name === "string" && r.payload.user_id === undefined);
  ok("user_name truncated to A25", r.ok === true && (r.payload.user_name?.length ?? 0) <= 25);
}

// user_id preferred when a valid operator national id (N9) exists.
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorNationalId: "312345678", operatorName: "דנה" });
  ok("user_id preferred over user_name", r.ok === true && r.payload.user_id === 312345678 && r.payload.user_name === undefined);
}

// Neither identity → validation error, no partial payload.
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "  " });
  ok("no operator identity → validation error", r.ok === false && r.errors.some((e) => e.code === "MISSING_OPERATOR_IDENTITY"));
}

// authorized_company omitted when no source (conditional).
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "דנה" });
  ok("authorized_company omitted when absent", r.ok === true && r.payload.authorized_company === undefined);
}
// authorized_company included only when a valid N9 source is supplied.
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "דנה", authorizedCompany: "512345678" });
  ok("authorized_company included when supplied (N9)", r.ok === true && r.payload.authorized_company === 512345678);
}
// invalid authorized_company → validation error (never fabricated/partial).
{
  const r = buildInvoiceDecisionPayload({ ...base, operatorName: "דנה", authorizedCompany: "abc" });
  ok("invalid authorized_company → validation error", r.ok === false && r.errors.some((e) => e.code === "INVALID_AUTHORIZED_COMPANY"));
}

// issuer VAT non-digits → validation error.
{
  const r = buildInvoiceDecisionPayload({ ...base, issuerVatNumber: "51-500", operatorName: "דנה" });
  ok("bad issuer VAT → validation error", r.ok === false && r.errors.some((e) => e.code === "INVALID_ISSUER_VAT_NUMBER"));
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll decision payload tests passed.");
