/**
 * C2.5 — issuance-time allocation integrity, proven against a real PostgreSQL.
 *
 * The defects being closed are a race and a missing check at a transaction
 * boundary; neither can be proven with a fake. Every case writes real rows
 * through the real services and asks the real readers.
 *
 * The case matrix is the owner's, on a 1,000 invoice:
 *
 *    1  E4 OVER    receipt 300, allocations 1,000      → issuance refused
 *    2  E4 UNDER   receipt 1,000, allocations 300      → issuance refused
 *    3  exact      1,000 / 1,000                       → issued, outstanding 0
 *    4  partial    400 / 400                           → issued, outstanding 600
 *    5  abandoned  draft A 1,000 left alone; B 1,000   → B prepared and issued
 *   5b             same, with A in PENDING_REVIEW
 *    6  concurrent A 1,000 ∥ B 1,000                   → exactly one issued
 *    7  concurrent A 400 ∥ B 600                       → both issued
 *    8  concurrent A 600 ∥ B 600                       → exactly one issued
 *    9  issued 400, then 600 → passes; then 601 → refused
 *   10  ad-hoc     receipt with no allocation          → issued
 *   11  immutability — an issued receipt's allocations and lines cannot change
 *   12  lock order — two receipts over the same two invoices, named in
 *                    opposite orders, issued concurrently: no deadlock
 *
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  createReceiptDraft,
  replaceReceiptPaymentLines,
} from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getInvoiceSettlementState } from "../lib/services/billing/receipt/billing-settlement-state.service";
import { loadAwaitingPaymentList } from "../lib/services/billing/collection/awaiting-payment.loader";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";

const prisma = new PrismaClient();
const store = createPaymentPrismaStore();

const ITER_FULL = Number(process.env.C25_ITER_FULL ?? 50);
const ITER_OTHER = Number(process.env.C25_ITER_OTHER ?? 25);

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

const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

type Ctx = { businessId: number; actorUserId: number; customerId: number };

async function makeBusiness(label: string): Promise<Ctx> {
  const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const business = await prisma.business.create({ data: { name: `c25-${stamp}` } });
  const actor = await prisma.user.create({
    data: {
      email: `c25-${stamp}@example.test`,
      password: "synthetic",
      businessId: business.id,
      role: "USER",
    },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "C25 Synthetic",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "1 Test St",
      billingPhone: "0500000000",
      billingEmail: "c25@example.test",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "C25 Customer" },
  });
  return { businessId: business.id, actorUserId: actor.id, customerId: customer.id };
}

let invoiceSeq = 0;
async function invoice(ctx: Ctx, total = "1000.00") {
  invoiceSeq += 1;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId,
      customerNameSnapshot: "C25 Customer",
      currency: "ILS",
      subtotalAmount: "0",
      vatAmount: "0",
      totalAmount: total,
      documentNumber: invoiceSeq,
      documentNumberFormatted: String(invoiceSeq).padStart(6, "0"),
      issuedAt: LONG_AGO,
    },
  });
}

const paymentLine = (amount: string) => ({
  method: "CREDIT_CARD",
  amount,
  paymentDate: new Date().toISOString(),
  cardBrand: "VISA",
  cardLast4: "4242",
});

async function draft(ctx: Ctx, amount: string) {
  return createReceiptDraft({
    businessId: ctx.businessId,
    documentType: BillingDocumentType.RECEIPT,
    actorUserId: ctx.actorUserId,
    customerId: ctx.customerId,
    currency: "ILS",
    paymentLines: [paymentLine(amount)],
  });
}

type Outcome = "PASS" | `REJECT:${string}`;

async function allocate(
  ctx: Ctx,
  receiptId: number,
  allocations: { invoiceDocumentId: number; allocatedAmount: string }[]
): Promise<Outcome> {
  try {
    await setReceiptAllocations({
      businessId: ctx.businessId,
      receiptDocumentId: receiptId,
      allocations,
    });
    return "PASS";
  } catch (e) {
    return `REJECT:${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
}

async function issue(ctx: Ctx, receiptId: number): Promise<Outcome> {
  try {
    await issueBillingDocument({
      businessId: ctx.businessId,
      billingDocumentId: receiptId,
      actorUserId: ctx.actorUserId,
    });
    return "PASS";
  } catch (e) {
    return `REJECT:${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
}

/** A rejection that is the integrity rule speaking, not an infrastructure failure. */
const isCapacityReject = (o: Outcome) =>
  o.startsWith("REJECT:") &&
  o.includes("exceeds the invoice remaining unpaid amount");
