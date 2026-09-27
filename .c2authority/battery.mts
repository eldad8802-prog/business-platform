/**
 * C2 — issued-allocation authority, proven against a real PostgreSQL.
 *
 * The rule is a Prisma `where` fragment: the money is summed in the database,
 * not in memory. That makes a fake useless here — the only way to know an
 * invoice's balance actually stops moving is to write the rows and ask the real
 * readers. All three are exercised, because the defect this closes was one
 * screen disagreeing with another about the same debt.
 *
 * The case matrix is the owner's, verbatim, on a 1,000 invoice:
 *
 *   A  no receipt                             outstanding 1,000
 *   B  DRAFT receipt allocated 1,000          outstanding 1,000
 *   C  PENDING_REVIEW receipt allocated 1,000 outstanding 1,000
 *   D  ISSUED receipt allocated 1,000         outstanding     0
 *   E  ISSUED receipt allocated   400         outstanding   600
 *   F  DRAFT 300 + ISSUED 400                 outstanding   600
 *
 * Then the transition that is the point of the whole phase: the SAME allocation
 * row, written once while the receipt was a draft, becomes authoritative when
 * the receipt is issued — with no second write.
 *
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { createReceiptDraft } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getInvoiceSettlementState } from "../lib/services/billing/receipt/billing-settlement-state.service";
import { loadAwaitingPaymentList } from "../lib/services/billing/collection/awaiting-payment.loader";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";

const prisma = new PrismaClient();
const store = createPaymentPrismaStore();

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

/** Long enough ago that the collection loader's payment-terms prefilter admits it. */
const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

type Ctx = {
  businessId: number;
  actorUserId: number;
  customerId: number;
};

async function makeBusiness(label: string): Promise<Ctx> {
  const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const business = await prisma.business.create({ data: { name: `c2-${stamp}` } });
  const actor = await prisma.user.create({
    data: {
      email: `c2-${stamp}@example.test`,
      password: "synthetic",
      businessId: business.id,
      role: "USER",
    },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "C2 Synthetic",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "1 Test St",
      billingPhone: "0500000000",
      billingEmail: "c2@example.test",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "C2 Customer" },
  });
  return { businessId: business.id, actorUserId: actor.id, customerId: customer.id };
}

let invoiceSeq = 0;
async function makeIssuedInvoice(ctx: Ctx, total = "1000.00") {
  invoiceSeq += 1;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId,
      customerNameSnapshot: "C2 Customer",
      currency: "ILS",
      subtotalAmount: "854.70",
      vatAmount: "145.30",
      totalAmount: total,
      documentNumber: invoiceSeq,
      documentNumberFormatted: String(invoiceSeq).padStart(6, "0"),
      issuedAt: LONG_AGO,
    },
  });
}

/**
 * A receipt carrying `amount`, allocated to `invoiceId`, left in `status`.
 *
 * The allocation is always written the same way — through the real service,
 * while the receipt is a DRAFT, because that is the only state in which
 * allocations may be written. Reaching PENDING_REVIEW or ISSUED afterwards
 * moves the document, never the allocation row.
 */
async function receiptAllocating(
  ctx: Ctx,
  invoiceId: number,
  amount: string,
  status: BillingDocumentStatus
) {
  const receipt = await createReceiptDraft({
    businessId: ctx.businessId,
    documentType: BillingDocumentType.RECEIPT,
    actorUserId: ctx.actorUserId,
    customerId: ctx.customerId,
    currency: "ILS",
    paymentLines: [
      {
        method: "CREDIT_CARD",
        amount,
        paymentDate: new Date().toISOString(),
        cardBrand: "VISA",
        cardLast4: "4242",
      },
    ],
  });

  await setReceiptAllocations({
    businessId: ctx.businessId,
    receiptDocumentId: receipt.id,
    allocations: [{ invoiceDocumentId: invoiceId, allocatedAmount: amount }],
  });

  if (status === BillingDocumentStatus.ISSUED) {
    await issueBillingDocument({
      businessId: ctx.businessId,
      billingDocumentId: receipt.id,
      actorUserId: ctx.actorUserId,
    });
  } else if (status === BillingDocumentStatus.PENDING_REVIEW) {
    await prisma.billingDocument.update({
      where: { id: receipt.id },
      data: { status: BillingDocumentStatus.PENDING_REVIEW },
    });
  }

  return receipt;
}

