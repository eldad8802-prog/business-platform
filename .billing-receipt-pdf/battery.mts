/**
 * A pure RECEIPT through the REAL billing PDF service (getOrRenderBillingPdf — what GET /api/billing/documents/[id]/pdf
 * calls), on an isolated PostgreSQL with synthetic data. No provider, no network: the settlement path is local by design.
 *
 *   S  a RECEIPT issued by the EXISTING settlement path: settleVerifiedPayment() over a synthetic verified (PAID) payment
 *   M  a RECEIPT issued the way the receipt screen does it (create draft → payment lines → issue)
 *   T  a TAX_INVOICE (control)
 * Each through BOTH existing renderers (html = the default; pdfmake via BILLING_PDF_RENDERER), cache skipped so every
 * call renders. The receipts' printed text must carry their own number and total.
 *
 * Before the 2026-11-09 exception both receipts were refused ("lines must be a non-empty array") — see
 * .billing-receipt-pdf/assert-snapshot.test.ts for the validator itself across all five types.
 *
 *   npx tsx .billing-receipt-pdf/battery.mts     (DATABASE_URL = a throwaway lab, schema pushed; Chromium installed)
 */
import { BillingDocumentType, PrismaClient } from "@prisma/client";
import { PDFParse } from "pdf-parse";

import { createBillingDraft } from "../lib/services/billing/billing-draft.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getOrRenderBillingPdf } from "../lib/services/billing/billing-pdf.service";
import { replaceReceiptPaymentLines } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";

const prisma = new PrismaClient();
const stub = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved" as const, billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) };

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function text(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await parser.getText()).text.replace(/\s+/g, "");
  } finally {
    await parser.destroy();
  }
}

async function main() {
  process.env.BILLING_PDF_SKIP_CACHE = "1";
  const stamp = Date.now();
  const b = (await prisma.business.create({ data: { name: "receipt-pdf-" + stamp } })).id;
  const u = (await prisma.user.create({ data: { email: `receipt-pdf-${stamp}@example.test`, password: "x", businessId: b } })).id;
  await prisma.businessProfile.create({ data: { businessId: b, billingLegalName: "עסק סינתטי לבדיקות", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingVatNumber: "999999998", billingAddress: "רחוב הבדיקה 1", billingPhone: "03-0000000", billingEmail: "receipt-pdf@example.test" } });
  const c = (await prisma.customer.create({ data: { businessId: b, name: "לקוח סינתטי" } })).id;

  const t = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: c, initialLines: [{ description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18" }] });
  await issueBillingDocument({ businessId: b, billingDocumentId: t.id, actorUserId: u }, stub as never);

  await prisma.businessPaymentConnection.create({ data: { businessId: b, provider: "CARDCOM", isActive: true, documentIssuer: "DUBIZ_ISSUES" } });
  const req = await prisma.paymentRequest.create({ data: { businessId: b, customerId: c, billingDocumentId: t.id, provider: "CARDCOM", amount: "118.00", currency: "ILS", status: "PAID", paidAt: new Date() } });
  const pay = await prisma.paymentTransaction.create({ data: { paymentRequestId: req.id, provider: "CARDCOM", providerTransactionId: `rcpt-pdf-${stamp}`, amount: "118.00", currency: "ILS", status: "PAID", rawPayload: {} } });
  await prisma.paymentAccountingSettlement.create({ data: { businessId: b, paymentTransactionId: pay.id } });
  const settled = await settleVerifiedPayment({ businessId: b, paymentTransactionId: pay.id });
  ok("the existing settlement path issued a receipt", settled.outcome === "SETTLED", JSON.stringify(settled));
  const s = await prisma.billingDocument.findFirstOrThrow({ where: { businessId: b, sourcePaymentTransactionId: pay.id } });

  const m = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId: c });
  await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: m.id, paymentLines: [{ lineIndex: 1, method: "CASH", amount: "50.00", currency: "ILS", paymentDate: "2026-11-09" }] });
  await issueBillingDocument({ businessId: b, billingDocumentId: m.id, actorUserId: u }, stub as never);

  const docs = [
    { label: "S settlement receipt", id: s.id, receipt: true, total: "118.00" },
    { label: "M screen receipt", id: m.id, receipt: true, total: "50.00" },
    { label: "T tax invoice (control)", id: t.id, receipt: false, total: "118.00" },
  ];
  for (const d of docs) {
    const row = await prisma.billingDocument.findUniqueOrThrow({ where: { id: d.id }, select: { documentType: true, documentNumberFormatted: true, issuedSnapshot: true } });
    const lines = (row.issuedSnapshot as { lines: unknown[] }).lines;
    if (d.receipt) ok(`${d.label}: a RECEIPT frozen with no goods lines`, row.documentType === "RECEIPT" && Array.isArray(lines) && lines.length === 0);
    for (const renderer of ["html", "pdfmake"] as const) {
      if (renderer === "pdfmake") process.env.BILLING_PDF_RENDERER = "pdfmake";
      else delete process.env.BILLING_PDF_RENDERER;
      try {
        const r = await getOrRenderBillingPdf({ businessId: b, billingDocumentId: d.id, actorUserId: u } as never);
        const buf = (r as { buffer: Buffer }).buffer;
        const printed = await text(buf);
        ok(`${d.label} · ${renderer}: the real PDF service renders a PDF`, buf.subarray(0, 5).toString() === "%PDF-", `${buf.length} bytes`);
        ok(`${d.label} · ${renderer}: it prints its own number and total`, printed.includes(row.documentNumberFormatted!) && printed.includes(d.total), `${row.documentNumberFormatted} / ${d.total}`);
      } catch (e) {
        ok(`${d.label} · ${renderer}: the real PDF service renders a PDF`, false, (e as Error).message.split("\n")[0]);
      }
    }
  }
  delete process.env.BILLING_PDF_RENDERER;

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