const isEqualityReject = (o: Outcome) =>
  o.startsWith("REJECT:") &&
  o.includes("Receipt allocations must equal the receipt total");

async function status(id: number) {
  return (await prisma.billingDocument.findUniqueOrThrow({ where: { id } })).status;
}

/** The same debt, asked of all three readers, plus the raw issued total. */
async function debt(ctx: Ctx, invoiceId: number) {
  const settlement = await getInvoiceSettlementState({
    businessId: ctx.businessId,
    invoiceDocumentId: invoiceId,
  });
  const payable = await store.findPayableDocument(ctx.businessId, invoiceId);
  const list = await loadAwaitingPaymentList(ctx.businessId);
  const listed = list.customers
    .flatMap((c) => c.invoices)
    .find((i) => i.id === invoiceId);
  const issued = await prisma.billingPaymentAllocation.aggregate({
    where: {
      invoiceDocumentId: invoiceId,
      receiptDocument: { status: BillingDocumentStatus.ISSUED },
    },
    _sum: { allocatedAmount: true },
  });
  return {
    settlement: settlement.remainingAmount.toFixed(2),
    store: payable ? new Prisma.Decimal(payable.outstandingAmount).toFixed(2) : null,
    collection: listed ? listed.outstanding.toFixed(2) : "0.00",
    issuedAllocated: (issued._sum.allocatedAmount ?? new Prisma.Decimal(0)).toFixed(2),
  };
}

function owes(name: string, d: Awaited<ReturnType<typeof debt>>, expected: string) {
  const want = new Prisma.Decimal(expected).toFixed(2);
  ok(
    `${name} — outstanding ${want} on all three readers`,
    d.settlement === want && d.store === want && d.collection === want,
    JSON.stringify(d)
  );
}