/**
 * The same debt, asked of all three readers.
 *
 * Returned side by side on purpose: the defect being closed was precisely that
 * two of these could disagree about one invoice, and a case that passes on one
 * reader while failing on another must be visible as such.
 */
async function outstandingEverywhere(ctx: Ctx, invoiceId: number) {
  const settlement = await getInvoiceSettlementState({
    businessId: ctx.businessId,
    invoiceDocumentId: invoiceId,
  });

  const payable = await store.findPayableDocument(ctx.businessId, invoiceId);

  const list = await loadAwaitingPaymentList(ctx.businessId);
  const listed = list.customers
    .flatMap((customer) => customer.invoices)
    .find((invoice) => invoice.id === invoiceId);

  return {
    settlementRemaining: settlement.remainingAmount.toString(),
    settlementStatus: settlement.status,
    settlementAllocated: settlement.allocatedAmount.toString(),
    storeOutstanding: payable?.outstandingAmount ?? null,
    // An invoice with nothing outstanding drops out of the collection list
    // entirely, which is itself the correct answer for that reader.
    collectionOutstanding: listed ? listed.outstanding.toString() : "0",
    collectionListed: Boolean(listed),
  };
}

function agrees(
  name: string,
  actual: Awaited<ReturnType<typeof outstandingEverywhere>>,
  expected: string
) {
  const norm = (v: string | null) =>
    v === null ? null : new Prisma.Decimal(v).toFixed(2);
  const want = new Prisma.Decimal(expected).toFixed(2);
  const seen = [
    norm(actual.settlementRemaining),
    norm(actual.storeOutstanding),
    norm(actual.collectionOutstanding),
  ];
  ok(
    `${name} — outstanding = ${want}`,
    seen.every((v) => v === want),
    `settlement=${seen[0]} store=${seen[1]} collection=${seen[2]}`
  );
}

