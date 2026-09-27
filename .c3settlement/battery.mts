/**
 * C3 — verified payment → accounting settlement, proven against real PostgreSQL.
 *
 * Every case drives the real code: the real webhook orchestration with a
 * synthetic provider adapter, the real Prisma payment store, the real
 * settlement service, the real receipt/allocation/issuance services and the
 * three real debt readers. Nothing here is mocked except the provider.
 *
 * Cases (the owner's letters): A full · B partial · C overpayment · D ad-hoc ·
 * E duplicate sequential · F concurrent duplicate · G crash/recovery ·
 * H retry after completion · I failed · J pending/unknown · K tenant isolation ·
 * L currency/document mismatch · M two settlements one invoice · N credit ·
 * O credit/receipt race (+ credit/credit race) · P missing identity ·
 * Q resolution + retry · R historical · T transient retry/backoff/exhaustion.
 *
 * C3_ONLY=F,M… runs a subset (used by the negative proofs).
 * Synthetic data only. No secrets, no Neon, no network.
 */
import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { runWithTenantContext } from "../lib/tenant/context";
import { processPaymentWebhook } from "../lib/services/payments/payment-webhook.service";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import {
  requeueSettlement,
  settleVerifiedPayment,
  SETTLEMENT_MAX_TRANSIENT_ATTEMPTS,
} from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import { createReceiptDraft } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { createBillingCreditNoteDraft } from "../lib/services/billing/billing-credit-reversal.service";
import { getInvoiceSettlementState } from "../lib/services/billing/receipt/billing-settlement-state.service";
import { loadAwaitingPaymentList } from "../lib/services/billing/collection/awaiting-payment.loader";

const prisma = new PrismaClient();
const store = createPaymentPrismaStore();
const ITER = Number(process.env.C3_ITER ?? 25);
const ONLY = (process.env.C3_ONLY ?? "").split(",").filter(Boolean);
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
const D = (v: string | number) => new Prisma.Decimal(v);
const LONG_AGO = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;

type Ctx = { businessId: number; actorUserId: number; customerId: number };

