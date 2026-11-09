/**
 * Receipt screen — the exact chain the screen sends, run against the REAL billing services on an isolated PostgreSQL
 * (ephemeral postgres:17 in CI; any throwaway local cluster). Synthetic data only; the authority approval call is the
 * local stub the issue service already accepts (a RECEIPT is never authority-eligible, so it is never called).
 *
 * Each step is the service its route calls, with the body the screen builds (features/business-documents/receipt-model):
 *   POST /api/billing/documents {documentType:"RECEIPT", customerId}  → createBillingDraft
 *   POST /api/billing/documents/[id]/payments    paymentsPayload()     → replaceReceiptPaymentLines
 *   POST /api/billing/documents/[id]/allocations allocationsPayload()  → setReceiptAllocations
 *   POST /api/billing/documents/[id]/issue                             → issueBillingDocument
 *   GET  /api/billing/documents/[id]/settlement-state                  → getInvoiceSettlementState
 * Nothing in billing is changed or mocked besides that stub.
 *
 *   npx tsx .business-documents/receipt-flow.battery.mts
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";

import { createBillingDraft } from "../lib/services/billing/billing-draft.service";
import { issueBillingDocument, type IssueAuthorityDeps } from "../lib/services/billing/billing-issue.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { replaceReceiptPaymentLines } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { getInvoiceSettlementState } from "../lib/services/billing/receipt/billing-settlement-state.service";
import { allocationsPayload, autoAllocate, decimalToAgorot, emptyLine, paymentsPayload, receiptProblems, type OpenInvoice, type PaymentLineForm } from "../features/business-documents/receipt-model";

const prisma = new PrismaClient();

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
async function refuses(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "it succeeded");
  } catch (error) {
    ok(name, true, error instanceof Error ? error.message.split("\n")[0] : String(error));
  }
}

const approvalCalls: number[] = [];
const stubAuthority: IssueAuthorityDeps = {
  executeApproval: async (input) => {
    approvalCalls.push(input.billingDocumentId);
    return { outcome: "completed_approved", billingDocumentId: input.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false };
  },
};

const LINES = [{ description: "שירות סינתטי", quantity: "1", unitPrice: "1000", vatRatePercent: "18" }]; // 1180.00

async function main() {
  const stamp = Date.now();
  const business = await prisma.business.create({ data: { name: "receipt-flow-" + stamp } });
  const actor = await prisma.user.create({ data: { email: `receipt-flow-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" } });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "עסק סינתטי לבדיקות בע\"מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingVatNumber: "999999998",
      billingAddress: "רחוב הבדיקה 1",
      billingPhone: "03-0000000",
      billingEmail: "receipt-flow@example.test",
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "פיילוט-בדיקה-לקוח-01" } });
  const other = await prisma.customer.create({ data: { businessId: business.id, name: "פיילוט-בדיקה-לקוח-02" } });
  const b = business.id;
  const u = actor.id;
  const today = "2026-11-09";
  const issue = (id: number) => issueBillingDocument({ businessId: b, billingDocumentId: id, actorUserId: u }, stubAuthority);
  const newReceipt = async (customerId: number) => (await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId })).id;
  const openInvoices = async (ids: number[]): Promise<OpenInvoice[]> => {
    const out: OpenInvoice[] = [];
    for (const id of ids) {
      const st = await getInvoiceSettlementState({ businessId: b, invoiceDocumentId: id });
      const doc = await prisma.billingDocument.findUniqueOrThrow({ where: { id } });
      out.push({ id, number: doc.documentNumberFormatted, issuedAt: doc.issuedAt?.toISOString() ?? null, totalAgorot: decimalToAgorot(st.totalAmount.toString()), remainingAgorot: decimalToAgorot(st.remainingAmount.toString()) });
    }
    return out;
  };

  // Two issued tax invoices of the customer (1180.00 each), through the existing path.
  const invA = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer.id, initialLines: LINES });
  await issue(invA.id);
  const invB = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer.id, initialLines: LINES });
  await issue(invB.id);
  const sequenceBefore = await prisma.billingDocumentNumberSequence.findMany({ where: { businessId: b }, orderBy: { documentType: "asc" } });

  console.log("--- consolidated receipt: one transfer settles two invoices ---");
  {
    const invoices = await openInvoices([invA.id, invB.id]);
    const lines: PaymentLineForm[] = [{ ...emptyLine(today), method: "BANK_TRANSFER", amount: "2000", bankName: "99", bankBranch: "999", bankAccountNumber: "123456" }];
    const allocations = autoAllocate(200000, invoices);
    ok("the screen sees no problem", Object.keys(receiptProblems({ customerId: String(customer.id), lines, allocations }, invoices)).length === 0);
    const id = await newReceipt(customer.id);
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload(lines).payments });
    await setReceiptAllocations({ businessId: b, receiptDocumentId: id, allocations: allocationsPayload(allocations)!.allocations });
    const { document } = await issue(id);
    ok("issued as RECEIPT with a number", document.status === BillingDocumentStatus.ISSUED && document.documentType === BillingDocumentType.RECEIPT && !!document.documentNumberFormatted, `${document.status} ${document.documentNumberFormatted}`);
    ok("receipt total = the payment", document.totalAmount.toString() === "2000" || document.totalAmount.toFixed(2) === "2000.00", document.totalAmount.toString());
    const [a, bb] = await openInvoices([invA.id, invB.id]);
    ok("oldest invoice fully settled", a.remainingAgorot === 0, String(a.remainingAgorot));
    ok("second invoice settled by the rest (820.00)", bb.remainingAgorot === 36000, String(bb.remainingAgorot));
  }

  console.log("--- a retry on the same draft replaces the payment lines ---");
  {
    const lines1: PaymentLineForm[] = [{ ...emptyLine(today), method: "CASH", amount: "100" }];
    const lines2: PaymentLineForm[] = [{ ...emptyLine(today), method: "CHECK", amount: "150", bankName: "12", bankBranch: "600", bankAccountNumber: "7788", checkNumber: "1001", checkDueDate: "2026-12-01" }, { ...emptyLine(today), method: "BIT", amount: "50", reference: "BIT-555" }];
    const id = await newReceipt(customer.id);
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload(lines1).payments });
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload(lines2).payments });
    const rows = await prisma.billingReceiptPayment.findMany({ where: { billingDocumentId: id }, orderBy: { lineIndex: "asc" } });
    ok("only the second set remains", rows.length === 2 && rows[0].method === "CHECK" && rows[1].method === "BIT", rows.map((r) => r.method).join());
    await setReceiptAllocations({ businessId: b, receiptDocumentId: id, allocations: allocationsPayload({ [invB.id]: "200" })!.allocations });
    const { document } = await issue(id);
    ok("issued: check + bit = 200.00", document.status === BillingDocumentStatus.ISSUED && Number(document.totalAmount) === 200);
    const [, bb] = await openInvoices([invA.id, invB.id]);
    ok("remaining of the second invoice is 160.00 (360.00 − 200.00)", bb.remainingAgorot === 16000, String(bb.remainingAgorot));
  }

  console.log("--- a receipt owed against nothing (no allocation) ---");
  {
    const id = await newReceipt(other.id);
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload([{ ...emptyLine(today), method: "CREDIT_CARD", amount: "75.5", cardBrand: "ויזה", cardLast4: "4242" }]).payments });
    const { document } = await issue(id);
    ok("issued without allocations", document.status === BillingDocumentStatus.ISSUED && Number(document.totalAmount) === 75.5);
  }

  console.log("--- the service still refuses what the screen guards ---");
  {
    const id = await newReceipt(customer.id);
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload([{ ...emptyLine(today), amount: "1000" }]).payments });
    await refuses("allocation above the invoice remaining", () => setReceiptAllocations({ businessId: b, receiptDocumentId: id, allocations: [{ invoiceDocumentId: invB.id, allocatedAmount: "1000.00" }] }));
    await refuses("allocations that do not add up to the total", () => setReceiptAllocations({ businessId: b, receiptDocumentId: id, allocations: [{ invoiceDocumentId: invB.id, allocatedAmount: "100.00" }] }));
    await refuses("a payment method refused on billing documents", () => replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: [{ method: "STANDING_ORDER", amount: "10", paymentDate: today }] }));
    const { document } = await issue((await prisma.billingDocument.findUniqueOrThrow({ where: { id } })).id).catch(() => ({ document: null }));
    ok("an unallocated draft can still be issued after the refusals", document?.status === BillingDocumentStatus.ISSUED);
    await refuses("an issued receipt refuses new payment lines", () => replaceReceiptPaymentLines({ businessId: b, billingDocumentId: id, paymentLines: paymentsPayload([{ ...emptyLine(today), amount: "1" }]).payments }));
  }

  console.log("--- billing numbering: receipts on their own sequence, invoices untouched ---");
  {
    const after = await prisma.billingDocumentNumberSequence.findMany({ where: { businessId: b }, orderBy: { documentType: "asc" } });
    const inv = (rows: typeof after) => rows.find((r) => r.documentType === BillingDocumentType.TAX_INVOICE)?.nextNumber;
    ok("the tax invoice sequence did not move", inv(after) === inv(sequenceBefore), `${inv(sequenceBefore)} → ${inv(after)}`);
    const receipts = await prisma.billingDocument.findMany({ where: { businessId: b, documentType: BillingDocumentType.RECEIPT, status: BillingDocumentStatus.ISSUED }, orderBy: { documentNumber: "asc" }, select: { documentNumber: true } });
    ok("four receipts numbered 1..4", receipts.map((r) => r.documentNumber).join() === "1,2,3,4", receipts.map((r) => r.documentNumber).join());
    ok("the authority stub was never called for a receipt", approvalCalls.every((id) => id === invA.id || id === invB.id));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