async function main() {
  console.log("=== the case matrix: a 1,000 invoice ===");

  // ── Case A — no receipt at all ─────────────────────────────────────────
  {
    const ctx = await makeBusiness("a");
    const invoice = await makeIssuedInvoice(ctx);
    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("A  no receipt", seen, "1000.00");
    ok("A  the invoice is UNPAID", seen.settlementStatus === "UNPAID", seen.settlementStatus);
    ok("A  and appears in the collection list", seen.collectionListed);
  }

  // ── Case B — a DRAFT receipt allocated in full ──────────────────────────
  //
  // THE DEFECT. Before C2 every reader here returned 0: an intention to record
  // money settled a real debt.
  {
    const ctx = await makeBusiness("b");
    const invoice = await makeIssuedInvoice(ctx);
    await receiptAllocating(ctx, invoice.id, "1000.00", BillingDocumentStatus.DRAFT);

    const rows = await prisma.billingPaymentAllocation.count({
      where: { businessId: ctx.businessId, invoiceDocumentId: invoice.id },
    });
    ok("B  the allocation row EXISTS", rows === 1, String(rows));

    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("B  DRAFT receipt allocated 1,000", seen, "1000.00");
    ok("B  it is still UNPAID", seen.settlementStatus === "UNPAID", seen.settlementStatus);
    ok(
      "B  nothing is counted as allocated",
      seen.settlementAllocated === "0",
      seen.settlementAllocated
    );
    ok("B  the debt is still collectable", seen.collectionListed);
  }

  // ── Case C — PENDING_REVIEW is not authority either ─────────────────────
  {
    const ctx = await makeBusiness("c");
    const invoice = await makeIssuedInvoice(ctx);
    const receipt = await receiptAllocating(
      ctx,
      invoice.id,
      "1000.00",
      BillingDocumentStatus.PENDING_REVIEW
    );
    const stored = await prisma.billingDocument.findUniqueOrThrow({
      where: { id: receipt.id },
      select: { status: true },
    });
    ok(
      "C  the receipt really is PENDING_REVIEW",
      stored.status === BillingDocumentStatus.PENDING_REVIEW,
      stored.status
    );

    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("C  PENDING_REVIEW receipt allocated 1,000", seen, "1000.00");
    ok("C  it is still UNPAID", seen.settlementStatus === "UNPAID", seen.settlementStatus);
  }

  // ── Case D — an ISSUED receipt settles it ───────────────────────────────
  {
    const ctx = await makeBusiness("d");
    const invoice = await makeIssuedInvoice(ctx);
    await receiptAllocating(ctx, invoice.id, "1000.00", BillingDocumentStatus.ISSUED);

    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("D  ISSUED receipt allocated 1,000", seen, "0.00");
    ok("D  the invoice is PAID", seen.settlementStatus === "PAID", seen.settlementStatus);
    ok(
      "D  and it has left the collection list",
      seen.collectionListed === false
    );
  }

  // ── Case E — partial settlement ────────────────────────────────────────
  {
    const ctx = await makeBusiness("e");
    const invoice = await makeIssuedInvoice(ctx);
    await receiptAllocating(ctx, invoice.id, "400.00", BillingDocumentStatus.ISSUED);

    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("E  ISSUED receipt allocated 400", seen, "600.00");
    ok(
      "E  the invoice is PARTIALLY_PAID",
      seen.settlementStatus === "PARTIALLY_PAID",
      seen.settlementStatus
    );
    ok("E  and the remainder is still collectable", seen.collectionListed);
  }

  // ── Case F — a mixture: only the issued half counts ─────────────────────
  {
    const ctx = await makeBusiness("f");
    const invoice = await makeIssuedInvoice(ctx);
    await receiptAllocating(ctx, invoice.id, "300.00", BillingDocumentStatus.DRAFT);
    await receiptAllocating(ctx, invoice.id, "400.00", BillingDocumentStatus.ISSUED);

    const rows = await prisma.billingPaymentAllocation.aggregate({
      where: { businessId: ctx.businessId, invoiceDocumentId: invoice.id },
      _sum: { allocatedAmount: true },
      _count: { _all: true },
    });
    ok("F  both allocation rows exist", rows._count._all === 2, String(rows._count._all));
    ok(
      "F  and they total 700 on the table — the raw sum a naive reader would take",
      (rows._sum.allocatedAmount ?? new Prisma.Decimal(0)).toFixed(2) === "700.00"
    );

    const seen = await outstandingEverywhere(ctx, invoice.id);
    agrees("F  DRAFT 300 + ISSUED 400", seen, "600.00");
    ok(
      "F  exactly 400 is counted as allocated",
      new Prisma.Decimal(seen.settlementAllocated).toFixed(2) === "400.00",
      seen.settlementAllocated
    );
  }

  // ── THE TRANSITION: issuance is the authority event ────────────────────
  //
  // One allocation row, written once, while the receipt was a draft. Nothing
  // touches it again. Issuing the receipt is what makes it count.
  console.log("\n=== the DRAFT → ISSUED transition ===");
  {
    const ctx = await makeBusiness("t");
    const invoice = await makeIssuedInvoice(ctx);
    const receipt = await receiptAllocating(
      ctx,
      invoice.id,
      "1000.00",
      BillingDocumentStatus.DRAFT
    );

    const before = await outstandingEverywhere(ctx, invoice.id);
    agrees("T  before issuance", before, "1000.00");

    const rowBefore = await prisma.billingPaymentAllocation.findFirstOrThrow({
      where: { businessId: ctx.businessId, receiptDocumentId: receipt.id },
    });

    await issueBillingDocument({
      businessId: ctx.businessId,
      billingDocumentId: receipt.id,
      actorUserId: ctx.actorUserId,
    });

    const after = await outstandingEverywhere(ctx, invoice.id);
    agrees("T  after issuance", after, "0.00");
    ok("T  the invoice is now PAID", after.settlementStatus === "PAID", after.settlementStatus);

    const rowAfter = await prisma.billingPaymentAllocation.findFirstOrThrow({
      where: { businessId: ctx.businessId, receiptDocumentId: receipt.id },
    });
    ok(
      "T  NO SECOND WRITE — the same allocation row, untouched",
      rowAfter.id === rowBefore.id &&
        rowAfter.allocatedAmount.equals(rowBefore.allocatedAmount) &&
        rowAfter.createdAt.getTime() === rowBefore.createdAt.getTime(),
      `${rowBefore.id}→${rowAfter.id}`
    );

    const count = await prisma.billingPaymentAllocation.count({
      where: { businessId: ctx.businessId, invoiceDocumentId: invoice.id },
    });
    ok("T  and still exactly one allocation — not counted twice", count === 1, String(count));
  }

  // ── §9 CREDIT NOTE REGRESSION — the rule C2 aligned itself to ───────────
  console.log("\n=== credit notes: unchanged ===");
  {
    const ctx = await makeBusiness("cn");
    const invoice = await makeIssuedInvoice(ctx);

    const draftCredit = await prisma.billingDocument.create({
      data: {
        businessId: ctx.businessId,
        documentType: BillingDocumentType.CREDIT_NOTE,
        status: BillingDocumentStatus.DRAFT,
        customerId: ctx.customerId,
        customerNameSnapshot: "C2 Customer",
        currency: "ILS",
        subtotalAmount: "256.41",
        vatAmount: "43.59",
        totalAmount: "300.00",
        referenceDocumentId: invoice.id,
      },
    });

    const withDraft = await outstandingEverywhere(ctx, invoice.id);
    agrees("CN  a DRAFT credit note does not reduce the debt", withDraft, "1000.00");

    await prisma.billingDocument.update({
      where: { id: draftCredit.id },
      data: {
        status: BillingDocumentStatus.ISSUED,
        documentNumber: 900 + invoiceSeq,
        documentNumberFormatted: String(900 + invoiceSeq).padStart(6, "0"),
        issuedAt: new Date(),
      },
    });

    const withIssued = await outstandingEverywhere(ctx, invoice.id);
    // The settlement-state service reports allocations only; credit is a
    // separate aggregation, so only the two outstanding readers move.
    ok(
      "CN  an ISSUED credit note still reduces outstanding, in both balance readers",
      new Prisma.Decimal(withIssued.storeOutstanding ?? "-1").toFixed(2) === "700.00" &&
        new Prisma.Decimal(withIssued.collectionOutstanding).toFixed(2) === "700.00",
      `store=${withIssued.storeOutstanding} collection=${withIssued.collectionOutstanding}`
    );
  }

  // ── §10 TENANT ISOLATION — the new join cannot cross a business ────────
  //
  // The C2 filter joins an allocation to the document that produced it, and a
  // foreign key knows nothing about tenants. This plants the row that would
  // exploit that: business A's allocation pointing at business B's ISSUED
  // receipt. If the join were written without a business predicate, B's
  // issuance would settle A's invoice.
  console.log("\n=== tenant isolation — APP-LAYER FILTER PROOF ===");
  console.log("APP-LAYER FILTER PROOF (sec/A F-5): this section runs as the lab OWNER, which bypasses row-level security. It proves the application's own business predicate (the C2 join's businessId predicate); it does NOT prove database isolation. DB-level isolation for these tables is proven by the rls-db lab of security/gate and the p7/cutover batteries (NOSUPERUSER NOBYPASSRLS roles).");
  {
    const a = await makeBusiness("ten-a");
    const b = await makeBusiness("ten-b");

    const invoiceA = await makeIssuedInvoice(a);
    const invoiceB = await makeIssuedInvoice(b);
    const receiptB = await receiptAllocating(
      b,
      invoiceB.id,
      "1000.00",
      BillingDocumentStatus.ISSUED
    );

    await prisma.billingPaymentAllocation.create({
      data: {
        businessId: a.businessId,
        receiptDocumentId: receiptB.id,
        invoiceDocumentId: invoiceA.id,
        allocatedAmount: "1000.00",
        currency: "ILS",
      },
    });

    const seen = await outstandingEverywhere(a, invoiceA.id);
    agrees(
      "TEN  another business's ISSUED receipt settles nothing here",
      seen,
      "1000.00"
    );
    ok(
      "TEN  business A's invoice is still UNPAID",
      seen.settlementStatus === "UNPAID",
      seen.settlementStatus
    );

    const seenB = await outstandingEverywhere(b, invoiceB.id);
    agrees("TEN  and business B's own invoice is unaffected", seenB, "0.00");
  }

  console.log(`\n[battery] C2 allocation authority  PASS=${pass}  FAIL=${failures.length}`);
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