async function makeBusiness(label: string, opts: { identity?: boolean } = {}): Promise<Ctx> {
  const stamp = `${label}-${uniq()}`;
  const business = await prisma.business.create({ data: { name: `c3-${stamp}` } });
  const actor = await prisma.user.create({
    data: { email: `c3-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" },
  });
  await prisma.businessProfile.create({
    data:
      opts.identity === false
        ? { businessId: business.id }
        : {
            businessId: business.id,
            billingLegalName: "C3 Synthetic",
            billingBusinessKind: "LTD_COMPANY",
            billingTaxId: "999999998",
            billingAddress: "1 Test St",
            billingPhone: "0500000000",
            billingEmail: "c3@example.test",
          },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "C3 Customer" } });
  await prisma.businessPaymentConnection.create({
    data: { businessId: business.id, provider: "CARDCOM", isActive: true, merchantId: "m-synthetic" },
  });
  return { businessId: business.id, actorUserId: actor.id, customerId: customer.id };
}

let invoiceNo = 0;
async function invoice(ctx: Ctx, total = "1000.00", opts: { currency?: string; status?: BillingDocumentStatus } = {}) {
  invoiceNo += 1;
  const issued = (opts.status ?? BillingDocumentStatus.ISSUED) === BillingDocumentStatus.ISSUED;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: opts.status ?? BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId,
      customerNameSnapshot: "C3 Customer",
      currency: opts.currency ?? "ILS",
      subtotalAmount: "0",
      vatAmount: "0",
      totalAmount: total,
      ...(issued
        ? { documentNumber: 100000 + invoiceNo, documentNumberFormatted: String(100000 + invoiceNo), issuedAt: LONG_AGO }
        : {}),
    },
  });
}

async function paymentRequest(
  ctx: Ctx,
  amount: string,
  opts: { invoiceId?: number | null; customerId?: number | null; currency?: string } = {}
) {
  const providerRequestId = `pr-${uniq()}`;
  const req = await prisma.paymentRequest.create({
    data: {
      businessId: ctx.businessId,
      customerId: opts.customerId === undefined ? ctx.customerId : opts.customerId,
      billingDocumentId: opts.invoiceId ?? null,
      provider: "CARDCOM",
      amount,
      currency: opts.currency ?? "ILS",
      status: "PENDING",
      providerRequestId,
    },
  });
  await prisma.paymentProviderRouting.create({
    data: { provider: "CARDCOM", providerRequestId, paymentRequestId: req.id, businessId: ctx.businessId },
  });
  return req;
}

let providerCalls = 0;
function adapter(
  outcome: "PAID" | "FAILED" | "PENDING" | "UNKNOWN",
  providerTransactionId: string,
  providerRequestId: string,
  money: { amount: string; currency: string }
) {
  return {
    provider: "CARDCOM",
    supportedCurrencies: null,
    async verifyWebhook() {
      providerCalls++;
      return { ok: true };
    },
    parseWebhook() {
      return {
        providerEventId: `evt-${uniq()}`,
        eventType: "synthetic",
        providerRequestId,
        providerTransactionId,
        outcome: outcome === "UNKNOWN" ? "PENDING" : outcome,
        amount: null,
        currency: null,
        correlationValue: null,
      };
    },
    async getPaymentStatus() {
      providerCalls++;
      // M1: the authority states the money it verified — here, what was asked.
      return {
        outcome,
        providerTransactionId,
        verifiedAmount: money.amount,
        verifiedCurrency: money.currency,
      };
    },
  } as never;
}

/** The whole real webhook path: verify → correlate → persist → verify authority → PAID + settlement → settle. */
async function webhook(
  req: { providerRequestId: string | null; amount: Prisma.Decimal | string; currency: string },
  outcome: "PAID" | "FAILED" | "PENDING" | "UNKNOWN",
  providerTransactionId = `ptx-${uniq()}`
) {
  return processPaymentWebhook(
    { provider: "CARDCOM", rawBody: "{}", parsedBody: {} },
    {
      store,
      resolveProvider: () =>
        adapter(outcome, providerTransactionId, req.providerRequestId!, {
          amount: String(req.amount),
          currency: req.currency,
        }),
      decryptConnectionCredential: () => null,
      settleAccounting: async (e) => {
        await settleVerifiedPayment(e);
      },
    }
  );
}

/** The durable write the webhook performs — and nothing after it. A "crash" right after. */
async function verifiedPaidOnly(ctx: Ctx, requestId: number, amount: string, withSettlement = true) {
  return runWithTenantContext({ businessId: ctx.businessId }, () =>
    store.createTransaction({
      paymentRequestId: requestId,
      provider: "CARDCOM",
      providerTransactionId: `ptx-${uniq()}`,
      amount,
      currency: "ILS",
      status: "PAID",
      rawPayload: {},
      ...(withSettlement ? { openAccountingSettlement: { businessId: ctx.businessId } } : {}),
    })
  );
}

async function txOf(requestId: number) {
  return prisma.paymentTransaction.findFirstOrThrow({ where: { paymentRequestId: requestId, amount: { gt: 0 } }, orderBy: { id: "desc" } });
}
async function receiptsFor(ptxId: number) {
  return prisma.billingDocument.findMany({
    where: { sourcePaymentTransactionId: ptxId },
    include: { paymentAllocationsAsReceipt: true, receiptPayments: true },
  });
}
async function settlementOf(ptxId: number) {
  return prisma.paymentAccountingSettlement.findUnique({ where: { paymentTransactionId: ptxId } });
}
async function outstanding(ctx: Ctx, invoiceId: number) {
  const s = await getInvoiceSettlementState({ businessId: ctx.businessId, invoiceDocumentId: invoiceId });
  const p = await store.findPayableDocument(ctx.businessId, invoiceId);
  const list = await loadAwaitingPaymentList(ctx.businessId);
  const listed = list.customers.flatMap((c) => c.invoices).find((i) => i.id === invoiceId);
  return {
    store: p ? D(p.outstandingAmount).toFixed(2) : null,
    collection: listed ? listed.outstanding.toFixed(2) : "0.00",
    settlementAllocated: s.allocatedAmount.toFixed(2),
  };
}

/** One settled receipt with exactly the expected split. */
async function assertSettled(name: string, ptxId: number, total: string, allocated: string, unapplied: string) {
  const rs = await receiptsFor(ptxId);
  const st = await settlementOf(ptxId);
  ok(`${name} — exactly one receipt`, rs.length === 1, `count=${rs.length}`);
  const r = rs[0];
  if (!r) return;
  const allocSum = r.paymentAllocationsAsReceipt.reduce((a, x) => a.plus(x.allocatedAmount), D(0));
  ok(`${name} — receipt ISSUED RECEIPT`, r.status === "ISSUED" && r.documentType === "RECEIPT");
  ok(`${name} — total ${total}`, r.totalAmount.toFixed(2) === D(total).toFixed(2), r.totalAmount.toFixed(2));
  ok(`${name} — allocation ${allocated}`, allocSum.toFixed(2) === D(allocated).toFixed(2), allocSum.toFixed(2));
  ok(`${name} — unapplied ${unapplied}`, r.unappliedAmount.toFixed(2) === D(unapplied).toFixed(2), r.unappliedAmount.toFixed(2));
  ok(`${name} — system issuer (issuedByUserId null)`, r.issuedByUserId === null);
  const snap = r.issuedSnapshot as { totals?: { unapplied?: string; total?: string }; metadata?: { source?: string; actorUserId?: unknown } } | null;
  ok(`${name} — snapshot freezes unapplied`, snap?.totals?.unapplied === D(unapplied).toFixed(2), JSON.stringify(snap?.totals));
  ok(`${name} — snapshot source payment_settlement`, snap?.metadata?.source === "payment_settlement" && snap?.metadata?.actorUserId === null);
  ok(`${name} — receipt payment line = amount, method OTHER, no invented card data`,
    r.receiptPayments.length === 1 && r.receiptPayments[0].amount.toFixed(2) === D(total).toFixed(2) &&
    r.receiptPayments[0].method === "OTHER" && r.receiptPayments[0].cardLast4 === null && r.receiptPayments[0].cardBrand === null);
  const audit = await prisma.billingAuditEvent.findFirst({ where: { billingDocumentId: r.id, eventType: "BILLING_DOC_ISSUED" } });
  ok(`${name} — billing audit source PAYMENT_SETTLEMENT, no actor`, audit?.source === "PAYMENT_SETTLEMENT" && audit?.actorUserId === null);
  ok(`${name} — settlement SETTLED with settledAt`, st?.status === "SETTLED" && st?.settledAt !== null);
}

async function main() {
  if (run("A")) {
    console.log("\n== A — full payment through the real webhook ==");
    const ctx = await makeBusiness("A");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    const res = await webhook(req, "PAID");
    ok("webhook PAID, verified", res.ok && res.paymentRequestStatus === "PAID" && res.verified === true, JSON.stringify(res));
    const ptx = await txOf(req.id);
    await assertSettled("A", ptx.id, "1000", "1000", "0");
    const o = await outstanding(ctx, inv.id);
    ok("A — outstanding 0 on store + collection, settlement-state allocated 1000", o.store === "0.00" && o.collection === "0.00" && o.settlementAllocated === "1000.00", JSON.stringify(o));
    const pa = await prisma.paymentAuditEvent.findFirst({ where: { paymentRequestId: req.id, eventType: "PAYMENT_ACCOUNTING_SETTLED" } });
    ok("A — payment audit PAYMENT_ACCOUNTING_SETTLED (SYSTEM)", pa?.source === "SYSTEM");
  }

  if (run("B")) {
    console.log("\n== B — partial ==");
    const ctx = await makeBusiness("B");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "400.00", { invoiceId: inv.id });
    await webhook(req, "PAID");
    const ptx = await txOf(req.id);
    await assertSettled("B", ptx.id, "400", "400", "0");
    const o = await outstanding(ctx, inv.id);
    ok("B — outstanding 600", o.store === "600.00" && o.collection === "600.00", JSON.stringify(o));
  }

  if (run("C")) {
    console.log("\n== C — overpayment: remaining 600, payment 1000 ==");
    const ctx = await makeBusiness("C");
    const inv = await invoice(ctx);
    // A manual receipt of 400 already settled part of the invoice.
    const manual = await createReceiptDraft({
      businessId: ctx.businessId, documentType: BillingDocumentType.RECEIPT, actorUserId: ctx.actorUserId,
      customerId: ctx.customerId, currency: "ILS",
      paymentLines: [{ method: "CASH", amount: "400.00", paymentDate: new Date().toISOString() }],
    });
    await setReceiptAllocations({ businessId: ctx.businessId, receiptDocumentId: manual.id, allocations: [{ invoiceDocumentId: inv.id, allocatedAmount: "400.00" }] });
    await issueBillingDocument({ businessId: ctx.businessId, billingDocumentId: manual.id, actorUserId: ctx.actorUserId });
    // The request was created for 1000 before that happened.
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    await webhook(req, "PAID");
    const ptx = await txOf(req.id);
    await assertSettled("C", ptx.id, "1000", "600", "400");
    const o = await outstanding(ctx, inv.id);
    ok("C — outstanding 0, never negative", o.store === "0.00" && o.collection === "0.00" && o.settlementAllocated === "1000.00", JSON.stringify(o));
  }

  if (run("D")) {
    console.log("\n== D — ad-hoc customer payment ==");
    const ctx = await makeBusiness("D");
    const req = await paymentRequest(ctx, "400.00", { invoiceId: null });
    await webhook(req, "PAID");
    const ptx = await txOf(req.id);
    await assertSettled("D", ptx.id, "400", "0", "0");
    const invoices = await prisma.billingDocument.count({ where: { businessId: ctx.businessId, documentType: "TAX_INVOICE" } });
    ok("D — no invoice invented", invoices === 0);
  }

  if (run("E") || run("H")) {
    console.log("\n== E/H — duplicate sequential + retry after completion ==");
    const ctx = await makeBusiness("E");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    const ptxId = `ptx-dup-${uniq()}`;
    await webhook(req, "PAID", ptxId);
    const ptx = await txOf(req.id);
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push((await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id })).outcome);
    ok("E — 5 further calls all ALREADY_SETTLED", outs.every((o) => o === "ALREADY_SETTLED"), outs.join(","));
    const redelivery = await webhook(req, "PAID", ptxId);
    ok("E — provider redelivery is a duplicate", redelivery.duplicate === true, JSON.stringify(redelivery));
    const rs = await receiptsFor(ptx.id);
    const allocRows = await prisma.billingPaymentAllocation.count({ where: { invoiceDocumentId: inv.id } });
    ok("E/H — still one receipt and one allocation row", rs.length === 1 && allocRows === 1, `receipts=${rs.length} allocs=${allocRows}`);
    const txCount = await prisma.paymentTransaction.count({ where: { paymentRequestId: req.id } });
    ok("E — still one money row", txCount === 1);
    const o = await outstanding(ctx, inv.id);
    ok("E — outstanding 0", o.store === "0.00");
  }

  if (run("F")) {
    console.log(`\n== F — concurrent duplicate, ${ITER} iterations × 4 callers ==`);
    const ctx = await makeBusiness("F");
    const tally = { exactlyOneReceipt: 0, dup: 0, oneSettled: 0, infra: 0 };
    let sample: unknown = null;
    for (let i = 0; i < ITER; i++) {
      const inv = await invoice(ctx);
      const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
      const ptx = await verifiedPaidOnly(ctx, req.id, "1000.00");
      const outs = await Promise.all(
        [0, 1, 2, 3].map(() =>
          settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id }).then((r) => r.outcome, (e) => `THROW:${(e as Error).message}`)
        )
      );
      const receipts = (await receiptsFor(ptx.id)).length;
      if (receipts === 1) tally.exactlyOneReceipt++;
      else tally.dup++;
      if (outs.filter((o) => o === "SETTLED").length === 1) tally.oneSettled++;
      if (outs.some((o) => o !== "SETTLED" && o !== "ALREADY_SETTLED")) {
        tally.infra++;
        sample ??= outs;
      }
    }
    console.log("   ", JSON.stringify({ tally, sample }));
    ok("F — exactly one receipt every iteration", tally.exactlyOneReceipt === ITER, JSON.stringify(tally));
    ok("F — DUPLICATE ACCOUNTING EFFECT NEVER OBSERVED", tally.dup === 0);
    ok("F — exactly one caller settled, the rest saw it settled", tally.oneSettled === ITER, JSON.stringify(sample));
    ok("F — no infrastructure failure", tally.infra === 0, JSON.stringify(sample));
  }

  if (run("G")) {
    console.log("\n== G — crash after the verified payment; local recovery, no provider ==");
    const ctx = await makeBusiness("G");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    const ptx = await verifiedPaidOnly(ctx, req.id, "1000.00"); // …then the process dies
    const before = await settlementOf(ptx.id);
    ok("G — durable PENDING settlement exists, no receipt yet", before?.status === "PENDING" && (await receiptsFor(ptx.id)).length === 0);
    const callsBefore = providerCalls;
    const r = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("G — recovery settles it", r.outcome === "SETTLED", JSON.stringify(r));
    ok("G — no provider call was needed", providerCalls === callsBefore);
    await assertSettled("G", ptx.id, "1000", "1000", "0");
  }

  if (run("I")) {
    console.log("\n== I — authoritative FAILED ==");
    const ctx = await makeBusiness("I");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    const res = await webhook(req, "FAILED");
    const txs = await prisma.paymentTransaction.findMany({ where: { paymentRequestId: req.id } });
    ok("I — request FAILED", res.paymentRequestStatus === "FAILED", JSON.stringify(res));
    ok("I — no settlement opened", (await prisma.paymentAccountingSettlement.count({ where: { paymentTransactionId: { in: txs.map((t) => t.id) } } })) === 0);
    ok("I — no receipt", (await prisma.billingDocument.count({ where: { businessId: ctx.businessId, documentType: "RECEIPT" } })) === 0);
    ok("I — invoice untouched", (await outstanding(ctx, inv.id)).store === "1000.00");
  }

  if (run("J")) {
    console.log("\n== J — pending / unknown ==");
    for (const outcome of ["PENDING", "UNKNOWN"] as const) {
      const ctx = await makeBusiness(`J-${outcome}`);
      const inv = await invoice(ctx);
      const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
      const res = await webhook(req, outcome);
      const fresh = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } });
      ok(`J ${outcome} — request stays PENDING (never PAID, never FAILED)`, fresh.status === "PENDING", JSON.stringify(res));
      ok(`J ${outcome} — no money row, no settlement, no receipt`,
        (await prisma.paymentTransaction.count({ where: { paymentRequestId: req.id } })) === 0 &&
        (await prisma.billingDocument.count({ where: { businessId: ctx.businessId, documentType: "RECEIPT" } })) === 0);
    }
  }

  if (run("K")) {
    console.log("\n== K — tenant isolation ==");
    const a = await makeBusiness("K-A");
    const b = await makeBusiness("K-B");
    const inv = await invoice(a);
    const req = await paymentRequest(a, "1000.00", { invoiceId: inv.id });
    const ptx = await verifiedPaidOnly(a, req.id, "1000.00");
    const r = await settleVerifiedPayment({ businessId: b.businessId, paymentTransactionId: ptx.id });
    ok("K — business B cannot settle A's payment", r.outcome === "NOT_ELIGIBLE", JSON.stringify(r));
    ok("K — A's settlement untouched (PENDING, 0 attempts)", (await settlementOf(ptx.id))?.status === "PENDING" && (await settlementOf(ptx.id))?.attemptCount === 0);
    ok("K — no receipt anywhere", (await receiptsFor(ptx.id)).length === 0 &&
      (await prisma.billingDocument.count({ where: { businessId: b.businessId, documentType: "RECEIPT" } })) === 0);
    const rq = await requeueSettlement({ businessId: b.businessId, paymentTransactionId: ptx.id });
    ok("K — B cannot requeue A's settlement", rq.requeued === false);
    const own = await settleVerifiedPayment({ businessId: a.businessId, paymentTransactionId: ptx.id });
    ok("K — A settles its own", own.outcome === "SETTLED");
    // A payment request whose invoice belongs to another tenant: fail closed.
    const foreignInv = await invoice(b);
    const req2 = await paymentRequest(a, "500.00", { invoiceId: foreignInv.id });
    const ptx2 = await verifiedPaidOnly(a, req2.id, "500.00");
    const r2 = await settleVerifiedPayment({ businessId: a.businessId, paymentTransactionId: ptx2.id });
    ok("K — another tenant's invoice is never allocated", r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "DOCUMENT_NOT_ALLOCATABLE", JSON.stringify(r2));
    ok("K — B's invoice untouched", (await outstanding(b, foreignInv.id)).store === "1000.00");
  }

  if (run("L")) {
    console.log("\n== L — currency / document mismatch fail closed ==");
    const ctx = await makeBusiness("L");
    const usd = await invoice(ctx, "1000.00", { currency: "USD" });
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: usd.id });
    const ptx = await verifiedPaidOnly(ctx, req.id, "1000.00");
    const r = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("L — currency mismatch → REQUIRES_ATTENTION", r.outcome === "REQUIRES_ATTENTION" && r.reason === "CURRENCY_MISMATCH", JSON.stringify(r));
    ok("L — no receipt, payment still PAID", (await receiptsFor(ptx.id)).length === 0 && (await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: ptx.id } })).status === "PAID");
    const draftInv = await invoice(ctx, "1000.00", { status: BillingDocumentStatus.DRAFT });
    const req2 = await paymentRequest(ctx, "1000.00", { invoiceId: draftInv.id });
    const ptx2 = await verifiedPaidOnly(ctx, req2.id, "1000.00");
    const r2 = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx2.id });
    ok("L — unissued invoice → DOCUMENT_NOT_ALLOCATABLE", r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "DOCUMENT_NOT_ALLOCATABLE", JSON.stringify(r2));
  }

  if (run("M")) {
    console.log(`\n== M — two different settlements, one invoice, concurrent, ${ITER} iterations ==`);
    const ctx = await makeBusiness("M");
    const tally = { exact: 0, over: 0, infra: 0 };
    let sample: unknown = null;
    for (let i = 0; i < ITER; i++) {
      const inv = await invoice(ctx);
      const r1 = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
      const r2 = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
      const p1 = await verifiedPaidOnly(ctx, r1.id, "1000.00");
      const p2 = await verifiedPaidOnly(ctx, r2.id, "1000.00");
      const outs = await Promise.all([p1, p2].map((p) => settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: p.id })));
      const alloc = await prisma.billingPaymentAllocation.aggregate({ where: { invoiceDocumentId: inv.id, receiptDocument: { status: "ISSUED" } }, _sum: { allocatedAmount: true } });
      const allocated = alloc._sum.allocatedAmount ?? D(0);
      const unapplied = await prisma.billingDocument.aggregate({ where: { sourcePaymentTransactionId: { in: [p1.id, p2.id] } }, _sum: { unappliedAmount: true } });
      if (outs.some((o) => o.outcome !== "SETTLED")) {
        tally.infra++;
        sample ??= outs;
      }
      if (allocated.greaterThan(1000)) tally.over++;
      else if (allocated.equals(1000) && (unapplied._sum.unappliedAmount ?? D(0)).equals(1000)) tally.exact++;
    }
    console.log("   ", JSON.stringify({ tally, sample }));
    ok("M — never over-settled", tally.over === 0, JSON.stringify(tally));
    ok("M — every iteration: 1000 allocated, 1000 stated unapplied (both payments receipted)", tally.exact === ITER, JSON.stringify(tally));
    ok("M — both settled, no infrastructure failure", tally.infra === 0, JSON.stringify(sample));
  }

  async function issuedCreditNote(ctx: Ctx, invoiceId: number, amount: string) {
    const cn = await createBillingCreditNoteDraft({
      businessId: ctx.businessId, actorUserId: ctx.actorUserId, sourceBillingDocumentId: invoiceId,
      initialLines: [{ description: "credit", quantity: "1", unitPrice: amount, vatRatePercent: "0" }],
    });
    return cn;
  }

  if (run("N")) {
    console.log("\n== N — issued credit notes reduce what a payment can settle ==");
    const ctx = await makeBusiness("N");
    const inv = await invoice(ctx);
    const cn = await issuedCreditNote(ctx, inv.id, "400.00");
    await issueBillingDocument({ businessId: ctx.businessId, billingDocumentId: cn.id, actorUserId: ctx.actorUserId });
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    await webhook(req, "PAID");
    const ptx = await txOf(req.id);
    await assertSettled("N", ptx.id, "1000", "600", "400");
    ok("N — collection outstanding 0", (await outstanding(ctx, inv.id)).collection === "0.00");
    // A manual receipt is now bounded the same way (the shared rule).
    const manual = await createReceiptDraft({
      businessId: ctx.businessId, documentType: BillingDocumentType.RECEIPT, actorUserId: ctx.actorUserId,
      customerId: ctx.customerId, currency: "ILS", paymentLines: [{ method: "CASH", amount: "1.00", paymentDate: new Date().toISOString() }],
    });
    let refused = false;
    try {
      await setReceiptAllocations({ businessId: ctx.businessId, receiptDocumentId: manual.id, allocations: [{ invoiceDocumentId: inv.id, allocatedAmount: "1.00" }] });
    } catch { refused = true; }
    ok("N — a manual receipt cannot allocate to an economically settled invoice", refused);
  }

  if (run("O")) {
    console.log(`\n== O — credit ∥ settlement and credit ∥ credit races, ${ITER} iterations ==`);
    const ctx = await makeBusiness("O");
    const t = { serial: 0, bad: 0, infra: 0, cc_one: 0, cc_over: 0 };
    let sample: unknown = null;
    for (let i = 0; i < ITER; i++) {
      const inv = await invoice(ctx);
      const cn = await issuedCreditNote(ctx, inv.id, "400.00");
      const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
      const ptx = await verifiedPaidOnly(ctx, req.id, "1000.00");
      const [c, s] = await Promise.all([
        issueBillingDocument({ businessId: ctx.businessId, billingDocumentId: cn.id, actorUserId: ctx.actorUserId }).then(() => "ok", (e) => `ERR:${(e as Error).message}`),
        settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id }),
      ]);
      const r = (await receiptsFor(ptx.id))[0];
      const alloc = r ? r.paymentAllocationsAsReceipt.reduce((a, x) => a.plus(x.allocatedAmount), D(0)) : D(-1);
      const consistent = r && alloc.plus(r.unappliedAmount).equals(1000);
      // Credit first → 600 settles; settlement first → 1000 settles and the
      // (payment-agnostic, unchanged) credit guard then allows the credit.
      if (c === "ok" && s.outcome === "SETTLED" && consistent && (alloc.equals(600) || alloc.equals(1000))) t.serial++;
      else if (c !== "ok" || s.outcome !== "SETTLED") { t.infra++; sample ??= { c, s }; }
      else { t.bad++; sample ??= { alloc: alloc.toFixed(2) }; }

      // credit ∥ credit on a fresh invoice: 600 ∥ 600 against 1000
      const inv2 = await invoice(ctx);
      const c1 = await issuedCreditNote(ctx, inv2.id, "600.00");
      const c2 = await issuedCreditNote(ctx, inv2.id, "600.00");
      const cc = await Promise.all([c1, c2].map((x) => issueBillingDocument({ businessId: ctx.businessId, billingDocumentId: x.id, actorUserId: ctx.actorUserId }).then(() => 1, () => 0)));
      const credited = await prisma.billingDocument.aggregate({ where: { referenceDocumentId: inv2.id, documentType: "CREDIT_NOTE", status: "ISSUED" }, _sum: { totalAmount: true } });
      if ((credited._sum.totalAmount ?? D(0)).greaterThan(1000)) t.cc_over++;
      if (cc[0] + cc[1] === 1) t.cc_one++;
    }
    console.log("   ", JSON.stringify({ t, sample }));
    ok("O — credit ∥ settlement always ends in a serial outcome (600 or 1000 settled, rest unapplied)", t.serial === ITER && t.bad === 0, JSON.stringify(t));
    ok("O — no infrastructure failure / deadlock", t.infra === 0, JSON.stringify(sample));
    ok("O — credit ∥ credit: exactly one issued every iteration", t.cc_one === ITER, JSON.stringify(t));
    ok("O — credit ∥ credit: never credited beyond the invoice", t.cc_over === 0, JSON.stringify(t));
  }

  if (run("P") || run("Q")) {
    console.log("\n== P/Q — missing identity → attention → resolution → one receipt ==");
    const ctx = await makeBusiness("P");
    const req = await paymentRequest(ctx, "400.00", { invoiceId: null, customerId: null });
    await webhook(req, "PAID");
    const ptx = await txOf(req.id);
    const st = await settlementOf(ptx.id);
    ok("P — no customer → REQUIRES_ATTENTION NO_CUSTOMER", st?.status === "REQUIRES_ATTENTION" && st?.attentionReason === "NO_CUSTOMER", JSON.stringify(st));
    ok("P — payment stays PAID, no receipt", (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: req.id } })).status === "PAID" && (await receiptsFor(ptx.id)).length === 0);
    const again = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("P — paused: further calls do nothing until resolved", again.outcome === "REQUIRES_ATTENTION" && (await receiptsFor(ptx.id)).length === 0);
    // Owner resolves: names the customer.
    await prisma.paymentRequest.update({ where: { id: req.id }, data: { customerId: ctx.customerId } });
    ok("Q — requeued", (await requeueSettlement({ businessId: ctx.businessId, paymentTransactionId: ptx.id })).requeued);
    const done = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("Q — settles after resolution", done.outcome === "SETTLED", JSON.stringify(done));
    await assertSettled("Q", ptx.id, "400", "0", "0");
    const twice = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("Q — and only once", twice.outcome === "ALREADY_SETTLED" && (await receiptsFor(ptx.id)).length === 1);

    const noId = await makeBusiness("P-ident", { identity: false });
    const inv = await invoice(noId);
    const req2 = await paymentRequest(noId, "1000.00", { invoiceId: inv.id });
    const ptx2 = await verifiedPaidOnly(noId, req2.id, "1000.00");
    const r2 = await settleVerifiedPayment({ businessId: noId.businessId, paymentTransactionId: ptx2.id });
    ok("P — incomplete billing identity → BILLING_IDENTITY_INCOMPLETE", r2.outcome === "REQUIRES_ATTENTION" && r2.reason === "BILLING_IDENTITY_INCOMPLETE", JSON.stringify(r2));
    await prisma.businessProfile.update({
      where: { businessId: noId.businessId },
      data: { billingLegalName: "Now Complete", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "c3@example.test" },
    });
    await requeueSettlement({ businessId: noId.businessId, paymentTransactionId: ptx2.id });
    const r3 = await settleVerifiedPayment({ businessId: noId.businessId, paymentTransactionId: ptx2.id });
    ok("Q — identity completed → settles once", r3.outcome === "SETTLED" && (await receiptsFor(ptx2.id)).length === 1, JSON.stringify(r3));
  }

  if (run("R")) {
    console.log("\n== R — historical PAID (no settlement row) is never swept up ==");
    const ctx = await makeBusiness("R");
    const inv = await invoice(ctx);
    const req = await paymentRequest(ctx, "1000.00", { invoiceId: inv.id });
    const ptx = await verifiedPaidOnly(ctx, req.id, "1000.00", false);
    const r = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id });
    ok("R — NOT_ELIGIBLE", r.outcome === "NOT_ELIGIBLE", JSON.stringify(r));
    ok("R — no receipt, no settlement row created", (await receiptsFor(ptx.id)).length === 0 && (await settlementOf(ptx.id)) === null);
    const refund = await runWithTenantContext({ businessId: ctx.businessId }, () =>
      store.createTransaction({ paymentRequestId: req.id, provider: "CARDCOM", providerTransactionId: null, amount: "-100.00", currency: "ILS", status: "PAID", rawPayload: {}, openAccountingSettlement: { businessId: ctx.businessId } })
    ).then(() => "created", () => "refused");
    ok("R — a refund (negative) row can never open a settlement", refund === "refused");
  }

  if (run("T")) {
    console.log("\n== T — transient failure: rollback, backoff, exhaustion, no PII ==");
    const ctx = await makeBusiness("T");
    const req = await paymentRequest(ctx, "400.00", { invoiceId: null });
    const ptx = await verifiedPaidOnly(ctx, req.id, "400.00");
    // Plant an unissued document already claiming this payment: the service
    // must refuse to add a second one and treat it as a transient anomaly.
    await prisma.billingDocument.create({
      data: { businessId: ctx.businessId, documentType: "RECEIPT", status: "DRAFT", totalAmount: "400.00", customerNameSnapshot: "x", sourcePaymentTransactionId: ptx.id },
    });
    const t0 = new Date("2030-01-01T00:00:00Z");
    const first = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id }, { now: () => t0 });
    const st1 = await settlementOf(ptx.id);
    ok("T — first transient → RETRY_SCHEDULED, attempt 1, +1m", first.outcome === "RETRY_SCHEDULED" && st1?.attemptCount === 1 && st1?.nextAttemptAt?.getTime() === t0.getTime() + 60_000, JSON.stringify(first));
    ok("T — lastError is a code, not a message", !!st1?.lastError && !/C3 Customer|@|\d{6,}/.test(st1.lastError) && st1.lastError.length <= 120, String(st1?.lastError));
    const expected = [5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000, 12 * 3600_000];
    let backoffOk = true;
    for (let k = 0; k < expected.length; k++) {
      await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id }, { now: () => t0 });
      const s = await settlementOf(ptx.id);
      if (s?.nextAttemptAt?.getTime() !== t0.getTime() + expected[k]) backoffOk = false;
    }
    ok("T — backoff 1m → 5m → 30m → 2h → 12h (then 12h)", backoffOk);
    let last = null as unknown;
    for (let k = 0; k < SETTLEMENT_MAX_TRANSIENT_ATTEMPTS; k++) last = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: ptx.id }, { now: () => t0 });
    const stN = await settlementOf(ptx.id);
    ok("T — after 10 transient attempts → REQUIRES_ATTENTION RETRY_EXHAUSTED", stN?.status === "REQUIRES_ATTENTION" && stN?.attentionReason === "RETRY_EXHAUSTED" && stN?.attemptCount === SETTLEMENT_MAX_TRANSIENT_ATTEMPTS, JSON.stringify({ last, stN }));
    ok("T — the planted draft is still the only document; no receipt issued", (await receiptsFor(ptx.id)).length === 1 && (await receiptsFor(ptx.id))[0].status === "DRAFT");
  }

  console.log(`\nC3 battery: ${pass} passed, ${failures.length} failed`);
  console.log(`CONCURRENCY ITERATIONS: F=${ITER}x4 M=${ITER} O=${ITER}x2`);
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