async function main() {
  console.log("\n== CASE 1 — E4 OVER: receipt 300, allocations 1,000 ==");
  {
    const ctx = await makeBusiness("c1");
    const inv = await invoice(ctx);
    const r = await draft(ctx, "1000.00");
    ok("allocation of 1,000 accepted while the receipt says 1,000", (await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "1000.00" }])) === "PASS");
    await replaceReceiptPaymentLines({ businessId: ctx.businessId, billingDocumentId: r.id, paymentLines: [paymentLine("300.00")] });
    const out = await issue(ctx, r.id);
    ok("issuance refused by the equality rule", isEqualityReject(out), out);
    ok("receipt remains DRAFT", (await status(r.id)) === BillingDocumentStatus.DRAFT);
    owes("invoice untouched", await debt(ctx, inv.id), "1000");
  }

  console.log("\n== CASE 2 — E4 UNDER: receipt 1,000, allocations 300 ==");
  {
    const ctx = await makeBusiness("c2");
    const inv = await invoice(ctx);
    const r = await draft(ctx, "300.00");
    ok("allocation of 300 accepted while the receipt says 300", (await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "300.00" }])) === "PASS");
    await replaceReceiptPaymentLines({ businessId: ctx.businessId, billingDocumentId: r.id, paymentLines: [paymentLine("1000.00")] });
    const out = await issue(ctx, r.id);
    ok("issuance refused by the equality rule", isEqualityReject(out), out);
    ok("receipt remains DRAFT", (await status(r.id)) === BillingDocumentStatus.DRAFT);
    owes("invoice untouched", await debt(ctx, inv.id), "1000");
  }

  console.log("\n== CASE 3 — exact match ==");
  {
    const ctx = await makeBusiness("c3");
    const inv = await invoice(ctx);
    const r = await draft(ctx, "1000.00");
    await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "1000.00" }]);
    ok("issued", (await issue(ctx, r.id)) === "PASS");
    owes("fully settled", await debt(ctx, inv.id), "0");
  }

  console.log("\n== CASE 4 — partial ==");
  {
    const ctx = await makeBusiness("c4");
    const inv = await invoice(ctx);
    const r = await draft(ctx, "400.00");
    await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "400.00" }]);
    ok("issued", (await issue(ctx, r.id)) === "PASS");
    owes("partially settled", await debt(ctx, inv.id), "600");
  }

  for (const abandonedAs of [BillingDocumentStatus.DRAFT, BillingDocumentStatus.PENDING_REVIEW]) {
    console.log(`\n== CASE 5${abandonedAs === "DRAFT" ? "" : "b"} — abandoned ${abandonedAs} reserves nothing ==`);
    const ctx = await makeBusiness(`c5-${abandonedAs}`);
    const inv = await invoice(ctx);
    const a = await draft(ctx, "1000.00");
    await allocate(ctx, a.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "1000.00" }]);
    if (abandonedAs === BillingDocumentStatus.PENDING_REVIEW) {
      // A pure receipt cannot reach review through the real submit path (it
      // has no goods lines), so the state is planted to prove the rule holds
      // for it all the same.
      await prisma.billingDocument.update({ where: { id: a.id }, data: { status: abandonedAs } });
    }
    const b = await draft(ctx, "1000.00");
    const prep = await allocate(ctx, b.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "1000.00" }]);
    ok("B prepared despite A's allocation", prep === "PASS", prep);
    const out = await issue(ctx, b.id);
    ok("B issued", out === "PASS", out);
    owes("settled by B alone", await debt(ctx, inv.id), "0");
    ok(`A is still ${abandonedAs} — untouched`, (await status(a.id)) === abandonedAs);
    const late = await issue(ctx, a.id);
    ok("A can no longer be issued — the capacity is gone", isCapacityReject(late), late);
    owes("still exactly settled, never over", await debt(ctx, inv.id), "0");
  }

  async function concurrentPair(label: string, total: string, amountA: string, amountB: string, iterations: number) {
    const ctx = await makeBusiness(label);
    const tally = { bothPass: 0, onePass: 0, nonePass: 0, infraError: 0, overSettled: 0, prepFailed: 0 };
    let sample: unknown = null;
    for (let i = 0; i < iterations; i++) {
      const inv = await invoice(ctx, total);
      const a = await draft(ctx, amountA);
      const b = await draft(ctx, amountB);
      // Both drafts must be genuinely prepared against the invoice; a refused
      // preparation would leave an ad-hoc receipt that "passes" issuance and
      // hide the race this case exists to measure.
      const pa = await allocate(ctx, a.id, [{ invoiceDocumentId: inv.id, allocatedAmount: amountA }]);
      const pb = await allocate(ctx, b.id, [{ invoiceDocumentId: inv.id, allocatedAmount: amountB }]);
      if (pa !== "PASS" || pb !== "PASS") {
        tally.prepFailed++;
        sample ??= { pa, pb };
        continue;
      }
      const [oa, ob] = await Promise.all([issue(ctx, a.id), issue(ctx, b.id)]);
      const passes = [oa, ob].filter((o) => o === "PASS").length;
      const others = [oa, ob].filter((o) => o !== "PASS" && !isCapacityReject(o));
      if (others.length) {
        tally.infraError++;
        sample ??= { oa, ob };
      }
      if (passes === 2) tally.bothPass++;
      else if (passes === 1) tally.onePass++;
      else tally.nonePass++;
      const d = await debt(ctx, inv.id);
      if (new Prisma.Decimal(d.issuedAllocated).greaterThan(total)) tally.overSettled++;
    }
    return { tally, sample };
  }

  console.log(`\n== CASE 6 — concurrent full settlement, ${ITER_FULL} iterations ==`);
  const c6 = await concurrentPair("c6", "1000.00", "1000.00", "1000.00", ITER_FULL);
  console.log("   ", JSON.stringify(c6));
  ok("every iteration: exactly one issued, one refused by capacity", c6.tally.onePass === ITER_FULL, JSON.stringify(c6.tally));
  ok("DOUBLE SETTLEMENT NEVER OBSERVED", c6.tally.bothPass === 0 && c6.tally.overSettled === 0, JSON.stringify(c6.tally));
  ok("both drafts prepared in every iteration (drafts reserve nothing)", c6.tally.prepFailed === 0, JSON.stringify(c6.sample));
  ok("no deadlock / infrastructure failure", c6.tally.infraError === 0, JSON.stringify(c6.sample));

  console.log(`\n== CASE 7 — concurrent partials within capacity, ${ITER_OTHER} iterations ==`);
  const c7 = await concurrentPair("c7", "1000.00", "400.00", "600.00", ITER_OTHER);
  console.log("   ", JSON.stringify(c7));
  ok("every iteration: both issued — the lock serialises, it does not falsely refuse", c7.tally.bothPass === ITER_OTHER, JSON.stringify(c7.tally));
  ok("never over-settled", c7.tally.overSettled === 0);
  ok("both drafts prepared in every iteration", c7.tally.prepFailed === 0, JSON.stringify(c7.sample));
  ok("no deadlock / infrastructure failure", c7.tally.infraError === 0, JSON.stringify(c7.sample));

  console.log(`\n== CASE 8 — concurrent over capacity, ${ITER_OTHER} iterations ==`);
  const c8 = await concurrentPair("c8", "1000.00", "600.00", "600.00", ITER_OTHER);
  console.log("   ", JSON.stringify(c8));
  ok("every iteration: exactly one issued", c8.tally.onePass === ITER_OTHER, JSON.stringify(c8.tally));
  ok("authoritative allocation never exceeds 1,000", c8.tally.overSettled === 0 && c8.tally.bothPass === 0);
  ok("both drafts prepared in every iteration", c8.tally.prepFailed === 0, JSON.stringify(c8.sample));
  ok("no deadlock / infrastructure failure", c8.tally.infraError === 0, JSON.stringify(c8.sample));

  console.log("\n== CASE 9 — existing issued + new ==");
  {
    const ctx = await makeBusiness("c9");
    const inv = await invoice(ctx);
    const first = await draft(ctx, "400.00");
    await allocate(ctx, first.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "400.00" }]);
    ok("first 400 issued", (await issue(ctx, first.id)) === "PASS");

    // 601 is refused already at preparation (the preflight now sees the
    // ISSUED 400); to prove the binding check itself, the draft is prepared
    // before the 400 is issued on a second invoice.
    const inv2 = await invoice(ctx);
    const over = await draft(ctx, "601.00");
    const early = await draft(ctx, "400.00");
    await allocate(ctx, early.id, [{ invoiceDocumentId: inv2.id, allocatedAmount: "400.00" }]);
    ok("601 prepared while nothing is issued on invoice 2", (await allocate(ctx, over.id, [{ invoiceDocumentId: inv2.id, allocatedAmount: "601.00" }])) === "PASS");
    ok("400 issued on invoice 2", (await issue(ctx, early.id)) === "PASS");
    const o601 = await issue(ctx, over.id);
    ok("601 refused at issuance by the binding check", isCapacityReject(o601), o601);
    ok("preflight also refuses 601 once the 400 is issued", isCapacityReject(await allocate(ctx, (await draft(ctx, "601.00")).id, [{ invoiceDocumentId: inv.id, allocatedAmount: "601.00" }])));

    const exact = await draft(ctx, "600.00");
    await allocate(ctx, exact.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "600.00" }]);
    ok("600 issued — exactly the remainder", (await issue(ctx, exact.id)) === "PASS");
    owes("invoice 1 settled", await debt(ctx, inv.id), "0");
    owes("invoice 2 still owes 600", await debt(ctx, inv2.id), "600");
  }

  console.log("\n== CASE 10 — ad-hoc receipt ==");
  {
    const ctx = await makeBusiness("c10");
    const r = await draft(ctx, "250.00");
    const out = await issue(ctx, r.id);
    ok("receipt with zero allocations is issued", out === "PASS", out);
    ok("status ISSUED", (await status(r.id)) === BillingDocumentStatus.ISSUED);
  }

  console.log("\n== CASE 11 — issued immutability ==");
  {
    const ctx = await makeBusiness("c11");
    const inv = await invoice(ctx);
    const r = await draft(ctx, "400.00");
    await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "400.00" }]);
    await issue(ctx, r.id);
    const re = await allocate(ctx, r.id, [{ invoiceDocumentId: inv.id, allocatedAmount: "400.00" }]);
    ok("changing allocations refused", re.startsWith("REJECT:") && re.includes("immutable"), re);
    let linesRefused = false;
    try {
      await replaceReceiptPaymentLines({ businessId: ctx.businessId, billingDocumentId: r.id, paymentLines: [paymentLine("1000.00")] });
    } catch (e) {
      linesRefused = (e as Error).message.includes("immutable");
    }
    ok("changing payment lines refused", linesRefused);
    const again = await issue(ctx, r.id);
    ok("issuing again refused", again.startsWith("REJECT:"), again);
    owes("unchanged", await debt(ctx, inv.id), "600");
  }

  console.log(`\n== CASE 12 — lock order over two invoices, ${ITER_OTHER} iterations ==`);
  {
    const ctx = await makeBusiness("c12");
    const tally = { onePass: 0, bothPass: 0, nonePass: 0, infraError: 0, prepFailed: 0 };
    let sample: unknown = null;
    for (let i = 0; i < ITER_OTHER; i++) {
      const i1 = await invoice(ctx);
      const i2 = await invoice(ctx);
      const a = await draft(ctx, "2000.00");
      const b = await draft(ctx, "2000.00");
      const pa = await allocate(ctx, a.id, [
        { invoiceDocumentId: i1.id, allocatedAmount: "1000.00" },
        { invoiceDocumentId: i2.id, allocatedAmount: "1000.00" },
      ]);
      const pb = await allocate(ctx, b.id, [
        { invoiceDocumentId: i2.id, allocatedAmount: "1000.00" },
        { invoiceDocumentId: i1.id, allocatedAmount: "1000.00" },
      ]);
      if (pa !== "PASS" || pb !== "PASS") {
        tally.prepFailed++;
        sample ??= { pa, pb };
        continue;
      }
      const [oa, ob] = await Promise.all([issue(ctx, a.id), issue(ctx, b.id)]);
      const passes = [oa, ob].filter((o) => o === "PASS").length;
      if ([oa, ob].some((o) => o !== "PASS" && !isCapacityReject(o))) {
        tally.infraError++;
        sample ??= { oa, ob };
      }
      if (passes === 1) tally.onePass++;
      else if (passes === 2) tally.bothPass++;
      else tally.nonePass++;
    }
    console.log("   ", JSON.stringify({ tally, sample }));
    ok("every iteration: exactly one issued", tally.onePass === ITER_OTHER, JSON.stringify(tally));
    ok("both drafts prepared in every iteration", tally.prepFailed === 0, JSON.stringify(sample));
    ok("no deadlock across opposite input orders", tally.infraError === 0, JSON.stringify(sample));
  }

  console.log(`\nC2.5 battery: ${pass} passed, ${failures.length} failed`);
  console.log(`CONCURRENCY ITERATIONS: case6=${ITER_FULL} case7=${ITER_OTHER} case8=${ITER_OTHER} case12=${ITER_OTHER}`);
  if (failures.length) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("BATTERY ERROR", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
