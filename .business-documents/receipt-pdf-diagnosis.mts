/**
 * Diagnosis (no fix): does the EXISTING billing PDF path refuse every pure RECEIPT, or only one made by the new
 * receipt screen? Isolated lab only, synthetic data, no provider and no network (the settlement path is local by
 * design: "resumable from local state alone — no provider involvement").
 *
 *   S  a RECEIPT issued by the EXISTING settlement path: settleVerifiedPayment() over a synthetic verified (PAID)
 *      PaymentTransaction of a PaymentRequest for an issued invoice — exactly what a provider webhook leads to.
 *   M  a RECEIPT issued the way the new screen does it (the existing routes' services).
 *   T  a TAX_INVOICE (control).
 * For each: the frozen snapshot's goods lines, assertSnapshotV1, and the existing PDF service getOrRenderBillingPdf.
 *
 *   npx tsx .business-documents/receipt-pdf-diagnosis.mts      (DATABASE_URL = a throwaway lab, schema pushed)
 */
import { BillingDocumentType, PrismaClient } from "@prisma/client";

import { createBillingDraft } from "../lib/services/billing/billing-draft.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getOrRenderBillingPdf } from "../lib/services/billing/billing-pdf.service";
import { assertSnapshotV1, type BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";
import { renderBillingPdfHtmlFromSnapshot } from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { renderBillingPdfFromSnapshot } from "../lib/services/billing/pdf/billing-pdf-renderer";
import { replaceReceiptPaymentLines } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";

const prisma = new PrismaClient();
const stub = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved" as const, billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) };

async function main() {
  const stamp = Date.now();
  const b = (await prisma.business.create({ data: { name: "pdf-diag-" + stamp } })).id;
  const u = (await prisma.user.create({ data: { email: `pdf-diag-${stamp}@example.test`, password: "x", businessId: b } })).id;
  await prisma.businessProfile.create({ data: { businessId: b, billingLegalName: "עסק סינתטי", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingVatNumber: "999999998", billingAddress: "רחוב 1", billingPhone: "03-0000000", billingEmail: "d@example.test" } });
  const c = (await prisma.customer.create({ data: { businessId: b, name: "לקוח סינתטי" } })).id;
  const lines = [{ description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18" }];

  // T — control: an issued tax invoice (118.00).
  const t = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: c, initialLines: lines });
  await issueBillingDocument({ businessId: b, billingDocumentId: t.id, actorUserId: u }, stub as never);

  // S — the existing settlement path: a verified payment for that invoice (CARDCOM, Dubiz issues the documents).
  await prisma.businessPaymentConnection.create({ data: { businessId: b, provider: "CARDCOM", isActive: true, documentIssuer: "DUBIZ_ISSUES" } });
  const req = await prisma.paymentRequest.create({ data: { businessId: b, customerId: c, billingDocumentId: t.id, provider: "CARDCOM", amount: "118.00", currency: "ILS", status: "PAID", paidAt: new Date() } });
  const tx = await prisma.paymentTransaction.create({ data: { paymentRequestId: req.id, provider: "CARDCOM", providerTransactionId: `diag-${stamp}`, amount: "118.00", currency: "ILS", status: "PAID", rawPayload: {} } });
  await prisma.paymentAccountingSettlement.create({ data: { businessId: b, paymentTransactionId: tx.id } });
  const settled = await settleVerifiedPayment({ businessId: b, paymentTransactionId: tx.id });
  const s = await prisma.billingDocument.findFirst({ where: { businessId: b, sourcePaymentTransactionId: tx.id } });
  console.log(`settlement outcome: ${JSON.stringify(settled)}`);

  // M — the new screen's way: draft → payment lines → issue.
  const m = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId: c });
  await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: m.id, paymentLines: [{ lineIndex: 1, method: "CASH", amount: "50.00", currency: "ILS", paymentDate: "2026-11-09" }] });
  await issueBillingDocument({ businessId: b, billingDocumentId: m.id, actorUserId: u }, stub as never);

  for (const [label, id] of [["S settlement receipt (existing path)", s?.id], ["M screen receipt", m.id], ["T tax invoice (control)", t.id]] as const) {
    if (!id) {
      console.log(`${label}: NOT CREATED`);
      continue;
    }
    const doc = await prisma.billingDocument.findUniqueOrThrow({ where: { id }, select: { documentType: true, status: true, issuedSnapshot: true } });
    const snap = doc.issuedSnapshot as { lines?: unknown[]; metadata?: { source?: string } } | null;
    let validator = "passes";
    try {
      assertSnapshotV1(doc.issuedSnapshot);
    } catch (e) {
      validator = `THROWS: ${(e as Error).message}`;
    }
    let service = "renders a PDF";
    try {
      const r = await getOrRenderBillingPdf({ businessId: b, billingDocumentId: id, actorUserId: u } as never);
      service = `renders a PDF (${(r as { buffer: Buffer }).buffer.subarray(0, 5).toString()}…, ${(r as { buffer: Buffer }).buffer.length} bytes)`;
    } catch (e) {
      service = `REFUSES: ${(e as Error).constructor.name}: ${(e as Error).message.split("\n")[0]}`;
    }
    // What the fix would let through: the SAME frozen snapshot through the two existing renderers, check bypassed here only.
    let renderers = "";
    if (doc.documentType === "RECEIPT" && doc.issuedSnapshot) {
      const snapV1 = doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1;
      for (const [name, fn] of [["html", renderBillingPdfHtmlFromSnapshot], ["pdfmake", renderBillingPdfFromSnapshot]] as const) {
        try {
          const buf = (await (fn as (s: BillingIssuedSnapshotV1) => Promise<Buffer>)(snapV1)) as Buffer;
          renderers += `\n   existing ${name} renderer on this snapshot: ${buf.subarray(0, 5).toString()} ${buf.length} bytes`;
        } catch (e) {
          renderers += `\n   existing ${name} renderer on this snapshot: THROWS ${(e as Error).message.split("\n")[0]}`;
        }
      }
    }
    console.log(`${label}: type=${doc.documentType} status=${doc.status} source=${snap?.metadata?.source} goodsLines=${snap?.lines?.length}\n   assertSnapshotV1: ${validator}\n   getOrRenderBillingPdf: ${service}${renderers}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
