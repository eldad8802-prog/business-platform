/**
 * D1 — issuer details completion, per track (#1081). Pure.
 *
 *   npx tsx lib/billing/issuer-declaration/details.test.ts
 */
import { hasValidIsraeliCheckDigit, REQUIRED_FIELDS_BY_KIND, TRACK_BY_KIND, validateIssuerDetails } from "@/lib/billing/issuer-declaration/details";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL: D1", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK: D1", name);
}

// Valid 9-digit numbers (check digit computed by the published algorithm).
const ID = "000000018";
const COMPANY = "510000003";
const base = { billingLegalName: "ישראל ישראלי", billingAddress: "הרצל 1, תל אביב", billingPhone: "050-1234567", billingEmail: "a@example.com" };

ok("check digit: 000000018 valid", hasValidIsraeliCheckDigit(ID));
ok("check digit: 510000003 valid", hasValidIsraeliCheckDigit(COMPANY));
ok("check digit: 000000019 invalid", !hasValidIsraeliCheckDigit("000000019"));
ok("check digit: 8 digits refused", !hasValidIsraeliCheckDigit("12345678"));
ok("check digit: separators refused", !hasValidIsraeliCheckDigit("51-000000-3"));

ok("no kind → only the kind is asked for", JSON.stringify(validateIssuerDetails({}).map((p) => p.field)) === '["billingBusinessKind"]');
ok("unknown kind → kind problem", validateIssuerDetails({ billingBusinessKind: "PARTNERSHIP" })[0]?.field === "billingBusinessKind");

// Exempt dealer
ok("exempt: complete with no VAT number", validateIssuerDetails({ ...base, billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID, billingVatNumber: null }).length === 0);
ok("exempt: VAT number is not applicable", validateIssuerDetails({ ...base, billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID, billingVatNumber: ID })[0]?.code === "NOT_APPLICABLE");
ok("exempt: required list has no VAT number", !REQUIRED_FIELDS_BY_KIND.EXEMPT_DEALER.includes("billingVatNumber"));
ok("exempt: track shape", JSON.stringify(TRACK_BY_KIND.EXEMPT_DEALER) === '{"track":"EXEMPT_DEALER","legalForm":"INDIVIDUAL","vatStatus":"EXEMPT","idType":"ISRAELI_ID"}');

// Authorized dealer
const authMissingVat = validateIssuerDetails({ ...base, billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: ID });
ok("authorized: VAT number required", authMissingVat.length === 1 && authMissingVat[0].field === "billingVatNumber" && authMissingVat[0].code === "MISSING", authMissingVat);
ok("authorized: complete", validateIssuerDetails({ ...base, billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: ID, billingVatNumber: ID }).length === 0);
ok("authorized: bad check digit on ID", validateIssuerDetails({ ...base, billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: "000000019", billingVatNumber: ID })[0]?.code === "CHECK_DIGIT");
ok("authorized: track shape", TRACK_BY_KIND.AUTHORIZED_DEALER.track === "AUTHORIZED_DEALER_INDIVIDUAL" && TRACK_BY_KIND.AUTHORIZED_DEALER.vatStatus === "AUTHORIZED");

// Company
ok("company: complete", validateIssuerDetails({ ...base, billingBusinessKind: "LTD_COMPANY", billingTaxId: COMPANY, billingVatNumber: COMPANY }).length === 0);
ok("company: VAT number required", validateIssuerDetails({ ...base, billingBusinessKind: "LTD_COMPANY", billingTaxId: COMPANY }).some((p) => p.field === "billingVatNumber"));
ok("company: number with separators → FORMAT", validateIssuerDetails({ ...base, billingBusinessKind: "LTD_COMPANY", billingTaxId: "51-000000-3", billingVatNumber: COMPANY })[0]?.code === "FORMAT");
ok("company: track shape", TRACK_BY_KIND.LTD_COMPANY.idType === "COMPANY_NUMBER" && TRACK_BY_KIND.LTD_COMPANY.legalForm === "COMPANY");

// Shared fields
const allMissing = validateIssuerDetails({ billingBusinessKind: "AUTHORIZED_DEALER" });
ok("every required field reported, in order", JSON.stringify(allMissing.map((p) => p.field)) === JSON.stringify(REQUIRED_FIELDS_BY_KIND.AUTHORIZED_DEALER), allMissing.map((p) => p.field));
ok("whitespace-only counts as missing", validateIssuerDetails({ ...base, billingLegalName: "   ", billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID })[0]?.field === "billingLegalName");
ok("legal name over 120 → TOO_LONG", validateIssuerDetails({ ...base, billingLegalName: "א".repeat(121), billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID })[0]?.code === "TOO_LONG");
ok("bad phone → FORMAT", validateIssuerDetails({ ...base, billingPhone: "abc", billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID })[0]?.field === "billingPhone");
ok("bad email → FORMAT", validateIssuerDetails({ ...base, billingEmail: "nope", billingBusinessKind: "EXEMPT_DEALER", billingTaxId: ID })[0]?.field === "billingEmail");
ok("every problem has a Hebrew message", allMissing.every((p) => /[֐-׿]/.test(p.message)));

console.log(failed ? `\nD1: ${passed} passed, ${failed} FAILED` : `\nD1: ${passed}/${passed} passed`);
if (failed) process.exit(1);
