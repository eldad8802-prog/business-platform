/**
 * ============================================================================
 * MANUAL SCRIPT — NOT PART OF CI. NOT A `verify:*` TEST.
 * ============================================================================
 *
 * Run by hand, against a DEVELOPMENT database only:
 *
 *   npx tsx scripts/manual/collection-loader-smoke.ts
 *
 * It is deliberately absent from `package.json` scripts and from every CI
 * workflow, because it WRITES to a database: CI has none, and a script that
 * creates rows must never run unattended against an environment nobody chose.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * `awaiting-payment.loader.ts` is the only part of the collection feature the
 * pure test suites cannot reach — it is the only file there that talks to
 * Prisma. Which document types count, how allocations and credit notes reduce
 * a balance, and whether tenants stay separated are therefore NOT covered by
 * `npm run verify:collection`. This script closes that gap on demand.
 *
 * It builds a fixture across two businesses, reads it back through the real
 * query, asserts, and deletes everything it created.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 *  - Refuses to start unless DATABASE_URL points at the known dev Neon branch.
 *    Widening that check is a decision, not a convenience.
 *  - Creates only its own businesses, marked with MARK, and modifies nothing
 *    that already existed.
 *  - Clears stale fixtures from an earlier interrupted run before starting,
 *    then clears its own on the way out — a crash mid-fixture (which is how
 *    this was first written) otherwise leaves orphan businesses behind.
 */

import { config } from "dotenv";

config();

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("ep-square-grass")) {
  console.error(
    "REFUSING TO RUN: DATABASE_URL does not point at the dev branch (ep-square-grass).",
  );
  process.exit(1);
}

