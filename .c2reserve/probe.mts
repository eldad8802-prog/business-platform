/**
 * PRE-C3 reservation probe — what the over-allocation guard actually does.
 *
 * INVESTIGATION ONLY. This file changes no behaviour and asserts no desired
 * outcome. It RECORDS what today's code does, so the reservation decision is
 * taken against evidence instead of against the guard's name.
 *
 * C2 settled accounting authority: only an ISSUED receipt's allocations reduce
 * outstanding. It deliberately did not touch `setReceiptAllocations`, whose
 * over-allocation guard reads allocation rows WITHOUT a status filter. So the
 * two questions came apart:
 *
 *   accounting authority   does this allocation reduce the real debt?
 *   reservation authority  does it stop another receipt claiming the same debt?
 *
 * Each case below prints OBSERVED, never PASS/FAIL, because there is no agreed
 * correct answer yet — that is what the report has to decide.
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
import { replaceReceiptPaymentLines } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getInvoiceSettlementState } from "../lib/services/billing/receipt/billing-settlement-state.service";

const prisma = new PrismaClient();

function observed(label: string, value: string) {
  console.log(`  OBSERVED  ${label}: ${value}`);
}

async function attempt(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ALLOWED";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.constructor.name : "unknown";
    return `REFUSED (${name}: ${message.split("\n")[0]})`;
  }
}

type Ctx = { businessId: number; actorUserId: number; customerId: number };

async function makeBusiness(label: string): Promise<Ctx> {
  const stamp = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const business = await prisma.business.create({ data: { name: `res-${stamp}` } });
  const actor = await prisma.user.create({
    data: {
      email: `res-${stamp}@example.test`,
      password: "synthetic",
      businessId: business.id,
      role: "USER",
    },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "Reservation Probe",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "1 Test St",
      billingPhone: "0500000000",
      billingEmail: "res@example.test",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "Probe Customer" },
  });
  return { businessId: business.id, actorUserId: actor.id, customerId: customer.id };
}

let seq = 0;
async function issuedInvoice(ctx: Ctx, total = "1000.00") {
  seq += 1;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId,
      customerNameSnapshot: "Probe Customer",
      currency: "ILS",
      subtotalAmount: "854.70",
      vatAmount: "145.30",
      totalAmount: total,
      documentNumber: seq,
      documentNumberFormatted: String(seq).padStart(6, "0"),
      issuedAt: new Date(),
    },
  });
}

async function draftReceipt(ctx: Ctx, amount: string) {
  return createReceiptDraft({
    businessId: ctx.businessId,
    documentType: BillingDocumentType.RECEIPT,
    actorUserId: ctx.actorUserId,
    customerId: ctx.customerId,
    currency: "ILS",
    paymentLines: [
      { method: "CASH", amount, paymentDate: new Date().toISOString() },
    ],
  });
}

function allocate(ctx: Ctx, receiptId: number, invoiceId: number, amount: string) {
  return setReceiptAllocations({
    businessId: ctx.businessId,
    receiptDocumentId: receiptId,
    allocations: [{ invoiceDocumentId: invoiceId, allocatedAmount: amount }],
  });
}

async function allocationFacts(ctx: Ctx, invoiceId: number) {
  const rows = await prisma.billingPaymentAllocation.findMany({
    where: { businessId: ctx.businessId, invoiceDocumentId: invoiceId },
    select: { allocatedAmount: true, receiptDocument: { select: { status: true } } },
  });
  const raw = rows.reduce(
    (s, r) => s.plus(r.allocatedAmount),
    new Prisma.Decimal(0)
  );
  const state = await getInvoiceSettlementState({
    businessId: ctx.businessId,
    invoiceDocumentId: invoiceId,
  });
  return {
    rowCount: rows.length,
    rawSum: raw.toFixed(2),
    byStatus: rows
      .map((r) => `${r.receiptDocument.status}:${r.allocatedAmount.toFixed(2)}`)
      .join(" "),
    authoritativeAllocated: state.allocatedAmount.toFixed(2),
    outstanding: state.remainingAmount.toFixed(2),
  };
}

async function main() {
  // ── CASE A — a second draft wants the whole invoice a first draft claimed ──
  console.log("\n=== CASE A  invoice 1,000 | draft A 1,000 | draft B attempts 1,000 ===");
  {
    const ctx = await makeBusiness("a");
    const inv = await issuedInvoice(ctx);
    const a = await draftReceipt(ctx, "1000.00");
    const b = await draftReceipt(ctx, "1000.00");
    observed("draft A allocation", await attempt(() => allocate(ctx, a.id, inv.id, "1000.00")));
    observed("draft B allocation", await attempt(() => allocate(ctx, b.id, inv.id, "1000.00")));
    const f = await allocationFacts(ctx, inv.id);
    observed("rows / raw sum", `${f.rowCount} rows, raw ${f.rawSum}, [${f.byStatus}]`);
    observed("authoritative allocated / outstanding", `${f.authoritativeAllocated} / ${f.outstanding}`);
  }

  // ── CASE B — partial claim, then an overlapping one ────────────────────
  console.log("\n=== CASE B  invoice 1,000 | draft A 400 | draft B attempts 700 ===");
  {
    const ctx = await makeBusiness("b");
    const inv = await issuedInvoice(ctx);
    const a = await draftReceipt(ctx, "400.00");
    const b = await draftReceipt(ctx, "700.00");
    observed("draft A 400", await attempt(() => allocate(ctx, a.id, inv.id, "400.00")));
    observed("draft B 700", await attempt(() => allocate(ctx, b.id, inv.id, "700.00")));
    const f = await allocationFacts(ctx, inv.id);
    observed("rows / raw sum", `${f.rowCount} rows, raw ${f.rawSum}, [${f.byStatus}]`);
    observed("authoritative allocated / outstanding", `${f.authoritativeAllocated} / ${f.outstanding}`);
  }

  // ── CASE C — two drafts that exactly fill the invoice ──────────────────
  console.log("\n=== CASE C  invoice 1,000 | draft A 400 | draft B 600 ===");
  {
    const ctx = await makeBusiness("c");
    const inv = await issuedInvoice(ctx);
    const a = await draftReceipt(ctx, "400.00");
    const b = await draftReceipt(ctx, "600.00");
    observed("draft A 400", await attempt(() => allocate(ctx, a.id, inv.id, "400.00")));
    observed("draft B 600", await attempt(() => allocate(ctx, b.id, inv.id, "600.00")));
    const f = await allocationFacts(ctx, inv.id);
    observed("rows / raw sum", `${f.rowCount} rows, raw ${f.rawSum}, [${f.byStatus}]`);
    observed(
      "authoritative allocated / outstanding",
      `${f.authoritativeAllocated} / ${f.outstanding}   <- fully reserved, nothing settled`
    );
  }

  // ── CASE D — a real settlement, then a draft wanting more than is left ──
  console.log("\n=== CASE D  invoice 1,000 | ISSUED receipt 400 | draft attempts 700 ===");
  {
    const ctx = await makeBusiness("d");
    const inv = await issuedInvoice(ctx);
    const paid = await draftReceipt(ctx, "400.00");
    await allocate(ctx, paid.id, inv.id, "400.00");
    await issueBillingDocument({
      businessId: ctx.businessId,
      billingDocumentId: paid.id,
      actorUserId: ctx.actorUserId,
    });
    const d = await draftReceipt(ctx, "700.00");
    observed("draft 700 after 400 settled", await attempt(() => allocate(ctx, d.id, inv.id, "700.00")));
    const d2 = await draftReceipt(ctx, "600.00");
    observed("draft 600 after 400 settled", await attempt(() => allocate(ctx, d2.id, inv.id, "600.00")));
    const f = await allocationFacts(ctx, inv.id);
    observed("rows / raw sum", `${f.rowCount} rows, raw ${f.rawSum}, [${f.byStatus}]`);
    observed("authoritative allocated / outstanding", `${f.authoritativeAllocated} / ${f.outstanding}`);
  }

  // ── CASE E — abandoning a draft, and whether a reservation can be released ──
  console.log("\n=== CASE E  is there any release path for a draft's reservation? ===");
  {
    const ctx = await makeBusiness("e");
    const inv = await issuedInvoice(ctx);
    const a = await draftReceipt(ctx, "1000.00");
    await allocate(ctx, a.id, inv.id, "1000.00");

    observed(
      "clear allocations with an empty array",
      await attempt(() =>
        setReceiptAllocations({
          businessId: ctx.businessId,
          receiptDocumentId: a.id,
          allocations: [],
        })
      )
    );

    // Move the claim to a different invoice — the only documented way the rows
    // are ever deleted is being replaced by another non-empty set.
    const other = await issuedInvoice(ctx);
    observed(
      "move the claim to another invoice",
      await attempt(() => allocate(ctx, a.id, other.id, "1000.00"))
    );
    const afterMove = await allocationFacts(ctx, inv.id);
    observed("original invoice after the move", `${afterMove.rowCount} rows, outstanding ${afterMove.outstanding}`);

    // Shrink the receipt's money and see whether its allocations are revalidated.
    observed(
      "shrink the receipt's payment lines to 100 while it holds a 1,000 claim",
      await attempt(() =>
        replaceReceiptPaymentLines({
          businessId: ctx.businessId,
          billingDocumentId: a.id,
          paymentLines: [
            { method: "CASH", amount: "100.00", paymentDate: new Date().toISOString() },
          ],
        })
      )
    );
    const shrunk = await prisma.billingDocument.findUniqueOrThrow({
      where: { id: a.id },
      select: { totalAmount: true },
    });
    const claim = await prisma.billingPaymentAllocation.aggregate({
      where: { businessId: ctx.businessId, receiptDocumentId: a.id },
      _sum: { allocatedAmount: true },
    });
    observed(
      "receipt total vs the claim it still holds",
      `total ${shrunk.totalAmount.toFixed(2)} vs allocations ${(claim._sum.allocatedAmount ?? new Prisma.Decimal(0)).toFixed(2)}`
    );

    // Can the now-inconsistent receipt still be issued?
    observed(
      "issue that receipt",
      await attempt(() =>
        issueBillingDocument({
          businessId: ctx.businessId,
          billingDocumentId: a.id,
          actorUserId: ctx.actorUserId,
        })
      )
    );

    // Lifecycle surface: what states exist at all.
    observed("BillingDocumentStatus values", Object.keys(BillingDocumentStatus).join(" | "));
  }

  // ── CASE F — two claims racing ─────────────────────────────────────────
  console.log("\n=== CASE F  two drafts allocate 1,000 to the same 1,000 invoice, concurrently ===");
  {
    let over = 0;
    const ROUNDS = 5;
    for (let round = 1; round <= ROUNDS; round++) {
      const ctx = await makeBusiness(`f${round}`);
      const inv = await issuedInvoice(ctx);
      const a = await draftReceipt(ctx, "1000.00");
      const b = await draftReceipt(ctx, "1000.00");

      const results = await Promise.allSettled([
        allocate(ctx, a.id, inv.id, "1000.00"),
        allocate(ctx, b.id, inv.id, "1000.00"),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const f = await allocationFacts(ctx, inv.id);
      if (new Prisma.Decimal(f.rawSum).greaterThan(new Prisma.Decimal("1000.00"))) over += 1;
      observed(
        `round ${round}`,
        `${ok}/2 accepted, ${f.rowCount} rows, raw sum ${f.rawSum} against a 1,000 invoice`
      );
    }
    observed(
      "rounds where the guard was beaten",
      `${over}/${ROUNDS}  (raw claimed > invoice total)`
    );
  }

  // ── structural facts the decision depends on ───────────────────────────
  console.log("\n=== structural facts ===");
  const iso = await prisma.$queryRawUnsafe<{ x: string }[]>(
    "SHOW default_transaction_isolation"
  );
  observed("database default isolation", JSON.stringify(iso[0]));
  const cons = await prisma.$queryRawUnsafe<{ conname: string; def: string }[]>(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = '"BillingPaymentAllocation"'::regclass
      ORDER BY conname`
  );
  for (const c of cons) observed("constraint", `${c.conname}  ${c.def}`);

  console.log("\n[probe] reservation investigation complete — nothing asserted, everything recorded.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
