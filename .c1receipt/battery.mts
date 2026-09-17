/**
 * C1 — receipt issuance correctness, proven against a real PostgreSQL.
 *
 * Run in CI against an ephemeral postgres:17, the same way every other
 * database-touching battery in this repository runs. It exists because the two
 * defects it covers are only observable end to end: the shape rule is unit
 * tested next door, but "a pure receipt reaches ISSUED and keeps its number,
 * its payment line and its allocation" is a statement about the whole
 * transaction, and a fake cannot make it.
 *
 * The sequence below is the exact one that failed during the audit.
 *
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { createReceiptDraft } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";

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
async function refuses(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    ok(name, false, "it succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(name, match.test(message), message.split("\n")[0]);
  }
}

async function main() {
  const stamp = Date.now();

  const business = await prisma.business.create({ data: { name: "c1-" + stamp } });
  const actor = await prisma.user.create({
    data: {
      email: `c1-${stamp}@example.test`,
      password: "synthetic",
      businessId: business.id,
      role: "USER",
    },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "C1 Synthetic",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "1 Test St",
      billingPhone: "0500000000",
      billingEmail: "c1@example.test",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "C1 Customer" },
  });

  // An ISSUED invoice to allocate against. Written directly: how an invoice
  // gets issued is not what this battery is about.
  const invoice = await prisma.billingDocument.create({
    data: {
      businessId: business.id,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      customerId: customer.id,
      customerNameSnapshot: "C1 Customer",
      currency: "ILS",
      subtotalAmount: "854.70",
      vatAmount: "145.30",
      totalAmount: "1000.00",
      documentNumber: 1,
      documentNumberFormatted: "000001",
      issuedAt: new Date(),
    },
  });

  console.log("--- the sequence that failed before C1 ---");

  const receipt = await createReceiptDraft({
    businessId: business.id,
    documentType: BillingDocumentType.RECEIPT,
    actorUserId: actor.id,
    customerId: customer.id,
    currency: "ILS",
    paymentLines: [
      {
        method: "CREDIT_CARD",
        amount: "1000.00",
        paymentDate: new Date().toISOString(),
        cardBrand: "VISA",
        cardLast4: "4242",
      },
    ],
  });
  ok("receipt draft created", receipt.status === BillingDocumentStatus.DRAFT);
  ok(
    "customer snapshot populated at creation",
    (receipt.customerNameSnapshot ?? "") === "C1 Customer",
    String(receipt.customerNameSnapshot)
  );
  ok("no goods lines, by design", receipt.lines.length === 0);
  ok("one payment line", (receipt.receiptPayments?.length ?? 0) === 1);

  await setReceiptAllocations({
    businessId: business.id,
    receiptDocumentId: receipt.id,
    allocations: [{ invoiceDocumentId: invoice.id, allocatedAmount: "1000.00" }],
  });

  await issueBillingDocument({
    businessId: business.id,
    billingDocumentId: receipt.id,
    actorUserId: actor.id,
  });

  const issued = await prisma.billingDocument.findUniqueOrThrow({
    where: { id: receipt.id },
    select: {
      status: true,
      documentNumber: true,
      documentNumberFormatted: true,
      customerNameSnapshot: true,
      totalAmount: true,
      issuedAt: true,
      issuedSnapshot: true,
    },
  });

  console.log("--- required result ---");
  ok("RECEIPT STATUS = ISSUED", issued.status === BillingDocumentStatus.ISSUED, issued.status);
  ok("DOCUMENT NUMBER present", typeof issued.documentNumber === "number", String(issued.documentNumber));
  ok("number is formatted", Boolean(issued.documentNumberFormatted), String(issued.documentNumberFormatted));
  ok("CUSTOMER SNAPSHOT present", Boolean(issued.customerNameSnapshot));
  ok("issuedAt set", issued.issuedAt !== null);
  ok(
    "total untouched by issuance",
    issued.totalAmount.toString() === "1000",
    issued.totalAmount.toString()
  );

  const snapshotTotal = (issued.issuedSnapshot as { totals?: { total?: string } })?.totals?.total;
  ok(
    "the legal snapshot carries the real total, not a zero from absent goods lines",
    snapshotTotal === "1000.00",
    String(snapshotTotal)
  );

  const payments = await prisma.billingReceiptPayment.count({
    where: { billingDocumentId: receipt.id },
  });
  const allocations = await prisma.billingPaymentAllocation.count({
    where: { receiptDocumentId: receipt.id },
  });
  ok("RECEIPT PAYMENT preserved through issuance", payments === 1, String(payments));
  ok("ALLOCATION preserved through issuance", allocations === 1, String(allocations));

  // Receipts number on their own sequence, independent of invoices.
  ok("receipt numbered from the receipt sequence", issued.documentNumber === 1);

  console.log("--- what must still be refused ---");

  const emptyReceipt = await prisma.billingDocument.create({
    data: {
      businessId: business.id,
      documentType: BillingDocumentType.RECEIPT,
      status: BillingDocumentStatus.DRAFT,
      customerId: customer.id,
      customerNameSnapshot: "C1 Customer",
      currency: "ILS",
      subtotalAmount: "0",
      vatAmount: "0",
      totalAmount: "0",
    },
  });
  await refuses(
    "a receipt with no payment lines cannot be issued",
    () =>
      issueBillingDocument({
        businessId: business.id,
        billingDocumentId: emptyReceipt.id,
        actorUserId: actor.id,
      }),
    /no payment lines/
  );

  // THE REGRESSION THAT MATTERS. If the zero-line guard had simply been
  // deleted, this would now succeed.
  const emptyInvoice = await prisma.billingDocument.create({
    data: {
      businessId: business.id,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.DRAFT,
      customerId: customer.id,
      customerNameSnapshot: "C1 Customer",
      currency: "ILS",
      subtotalAmount: "0",
      vatAmount: "0",
      totalAmount: "0",
    },
  });
  await refuses(
    "an invoice with no lines still cannot be issued",
    () =>
      issueBillingDocument({
        businessId: business.id,
        billingDocumentId: emptyInvoice.id,
        actorUserId: actor.id,
      }),
    /no lines/
  );

  const other = await prisma.business.create({ data: { name: "other-" + stamp } });
  await refuses(
    "a receipt cannot be created against another business's customer",
    () =>
      createReceiptDraft({
        businessId: other.id,
        documentType: BillingDocumentType.RECEIPT,
    actorUserId: actor.id,
        customerId: customer.id,
        currency: "ILS",
        paymentLines: [
          { method: "CASH", amount: "10.00", paymentDate: new Date().toISOString() },
        ],
      }),
    /does not belong to this business/
  );

  console.log(`\n[battery] C1 receipt issuance  PASS=${pass}  FAIL=${failures.length}`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
