/* eslint-disable @typescript-eslint/no-explicit-any -- test battery: loose JSON response bodies */
/**
 * Collection product — server read models and actions, proven against real
 * PostgreSQL through the REAL route handlers (real bearer auth, real tenant).
 *
 *   I1  inbox segments: צריך לגבות · ממתין · דורש טיפול · שולם, each from server state
 *   I2  cancelled-then-paid money is PAID, once — never lost, never twice
 *   I3  paid history is bounded and pages backwards
 *   I4  excess stays in attention until refunded
 *   T1  customer thread: events, order, economic outstanding (credit aware)
 *   X1  cancel: only open, never paid, never another tenant's
 *   X2  resolve NO_CUSTOMER → exactly one receipt; cannot rename a known payer
 *   R1  readiness: no provider / ambiguous / identity incomplete / ready
 *   V1  invoice collection state: שולם / זוכה / נותר from the shared rule
 *   K1  tenant isolation on every new route
 *
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import { BillingDocumentStatus, BillingDocumentType, Prisma, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runWithTenantContext } from "../lib/tenant/context";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import * as inboxRoute from "../app/api/collection/inbox/route";
import * as threadRoute from "../app/api/collection/customers/[customerId]/route";
import * as readinessRoute from "../app/api/collection/readiness/route";
import * as retryRoute from "../app/api/collection/settlements/[paymentTransactionId]/retry/route";
import * as invoiceRoute from "../app/api/collection/invoices/[id]/route";
import * as cancelRoute from "../app/api/payments/requests/[id]/cancel/route";

const prisma = new PrismaClient();
const store = createPaymentPrismaStore();
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;
const D = (v: string | number) => new Prisma.Decimal(v);
const DAY = 86400_000;

type Ctx = { businessId: number; userId: number; token: string; customerId: number };

async function makeBusiness(label: string, opts: { identity?: boolean; connections?: number } = {}): Promise<Ctx> {
  const business = await prisma.business.create({ data: { name: `col-${label}-${uniq()}` } });
  const user = await prisma.user.create({ data: { email: `col-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" } });
  await prisma.businessProfile.create({
    data: opts.identity === false ? { businessId: business.id } : {
      businessId: business.id, billingLegalName: "Col Synthetic", billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "col@example.test",
    },
  });
  const providers = ["CARDCOM", "SUMIT"].slice(0, opts.connections ?? 1);
  for (const provider of providers) {
    await prisma.businessPaymentConnection.create({ data: { businessId: business.id, provider: provider as never, isActive: true, merchantId: "m" } });
  }
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "יוסי כהן", phone: "0501234567" } });
  return { businessId: business.id, userId: user.id, token: signAuthToken(user.id), customerId: customer.id };
}
let invNo = 0;
async function invoice(ctx: Ctx, total = "1000.00", issuedDaysAgo = 400) {
  invNo++;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId, customerNameSnapshot: "יוסי כהן", currency: "ILS", subtotalAmount: "0", vatAmount: "0",
      totalAmount: total, documentNumber: 700000 + invNo, documentNumberFormatted: String(700000 + invNo),
      issuedAt: new Date(Date.now() - issuedDaysAgo * DAY),
    },
  });
}
async function request(ctx: Ctx, amount: string, opts: { invoiceId?: number | null; customerId?: number | null; status?: string; expiresAt?: Date } = {}) {
  return prisma.paymentRequest.create({
    data: {
      businessId: ctx.businessId, customerId: opts.customerId === undefined ? ctx.customerId : opts.customerId,
      billingDocumentId: opts.invoiceId ?? null, provider: "CARDCOM", amount, currency: "ILS",
      status: (opts.status ?? "PENDING") as never, providerRequestId: `pr-${uniq()}`, paymentUrl: "https://pay.example/x",
      expiresAt: opts.expiresAt,
    },
  });
}
async function verified(ctx: Ctx, requestId: number, amount: string, settle = true, withSettlement = true) {
  const t = await runWithTenantContext({ businessId: ctx.businessId }, () =>
    store.createTransaction({
      paymentRequestId: requestId, provider: "CARDCOM", providerTransactionId: `ptx-${uniq()}`, amount, currency: "ILS",
      status: "PAID", rawPayload: {}, ...(withSettlement ? { openAccountingSettlement: { businessId: ctx.businessId } } : {}),
    })
  );
  if (settle && withSettlement) await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: t.id });
  return t;
}
const req = (url: string, token: string, init: RequestInit = {}) =>
  new NextRequest(`https://t.test${url}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
async function json(res: Response) { return { status: res.status, body: (await res.json()) as any }; }
const inbox = async (ctx: Ctx, qs = "") => json(await inboxRoute.GET(req(`/api/collection/inbox${qs}`, ctx.token)));

async function main() {
  console.log("\n== I1 — inbox segments from server state ==");
  const a = await makeBusiness("A");
  const due = await invoice(a, "1000.00");
  const open = await request(a, "1000.00", { invoiceId: due.id });
  const failed = await request(a, "200.00", { status: "FAILED" });
  const expired = await request(a, "300.00", { expiresAt: new Date(Date.now() - DAY) });
  const anon = await request(a, "150.00", { customerId: null });
  await verified(a, anon.id, "150.00"); // → REQUIRES_ATTENTION NO_CUSTOMER
  const paidInv = await invoice(a, "500.00");
  const paidReq = await request(a, "500.00", { invoiceId: paidInv.id });
  const paidTx = await verified(a, paidReq.id, "500.00");
  const histReq = await request(a, "80.00");
  await verified(a, histReq.id, "80.00", false, false); // historical: no settlement
  const i1 = await inbox(a);
  ok("I1 — 200", i1.status === 200, JSON.stringify(i1.body).slice(0, 200));
  const b = i1.body;
  ok("I1 — צריך לגבות: the due customer, with the open request noted", b.toCollect.length === 1 && b.toCollect[0].customerId === a.customerId && b.toCollect[0].openRequestCount >= 1, JSON.stringify(b.toCollect));
  ok("I1 — ממתין: the open request", b.waiting.some((w: any) => w.requestId === open.id && w.state === "WAITING"));
  ok("I1 — expired-by-own-expiry is not ממתין", !b.waiting.some((w: any) => w.requestId === expired.id));
  const kinds = b.attention.map((x: any) => `${x.kind}:${x.request.requestId}`);
  ok("I1 — דורש טיפול: failed", kinds.includes(`PAYMENT_FAILED:${failed.id}`), kinds.join(","));
  ok("I1 — דורש טיפול: link expired", kinds.includes(`LINK_EXPIRED:${expired.id}`), kinds.join(","));
  ok("I1 — דורש טיפול: receipt paused (NO_CUSTOMER)", b.attention.some((x: any) => x.kind === "RECEIPT_ATTENTION" && x.reason === "NO_CUSTOMER"), kinds.join(","));
  const p = b.paid.find((x: any) => x.paymentTransactionId === paidTx.id);
  ok("I1 — שולם: receipted with its receipt number and allocation", p?.accounting === "RECEIPTED" && !!p?.receiptNumber && p?.allocatedAmount === "500.00", JSON.stringify(p));
  ok("I1 — שולם: historical payment says no automatic receipt", b.paid.some((x: any) => x.requestId === histReq.id && x.accounting === "NO_AUTOMATIC_RECEIPT"));
  ok("I1 — no provider name leaks into the inbox", !JSON.stringify(b).includes("CARDCOM"));
  ok("I1 — business name for messages", typeof b.businessName === "string" && b.businessName.length > 0);

  console.log("\n== I2 — cancelled, then paid anyway ==");
  const c = await makeBusiness("C");
  const cr = await request(c, "400.00");
  const cancel = await json(await cancelRoute.POST(req(`/api/payments/requests/${cr.id}/cancel`, c.token, { method: "POST" }), { params: Promise.resolve({ id: String(cr.id) }) }));
  ok("I2 — cancel 200 → CANCELLED", cancel.status === 200 && cancel.body.status === "CANCELLED", JSON.stringify(cancel));
  const ctx2 = await verified(c, cr.id, "400.00");
  const i2 = (await inbox(c)).body;
  ok("I2 — the money is שולם", i2.paid.some((x: any) => x.paymentTransactionId === ctx2.id));
  ok("I2 — and not ממתין (shown once)", !i2.waiting.some((x: any) => x.requestId === cr.id));
  const audit = await prisma.paymentAuditEvent.findFirst({ where: { paymentRequestId: cr.id, eventType: "PAYMENT_REQUEST_CANCELLED" } });
  ok("I2 — cancellation audited as the owner's act", audit?.source === "USER" && audit?.actorUserId === c.userId);

  console.log("\n== I3 — bounded paid history ==");
  const h = await makeBusiness("H");
  for (let i = 0; i < 25; i++) {
    const r = await request(h, "10.00");
    await verified(h, r.id, "10.00", false, false);
  }
  const p1 = (await inbox(h)).body;
  ok("I3 — first page 20 + a cursor", p1.paid.length === 20 && !!p1.paidNextBefore, `${p1.paid.length} ${p1.paidNextBefore}`);
  const p2 = (await inbox(h, `?paidBefore=${encodeURIComponent(p1.paidNextBefore)}`)).body;
  ok("I3 — next page the remaining 5, no cursor", p2.paid.length === 5 && p2.paidNextBefore === null, `${p2.paid.length}`);
  const ids = new Set([...p1.paid, ...p2.paid].map((x: any) => x.paymentTransactionId));
  ok("I3 — 25 distinct payments across pages", ids.size === 25);

  console.log("\n== I4 — excess stays in attention until refunded ==");
  const e = await makeBusiness("E");
  const einv = await invoice(e, "600.00");
  const er = await request(e, "1000.00", { invoiceId: einv.id });
  const et = await verified(e, er.id, "1000.00");
  const before = (await inbox(e)).body.attention.find((x: any) => x.kind === "UNAPPLIED_EXCESS");
  ok("I4 — excess 400 shown", before?.unappliedAmount === "400.00" && before?.paymentTransactionId === et.id, JSON.stringify(before));
  await prisma.paymentTransaction.create({ data: { paymentRequestId: er.id, provider: "CARDCOM", providerTransactionId: `rf-${uniq()}`, amount: "-400.00", currency: "ILS", status: "PAID" } });
  const after = (await inbox(e)).body.attention.find((x: any) => x.kind === "UNAPPLIED_EXCESS");
  ok("I4 — refunded excess leaves attention", after === undefined);

  console.log("\n== T1 — customer thread ==");
  const t = await makeBusiness("T");
  const tinv = await invoice(t, "1000.00", 10);
  await prisma.billingDocument.create({ data: { businessId: t.businessId, documentType: "CREDIT_NOTE", status: "ISSUED", referenceDocumentId: tinv.id, customerId: t.customerId, customerNameSnapshot: "יוסי כהן", totalAmount: "100.00", documentNumber: 1, documentNumberFormatted: "1", issuedAt: new Date(Date.now() - 5 * DAY) } });
  const tr = await request(t, "400.00", { invoiceId: tinv.id });
  await verified(t, tr.id, "400.00");
  const th = await json(await threadRoute.GET(req(`/api/collection/customers/${t.customerId}`, t.token), { params: Promise.resolve({ customerId: String(t.customerId) }) }));
  ok("T1 — 200", th.status === 200);
  const kindsT = th.body.events.map((x: any) => x.kind);
  for (const k of ["INVOICE_ISSUED", "CREDIT_NOTE_ISSUED", "REQUEST_CREATED", "PAYMENT_VERIFIED", "RECEIPT_ISSUED"]) ok(`T1 — has ${k}`, kindsT.includes(k), kindsT.join(","));
  ok("T1 — newest first", th.body.events.every((x: any, i: number, arr: any[]) => i === 0 || arr[i - 1].at >= x.at));
  ok("T1 — outstanding = 1000 − 400 paid − 100 credited = 500", th.body.totals.outstanding === "500.00", th.body.totals.outstanding);
  ok("T1 — receipt shows its allocation", th.body.events.some((x: any) => x.kind === "RECEIPT_ISSUED" && x.allocations[0]?.amount === "400.00" && x.automatic));
  const cth = await json(await threadRoute.GET(req(`/api/collection/customers/${c.customerId}`, c.token), { params: Promise.resolve({ customerId: String(c.customerId) }) }));
  const crEvent = cth.body.events.find((x: any) => x.kind === "REQUEST_CREATED" && x.requestId === cr.id);
  ok("T1 — a cancelled-then-paid request reads PAID in the thread, with nothing to share or cancel", crEvent?.status === "PAID" && crEvent?.paymentUrl === null, JSON.stringify(crEvent));

  console.log("\n== X1 — cancel rules ==");
  const x = await makeBusiness("X");
  const xpaid = await request(x, "50.00");
  await verified(x, xpaid.id, "50.00", false, false);
  const xc = await json(await cancelRoute.POST(req(`/api/payments/requests/${xpaid.id}/cancel`, x.token, { method: "POST" }), { params: Promise.resolve({ id: String(xpaid.id) }) }));
  ok("X1 — a request carrying verified money cannot be cancelled", xc.status === 400, JSON.stringify(xc));
  const xf = await json(await cancelRoute.POST(req(`/api/payments/requests/${failed.id}/cancel`, x.token, { method: "POST" }), { params: Promise.resolve({ id: String(failed.id) }) }));
  ok("X1 — another tenant's request is not found", xf.status === 404, JSON.stringify(xf));
  const xnf = await json(await cancelRoute.POST(req(`/api/payments/requests/${failed.id}/cancel`, a.token, { method: "POST" }), { params: Promise.resolve({ id: String(failed.id) }) }));
  ok("X1 — a non-open request cannot be cancelled", xnf.status === 400, JSON.stringify(xnf));

  console.log("\n== X2 — resolve NO_CUSTOMER ==");
  const anonTx = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentRequestId: anon.id, amount: { gt: 0 } } });
  const foreign = await json(await retryRoute.POST(req(`/api/collection/settlements/${anonTx.id}/retry`, a.token, { method: "POST", body: JSON.stringify({ customerId: x.customerId }) }), { params: Promise.resolve({ paymentTransactionId: String(anonTx.id) }) }));
  ok("X2 — naming another tenant's customer is refused", foreign.status === 404, JSON.stringify(foreign));
  const byOther = await json(await retryRoute.POST(req(`/api/collection/settlements/${anonTx.id}/retry`, x.token, { method: "POST", body: "{}" }), { params: Promise.resolve({ paymentTransactionId: String(anonTx.id) }) }));
  ok("X2 — another tenant cannot retry it", byOther.status === 404, JSON.stringify(byOther));
  const fixed = await json(await retryRoute.POST(req(`/api/collection/settlements/${anonTx.id}/retry`, a.token, { method: "POST", body: JSON.stringify({ customerId: a.customerId }) }), { params: Promise.resolve({ paymentTransactionId: String(anonTx.id) }) }));
  ok("X2 — named → SETTLED", fixed.status === 200 && fixed.body.outcome === "SETTLED", JSON.stringify(fixed));
  const receipts = await prisma.billingDocument.count({ where: { sourcePaymentTransactionId: anonTx.id } });
  ok("X2 — exactly one receipt", receipts === 1);
  const again = await json(await retryRoute.POST(req(`/api/collection/settlements/${anonTx.id}/retry`, a.token, { method: "POST", body: JSON.stringify({ customerId: a.customerId }) }), { params: Promise.resolve({ paymentTransactionId: String(anonTx.id) }) }));
  ok("X2 — renaming a known payer is refused", again.status === 400, JSON.stringify(again));
  ok("X2 — still one receipt", (await prisma.billingDocument.count({ where: { sourcePaymentTransactionId: anonTx.id } })) === 1);
  const named = await prisma.paymentAuditEvent.findFirst({ where: { paymentRequestId: anon.id, eventType: "PAYMENT_ACCOUNTING_CUSTOMER_NAMED" } });
  ok("X2 — naming audited as the owner's act", named?.source === "USER" && named?.actorUserId === a.userId);

  console.log("\n== R1 — readiness ==");
  const r0 = await makeBusiness("R0", { connections: 0 });
  const r2 = await makeBusiness("R2", { connections: 2 });
  const rI = await makeBusiness("RI", { identity: false });
  const rd = async (ctx: Ctx) => (await json(await readinessRoute.GET(req("/api/collection/readiness", ctx.token)))).body;
  ok("R1 — no provider", JSON.stringify((await rd(r0)).blockers) === JSON.stringify(["NO_PAYMENT_PROVIDER"]));
  ok("R1 — ambiguous provider", (await rd(r2)).blockers.includes("PAYMENT_PROVIDER_AMBIGUOUS"));
  ok("R1 — identity incomplete", (await rd(rI)).blockers.includes("BILLING_IDENTITY_INCOMPLETE"));
  const ready = await rd(a);
  ok("R1 — ready", ready.ready === true && ready.blockers.length === 0, JSON.stringify(ready));

  console.log("\n== V1 — invoice collection state ==");
  const v = await json(await invoiceRoute.GET(req(`/api/collection/invoices/${tinv.id}`, t.token), { params: Promise.resolve({ id: String(tinv.id) }) }));
  ok("V1 — שולם 400 · זוכה 100 · נותר 500", v.body.paid === "400.00" && v.body.credited === "100.00" && v.body.remaining === "500.00", JSON.stringify(v.body));
  ok("V1 — latest request shown", v.body.latestRequest?.id === tr.id);

  console.log("\n== K1 — tenant isolation on every new route ==");
  const kThread = await json(await threadRoute.GET(req(`/api/collection/customers/${t.customerId}`, a.token), { params: Promise.resolve({ customerId: String(t.customerId) }) }));
  ok("K1 — thread of another tenant's customer → 404", kThread.status === 404, String(kThread.status));
  const kInv = await json(await invoiceRoute.GET(req(`/api/collection/invoices/${tinv.id}`, a.token), { params: Promise.resolve({ id: String(tinv.id) }) }));
  ok("K1 — another tenant's invoice → 404", kInv.status === 404, String(kInv.status));
  const kInbox = (await inbox(x)).body;
  ok("K1 — inbox shows only own data", !JSON.stringify(kInbox).includes(String(open.id) + ",") && kInbox.waiting.every((w: any) => w.requestId !== open.id) && kInbox.paid.every((p: any) => p.requestId !== paidReq.id));
  const noAuth = await inboxRoute.GET(new NextRequest("https://t.test/api/collection/inbox"));
  ok("K1 — no token → 401", noAuth.status === 401, String(noAuth.status));

  console.log(`\nCollection battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error("BATTERY ERROR", e); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
