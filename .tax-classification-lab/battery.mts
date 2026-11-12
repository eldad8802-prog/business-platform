/**
 * PR-0 — tax-classification readiness lab: every supported classification × every billing document type,
 * create → edit → issue → numbering → saved state → PDF → re-read after "refresh", on an isolated PostgreSQL
 * with synthetic data, under the repository's replayed RLS, connected as a NOBYPASSRLS role.
 *
 * Tests only. No product code is changed. A reproduced defect is recorded as DEFECT (see lab-kit.mts), so the
 * suite stays green while the defect exists and turns red when a fix lands — the expectation is then updated
 * on purpose, in the fixing PR.
 *
 * Authority (ITA): the issue ROUTE runs with Production's pilot settings (RUNTIME=PRODUCTION, pilot list "9",
 * OPERATIONS=oauth) — exactly what a real non-pilot business gets today. Allocation outcomes (APPROVED, HELD,
 * uncertain, not-sent failure, rejected) run through the REAL execution service and REAL state transitions with
 * only the HTTP request replaced by a local fake (counted). No request leaves the process (network trap), and in
 * CI the process additionally runs under an OS-level iptables owner rule.
 *
 *   DATABASE_URL / DIRECT_URL / AUTH_DATABASE_URL = NOBYPASSRLS runtime role on a throwaway database
 *   RLS_ADMIN_URL = the owner of that database (fixtures + policy replay)
 *   STORAGE_PROVIDER=local LOCAL_STORAGE_ROOT=… BILLING_PDF_STORAGE_ROOT=… ; Chromium installed (playwright)
 *   npx tsx .tax-classification-lab/battery.mts
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

import {
  callRoute,
  EVIDENCE_DIR,
  check,
  errorText,
  failureCount,
  networkAttempts,
  pdfText,
  printed,
  replayRepositoryRls,
  saveEvidence,
  untested,
  writeLedger,
  type RouteResult,
} from "./lab-kit.mts";

// Production's pilot settings, verbatim shape (values: the pilot business is 9; lab businesses start at 1000).
process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
// The PDF cache stays ON, as in Production: a second download must serve the stored file.

const ADMIN_URL = process.env.RLS_ADMIN_URL;
if (!ADMIN_URL) {
  console.error("RLS_ADMIN_URL is required");
  process.exit(1);
}
const owner = new PrismaClient({ datasourceUrl: ADMIN_URL });
const runtime = new PrismaClient();

const KIND_LABEL: Record<string, string> = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER: "עוסק מורשה",
  LTD_COMPANY: "חברה",
  NONE: "סיווג חסר",
  INCOMPLETE: "פרטים חסרים",
};
const TYPE_HE: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  TAX_INVOICE_RECEIPT: "חשבונית מס/קבלה",
  RECEIPT: "קבלה",
  CREDIT_NOTE: "חשבונית זיכוי",
  QUOTE: "הצעת מחיר",
};

type Tenant = {
  key: string;
  kind: string;
  businessId: number;
  userId: number;
  token: string;
  user2Id: number;
  token2: string;
  dealerCustomerId: number;
  privateCustomerId: number;
};

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const docsRoute = await import("@/app/api/billing/documents/route");
  const docRoute = await import("@/app/api/billing/documents/[id]/route");
  const linesRoute = await import("@/app/api/billing/documents/[id]/lines/route");
  const paymentsRoute = await import("@/app/api/billing/documents/[id]/payments/route");
  const allocationsRoute = await import("@/app/api/billing/documents/[id]/allocations/route");
  const issueRoute = await import("@/app/api/billing/documents/[id]/issue/route");
  const pdfRoute = await import("@/app/api/billing/documents/[id]/pdf/route");
  const convertRoute = await import("@/app/api/billing/documents/[id]/convert-to-invoice/route");
  const creditRoute = await import("@/app/api/billing/documents/[id]/credit-note/route");
  const decisionRoute = await import("@/app/api/billing/documents/[id]/authority-decision/route");
  const profileRoute = await import("@/app/api/billing/invoice-profile/route");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { executeAuthorityApproval, defaultSubmissionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-submission-execution.service"
  );
  const { executeAuthorityDecision, defaultDecisionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-decision.service"
  );
  const { describeAuthorityIssueOutcome } = await import("@/lib/billing/authority-issue-display");
  const { settleVerifiedPayment } = await import("@/lib/services/billing/settlement/payment-accounting-settlement.service");

  // ------------------------------------------------------------------ posture
  const [who] = (await runtime.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`connected as ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.error("the runtime role bypasses RLS — the lab would prove nothing");
    process.exit(1);
  }
  const replayed = await replayRepositoryRls(ADMIN_URL!);
  check("P0", "OK", "SERVICE", `replayed ${replayed} RLS/role statements; battery runs NOBYPASSRLS`, replayed > 50, replayed);
  await owner.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Business"','id'), GREATEST(1000, (SELECT COALESCE(MAX(id),0) FROM "Business")))`);

  // ------------------------------------------------------------------ fixtures (owner)
  const stamp = Date.now();
  async function tenant(key: string, kind: string, profile: Record<string, string | null> | null): Promise<Tenant> {
    const b = await owner.business.create({ data: { name: `taxlab-${key}-${stamp}` } });
    const u = await owner.user.create({ data: { email: `taxlab-${key}-${stamp}@example.test`, password: "x", businessId: b.id, role: "USER" } });
    const u2 = await owner.user.create({ data: { email: `taxlab-${key}-2-${stamp}@example.test`, password: "x", businessId: b.id, role: "USER" } });
    if (profile) await owner.businessProfile.create({ data: { businessId: b.id, ...profile } });
    const dealer = await owner.customer.create({ data: { businessId: b.id, name: "לקוח עוסק מורשה סינתטי", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    const priv = await owner.customer.create({ data: { businessId: b.id, name: "לקוח פרטי סינתטי" } });
    return {
      key, kind, businessId: b.id, userId: u.id, token: signAuthToken(u.id, u.tokenVersion), user2Id: u2.id,
      token2: signAuthToken(u2.id, u2.tokenVersion), dealerCustomerId: dealer.id, privateCustomerId: priv.id,
    };
  }
  const base = (label: string) => ({
    billingLegalName: `עסק סינתטי ${label}`,
    billingAddress: "רחוב הבדיקה 1, תל אביב",
    billingPhone: "03-0000000",
    billingEmail: `taxlab-${label}@example.test`,
  });
  const E = await tenant("E", "EXEMPT_DEALER", { ...base("פטור"), billingBusinessKind: "EXEMPT_DEALER", billingTaxId: "000000018" });
  const A = await tenant("A", "AUTHORIZED_DEALER", { ...base("מורשה"), billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: "999999998", billingVatNumber: "999999998" });
  const C = await tenant("C", "LTD_COMPANY", { ...base("חברה"), billingBusinessKind: "LTD_COMPANY", billingTaxId: "516000004", billingVatNumber: "516000004" });
  const N = await tenant("N", "NONE", { ...base("ללא סיווג"), billingBusinessKind: null, billingTaxId: "999999981" });
  const I = await tenant("I", "INCOMPLETE", { ...base("חסר"), billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: "999999973", billingAddress: null });
  const X = await tenant("X", "LTD_COMPANY", { ...base("אחר"), billingBusinessKind: "LTD_COMPANY", billingTaxId: "516000012" });
  check("P1", "OK", "SERVICE", "lab businesses are not the pilot business (ids ≥ 1000, pilot list = 9)", [E, A, C, N, I, X].every((t) => t.businessId >= 1000), [E, A, C, N, I, X].map((t) => t.businessId));

  // ------------------------------------------------------------------ API helpers
  const P = (id: number) => ({ id: String(id) });
  const line = (description: string, unitPrice: string, vat: string, quantity = "1") => ({ description, quantity, unitPrice, vatRatePercent: vat });
  const createDraft = (t: Tenant, documentType: string, extra: Record<string, unknown> = {}, token = t.token) =>
    callRoute(docsRoute.POST, { method: "POST", url: "/api/billing/documents", token, body: { documentType, ...extra } });
  const putLines = (t: Tenant, id: number, lines: unknown[]) =>
    callRoute(linesRoute.PUT, { method: "PUT", url: `/api/billing/documents/${id}/lines`, token: t.token, body: { lines }, params: P(id) });
  const putPayments = (t: Tenant, id: number, payments: unknown[]) =>
    callRoute(paymentsRoute.POST, { method: "POST", url: `/api/billing/documents/${id}/payments`, token: t.token, body: { payments }, params: P(id) });
  const putAllocations = (t: Tenant, id: number, allocations: unknown[]) =>
    callRoute(allocationsRoute.POST, { method: "POST", url: `/api/billing/documents/${id}/allocations`, token: t.token, body: { allocations }, params: P(id) });
  const issue = (t: Tenant, id: number, token = t.token) =>
    callRoute(issueRoute.POST, { method: "POST", url: `/api/billing/documents/${id}/issue`, token, params: P(id) });
  const getDoc = (t: Tenant, id: number, token = t.token) =>
    callRoute(docRoute.GET, { method: "GET", url: `/api/billing/documents/${id}`, token, params: P(id) });
  const getPdf = (t: Tenant, id: number, token = t.token) =>
    callRoute(pdfRoute.GET, { method: "GET", url: `/api/billing/documents/${id}/pdf`, token, params: P(id) });
  const convert = (t: Tenant, id: number) =>
    callRoute(convertRoute.POST, { method: "POST", url: `/api/billing/documents/${id}/convert-to-invoice`, token: t.token, params: P(id) });
  const credit = (t: Tenant, id: number) =>
    callRoute(creditRoute.POST, { method: "POST", url: `/api/billing/documents/${id}/credit-note`, token: t.token, params: P(id) });
  const patchProfile = (token: string, body: Record<string, unknown>) =>
    callRoute(profileRoute.PATCH, { method: "PATCH", url: "/api/billing/invoice-profile", token, body });
  const cash = (amount: string) => [{ lineIndex: 1, method: "CASH", amount, currency: "ILS", paymentDate: "2026-11-10" }];
  const seq = async (businessId: number, documentType: BillingDocumentType) =>
    (await owner.billingDocumentNumberSequence.findUnique({ where: { businessId_documentType: { businessId, documentType } } }))?.nextNumber ?? null;
  const docRow = (id: number) =>
    owner.billingDocument.findUniqueOrThrow({
      where: { id },
      select: { status: true, documentType: true, documentNumber: true, documentNumberFormatted: true, issuedSnapshot: true, allocationNumber: true, convertedToInvoiceId: true, referenceDocumentId: true },
    });
  const submissionOf = (id: number) => owner.billingAuthoritySubmission.findUnique({ where: { billingDocumentId: id } });

  /** Fetch the PDF through the real route; save it and its text as evidence. */
  async function pdfEvidence(t: Tenant, id: number, label: string) {
    const r = await getPdf(t, id);
    if (r.status !== 200 || !r.buffer) return { r, text: "", disposition: r.headers.get("content-disposition") ?? "" };
    const text = await pdfText(r.buffer);
    saveEvidence(`pdf/${label}.pdf`, r.buffer);
    saveEvidence(`pdf/${label}.txt`, text);
    return { r, text, disposition: r.headers.get("content-disposition") ?? "" };
  }

  /** Re-read after a "refresh": the document API returns what was saved, and a second PDF fetch is the same bytes. */
  async function reread(t: Tenant, id: number, idp: string, first: RouteResult, tags: Record<string, string>) {
    const again = await getDoc(t, id);
    const pdf2 = await getPdf(t, id);
    check(`${idp}.reread`, "OK", "API", "after refresh: document reads back ISSUED with its number; PDF served again identically",
      again.status === 200 && again.json?.document?.status === "ISSUED" && !!again.json?.document?.documentNumberFormatted &&
        pdf2.status === 200 && !!first.buffer && !!pdf2.buffer && first.buffer.equals(pdf2.buffer),
      { status: again.status, docStatus: again.json?.document?.status, sameBytes: !!first.buffer && !!pdf2.buffer && first.buffer.equals(pdf2.buffer) }, tags);
  }

  // ================================================================== 1. drafts per classification × type (API)
  console.log("\n— 1. drafts at creation");
  const tenants = [E, A, C, N, I];
  const draftStatus: Record<string, Record<string, number>> = {};
  for (const t of tenants) {
    draftStatus[t.key] = {};
    for (const type of ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "QUOTE", "CREDIT_NOTE"]) {
      const body = type === "RECEIPT" ? { customerId: t.privateCustomerId } : { customerId: t.privateCustomerId, initialLines: [line("שירות", "100", "18")] };
      const r = await createDraft(t, type, body);
      draftStatus[t.key][type] = r.status;
    }
  }
  saveEvidence("draft-creation-status.json", JSON.stringify(draftStatus, null, 2));
  check("D1.E.TI", "OBSERVED", "API", "exempt dealer CAN create a TAX_INVOICE draft (refused only at issue)", draftStatus.E.TAX_INVOICE === 201, draftStatus.E, { classification: "EXEMPT_DEALER", docType: "TAX_INVOICE" });
  check("D1.E.TIR", "OBSERVED", "API", "exempt dealer CAN create a TAX_INVOICE_RECEIPT draft", draftStatus.E.TAX_INVOICE_RECEIPT === 201, draftStatus.E, { classification: "EXEMPT_DEALER", docType: "TAX_INVOICE_RECEIPT" });
  check("D1.N.TI", "OK", "API", "missing classification: TAX_INVOICE draft refused at creation", draftStatus.N.TAX_INVOICE === 400, draftStatus.N, { classification: "NONE", docType: "TAX_INVOICE" });
  check("D1.N.TIR", "DEFECT", "API", "missing classification: TAX_INVOICE_RECEIPT draft is NOT refused at creation (only TAX_INVOICE is checked)", draftStatus.N.TAX_INVOICE_RECEIPT === 201, draftStatus.N, { classification: "NONE", docType: "TAX_INVOICE_RECEIPT" });
  check("D1.I.TI", "OK", "API", "incomplete details: TAX_INVOICE draft refused at creation", draftStatus.I.TAX_INVOICE === 400, draftStatus.I, { classification: "INCOMPLETE", docType: "TAX_INVOICE" });
  check("D1.N.Q", "OBSERVED", "API", "missing classification: QUOTE and RECEIPT drafts can be created", draftStatus.N.QUOTE === 201 && draftStatus.N.RECEIPT === 201, draftStatus.N, { classification: "NONE" });
  check("D1.ALL.CN", "OK", "API", "a CREDIT_NOTE cannot be created through the generic endpoint (only from a source invoice)", tenants.every((t) => draftStatus[t.key].CREDIT_NOTE >= 400), Object.fromEntries(tenants.map((t) => [t.key, draftStatus[t.key].CREDIT_NOTE])), { docType: "CREDIT_NOTE" });

  // exempt dealer: VAT on lines
  const eq = await createDraft(E, "QUOTE", { customerId: E.privateCustomerId, initialLines: [line("שירות", "100", "18")] });
  check("D2.E.VAT", "DEFECT", "API", "exempt dealer: a line with 18% VAT is accepted (VAT is not tied to the classification)", eq.status === 201 && String(eq.json?.document?.vatAmount) !== "0" && Number(eq.json?.document?.vatAmount) > 0, { status: eq.status, vat: eq.json?.document?.vatAmount }, { classification: "EXEMPT_DEALER", docType: "QUOTE" });

  // client default VAT — the new-line default the document screen uses (static: lib/billing/document-view-model.ts)
  const vm = readFileSync("lib/billing/document-view-model.ts", "utf8");
  // #1111: was DEFECT "the new-line VAT default is 17% (no per-date rate; 18% since 1.1.2025)". Now: today's dated
  // standard rate, 0 for an exempt dealer, and the screen passes the kind it read from the server. Behaviour is
  // proven in the browser by U6 (ui.e2e.mts); this is the structural half.
  const pageSrc = readFileSync("app/billing/[id]/page.tsx", "utf8");
  const def = {
    dated: /vatRatePercent:\s*options\.businessKind === "EXEMPT_DEALER" \? "0" : standardVatRatePercent\(/.test(vm),
    hardCoded: /export function newEmptyLocalLine[\s\S]*?vatRatePercent:\s*"(\d+)"/.test(vm),
    screenPassesKind: pageSrc.includes("newEmptyLocalLine({ businessKind })") && !pageSrc.includes("newEmptyLocalLine()"),
    kindFromServer: pageSrc.includes('"/api/billing/invoice-profile"') && pageSrc.includes("j?.profile?.billingBusinessKind"),
  };
  check("D3.VAT.DEFAULT", "OK", "STATIC", "the new-line VAT default is the dated standard rate, 0 for an exempt dealer, and the screen passes the business kind it read from the server", def.dated && !def.hardCoded && def.screenPassesKind && def.kindFromServer, def, { legal: "VAT rate 18% from 1.1.2025 — confirm against the official order" });

  // ================================================================== 2. exempt dealer (API)
  console.log("\n— 2. exempt dealer");
  {
    const tags = { classification: "EXEMPT_DEALER" };
    // tax invoice refused, no number consumed, draft untouched
    const d = await createDraft(E, "TAX_INVOICE", { customerId: E.privateCustomerId, initialLines: [line("שירות", "100", "0")] });
    const seqBefore = await seq(E.businessId, BillingDocumentType.TAX_INVOICE);
    const r = await issue(E, d.json.document.id);
    const row = await docRow(d.json.document.id);
    check("E1.TI", "OK", "API", "TAX_INVOICE refused at issue with a Hebrew explanation; no number consumed; draft unchanged",
      r.status === 400 && /עוסק פטור/.test(errorText(r)) && (await seq(E.businessId, BillingDocumentType.TAX_INVOICE)) === seqBefore && row.status === "DRAFT" && row.documentNumber === null,
      { status: r.status, error: errorText(r), seqBefore, row: { status: row.status, n: row.documentNumber } }, { ...tags, docType: "TAX_INVOICE" });
    const d2 = await createDraft(E, "TAX_INVOICE_RECEIPT", { customerId: E.privateCustomerId, initialLines: [line("שירות", "100", "0")] });
    await putPayments(E, d2.json.document.id, cash("100.00"));
    const r2 = await issue(E, d2.json.document.id);
    check("E2.TIR", "OK", "API", "TAX_INVOICE_RECEIPT refused at issue; stays DRAFT", r2.status === 400 && (await docRow(d2.json.document.id)).status === "DRAFT", { status: r2.status, error: errorText(r2) }, { ...tags, docType: "TAX_INVOICE_RECEIPT" });

    // standalone receipt, no source invoice
    const rc = await createDraft(E, "RECEIPT", { customerId: E.privateCustomerId });
    const pay = await putPayments(E, rc.json.document.id, cash("250.00"));
    const ri = await issue(E, rc.json.document.id);
    const rrow = await docRow(rc.json.document.id);
    const snapKind = (rrow.issuedSnapshot as { extensions?: { billingBusinessKind?: string } } | null)?.extensions?.billingBusinessKind;
    check("E3.RCPT.issue", "OK", "API", "standalone RECEIPT (no source invoice, no allocations) issues: number 00001, kind frozen in the snapshot",
      pay.status === 200 && ri.status === 200 && rrow.status === "ISSUED" && rrow.documentNumber === 1 && snapKind === "EXEMPT_DEALER",
      { pay: pay.status, issue: ri.status, error: errorText(ri), n: rrow.documentNumberFormatted, snapKind }, { ...tags, docType: "RECEIPT" });
    check("E3.RCPT.authority", "OK", "API", "a receipt creates no allocation request", ri.json?.authority?.status === "not_required" && (await submissionOf(rc.json.document.id)) === null, ri.json?.authority, { ...tags, docType: "RECEIPT" });
    const pe = await pdfEvidence(E, rc.json.document.id, "E-receipt");
    check("E3.RCPT.pdf", "OK", "API", "the receipt PDF is produced through the real PDF route", pe.r.status === 200, { status: pe.r.status, error: errorText(pe.r) }, { ...tags, docType: "RECEIPT" });
    if (pe.r.status === 200) {
      // #1108 fixed the receipt PDF: these were DEFECT/OBSERVED checks (the defect reproduced) and now assert the fix.
      check("E3.RCPT.title", "OK", "API", "receipt PDF is titled 'קבלה', never the raw key 'RECEIPT'",
        printed(pe.text, "קבלה") && !pe.text.includes("RECEIPT"), pe.text.slice(0, 200), { ...tags, docType: "RECEIPT" });
      check("E3.RCPT.kind", "OK", "API", "an exempt dealer's receipt PDF states 'עוסק פטור' (from the kind frozen at issue) and never 'עוסק מורשה'",
        printed(pe.text, "עוסק פטור") && !printed(pe.text, "עוסק מורשה"),
        { exempt: printed(pe.text, "עוסק פטור"), authorized: printed(pe.text, "עוסק מורשה") }, { ...tags, docType: "RECEIPT", legal: "whether stating 'עוסק פטור' is mandatory — open" });
      check("E3.RCPT.vatrow", "OK", "API", "an exempt dealer's receipt PDF prints no VAT row (מע\"מ)", !/מע"מ|מ"מע|מע״מ/.test(pe.text), "", { ...tags, docType: "RECEIPT", legal: "wording for an exempt dealer — open" });
      check("E3.RCPT.placeholder", "OK", "API", "a receipt that records a payment does not print 'לא הוגדרו פרטי תשלום'", !/לא הוגדרו פרטי תשלום/.test(pe.text) && !printed(pe.text, "לא הוגדרו"), "", { ...tags, docType: "RECEIPT" });
      check("E3.RCPT.payments", "OK", "API", "the receipt PDF prints the recorded payment: method (מזומן) and amount (250.00)",
        printed(pe.text, "אמצעי תשלום") && printed(pe.text, "מזומן") && pe.text.includes("250.00") && !pe.text.includes("CASH"),
        { section: printed(pe.text, "אמצעי תשלום"), method: printed(pe.text, "מזומן"), amount: pe.text.includes("250.00") }, { ...tags, docType: "RECEIPT", legal: "הוראות ניהול פנקסים s.5 — nature of payment; source = mirror, verify" });
      check("E3.RCPT.wording", "OK", "API", "the receipt PDF labels the money as received ('התקבל'), never 'סה\"כ לתשלום'",
        printed(pe.text, "התקבל") && !printed(pe.text, "לתשלום"), "", { ...tags, docType: "RECEIPT" });
      check("E3.RCPT.filename", "OK", "API", "receipt download is named receipt-…pdf / קבלה-…pdf, never invoice-/חשבונית-",
        /filename="receipt-/.test(pe.disposition) && pe.disposition.includes(encodeURIComponent("קבלה")) && !/invoice-/.test(pe.disposition) && !pe.disposition.includes(encodeURIComponent("חשבונית")),
        pe.disposition, { ...tags, docType: "RECEIPT" });
      await reread(E, rc.json.document.id, "E3.RCPT", pe.r, { ...tags, docType: "RECEIPT" });
    }

    // quote → convert → stuck
    const q = await createDraft(E, "QUOTE", { customerId: E.privateCustomerId, initialLines: [line("שירות", "100", "0")] });
    const cv = await convert(E, q.json.document.id);
    const qrow = await docRow(q.json.document.id);
    const conv = cv.status === 201 ? await issue(E, cv.json.document.id) : null;
    check("E4.QUOTE.convert", "DEFECT", "API", "exempt dealer: 'convert quote to invoice' creates a TAX_INVOICE draft that can never be issued, and locks the quote",
      cv.status === 201 && cv.json?.document?.documentType === "TAX_INVOICE" && qrow.convertedToInvoiceId !== null && conv?.status === 400,
      { convert: cv.status, type: cv.json?.document?.documentType, quoteLockedTo: qrow.convertedToInvoiceId, issue: conv?.status, error: conv ? errorText(conv) : null }, { ...tags, docType: "QUOTE" });
    const qe = await createDraft(E, "QUOTE", { customerId: E.privateCustomerId, initialLines: [line("שירות", "100", "0")] });
    const qp = await pdfEvidence(E, qe.json.document.id, "E-quote");
    check("E5.QUOTE.pdf", "OK", "API", "exempt dealer's quote PDF renders with title 'הצעת מחיר'", qp.r.status === 200 && printed(qp.text, "הצעת מחיר"), { status: qp.r.status, error: errorText(qp.r) }, { ...tags, docType: "QUOTE" });
    check("E5.QUOTE.kind", "OBSERVED", "API", "quote PDF does not state the classification", !printed(qp.text, "עוסק פטור"), "", { ...tags, docType: "QUOTE" });
    untested("E6.CREDIT", "exempt dealer credit / cancellation of a receipt", "no mechanism exists: a credit note can reference only an issued TAX_INVOICE, which an exempt dealer cannot issue", { ...tags, docType: "CREDIT_NOTE" });
  }

  // ================================================================== 3. licensed dealer and company (API)
  for (const t of [A, C]) {
    const k = t.key;
    const tags = { classification: t.kind };
    console.log(`\n— 3. ${t.kind}`);
    // tax invoice below threshold, private customer → no allocation
    const ti = await createDraft(t, "TAX_INVOICE", { customerId: t.privateCustomerId, initialLines: [line("שירות", "1000", "18")] });
    const ed = await putLines(t, ti.json.document.id, [line("שירות", "1000", "18"), line("חלק", "200", "18", "2")]);
    const ii = await issue(t, ti.json.document.id);
    const tirow = await docRow(ti.json.document.id);
    check(`${k}1.TI.issue`, "OK", "API", "TAX_INVOICE: edit → issue → number 00001, ISSUED, allocation not required",
      ed.status === 200 && ii.status === 200 && tirow.status === "ISSUED" && tirow.documentNumber === 1 && ii.json?.authority?.status === "not_required",
      { edit: ed.status, issue: ii.status, n: tirow.documentNumberFormatted, authority: ii.json?.authority?.status, total: ii.json?.document?.totalAmount }, { ...tags, docType: "TAX_INVOICE" });
    const tip = await pdfEvidence(t, ti.json.document.id, `${k}-tax-invoice`);
    check(`${k}1.TI.pdf`, "OK", "API", "TAX_INVOICE PDF: title 'חשבונית מס', number, total 1,652.00 printed",
      tip.r.status === 200 && printed(tip.text, "חשבונית מס") && tip.text.includes(tirow.documentNumberFormatted!) && /1,?652\.00/.test(tip.text),
      { status: tip.r.status, error: errorText(tip.r) }, { ...tags, docType: "TAX_INVOICE" });
    if (tip.r.status === 200) {
      check(`${k}1.TI.kindlabel`, "OBSERVED", "API", "issuer label: 'עוסק מורשה' printed (it follows the VAT-number field, not the classification)", printed(tip.text, "עוסק מורשה"), "", { ...tags, docType: "TAX_INVOICE" });
      check(`${k}1.TI.idlabel`, "OBSERVED", "API", "issuer id label 'ע.מ./ח.פ.' for every classification", printed(tip.text, "ע.מ./ח.פ.") || printed(tip.text, "ע.מ"), "", { ...tags, docType: "TAX_INVOICE" });
      await reread(t, ti.json.document.id, `${k}1.TI`, tip.r, { ...tags, docType: "TAX_INVOICE" });
    }

    // tax invoice / receipt
    const tir = await createDraft(t, "TAX_INVOICE_RECEIPT", { customerId: t.privateCustomerId, initialLines: [line("שירות", "500", "18")] });
    const tirPayBad = await putPayments(t, tir.json.document.id, cash("100.00"));
    const tirPay = await putPayments(t, tir.json.document.id, cash("590.00"));
    const tirI = await issue(t, tir.json.document.id);
    const tirRow = await docRow(tir.json.document.id);
    check(`${k}2.TIR.issue`, "OK", "API", "TAX_INVOICE_RECEIPT: payments must equal the total; issues with its own series (00001)",
      tirPayBad.status === 400 && tirPay.status === 200 && tirI.status === 200 && tirRow.documentNumber === 1,
      { badPay: tirPayBad.status, pay: tirPay.status, issue: tirI.status, error: errorText(tirI), n: tirRow.documentNumberFormatted }, { ...tags, docType: "TAX_INVOICE_RECEIPT" });
    const tirp = await pdfEvidence(t, tir.json.document.id, `${k}-tax-invoice-receipt`);
    check(`${k}2.TIR.pdf`, "OK", "API", "TAX_INVOICE_RECEIPT PDF renders", tirp.r.status === 200, { status: tirp.r.status, error: errorText(tirp.r) }, { ...tags, docType: "TAX_INVOICE_RECEIPT" });
    if (tirp.r.status === 200) {
      check(`${k}2.TIR.title`, "DEFECT", "API", "TAX_INVOICE_RECEIPT PDF title is the raw key 'TAX_INVOICE_RECEIPT'", tirp.text.includes("TAX_INVOICE_RECEIPT"), tirp.text.slice(0, 200), { ...tags, docType: "TAX_INVOICE_RECEIPT" });
      check(`${k}2.TIR.paid`, "OBSERVED", "API", "TAX_INVOICE_RECEIPT PDF has no 'נפרע' marking", !printed(tirp.text, "נפרע"), "", { ...tags, docType: "TAX_INVOICE_RECEIPT", legal: "הוראות s.5(ג) 'נפרע' — source = mirror, verify" });
      await reread(t, tir.json.document.id, `${k}2.TIR`, tirp.r, { ...tags, docType: "TAX_INVOICE_RECEIPT" });
    }
    const tirCredit = await credit(t, tir.json.document.id);
    check(`${k}2.TIR.credit`, "OBSERVED", "API", "a TAX_INVOICE_RECEIPT cannot be credited (credit-note route refuses it)", tirCredit.status >= 400, { status: tirCredit.status, error: errorText(tirCredit) }, { ...tags, docType: "TAX_INVOICE_RECEIPT" });

    // receipt allocated to the invoice
    const rc = await createDraft(t, "RECEIPT", { customerId: t.privateCustomerId });
    await putPayments(t, rc.json.document.id, cash("652.00"));
    const al = await putAllocations(t, rc.json.document.id, [{ invoiceDocumentId: ti.json.document.id, allocatedAmount: "652.00" }]);
    const rci = await issue(t, rc.json.document.id);
    check(`${k}3.RCPT.issue`, "OK", "API", "RECEIPT allocated to the issued invoice issues (number 00001)", al.status === 200 && rci.status === 200, { alloc: al.status, allocError: errorText(al), issue: rci.status, error: errorText(rci) }, { ...tags, docType: "RECEIPT" });
    const rcp = await pdfEvidence(t, rc.json.document.id, `${k}-receipt`);
    if (rcp.r.status === 200) {
      // #1108 fixed the receipt PDF: title / wording were DEFECT checks and now assert the fix (+ method, placeholder, status line).
      check(`${k}3.RCPT.title`, "OK", "API", "receipt PDF is titled 'קבלה', never the raw key 'RECEIPT'",
        printed(rcp.text, "קבלה") && !rcp.text.includes("RECEIPT"), rcp.text.slice(0, 200), { ...tags, docType: "RECEIPT" });
      check(`${k}3.RCPT.payments`, "OK", "API", "the receipt PDF prints the recorded payment (מזומן, 652.00) and no 'לא הוגדרו פרטי תשלום'",
        printed(rcp.text, "אמצעי תשלום") && printed(rcp.text, "מזומן") && rcp.text.includes("652.00") && !printed(rcp.text, "לא הוגדרו"),
        { section: printed(rcp.text, "אמצעי תשלום"), method: printed(rcp.text, "מזומן"), amount: rcp.text.includes("652.00"), placeholder: printed(rcp.text, "לא הוגדרו") }, { ...tags, docType: "RECEIPT" });
      check(`${k}3.RCPT.kind`, "OK", "API", "an authorized dealer / company receipt never states 'עוסק פטור'; its VAT number is shown as 'עוסק מורשה'",
        !printed(rcp.text, "עוסק פטור") && printed(rcp.text, "עוסק מורשה"),
        { exempt: printed(rcp.text, "עוסק פטור"), authorized: printed(rcp.text, "עוסק מורשה") }, { ...tags, docType: "RECEIPT" });
      const snap = JSON.stringify((await docRow(rc.json.document.id)).issuedSnapshot ?? {});
      check(`${k}3.RCPT.source`, "OBSERVED", "SERVICE", "the receipt's frozen snapshot (and so its PDF) carries no reference to the invoice it pays",
        !/allocations|invoiceDocumentId|referenceDocumentNumber/i.test(snap), snap.slice(0, 200), { ...tags, docType: "RECEIPT" });
      check(`${k}3.RCPT.wording`, "OK", "API", "the receipt PDF labels the money as received ('התקבל'), never 'סה\"כ לתשלום'",
        printed(rcp.text, "התקבל") && !printed(rcp.text, "לתשלום"), "", { ...tags, docType: "RECEIPT" });
    } else check(`${k}3.RCPT.pdf`, "OK", "API", "receipt PDF renders", false, { status: rcp.r.status, error: errorText(rcp.r) }, { ...tags, docType: "RECEIPT" });

    // credit note on a historical 17% invoice
    const h = await createDraft(t, "TAX_INVOICE", { customerId: t.privateCustomerId, initialLines: [line("שירות היסטורי", "1000", "17")] });
    const hi = await issue(t, h.json.document.id);
    const cn = await credit(t, h.json.document.id);
    const cnId = cn.json?.creditNoteId as number | undefined;
    const cnLines = cnId ? await owner.billingDocumentLine.findMany({ where: { billingDocumentId: cnId } }) : [];
    check(`${k}4.CN.create`, "OK", "API", "credit note drafted from the issued invoice, lines copied at the source rate (17%)",
      hi.status === 200 && cn.status === 201 && cnLines.length === 1 && String(cnLines[0].vatRatePercent) === "17", { issue: hi.status, credit: cn.status, rates: cnLines.map((l) => String(l.vatRatePercent)) }, { ...tags, docType: "CREDIT_NOTE" });
    if (cnId) {
      const edit = await putLines(t, cnId, [line("שירות היסטורי", "500", "18")]);
      check(`${k}4.CN.vatedit`, "OBSERVED", "API", "the credit note's VAT rate can be changed from the source's 17% to 18% with no check",
        edit.status === 200, { status: edit.status, error: errorText(edit), vat: edit.json?.document?.vatAmount }, { ...tags, docType: "CREDIT_NOTE", legal: "credit rate for a 17% invoice — interpretation 1/2025 (probably 17%), verify" });
      const cni = await issue(t, cnId);
      const cnRow = await docRow(cnId);
      check(`${k}4.CN.issue`, "OK", "API", "credit note issues with its own series (00001) and references the source invoice",
        cni.status === 200 && cnRow.documentNumber === 1 && cnRow.referenceDocumentId === h.json.document.id, { issue: cni.status, error: errorText(cni), n: cnRow.documentNumberFormatted, ref: cnRow.referenceDocumentId }, { ...tags, docType: "CREDIT_NOTE" });
      const cnp = await pdfEvidence(t, cnId, `${k}-credit-note`);
      const srcNo = (await docRow(h.json.document.id)).documentNumberFormatted!;
      if (cnp.r.status === 200) {
        check(`${k}4.CN.title`, "DEFECT", "API", "credit note PDF title is the raw key 'CREDIT_NOTE'", cnp.text.includes("CREDIT_NOTE"), "", { ...tags, docType: "CREDIT_NOTE" });
        check(`${k}4.CN.wording`, "DEFECT", "API", "the credit note PDF shows the credited amount as a positive 'סה\"כ לתשלום' (total to pay), with no credit wording",
          /לתשלום/.test(cnp.text) && !/זיכוי/.test(cnp.text), "", { ...tags, docType: "CREDIT_NOTE" });
        check(`${k}4.CN.source`, "OBSERVED", "API", "credit note PDF does not print the credited invoice's number",
          !new RegExp(`(חשבונית|מקור|זיכוי)[^\\n]{0,40}${srcNo}`).test(cnp.text), { srcNo }, { ...tags, docType: "CREDIT_NOTE", legal: "הוראות s.9(ה)(4) numbers + dates of credited invoices — source = mirror, verify" });
        await reread(t, cnId, `${k}4.CN`, cnp.r, { ...tags, docType: "CREDIT_NOTE" });
      } else check(`${k}4.CN.pdf`, "OK", "API", "credit note PDF renders", false, { status: cnp.r.status, error: errorText(cnp.r) }, { ...tags, docType: "CREDIT_NOTE" });
      const second = await credit(t, h.json.document.id);
      check(`${k}4.CN.second`, "DEFECT", "API", "a second (partial) credit on the same invoice is impossible through the route", second.status === 400 && /initialLines/.test(errorText(second)), { status: second.status, error: errorText(second) }, { ...tags, docType: "CREDIT_NOTE" });
    }

    // quote → convert → issue
    const q = await createDraft(t, "QUOTE", { customerId: t.privateCustomerId, initialLines: [line("שירות", "300", "18")] });
    const cv = await convert(t, q.json.document.id);
    const cvi = cv.status === 201 ? await issue(t, cv.json.document.id) : null;
    check(`${k}5.QUOTE.convert`, "OK", "API", "quote → convert → TAX_INVOICE issues", cv.status === 201 && cvi?.status === 200, { convert: cv.status, issue: cvi?.status, error: cvi ? errorText(cvi) : errorText(cv) }, { ...tags, docType: "QUOTE" });
  }

  // ================================================================== 4. missing / incomplete classification (API)
  console.log("\n— 4. missing / incomplete");
  for (const t of [N, I]) {
    const tags = { classification: t.kind };
    const rc = await createDraft(t, "RECEIPT", { customerId: t.privateCustomerId });
    await putPayments(t, rc.json.document.id, cash("100.00"));
    const before = await seq(t.businessId, BillingDocumentType.RECEIPT);
    const r = await issue(t, rc.json.document.id);
    check(`M1.${t.key}.RCPT`, "OK", "API", "issuing anything is refused before numbering when the classification / details are missing",
      r.status === 400 && (await seq(t.businessId, BillingDocumentType.RECEIPT)) === before && (await docRow(rc.json.document.id)).status === "DRAFT", { status: r.status, error: errorText(r) }, { ...tags, docType: "RECEIPT" });
    check(`M2.${t.key}.msg`, "DEFECT", "API", "the refusal for a RECEIPT speaks of 'חשבונית מס' and does not say what is missing", /חשבונית מס/.test(errorText(r)) && !/סיווג/.test(errorText(r)), errorText(r), { ...tags, docType: "RECEIPT" });
  }
  check("M3.DECL", "OBSERVED", "STATIC", "no declaration / confirmation record exists: BusinessProfile has no confirmedAt / confirmedBy / declaration table",
    !/billingBusinessKindConfirmed|taxDeclaration|TaxDeclaration|classificationConfirmed/i.test(readFileSync("prisma/schema.prisma", "utf8")), "schema grep", {});

  // ================================================================== 5. classification change with open drafts (API)
  console.log("\n— 5. classification change");
  {
    const tags = { classification: "AUTHORIZED_DEALER" };
    const open = await createDraft(A, "TAX_INVOICE", { customerId: A.privateCustomerId, initialLines: [line("שירות", "100", "18")] });
    const issuedBefore = await owner.billingDocument.findFirstOrThrow({ where: { businessId: A.businessId, documentType: "TAX_INVOICE", status: "ISSUED" }, orderBy: { id: "asc" } });
    const pdfBefore = await getPdf(A, issuedBefore.id);
    const snapBefore = JSON.stringify((await docRow(issuedBefore.id)).issuedSnapshot);
    const ch = await patchProfile(A.token2, { billingBusinessKind: "EXEMPT_DEALER" });
    check("K1.anyuser", "OBSERVED", "API", "a second ordinary user of the business changes the classification (no role, no confirmation)", ch.status === 200, { status: ch.status }, tags);
    const r = await issue(A, open.json.document.id);
    check("K2.opendraft", "OK", "API", "after the change to exempt, the open TAX_INVOICE draft is refused at issue (fail-closed)", r.status === 400 && (await docRow(open.json.document.id)).status === "DRAFT", { status: r.status, error: errorText(r) }, { ...tags, docType: "TAX_INVOICE" });
    const pdfAfter = await getPdf(A, issuedBefore.id);
    check("K3.history", "OK", "API", "an invoice issued before the change: snapshot and PDF bytes unchanged",
      JSON.stringify((await docRow(issuedBefore.id)).issuedSnapshot) === snapBefore && !!pdfBefore.buffer && !!pdfAfter.buffer && pdfBefore.buffer.equals(pdfAfter.buffer),
      { samePdf: !!pdfBefore.buffer && !!pdfAfter.buffer && pdfBefore.buffer.equals(pdfAfter.buffer) }, { ...tags, docType: "TAX_INVOICE" });
    const cleared = await patchProfile(A.token2, { billingBusinessKind: "" });
    const prof = await owner.businessProfile.findUniqueOrThrow({ where: { businessId: A.businessId }, select: { billingBusinessKind: true } });
    check("K4.clear", "DEFECT", "API", "the classification can be silently cleared to empty by any user", cleared.status === 200 && prof.billingBusinessKind === null, { status: cleared.status, stored: prof.billingBusinessKind }, tags);
    const back = await patchProfile(A.token, { billingBusinessKind: "AUTHORIZED_DEALER" });
    const r2 = await issue(A, open.json.document.id);
    const n2 = (await docRow(open.json.document.id)).documentNumber;
    check("K5.numbering", "OBSERVED", "API", "changing back to licensed: the same draft issues and the TAX_INVOICE series simply continues", back.status === 200 && r2.status === 200 && (n2 ?? 0) > 1, { back: back.status, issue: r2.status, n: n2 }, { ...tags, docType: "TAX_INVOICE", legal: "series on a status change — open" });
    const audit = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_name ILIKE '%declaration%'`);
    check("K6.trail", "OBSERVED", "STATIC", "no declaration history table; the change leaves only a sensor event", Number(audit[0]?.n ?? 0) === 0, audit, tags);
  }

  // ================================================================== 6. allocation (API with Production pilot settings; SERVICE with a fake ITA)
  console.log("\n— 6. allocation");
  const tagsT = { classification: "AUTHORIZED_DEALER", docType: "TAX_INVOICE" };
  async function readyInvoice(t: Tenant, unit = "6000") {
    const d = await createDraft(t, "TAX_INVOICE", { customerId: t.dealerCustomerId, initialLines: [line("פרויקט", unit, "18")] });
    return d.json.document.id as number;
  }
  {
    // T1 — submissions closed (OPERATIONS=oauth, business not in the pilot list): the real route.
    // After the issue-time allocation gate: refused BEFORE numbering, the draft stays a draft.
    const id = await readyInvoice(A);
    const netBefore = networkAttempts.length;
    const seqBefore = await seq(A.businessId, BillingDocumentType.TAX_INVOICE);
    const r = await issue(A, id);
    const sub = await submissionOf(id);
    const row = await docRow(id);
    saveEvidence("allocation/T1-submissions-closed.json", JSON.stringify({ status: r.status, body: r.json, submission: sub && { status: sub.status }, document: { status: row.status, number: row.documentNumber } }, null, 2));
    check("T1.state", "OK", "API", "≥5,000 ₪ to a dealer customer, submissions closed: refused before numbering (409) — DRAFT, no number, no submission, sequence untouched, nothing sent",
      r.status === 409 && r.json?.code === "AUTHORITY_ALLOCATION_SENDING_CLOSED" && row.status === "DRAFT" && row.documentNumber === null && sub === null &&
        (await seq(A.businessId, BillingDocumentType.TAX_INVOICE)) === seqBefore && networkAttempts.length === netBefore,
      { status: r.status, code: r.json?.code, doc: row.status, n: row.documentNumber, sub: sub?.status ?? null }, tagsT);
    check("T1.message", "OK", "API", "the refusal explains, in Hebrew, that an allocation is required, sending is not open, and the invoice stayed a draft without a number",
      /מספר הקצאה/.test(errorText(r)) && /טיוטה/.test(errorText(r)) && !/נסו שוב|לנסות שוב/.test(errorText(r)), errorText(r), tagsT);
    const again = await getDoc(A, id);
    check("T1.refresh", "OK", "API", "after refresh the document reads back as a DRAFT with no allocation state (nothing issued)",
      again.status === 200 && again.json?.document?.status === "DRAFT" && again.json?.document?.authorityState === null, { status: again.json?.document?.status, authorityState: again.json?.document?.authorityState }, tagsT);
    const routes = readdirSync("app/api/billing/documents/[id]");
    check("T1.retry", "OBSERVED", "STATIC", "there is still no endpoint to resend a not-sent allocation request (no new invoice can reach that state through the gate)", !routes.some((r) => /retry|resubmit|allocation-request|authority-approval/.test(r)), routes, tagsT);

    // T1L — an invoice that got stuck BEFORE the gate (issued READY, never sent): not changed by the fix.
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
    const legacy = await readyInvoice(A);
    await issueBillingDocument({ businessId: A.businessId, billingDocumentId: legacy, actorUserId: A.userId }, { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "preflight_failed", billingDocumentId: i.billingDocumentId, errorCode: "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED", safeToRetry: false }) } as never);
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
    const lg = await getDoc(A, legacy);
    const lst = lg.json?.document?.authorityState;
    check("T1L.state", "OK", "API", "an invoice stuck before the fix: the document API now says READY + not deliverable, so the screen can show it after a reload",
      lg.json?.document?.status === "ISSUED" && lst?.submissionStatus === "READY" && lst?.deliverable === false, lst, tagsT);
    const lpdf = await getPdf(A, legacy);
    check("T1L.pdf", "OBSERVED", "API", "its PDF stays refused — existing stuck invoices are left as they are (separate handling, not automatic)", lpdf.status === 403, { status: lpdf.status }, tagsT);
  }

  // Fake ITA: the real execution service and transitions; only the HTTP request is replaced.
  let itaCalls = 0;
  const fakeCtx = async () => ({ ok: true as const, context: { accessToken: "lab-token", approvalConfig: {} as never, accountingSoftwareNumber: "123456", connectionId: 1, environment: "SANDBOX" as const } });
  const viaFakeIta = (result: unknown, delayMs = 0) => ({
    executeApproval: (input: { businessId: number; billingDocumentId: number; actorUserId: number }) =>
      executeAuthorityApproval(input, {
        ...defaultSubmissionExecutionDeps,
        resolveEnvironment: () => "SANDBOX" as never,
        resolveRuntimeContext: fakeCtx,
        requestApproval: async () => {
          itaCalls++;
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return result as never;
        },
      }),
  });
  async function issueWithFake(t: Tenant, result: unknown, label: string) {
    const id = await readyInvoice(t);
    const callsBefore = itaCalls;
    // These scenarios test what happens AFTER a send, so the issue itself runs where the
    // send is open (SANDBOX); under Production's closed pilot the issue-time gate (T1) refuses first.
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
    const out = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, viaFakeIta(result) as never).finally(() => {
      process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
    });
    const sub = await submissionOf(id);
    const row = await docRow(id);
    const display = describeAuthorityIssueOutcome(out.authority);
    const pdf = await getPdf(t, id);
    if (pdf.buffer) saveEvidence(`pdf/allocation-${label}.pdf`, pdf.buffer);
    saveEvidence(`allocation/${label}.json`, JSON.stringify({ authority: out.authority, display, submission: sub && { status: sub.status, errorCode: sub.errorCode }, allocationNumber: row.allocationNumber, pdfStatus: pdf.status, itaCalls: itaCalls - callsBefore }, null, 2));
    return { id, out, sub, row, display, pdf, calls: itaCalls - callsBefore, text: pdf.buffer ? await pdfText(pdf.buffer) : "" };
  }
  {
    const a = await issueWithFake(A, { outcome: "approved", confirmationNumber: "2026111012345678" }, "T2-approved");
    check("T2.approved", "OK", "SERVICE", "APPROVED: one request, number stored on the document, message shows the 9 right-most digits, PDF prints it",
      a.calls === 1 && a.sub?.status === "APPROVED" && !!a.row.allocationNumber && a.display.allocationReceived && a.pdf.status === 200 && a.text.includes("012345678"),
      { calls: a.calls, sub: a.sub?.status, alloc: a.row.allocationNumber, title: a.display.title, detail: a.display.detail, pdf: a.pdf.status, error: errorText(a.pdf) }, tagsT);
    process.env.BILLING_PDF_RENDERER = "pdfmake";
    const pm = await getPdf(A, a.id);
    delete process.env.BILLING_PDF_RENDERER;
    const pmText = pm.buffer ? await pdfText(pm.buffer) : "";
    check("T2.pdfmake", "DEFECT", "API", "the alternative renderer (BILLING_PDF_RENDERER=pdfmake) drops the allocation number", pm.status === 200 && !pmText.includes("012345678"), { status: pm.status, error: errorText(pm) }, tagsT);

    const h = await issueWithFake(A, { outcome: "decision_required", code: 460, confirmationNumber: null, message: "held" }, "T3-held");
    check("T3.held", "OK", "SERVICE", "HELD: one request, status HELD, warning 'נדרשת החלטה', PDF blocked, no number",
      h.calls === 1 && h.sub?.status === "HELD" && h.display.userActionRequired && h.pdf.status === 403 && !h.row.allocationNumber,
      { calls: h.calls, sub: h.sub?.status, title: h.display.title, pdf: h.pdf.status }, tagsT);
    const tsx = execGrep("authority-decision", ["app", "components"], ".tsx");
    check("T3.noui", "DEFECT", "STATIC", "no screen calls the HELD decision endpoint", tsx.length === 0, tsx, tagsT);
    const decRoute = await callRoute(decisionRoute.POST, { method: "POST", url: `/api/billing/documents/${h.id}/authority-decision`, token: A.token, body: { action: "Continue" }, params: P(h.id) });
    check("T3.route", "OK", "API", "the decision route itself refuses to act in Production for a non-pilot business (nothing sent)", decRoute.status >= 400 || decRoute.json?.authorityDecision?.outcome !== "accepted", { status: decRoute.status, body: decRoute.json }, tagsT);
    let decCalls = 0;
    const dec = await executeAuthorityDecision({ businessId: A.businessId, billingDocumentId: h.id, actorUserId: A.userId, action: "Continue" as never }, {
      ...defaultDecisionExecutionDeps,
      resolveEnvironment: () => "SANDBOX" as never,
      resolveRuntimeContext: fakeCtx,
      requestDecision: async () => { decCalls++; return { outcome: "accepted", message: null } as never; },
    });
    const afterDec = await getPdf(A, h.id);
    check("T3.continue", "OK", "SERVICE", "HELD + reported 'Continue' decision: the PDF is delivered without an allocation number", decCalls === 1 && afterDec.status === 200, { dec, decCalls, pdf: afterDec.status, error: errorText(afterDec) }, tagsT);

    const u = await issueWithFake(A, { outcome: "infrastructure_failure", classification: "TIMEOUT", message: "timeout", sendCertainty: "POSSIBLY_SENT", failureKind: "TIMEOUT", providerHttpStatus: null, providerErrorId: null, transportCode: "ETIMEDOUT" }, "T4-uncertain");
    check("T4.uncertain", "OK", "SERVICE", "uncertain (timeout after send): SUBMITTED + uncertain marker, 'תוצאת ההקצאה אינה ודאית', PDF blocked",
      u.calls === 1 && u.sub?.status === "SUBMITTED" && /UNCERTAIN/.test(u.sub?.errorCode ?? "") && u.display.tone === "danger" && u.pdf.status === 403,
      { calls: u.calls, sub: u.sub?.status, code: u.sub?.errorCode, title: u.display.title, pdf: u.pdf.status }, tagsT);
    const before = itaCalls;
    const re = await viaFakeIta({ outcome: "approved", confirmationNumber: "1" }).executeApproval({ businessId: A.businessId, billingDocumentId: u.id, actorUserId: A.userId });
    check("T4.nosend", "OK", "SERVICE", "an uncertain request is never sent again (re-execution sends nothing)", itaCalls === before && re.outcome === "outcome_uncertain", { outcome: re.outcome, sent: itaCalls - before }, tagsT);
    untested("T4.reconcile", "resolving an uncertain allocation", "no reconciliation path exists in the code — the invoice's PDF stays blocked; nothing to exercise", tagsT);

    const f = await issueWithFake(A, { outcome: "infrastructure_failure", classification: "NETWORK", message: "refused", sendCertainty: "NOT_SENT", failureKind: "CONNECT", providerHttpStatus: null, providerErrorId: null, transportCode: "ECONNREFUSED" }, "T5-not-sent");
    check("T5.failed", "OK", "SERVICE", "provably not sent: FAILED, the message says it was not sent and offers no retry, PDF blocked",
      f.calls === 1 && f.sub?.status === "FAILED" && /לא נשלחה/.test(f.display.detail) && !/לנסות שוב/.test(f.display.detail) && f.pdf.status === 403,
      { calls: f.calls, sub: f.sub?.status, code: f.sub?.errorCode, detail: f.display.detail, pdf: f.pdf.status }, tagsT);
    const retry = await viaFakeIta({ outcome: "approved", confirmationNumber: "2026111099999999" }).executeApproval({ businessId: A.businessId, billingDocumentId: f.id, actorUserId: A.userId });
    check("T5.retry", "OBSERVED", "SERVICE", "the service can re-send a not-sent request (approved on retry) — but no route / screen offers it", retry.outcome === "completed_approved", retry, tagsT);

    const rj = await issueWithFake(A, { outcome: "authority_validation_failed", errors: [{ code: "E1", message: "bad" }] }, "T6-rejected");
    check("T6.rejected", "OK", "SERVICE", "rejected: REJECTED, 'בקשת ההקצאה נדחתה', PDF blocked", rj.sub?.status === "REJECTED" && rj.display.tone === "danger" && rj.pdf.status === 403, { sub: rj.sub?.status, title: rj.display.title, pdf: rj.pdf.status }, tagsT);

    // consistency: 'allocation received' is shown only when a number is stored
    const all = [a, h, u, f, rj];
    check("T7.consistency", "OK", "SERVICE", "the message claims an allocation only when a number is stored on the document",
      all.every((x) => x.display.allocationReceived === !!x.row.allocationNumber), all.map((x) => ({ s: x.sub?.status, shown: x.display.allocationReceived, stored: !!x.row.allocationNumber })), tagsT);

    // concurrency: five parallel executions of one READY request → one send
    const id = await readyInvoice(C);
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
    await issueBillingDocument({ businessId: C.businessId, billingDocumentId: id, actorUserId: C.userId }, { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "preflight_failed", billingDocumentId: i.billingDocumentId, errorCode: "LAB_HOLD", safeToRetry: false }) } as never);
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
    const b2 = itaCalls;
    const slow = viaFakeIta({ outcome: "approved", confirmationNumber: "2026111055555555" }, 300);
    const outs = await Promise.all(Array.from({ length: 5 }, () => slow.executeApproval({ businessId: C.businessId, billingDocumentId: id, actorUserId: C.userId })));
    check("T8.double", "OK", "SERVICE", "five parallel attempts on one invoice → exactly one request to the authority", itaCalls - b2 === 1 && outs.filter((o) => o.outcome === "completed_approved").length === 1,
      { sent: itaCalls - b2, outcomes: outs.map((o) => o.outcome) }, { classification: "LTD_COMPANY", docType: "TAX_INVOICE" });
  }

  // ================================================================== 7. automatic receipt after payment (SERVICE)
  console.log("\n— 7. settlement receipt");
  async function payment(t: Tenant, amount: string, invoiceId: number | null) {
    await owner.businessPaymentConnection.upsert({ where: { businessId_provider: { businessId: t.businessId, provider: "CARDCOM" } } as never, create: { businessId: t.businessId, provider: "CARDCOM", isActive: true, documentIssuer: "DUBIZ_ISSUES" }, update: {} });
    const req = await owner.paymentRequest.create({ data: { businessId: t.businessId, customerId: t.privateCustomerId, billingDocumentId: invoiceId, provider: "CARDCOM", amount, currency: "ILS", status: "PAID", paidAt: new Date() } });
    const pay = await owner.paymentTransaction.create({ data: { paymentRequestId: req.id, provider: "CARDCOM", providerTransactionId: `taxlab-${t.key}-${Date.now()}-${Math.random()}`, amount, currency: "ILS", status: "PAID", rawPayload: {} } });
    await owner.paymentAccountingSettlement.create({ data: { businessId: t.businessId, paymentTransactionId: pay.id } });
    return pay.id;
  }
  for (const t of [N, E]) {
    const tags = { classification: t.kind, docType: "RECEIPT" };
    let result: unknown;
    let thrown: string | null = null;
    const payId = await payment(t, "120.00", null);
    try {
      result = await settleVerifiedPayment({ businessId: t.businessId, paymentTransactionId: payId });
    } catch (e) {
      thrown = (e as Error).message;
    }
    const settlement = await owner.paymentAccountingSettlement.findFirst({ where: { paymentTransactionId: payId } });
    const receipt = await owner.billingDocument.findFirst({ where: { businessId: t.businessId, sourcePaymentTransactionId: payId } });
    const tx = await owner.paymentTransaction.findUniqueOrThrow({ where: { id: payId }, select: { status: true } });
    saveEvidence(`settlement/${t.key}.json`, JSON.stringify({ result, thrown, settlement, receipt: receipt && { status: receipt.status, n: receipt.documentNumberFormatted }, payment: tx }, null, 2));
    if (t === N) {
      check("S1.N", "OBSERVED", "SERVICE", "payment received while the classification is missing: no receipt is issued, the payment stays recorded and the settlement row is left pending/failed",
        (receipt === null || receipt.status !== "ISSUED") && tx.status === "PAID", { result, thrown, settlement: settlement && { status: (settlement as { status?: string }).status, lastError: (settlement as { lastErrorCode?: string }).lastErrorCode }, receipt: receipt?.status ?? null }, tags);
    } else {
      check("S2.E", "OK", "SERVICE", "exempt dealer with complete details: the automatic receipt is issued", receipt?.status === "ISSUED", { result, thrown, receipt: receipt?.status }, tags);
    }
  }

  // ================================================================== 8. parallel issuance and numbering (API)
  console.log("\n— 8. parallel issuance");
  {
    const tags = { classification: "LTD_COMPANY", docType: "RECEIPT" };
    const d = await createDraft(C, "RECEIPT", { customerId: C.privateCustomerId });
    await putPayments(C, d.json.document.id, cash("10.00"));
    const both = await Promise.all([issue(C, d.json.document.id), issue(C, d.json.document.id)]);
    check("N1.same", "OK", "API", "two simultaneous issues of one draft → exactly one succeeds, one number", both.filter((r) => r.status === 200).length === 1 && both.some((r) => r.status === 403), both.map((r) => r.status), tags);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const x = await createDraft(C, "RECEIPT", { customerId: C.privateCustomerId });
      await putPayments(C, x.json.document.id, cash(`${i + 1}.00`));
      ids.push(x.json.document.id);
    }
    const rs = await Promise.all(ids.map((id) => issue(C, id)));
    const nums = (await Promise.all(ids.map((id) => docRow(id)))).map((r) => r.documentNumber!).sort((x, y) => x - y);
    const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    check("N2.distinct", "OK", "API", "six simultaneous issues → six distinct, contiguous numbers", rs.every((r) => r.status === 200) && new Set(nums).size === 6 && contiguous, { statuses: rs.map((r) => r.status), nums }, tags);
    const types = await owner.billingDocumentNumberSequence.findMany({ where: { businessId: C.businessId }, select: { documentType: true, nextNumber: true } });
    check("N3.series", "OK", "SERVICE", "a separate number series per document type", new Set(types.map((x) => x.documentType)).size === types.length && types.length >= 4, types, { classification: "LTD_COMPANY" });
  }

  // ================================================================== 9. isolation and permissions (API)
  console.log("\n— 9. isolation");
  {
    const victim = await owner.billingDocument.findFirstOrThrow({ where: { businessId: A.businessId, status: "ISSUED", documentType: "TAX_INVOICE" } });
    const draftA = await createDraft(A, "TAX_INVOICE", { customerId: A.privateCustomerId, initialLines: [line("שירות", "1", "18")] });
    const g = await getDoc(X, victim.id, X.token);
    const p = await getPdf(X, victim.id, X.token);
    const i = await issue(X, draftA.json.document.id, X.token);
    const l = await callRoute(linesRoute.PUT, { method: "PUT", url: `/api/billing/documents/${draftA.json.document.id}/lines`, token: X.token, body: { lines: [line("x", "1", "0")] }, params: P(draftA.json.document.id) });
    const c = await callRoute(creditRoute.POST, { method: "POST", url: `/api/billing/documents/${victim.id}/credit-note`, token: X.token, params: P(victim.id) });
    check("R1.cross", "OK", "API", "another business cannot read, download, issue, edit or credit this business's documents (404)",
      [g, p, i, l, c].every((r) => r.status === 404), [g, p, i, l, c].map((r) => r.status), {});
    const unscoped = await runtime.billingDocument.findMany({ where: { businessId: A.businessId } });
    check("R2.rls", "OK", "SERVICE", "an unscoped read under the runtime role sees nothing (RLS in force)", unscoped.length === 0, unscoped.length, {});
    const noAuth = await getDoc(A, victim.id, "");
    check("R3.noauth", "OK", "API", "no token → 401", noAuth.status === 401, noAuth.status, {});
    const second = await issue(A, draftA.json.document.id, A.token2);
    check("R4.roles", "OBSERVED", "API", "any user of the business may issue (no owner / staff / accountant roles exist)", second.status === 200, second.status, {});
  }

  // ================================================================== 10. numbering audit (API + SERVICE + STATIC)
  console.log("\n— 10. numbering");
  {
    // A fresh company issuer so every number below is predictable.
    const Q = await tenant("Q", "LTD_COMPANY", { ...base("מספור"), billingBusinessKind: "LTD_COMPANY", billingTaxId: "516000020", billingVatNumber: "516000020" });
    const tags = { classification: "LTD_COMPANY", docType: "TAX_INVOICE" };
    const TI = BillingDocumentType.TAX_INVOICE;
    const small = (label: string) => createDraft(Q, "TAX_INVOICE", { customerId: Q.privateCustomerId, initialLines: [line(label, "100", "18")] });

    // drafts never consume a number: three drafts, the third issued first → 000001
    const d1 = await small("טיוטה 1");
    const d2 = await small("טיוטה 2");
    const d3 = await small("טיוטה 3");
    check("NUM1.draft", "OK", "API", "drafts hold no number; the sequence does not exist until the first issue",
      [d1, d2, d3].every((d) => d.json.document.documentNumber === null) && (await seq(Q.businessId, TI)) === null, [d1, d2, d3].map((d) => d.json.document.documentNumber), tags);
    const i3 = await issue(Q, d3.json.document.id);
    check("NUM2.first", "OBSERVED", "API", "the first issued document of a series is always 000001 — there is no opening number to set",
      i3.status === 200 && (await docRow(d3.json.document.id)).documentNumber === 1, (await docRow(d3.json.document.id)).documentNumberFormatted, { ...tags, legal: "opening number / continuing a previous book — see chapter 10" });

    // a refused issue inside the issue transaction consumes nothing: two full credit drafts of one invoice;
    // once the first is issued, the second exceeds what is left to credit and is refused at issue.
    const cnA = await credit(Q, d3.json.document.id);
    const cnB = await credit(Q, d3.json.document.id);
    await issue(Q, cnA.json.creditNoteId);
    const cnId = cnB.json?.creditNoteId as number;
    const cnSeq = await seq(Q.businessId, BillingDocumentType.CREDIT_NOTE);
    const refused = await issue(Q, cnId);
    check("NUM3.refused", "OK", "API", "a refused issue (second full credit of an already credited invoice) leaves the draft unnumbered and the sequence untouched",
      refused.status >= 400 && (await docRow(cnId)).documentNumber === null && (await seq(Q.businessId, BillingDocumentType.CREDIT_NOTE)) === cnSeq,
      { status: refused.status, error: errorText(refused), seqBefore: cnSeq, seqAfter: await seq(Q.businessId, BillingDocumentType.CREDIT_NOTE) }, { ...tags, docType: "CREDIT_NOTE" });

    // retry after a lost response: the second call is refused, the number and the sequence stay as they were
    const before = await seq(Q.businessId, TI);
    const again = await issue(Q, d3.json.document.id);
    check("NUM4.retry", "OK", "API", "a repeated issue of an issued document (retry after a lost response) is refused; same number, sequence unchanged",
      again.status === 403 && (await docRow(d3.json.document.id)).documentNumber === 1 && (await seq(Q.businessId, TI)) === before, { status: again.status, error: errorText(again) }, tags);
    check("NUM4.msg", "OBSERVED", "API", "the refusal text the client gets on that retry", true, errorText(again), tags);

    // two clicks at once on the same draft: one number, the loser's increment rolled back
    const s0 = await seq(Q.businessId, TI);
    const twice = await Promise.all([issue(Q, d1.json.document.id), issue(Q, d1.json.document.id)]);
    const s1 = await seq(Q.businessId, TI);
    check("NUM5.doubleclick", "OK", "API", "double click: one 200, one 403, the sequence advanced by exactly one",
      twice.filter((r) => r.status === 200).length === 1 && s1 === (s0 ?? 1) + 1, { statuses: twice.map((r) => r.status), s0, s1 }, tags);

    // PDF failure after the issue committed: same document, same number, later render works
    const pf = await small("PDF נכשל");
    const pfi = await issue(Q, pf.json.document.id);
    const pfNo = (await docRow(pf.json.document.id)).documentNumber;
    const sBefore = await seq(Q.businessId, TI);
    // Break the PDF's storage for one call, the same way on every OS: the storage root points
    // under a regular file, so the write fails after the render. Restored right after.
    const { resetStorageServiceForTests } = await import("@/lib/storage/storage.factory");
    const realRoot = process.env.LOCAL_STORAGE_ROOT;
    const blocker = path.join(EVIDENCE_DIR, "storage-blocker");
    writeFileSync(blocker, "not a directory");
    process.env.LOCAL_STORAGE_ROOT = path.join(blocker, "root");
    resetStorageServiceForTests();
    const broken = await getPdf(Q, pf.json.document.id);
    process.env.LOCAL_STORAGE_ROOT = realRoot;
    resetStorageServiceForTests();
    const status1 = (await owner.billingDocument.findUniqueOrThrow({ where: { id: pf.json.document.id }, select: { pdfRenderStatus: true } })).pdfRenderStatus;
    const fixed = await getPdf(Q, pf.json.document.id);
    const fixedText = fixed.buffer ? await pdfText(fixed.buffer) : "";
    check("NUM6.pdffail", "OK", "API", "PDF fails after issue → document stays ISSUED with its number (FAILED recorded); the next download renders the same number; sequence untouched",
      pfi.status === 200 && broken.status >= 500 && status1 === "FAILED" && fixed.status === 200 && fixedText.includes(String(pfNo).padStart(6, "0")) && (await seq(Q.businessId, TI)) === sBefore,
      { broken: broken.status, renderStatus: status1, fixed: fixed.status, number: pfNo }, tags);

    // a credit note never renumbers its source
    const src = await small("מקור לזיכוי");
    await issue(Q, src.json.document.id);
    const srcNo = (await docRow(src.json.document.id)).documentNumber;
    const c2 = await credit(Q, src.json.document.id);
    const c2i = await issue(Q, c2.json.creditNoteId);
    check("NUM7.credit", "OK", "API", "a credit note takes its own series number and leaves the source invoice's number unchanged",
      c2i.status === 200 && (await docRow(src.json.document.id)).documentNumber === srcNo && (await docRow(c2.json.creditNoteId)).documentType === "CREDIT_NOTE",
      { srcNo, credit: (await docRow(c2.json.creditNoteId)).documentNumberFormatted }, { ...tags, docType: "CREDIT_NOTE" });

    // the database refuses a duplicate number in the same (business, type) — the last line of defence
    let dupError = "";
    try {
      await owner.billingDocument.create({ data: { businessId: Q.businessId, documentType: TI, status: "ISSUED", documentNumber: srcNo, documentNumberFormatted: "dup", customerNameSnapshot: "x", currency: "ILS", subtotalAmount: "0", vatAmount: "0", totalAmount: "0" } });
    } catch (e) {
      dupError = (e as { code?: string }).code ?? (e as Error).message;
    }
    check("NUM8.unique", "OK", "SERVICE", "a duplicate (business, type, number) is refused by the database's unique index", dupError === "P2002", dupError, tags);

    // a change of legal identity on the same business continues the same series
    const idChange = await patchProfile(Q.token, { billingTaxId: "516000038", billingLegalName: "חברה אחרת בע\"מ" });
    const after = await small("אחרי שינוי זהות");
    await issue(Q, after.json.document.id);
    const afterRow = await docRow(after.json.document.id);
    const issuer = (afterRow.issuedSnapshot as { issuer?: { taxId?: string } } | null)?.issuer?.taxId;
    check("NUM9.identity", "DEFECT", "API", "changing the issuer's tax id / legal name on the same business is accepted and the new entity simply continues the old series",
      idChange.status === 200 && issuer === "516000038" && (afterRow.documentNumber ?? 0) > (srcNo ?? 0), { status: idChange.status, issuer, number: afterRow.documentNumber }, { ...tags, legal: "a company is a separate עוסק — chapter 10" });

    // static: what the schema and code do not have
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const seqModel = /model BillingDocumentNumberSequence \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    check("NUM10.noyear", "OK", "STATIC", "no annual reset: the sequence has no year in its key ((businessId, documentType) only)", !/year|fiscal/i.test(seqModel) && /@@unique\(\[businessId, documentType\]\)/.test(seqModel), seqModel.replace(/\s+/g, " ").slice(0, 200), tags);
    check("NUM11.noseries", "OBSERVED", "STATIC", "no series identity beyond (business, type): no series code, no opening number, no lock, no record of a previous book/software", !/series|openingNumber|startNumber|locked/i.test(seqModel), "", tags);
    const issueSrc = readFileSync("lib/services/billing/billing-issue.service.ts", "utf8");
    check("NUM12.date", "OK", "STATIC", "the issue date is the server's clock at issue — no caller-supplied or back-dated document date", /const issuedAt = new Date\(\)/.test(issueSrc) || /issuedAt: new Date\(\)/.test(issueSrc), "", tags);
    const libFiles = execGrep("documentNumber", ["lib/services/billing", "app/api/billing", "app/api/reports"], ".ts").filter((f) =>
      /function\s+\w*(Continuity|NumberGap|SequenceGap|MissingNumber|DuplicateNumber)\w*/i.test(readFileSync(f, "utf8")));
    // After #1079: a read-only continuity check exists — as an internal service only (no route, no screen).
    check("NUM13.check", "OK", "STATIC", "a read-only continuity / duplicate check exists in the billing code (#1079) — internal service only, no route or screen",
      libFiles.some((f) => f.split(path.sep).join("/").endsWith("numbering/billing-numbering-continuity.ts")) &&
        !readdirSync("app/api/billing").some((d) => /continuity|numbering/.test(d)), libFiles, tags);
    const { loadNumberingContinuityReport } = await import("@/lib/services/billing/numbering/billing-numbering-continuity");
    const qReport = await loadNumberingContinuityReport(Q.businessId);
    const qTi = qReport.find((r) => r.documentType === "TAX_INVOICE")!;
    const qCn = qReport.find((r) => r.documentType === "CREDIT_NOTE")!;
    saveEvidence("numbering/continuity-Q.json", JSON.stringify(qReport, null, 2));
    check("NUM14.report", "OK", "SERVICE", "on the lab business: tax invoices and credit notes consistent in range, counters agree — reported PARTIAL (no opening number recorded), never fully verified",
      qTi.consistentInRange && qCn.consistentInRange && qReport.every((r) => !r.fullyVerified) && qTi.coverage === "FROM_FIRST_ISSUED", qReport.map((r) => ({ t: r.documentType, cov: r.coverage, ok: r.consistentInRange, full: r.fullyVerified, range: [r.first, r.last] })), tags);
  }

  // ------------------------------------------------------------------ UI-only items (recorded, not exercised here)
  untested("U1", "exempt dealer is offered 'חשבונית מס' in the create menu", "UI behaviour — exercised in the UI job (ui.e2e.mts), not here");
  untested("U2", "allocation state visible on the document screen after reload", "UI behaviour — exercised in the UI job (ui.e2e.mts), not here");

  const summary = writeLedger({
    head: process.env.GITHUB_SHA ?? "local",
    env: {
      runtimeEnvironment: process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT,
      pilotOperations: process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS,
      renderer: process.env.BILLING_PDF_RENDERER ?? "html (default)",
    },
    tenants: Object.fromEntries([E, A, C, N, I, X].map((t) => [t.key, { kind: t.kind, businessId: t.businessId }])),
  });
  console.log(`\n${summary.totals.checks} checks — OK ${summary.totals.ok}, DEFECT ${summary.totals.defect}, OBSERVED ${summary.totals.observed}, UNTESTED ${summary.totals.untested}; mismatches ${failureCount()}; network attempts ${networkAttempts.length}`);
  if (networkAttempts.length) console.log("network attempts:", networkAttempts);
  if (failureCount() > 0 || networkAttempts.length > 0) process.exitCode = 1;
}

/** Files under `dirs` with extension `ext` whose text contains `needle` (static evidence). */
function execGrep(needle: string, dirs: string[], ext: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (f === "node_modules" || f.startsWith(".")) continue;
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (p.endsWith(ext) && readFileSync(p, "utf8").includes(needle)) hits.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
    await runtime.$disconnect();
  });