import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { loadAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.loader";

const prisma = new PrismaClient();

let failed = 0;
function ok(name: string, condition: boolean, detail?: unknown) {
  if (!condition) {
    console.error("FAIL:", name, detail === undefined ? "" : detail);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const MARK = "__collection_smoke__";
const NOW = new Date("2026-08-21T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const dec = (v: string) => new Prisma.Decimal(v);

async function makeInvoice(
  businessId: number,
  customerId: number | null,
  opts: {
    type?: BillingDocumentType;
    status?: BillingDocumentStatus;
    number: number;
    total: string;
    issuedDaysAgo: number;
  },
) {
  return prisma.billingDocument.create({
    data: {
      businessId,
      customerId,
      documentType: opts.type ?? BillingDocumentType.TAX_INVOICE,
      status: opts.status ?? BillingDocumentStatus.ISSUED,
      documentNumber: opts.number,
      documentNumberFormatted: String(opts.number),
      totalAmount: dec(opts.total),
      currency: "ILS",
      issuedAt: daysAgo(opts.issuedDaysAgo),
    },
  });
}

async function main() {
  // ---------------------------------------------------------------- fixture --
  // Business A: 7-day terms. Business B: no terms configured -> default 30.
  const bizA = await prisma.business.create({ data: { name: `${MARK} A` } });
  const bizB = await prisma.business.create({ data: { name: `${MARK} B` } });

  await prisma.businessProfile.create({
    data: { businessId: bizA.id, billingPaymentTermsDays: 7 },
  });
  await prisma.businessProfile.create({ data: { businessId: bizB.id } });

  const avi = await prisma.customer.create({
    data: { businessId: bizA.id, name: "אבי", phone: "0501110001" },
  });
  const beni = await prisma.customer.create({
    data: { businessId: bizA.id, name: "בני", phone: "0501110002" },
  });
  const gadi = await prisma.customer.create({
    data: { businessId: bizA.id, name: "גדי", phone: "0501110003" },
  });
  const dana = await prisma.customer.create({
    data: { businessId: bizA.id, name: "דנה", phone: "0501110004" },
  });
  // Same display name as a Business A customer — grouping must never merge them.
  const aviOfB = await prisma.customer.create({
    data: { businessId: bizB.id, name: "אבי", phone: "0502220001" },
  });

  // אבי: one clean invoice + one partially paid.
  const inv1 = await makeInvoice(bizA.id, avi.id, {
    number: 101,
    total: "1000",
    issuedDaysAgo: 30,
  });
  const inv2 = await makeInvoice(bizA.id, avi.id, {
    number: 102,
    total: "500",
    issuedDaysAgo: 20,
  });
  const receipt = await makeInvoice(bizA.id, avi.id, {
    type: BillingDocumentType.RECEIPT,
    number: 201,
    total: "200",
    issuedDaysAgo: 15,
  });
  await prisma.billingPaymentAllocation.create({
    data: {
      businessId: bizA.id,
      receiptDocumentId: receipt.id,
      invoiceDocumentId: inv2.id,
      allocatedAmount: dec("200"),
      currency: "ILS",
    },
  });

  // בני: one partially credited + one fully credited.
  const inv3 = await makeInvoice(bizA.id, beni.id, {
    number: 103,
    total: "800",
    issuedDaysAgo: 30,
  });
  const inv4 = await makeInvoice(bizA.id, beni.id, {
    number: 104,
    total: "400",
    issuedDaysAgo: 30,
  });
  await prisma.billingDocument.create({
    data: {
      businessId: bizA.id,
      customerId: beni.id,
      documentType: BillingDocumentType.CREDIT_NOTE,
      status: BillingDocumentStatus.ISSUED,
      documentNumber: 301,
      documentNumberFormatted: "301",
      totalAmount: dec("300"),
      currency: "ILS",
      issuedAt: daysAgo(10),
      referenceDocumentId: inv3.id,
    },
  });
  await prisma.billingDocument.create({
    data: {
      businessId: bizA.id,
      customerId: beni.id,
      documentType: BillingDocumentType.CREDIT_NOTE,
      status: BillingDocumentStatus.ISSUED,
      documentNumber: 302,
      documentNumberFormatted: "302",
      totalAmount: dec("400"),
      currency: "ILS",
      issuedAt: daysAgo(10),
      referenceDocumentId: inv4.id,
    },
  });
  // A DRAFT credit note is an intention, not a reversal — must NOT reduce inv1.
  await prisma.billingDocument.create({
    data: {
      businessId: bizA.id,
      customerId: avi.id,
      documentType: BillingDocumentType.CREDIT_NOTE,
      status: BillingDocumentStatus.DRAFT,
      documentNumber: 303,
      documentNumberFormatted: "303",
      totalAmount: dec("1000"),
      currency: "ILS",
      referenceDocumentId: inv1.id,
    },
  });

  // גדי: nothing that counts as a debt.
  await makeInvoice(bizA.id, gadi.id, {
    type: BillingDocumentType.TAX_INVOICE_RECEIPT,
    number: 401,
    total: "900",
    issuedDaysAgo: 30,
  });
  await makeInvoice(bizA.id, gadi.id, {
    type: BillingDocumentType.QUOTE,
    number: 501,
    total: "5000",
    issuedDaysAgo: 30,
  });
  await makeInvoice(bizA.id, gadi.id, {
    status: BillingDocumentStatus.DRAFT,
    number: 105,
    total: "700",
    issuedDaysAgo: 30,
  });

  // דנה: one not yet due under 7-day terms, one due.
  await makeInvoice(bizA.id, dana.id, {
    number: 106,
    total: "600",
    issuedDaysAgo: 3,
  });
  await makeInvoice(bizA.id, dana.id, {
    number: 107,
    total: "250",
    issuedDaysAgo: 10,
  });

  // Unassigned debt — counted, never listed.
  await makeInvoice(bizA.id, null, { number: 108, total: "999", issuedDaysAgo: 30 });

  // Business B: 60 days old (due under the 30-day default) + 10 days (not due).
  await makeInvoice(bizB.id, aviOfB.id, {
    number: 101,
    total: "5000",
    issuedDaysAgo: 60,
  });
  await makeInvoice(bizB.id, aviOfB.id, {
    number: 102,
    total: "111",
    issuedDaysAgo: 10,
  });

  // ------------------------------------------------------------------ read --
  const a = await loadAwaitingPaymentList(bizA.id, NOW);
  const b = await loadAwaitingPaymentList(bizB.id, NOW);

  const byName = (name: string) => a.customers.find((c) => c.customerName === name);

  // 1 — only TAX_INVOICE enters
  ok("only TAX_INVOICE enters: גדי is absent", byName("גדי") === undefined);
  const allTypes = a.customers.flatMap((c) => c.invoices.map((i) => i.documentNumber));
  ok("no receipt/quote/draft numbers leaked", !allTypes.some((n) => n && Number(n) >= 200));

  // 2 — payment terms
  const danaRow = byName("דנה");
  ok("terms: דנה is listed", danaRow !== undefined);
  ok(
    "terms: 3-day-old invoice is NOT due under 7-day terms",
    danaRow?.invoices.every((i) => i.documentNumber !== "106") === true,
  );
  ok(
    "terms: 10-day-old invoice IS due under 7-day terms",
    danaRow?.invoices.some((i) => i.documentNumber === "107") === true,
  );
  ok("terms: דנה owes exactly 250", danaRow?.totalOutstanding.equals(dec("250")) === true,
    danaRow?.totalOutstanding.toString());
  ok(
    "terms: default 30 days applies when unset — 60-day invoice is due",
    b.customers[0]?.invoices.some((i) => i.documentNumber === "101") === true,
  );
  ok(
    "terms: default 30 days applies when unset — 10-day invoice is NOT due",
    b.customers[0]?.invoices.every((i) => i.documentNumber !== "102") === true,
  );

  // 3 & 6 — allocations reduce the balance, only the remainder is shown
  const aviRow = byName("אבי");
  const inv2Row = aviRow?.invoices.find((i) => i.documentNumber === "102");
  ok("allocation: invoice 102 still listed", inv2Row !== undefined);
  ok("allocation: 500 − 200 = 300 remaining", inv2Row?.outstanding.equals(dec("300")) === true,
    inv2Row?.outstanding.toString());
  ok("allocation: marked partially settled", inv2Row?.isPartiallySettled === true);

  // 4 — partial credit reduces the balance
  const beniRow = byName("בני");
  const inv3Row = beniRow?.invoices.find((i) => i.documentNumber === "103");
  ok("partial credit: 800 − 300 = 500", inv3Row?.outstanding.equals(dec("500")) === true,
    inv3Row?.outstanding.toString());

  // 5 — full credit removes it entirely
  ok(
    "full credit: invoice 104 is gone",
    beniRow?.invoices.every((i) => i.documentNumber !== "104") === true,
  );
  ok("בני owes exactly 500", beniRow?.totalOutstanding.equals(dec("500")) === true);

  // a draft credit note must not erase a real debt
  const inv1Row = aviRow?.invoices.find((i) => i.documentNumber === "101");
  ok("draft credit note does NOT reduce the balance", inv1Row?.outstanding.equals(dec("1000")) === true,
    inv1Row?.outstanding.toString());

  // grouping
  ok("אבי is one row with two invoices", aviRow?.invoices.length === 2);
  ok("אבי owes 1000 + 300 = 1300", aviRow?.totalOutstanding.equals(dec("1300")) === true,
    aviRow?.totalOutstanding.toString());
  ok("business A has exactly 3 customers", a.customerCount === 3, a.customerCount);
  ok("business A total is 2050", a.totalOutstanding.equals(dec("2050")), a.totalOutstanding.toString());
  ok("largest first", a.customers[0]?.customerName === "אבי");
  ok("unassigned invoice counted, not listed", a.unassignedCount === 1);

  // 7 & 8 — tenant isolation
  ok("business B sees exactly 1 customer", b.customerCount === 1, b.customerCount);
  ok("business B total is 5000", b.totalOutstanding.equals(dec("5000")), b.totalOutstanding.toString());
  const aIds = new Set(a.customers.map((c) => c.customerId));
  ok(
    "no Business A customer appears in Business B's list",
    b.customers.every((c) => !aIds.has(c.customerId)),
  );
  ok(
    "same-named 'אבי' is NOT merged across businesses",
    b.customers[0]?.customerId === aviOfB.id && aviRow?.customerId === avi.id,
  );
  ok(
    "Business B's list carries none of Business A's amounts",
    !b.customers.some((c) => c.totalOutstanding.equals(dec("1300"))),
  );

}

/**
 * Delete every business this script has ever created, by marker.
 *
 * Driven by MARK rather than by ids collected during the run, so it also cleans
 * up after a run that died before it could report what it had built.
 */
async function purgeFixtures(): Promise<number> {
  const stale = await prisma.business.findMany({
    where: { name: { contains: MARK } },
    select: { id: true },
  });

  for (const { id: businessId } of stale) {
    await prisma.billingPaymentAllocation.deleteMany({ where: { businessId } });
    // Credit notes reference invoices, so they must go first.
    await prisma.billingDocument.deleteMany({
      where: { businessId, referenceDocumentId: { not: null } },
    });
    await prisma.billingDocument.deleteMany({ where: { businessId } });
    await prisma.customer.deleteMany({ where: { businessId } });
    await prisma.businessProfile.deleteMany({ where: { businessId } });
    await prisma.business.delete({ where: { id: businessId } });
  }

  return stale.length;
}

purgeFixtures()
  .then((stale) => {
    if (stale > 0) {
      console.log(`cleared ${stale} leftover fixture business(es) from an earlier run`);
    }
    return main();
  })
  .catch((error) => {
    console.error("SMOKE ERROR:", error);
    failed += 1;
  })
  .finally(async () => {
    try {
      const removed = await purgeFixtures();
      console.log(`cleanup: ${removed} fixture business(es) removed`);
    } catch (error) {
      console.error("CLEANUP FAILED — fixture businesses remain:", error);
      failed += 1;
    }
    await prisma.$disconnect();
    console.log(
      failed === 0
        ? "\nCollection · loader smoke: ALL CHECKS PASSED"
        : `\nCollection · loader smoke: ${failed} CHECK(S) FAILED`,
    );
    process.exit(failed === 0 ? 0 : 1);
  });
