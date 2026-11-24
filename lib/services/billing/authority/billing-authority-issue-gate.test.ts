/**
 * Pure rule: an invoice that would be READY for an allocation number is blocked at
 * issue while the Approval is known to be refused (Production pilot gate); every
 * other case is left alone.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-issue-gate.test.ts
 */
import { BillingDocumentType, CustomerTaxIdType, Prisma } from "@prisma/client";
import {
  AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_CODE,
  AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE,
  AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE,
  resolveIssueAllocationGate,
  type IssueAllocationGateDeps,
  type IssueAllocationGateInput,
} from "@/lib/services/billing/authority/billing-authority-issue-gate";
import {
  AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED,
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY,
  resolveAuthorityProductionApprovalDocumentRefusal,
  resolveAuthorityProductionOperationRefusal,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const D = (v: string) => new Prisma.Decimal(v);
const JUNE_2026 = new Date("2026-11-10T09:00:00Z"); // threshold 5,000 ILS

/** READY for a licensed issuer: VAT > 0, 6,000 ILS ≥ threshold, licensed-dealer customer. */
const ready: IssueAllocationGateInput = {
  businessId: 1001,
  billingDocumentId: 5001,
  documentType: BillingDocumentType.TAX_INVOICE,
  invoiceDate: JUNE_2026,
  vatAmount: D("1080.00"),
  subtotalAmount: D("6000.00"),
  currency: "ILS",
  customerTaxIdType: CustomerTaxIdType.AUTHORIZED_DEALER,
  customerTaxId: "515000131",
};

const refusing = (code = AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED): IssueAllocationGateDeps => ({
  resolveEnvironment: () => "PRODUCTION",
  resolveRefusal: () => code,
  // Never reached while sending is closed; authorizes everything so it cannot mask the closed answer.
  resolveDocumentRefusal: () => null,
});
const allowing: IssueAllocationGateDeps = { resolveEnvironment: () => "PRODUCTION", resolveRefusal: () => null, resolveDocumentRefusal: () => null };
const blocked = (input: IssueAllocationGateInput, deps: IssueAllocationGateDeps) => resolveIssueAllocationGate(input, deps).blocked;

// --- blocked only when READY and the send is refused ---
ok("READY tax invoice + pilot refuses → blocked", blocked(ready, refusing()));
ok("READY tax invoice/receipt + pilot refuses → blocked", blocked({ ...ready, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT }, refusing()));
ok("READY + OAUTH_ONLY stage refuses → blocked", blocked(ready, refusing(AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY)));
ok("READY + pilot allows → not blocked", !blocked(ready, allowing));
const r = resolveIssueAllocationGate(ready, refusing());
ok("the refusal code is carried for diagnostics", r.blocked && r.refusalCode === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED);

// --- never blocked when no allocation would be required (same readiness rule) ---
ok("below the 5,000 ILS threshold → not blocked", !blocked({ ...ready, subtotalAmount: D("4999.99") }, refusing()));
ok("no VAT → not blocked", !blocked({ ...ready, vatAmount: D("0") }, refusing()));
ok("foreign currency → not blocked", !blocked({ ...ready, currency: "USD" }, refusing()));
ok("private customer → not blocked", !blocked({ ...ready, customerTaxIdType: CustomerTaxIdType.PRIVATE_ID }, refusing()));
ok("exempt-dealer customer → not blocked", !blocked({ ...ready, customerTaxIdType: CustomerTaxIdType.EXEMPT_DEALER }, refusing()));
ok("dealer type without a tax id → not blocked", !blocked({ ...ready, customerTaxId: "  " }, refusing()));
for (const t of [BillingDocumentType.RECEIPT, BillingDocumentType.CREDIT_NOTE, BillingDocumentType.QUOTE]) {
  ok(`${t} → never blocked`, !blocked({ ...ready, documentType: t }, refusing()));
}
ok("threshold by date: 6,000 ILS in early 2026 (10,000 threshold) → not blocked",
  !blocked({ ...ready, invoiceDate: new Date("2026-03-01T09:00:00Z") }, refusing()));

// --- an unresolvable environment is left as before (not this gate's decision) ---
ok("environment not configured → not blocked (unchanged behaviour)",
  !blocked(ready, {
    resolveEnvironment: () => { throw new Error("unset"); },
    resolveRefusal: () => AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
    resolveDocumentRefusal: () => AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED,
  }));
ok("sending closed → the unchanged #1076 code and message (byte-identical)",
  r.blocked && r.reason === "SENDING_CLOSED" && r.code === AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE &&
  r.code === "AUTHORITY_ALLOCATION_SENDING_CLOSED" && r.message === AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE);

// --- N10: sending open → only the document authorized in advance may issue ---
const docGate = (refusal: string | null): IssueAllocationGateDeps => ({
  resolveEnvironment: () => "PRODUCTION",
  resolveRefusal: () => null,
  resolveDocumentRefusal: () => refusal as never,
});
const n = resolveIssueAllocationGate(ready, docGate(AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED));
ok("N10 sending open + document not authorized → blocked with DOCUMENT_NOT_AUTHORIZED",
  n.blocked && n.reason === "DOCUMENT_NOT_AUTHORIZED" && n.code === AUTHORITY_ALLOCATION_DOCUMENT_NOT_AUTHORIZED_CODE &&
  n.refusalCode === AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED && /טיוטה/.test(n.message));
ok("N10 sending open + document authorized → not blocked", !blocked(ready, docGate(null)));
ok("N10 a document that needs no allocation is never refused by the list",
  !blocked({ ...ready, customerTaxIdType: CustomerTaxIdType.PRIVATE_ID }, docGate(AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED)));
let docAsked = 0;
resolveIssueAllocationGate(ready, { ...refusing(), resolveDocumentRefusal: () => { docAsked++; return null; } });
ok("N10 sending closed answers first: the document list is not even consulted", docAsked === 0);

// --- the real gates together, through explicit environments (no process.env) ---
const realDeps = (env: Record<string, string>): IssueAllocationGateDeps => ({
  resolveEnvironment: () => (env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT as never) ?? "PRODUCTION",
  resolveRefusal: (b, e) => resolveAuthorityProductionOperationRefusal(b, e, "approval", env),
  resolveDocumentRefusal: (b, d, e) => resolveAuthorityProductionApprovalDocumentRefusal(b, d, e, env),
});
const pilotOpen = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION",
  BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: "1001",
  BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,refresh,approval",
  BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS: "PRODUCTION:1001:5001",
};
const real = (input: IssueAllocationGateInput, env: Record<string, string>) => resolveIssueAllocationGate(input, realDeps(env));
ok("M1 \"oauth\" (today) → SENDING_CLOSED, unchanged", (() => { const x = real(ready, { ...pilotOpen, BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth" }); return x.blocked && x.reason === "SENDING_CLOSED"; })());
ok("M2 approval open, list unset → every READY document refused (fail closed)", (() => {
  const { BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS: _omit, ...noList } = pilotOpen; void _omit;
  const x = real(ready, noList); return x.blocked && x.reason === "DOCUMENT_NOT_AUTHORIZED";
})());
ok("M3 approval open, this document listed → issues", !real(ready, pilotOpen).blocked);
ok("M4 approval open, ANOTHER document of the same business → refused", (() => { const x = real({ ...ready, billingDocumentId: 5002 }, pilotOpen); return x.blocked && x.reason === "DOCUMENT_NOT_AUTHORIZED"; })());
ok("M5 the same document id listed under ANOTHER business → refused", (() => { const x = real(ready, { ...pilotOpen, BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: "1001,2002", BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS: "PRODUCTION:2002:5001" }); return x.blocked && x.reason === "DOCUMENT_NOT_AUTHORIZED"; })());
ok("M6 NOT_REQUIRED document, not listed → issues", !real({ ...ready, billingDocumentId: 5002, subtotalAmount: D("1000.00") }, pilotOpen).blocked);
ok("M7 SANDBOX → never gated, listed or not", !real({ ...ready, billingDocumentId: 5002 }, { ...pilotOpen, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" }).blocked);
ok("M8 a business not on the pilot list → SENDING_CLOSED (unchanged), even if its document is listed", (() => {
  const x = real({ ...ready, businessId: 3003 }, { ...pilotOpen, BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS: "PRODUCTION:3003:5001" });
  return x.blocked && x.reason === "SENDING_CLOSED";
})());
ok("M9 an invalid list (one bad entry) → nothing authorized", (() => { const x = real(ready, { ...pilotOpen, BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS: "PRODUCTION:1001:5001,SANDBOX:1001:5002" }); return x.blocked && x.reason === "DOCUMENT_NOT_AUTHORIZED"; })());

// --- the default deps use the real pilot gate: Production's settings ---
const prodEnv = {
  BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: "9",
  BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth",
};
ok("real gate, Production settings: a non-pilot business is refused the Approval",
  resolveAuthorityProductionOperationRefusal(1001, "PRODUCTION", "approval", prodEnv) !== null);
ok("real gate, Production settings: the pilot business is refused too (OAUTH_ONLY)",
  resolveAuthorityProductionOperationRefusal(9, "PRODUCTION", "approval", prodEnv) === AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY);
ok("real gate: SANDBOX is never refused", resolveAuthorityProductionOperationRefusal(1001, "SANDBOX", "approval", prodEnv) === null);
ok("real gate: approval opened for the pilot business → allowed",
  resolveAuthorityProductionOperationRefusal(9, "PRODUCTION", "approval", { ...prodEnv, BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,refresh,approval" }) === null);

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
