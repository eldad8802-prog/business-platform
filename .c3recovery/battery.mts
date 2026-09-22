/**
 * C3 — scheduled local recovery, proven against real PostgreSQL.
 *
 *   V1  PAID + durable PENDING, process died, NO provider resend → recovery settles it, once
 *   V2  a settlement not yet due is left alone; REQUIRES_ATTENTION is never retried blindly
 *   V3  one tenant's broken settlement does not stop the run (failure isolation)
 *   V4  bounded batch: a run stops at its budget; the next run finishes the rest
 *   V5  concurrent runs + a direct webhook-style call → exactly one receipt each
 *   V6  a business being erased is skipped entirely
 *   V7  a historical PAID with no settlement row is never swept up
 *   V8  discovery through the real routing hint (no test seam)
 *
 * RECOVERY_ONLY=V1,… runs a subset (used by the negative proof).
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { runWithTenantContext } from "../lib/tenant/context";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import { runSettlementRecovery } from "../lib/services/billing/settlement/payment-settlement-recovery.service";

const prisma = new PrismaClient();
const store = createPaymentPrismaStore();
const ITER = Number(process.env.RECOVERY_ITER ?? 15);
const ONLY = (process.env.RECOVERY_ONLY ?? "").split(",").filter(Boolean);
const run = (c: string) => ONLY.length === 0 || ONLY.includes(c);

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
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;
type Ctx = { businessId: number; customerId: number };

async function makeBusiness(label: string): Promise<Ctx> {
  const business = await prisma.business.create({ data: { name: `c3r-${label}-${uniq()}` } });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id, billingLegalName: "C3R Synthetic", billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "c3r@example.test",
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "C3R Customer" } });
  return { businessId: business.id, customerId: customer.id };
}
let invoiceNo = 0;
async function invoice(ctx: Ctx, total = "1000.00") {
  invoiceNo += 1;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId, customerNameSnapshot: "C3R Customer", currency: "ILS",
      subtotalAmount: "0", vatAmount: "0", totalAmount: total,
      documentNumber: 500000 + invoiceNo, documentNumberFormatted: String(500000 + invoiceNo),
      issuedAt: new Date(Date.now() - 400 * 86400_000),
    },
  });
}
/** A verified payment recorded exactly as the webhook records it — and then the process dies. */
async function paidThenCrash(ctx: Ctx, amount = "1000.00", withSettlement = true) {
  const inv = await invoice(ctx);
  const providerRequestId = `pr-${uniq()}`;
  const req = await prisma.paymentRequest.create({
    data: {
      businessId: ctx.businessId, customerId: ctx.customerId, billingDocumentId: inv.id,
      provider: "CARDCOM", amount, currency: "ILS", status: "PAID", providerRequestId,
    },
  });
  await prisma.paymentProviderRouting.create({
    data: { provider: "CARDCOM", providerRequestId, paymentRequestId: req.id, businessId: ctx.businessId },
  });
  const ptx = await runWithTenantContext({ businessId: ctx.businessId }, () =>
    store.createTransaction({
      paymentRequestId: req.id, provider: "CARDCOM", providerTransactionId: `ptx-${uniq()}`,
      amount, currency: "ILS", status: "PAID", rawPayload: {},
      ...(withSettlement ? { openAccountingSettlement: { businessId: ctx.businessId } } : {}),
    })
  );
  return { ptx, inv };
}
const receipts = (ptxId: number) => prisma.billingDocument.count({ where: { sourcePaymentTransactionId: ptxId, status: "ISSUED" } });
const settlement = (ptxId: number) => prisma.paymentAccountingSettlement.findUnique({ where: { paymentTransactionId: ptxId } });

async function main() {
  if (run("V1")) {
    console.log("\n== V1 — crash after the verified write; recovery settles, no provider ==");
    const a = await makeBusiness("V1a");
    const b = await makeBusiness("V1b");
    const pa = await paidThenCrash(a);
    const pb1 = await paidThenCrash(b, "400.00");
    const pb2 = await paidThenCrash(b, "600.00");
    const report = await runSettlementRecovery({ listBusinessIds: async () => [a.businessId, b.businessId] });
    ok("V1 — report: 3 attempted, 3 settled", report.attempted === 3 && report.settled === 3, JSON.stringify(report));
    for (const p of [pa, pb1, pb2]) {
      ok(`V1 — ptx ${p.ptx.id}: one issued receipt, SETTLED`, (await receipts(p.ptx.id)) === 1 && (await settlement(p.ptx.id))?.status === "SETTLED");
    }
    const again = await runSettlementRecovery({ listBusinessIds: async () => [a.businessId, b.businessId] });
    ok("V1 — a second run finds nothing to do", again.attempted === 0, JSON.stringify(again));
  }

  if (run("V2")) {
    console.log("\n== V2 — not due, and paused, are left alone ==");
    const c = await makeBusiness("V2");
    const notDue = await paidThenCrash(c);
    await prisma.paymentAccountingSettlement.update({
      where: { paymentTransactionId: notDue.ptx.id },
      data: { nextAttemptAt: new Date(Date.now() + 3600_000) },
    });
    const paused = await paidThenCrash(c);
    await prisma.paymentAccountingSettlement.update({
      where: { paymentTransactionId: paused.ptx.id },
      data: { status: "REQUIRES_ATTENTION", attentionReason: "NO_CUSTOMER" },
    });
    const report = await runSettlementRecovery({ listBusinessIds: async () => [c.businessId] });
    ok("V2 — nothing attempted", report.attempted === 0, JSON.stringify(report));
    ok("V2 — neither has a receipt", (await receipts(notDue.ptx.id)) === 0 && (await receipts(paused.ptx.id)) === 0);
    const later = await runSettlementRecovery({ listBusinessIds: async () => [c.businessId], now: () => new Date(Date.now() + 2 * 3600_000) });
    ok("V2 — once due, it is settled; the paused one still is not", later.settled === 1 && (await receipts(notDue.ptx.id)) === 1 && (await receipts(paused.ptx.id)) === 0, JSON.stringify(later));
  }

  if (run("V3")) {
    console.log("\n== V3 — one broken settlement does not stop the run ==");
    const bad = await makeBusiness("V3bad");
    const good = await makeBusiness("V3good");
    const broken = await paidThenCrash(bad);
    await prisma.billingDocument.create({
      data: { businessId: bad.businessId, documentType: "RECEIPT", status: "DRAFT", totalAmount: "1000.00", customerNameSnapshot: "x", sourcePaymentTransactionId: broken.ptx.id },
    });
    const fine = await paidThenCrash(good);
    const report = await runSettlementRecovery({ listBusinessIds: async () => [bad.businessId, good.businessId] });
    ok("V3 — the broken one is scheduled for retry", report.retryScheduled === 1 && (await settlement(broken.ptx.id))?.attemptCount === 1, JSON.stringify(report));
    ok("V3 — the healthy one still settled", report.settled === 1 && (await receipts(fine.ptx.id)) === 1, JSON.stringify(report));
  }

  if (run("V4")) {
    console.log("\n== V4 — bounded batch ==");
    const d = await makeBusiness("V4");
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(await paidThenCrash(d, "100.00"));
    const r1 = await runSettlementRecovery({ listBusinessIds: async () => [d.businessId], maxSettlements: 2 });
    ok("V4 — first run stops at 2", r1.attempted === 2 && r1.settled === 2 && r1.stoppedEarly, JSON.stringify(r1));
    const r2 = await runSettlementRecovery({ listBusinessIds: async () => [d.businessId], maxSettlements: 10 });
    ok("V4 — next run finishes the other 3", r2.settled === 3, JSON.stringify(r2));
    let all = true;
    for (const p of ps) if ((await receipts(p.ptx.id)) !== 1) all = false;
    ok("V4 — all five: exactly one receipt each", all);
  }

  if (run("V5")) {
    console.log(`\n== V5 — two overlapping runs + a direct call, ${ITER} iterations ==`);
    const e = await makeBusiness("V5");
    let dup = 0;
    let missing = 0;
    let infra = 0;
    for (let i = 0; i < ITER; i++) {
      const ps = [await paidThenCrash(e), await paidThenCrash(e, "300.00")];
      const results = await Promise.allSettled([
        runSettlementRecovery({ listBusinessIds: async () => [e.businessId] }),
        runSettlementRecovery({ listBusinessIds: async () => [e.businessId] }),
        settleVerifiedPayment({ businessId: e.businessId, paymentTransactionId: ps[0].ptx.id }),
      ]);
      if (results.some((r) => r.status === "rejected")) infra++;
      for (const p of ps) {
        const n = await receipts(p.ptx.id);
        if (n > 1) dup++;
        if (n === 0) {
          // A settlement skipped by both runs (locked at the moment) is left for
          // the next run — never lost. Finish it and confirm.
          await runSettlementRecovery({ listBusinessIds: async () => [e.businessId] });
          if ((await receipts(p.ptx.id)) !== 1) missing++;
        }
      }
    }
    ok("V5 — DUPLICATE RECEIPT NEVER OBSERVED", dup === 0, `dup=${dup}`);
    ok("V5 — nothing lost: every payment ends with exactly one receipt", missing === 0, `missing=${missing}`);
    ok("V5 — no run failed", infra === 0, `infra=${infra}`);
  }

  if (run("V6")) {
    console.log("\n== V6 — a business being erased is skipped ==");
    const f = await makeBusiness("V6");
    const p = await paidThenCrash(f);
    await prisma.business.update({ where: { id: f.businessId }, data: { deletionRequestedAt: new Date() } });
    const report = await runSettlementRecovery({ listBusinessIds: async () => [f.businessId] });
    ok("V6 — not scanned, nothing settled", report.businessesScanned === 0 && report.attempted === 0 && (await receipts(p.ptx.id)) === 0, JSON.stringify(report));
  }

  if (run("V7")) {
    console.log("\n== V7 — historical PAID (no settlement row) is never swept up ==");
    const g = await makeBusiness("V7");
    const hist = await paidThenCrash(g, "1000.00", false);
    const report = await runSettlementRecovery({ listBusinessIds: async () => [g.businessId] });
    ok("V7 — nothing attempted, no receipt", report.attempted === 0 && (await receipts(hist.ptx.id)) === 0, JSON.stringify(report));
  }

  if (run("V8")) {
    console.log("\n== V8 — discovery through the real routing hint ==");
    const h = await makeBusiness("V8");
    const p = await paidThenCrash(h);
    const report = await runSettlementRecovery({ maxSettlements: 1000, maxPerBusiness: 1000 });
    ok("V8 — found and settled without a test seam", (await receipts(p.ptx.id)) === 1 && report.businessesScanned >= 1, JSON.stringify(report));
  }

  console.log(`\nC3 recovery battery: ${pass} passed, ${failures.length} failed`);
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
