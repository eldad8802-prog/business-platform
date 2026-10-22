/* eslint-disable @typescript-eslint/no-explicit-any -- test battery: loose JSON response bodies */
/**
 * Multi-currency + isolation battery — the REAL route handlers and services on an ephemeral
 * PostgreSQL (CI service container only). The i18n flag is OFF here (route handlers run outside the
 * Next request scope), which is exactly today's Production behaviour.
 *
 *   M1  mixed currencies: a customer owing ILS + USD is two rows; the headline never adds them
 *   M2  partial payment in ILS reduces only the ILS balance
 *   M3  a USD payment for a USD invoice settles in USD; the ILS balance is untouched
 *   M4  a payment in the WRONG currency is never allocated to the invoice (no silent conversion)
 *   M5  "paid recently" headline is single-currency and flags the mix
 *   M6  customer thread: per-currency balances, ILS headline
 *   K1  isolation: business B (ILS only) sees none of A's rows, and its own output is unchanged
 *   F1  flag off: the locale endpoint does not exist and every request resolves Hebrew without
 *       reading a cookie
 *
 * Synthetic data only. No secrets, no Neon, no network, no provider.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runWithTenantContext } from "../lib/tenant/context";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import * as inboxRoute from "../app/api/collection/inbox/route";
import * as threadRoute from "../app/api/collection/customers/[customerId]/route";
import * as localeRoute from "../app/api/preferences/locale/route";
import { getRequestLocale } from "../lib/i18n/server";

if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("ABORT: this battery runs only against the local CI service container");
  process.exit(2);
}
if (process.env.DUBIZ_I18N_ENABLED === "true") {
  console.error("ABORT: the battery proves the flag-OFF behaviour; unset DUBIZ_I18N_ENABLED");
  process.exit(2);
}

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
const DAY = 86400_000;

type Ctx = { businessId: number; userId: number; token: string; customerId: number };

async function makeBusiness(label: string): Promise<Ctx> {
  const business = await prisma.business.create({ data: { name: `fx-${label}-${uniq()}` } });
  const user = await prisma.user.create({ data: { email: `fx-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" } });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id, billingLegalName: "FX Synthetic", billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "fx@example.test",
    },
  });
  await prisma.businessPaymentConnection.create({ data: { businessId: business.id, provider: "CARDCOM" as never, isActive: true, merchantId: "m", documentIssuer: "DUBIZ_ISSUES" } });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: `Customer ${label}`, phone: "0501234567" } });
  return { businessId: business.id, userId: user.id, token: signAuthToken(user.id), customerId: customer.id };
}
let invNo = 0;
async function invoice(ctx: Ctx, total: string, currency: string) {
  invNo++;
  return prisma.billingDocument.create({
    data: {
      businessId: ctx.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId, customerNameSnapshot: "Customer", currency, subtotalAmount: "0", vatAmount: "0",
      totalAmount: total, documentNumber: 800000 + invNo, documentNumberFormatted: String(800000 + invNo),
      issuedAt: new Date(Date.now() - 400 * DAY),
    },
  });
}
async function request(ctx: Ctx, amount: string, currency: string, invoiceId: number | null) {
  return prisma.paymentRequest.create({
    data: {
      businessId: ctx.businessId, customerId: ctx.customerId, billingDocumentId: invoiceId, provider: "CARDCOM",
      amount, currency, status: "PENDING" as never, providerRequestId: `pr-${uniq()}`, paymentUrl: "https://pay.example/x",
    },
  });
}
/** A verified provider payment; returns the settlement outcome (or the error it raised). */
async function paid(ctx: Ctx, requestId: number, amount: string, currency: string) {
  const t = await runWithTenantContext({ businessId: ctx.businessId }, () =>
    store.createTransaction({
      paymentRequestId: requestId, provider: "CARDCOM", providerTransactionId: `ptx-${uniq()}`, amount, currency,
      status: "PAID", rawPayload: {}, openAccountingSettlement: { businessId: ctx.businessId },
    })
  );
  try {
    const r = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: t.id });
    return { tx: t, settled: r as any, error: null as string | null };
  } catch (e) {
    return { tx: t, settled: null, error: e instanceof Error ? e.message : String(e) };
  }
}
const req = (url: string, token: string) => new NextRequest(`https://t.test${url}`, { headers: { authorization: `Bearer ${token}` } });
async function json(res: Response) { return { status: res.status, body: (await res.json()) as any }; }
const inbox = async (ctx: Ctx) => json(await inboxRoute.GET(req(`/api/collection/inbox`, ctx.token)));
const thread = async (ctx: Ctx) =>
  json(await threadRoute.GET(req(`/api/collection/customers/${ctx.customerId}`, ctx.token), { params: Promise.resolve({ customerId: String(ctx.customerId) }) }));
const toCollectOf = (b: any) => b.toCollect.map((c: any) => `${c.currency}:${c.totalOutstanding}`).sort().join(",");

async function main() {
  console.log("\n== F1 — flag off ==");
  const loc = await localeRoute.POST(new Request("https://t.test/api/preferences/locale", { method: "POST", body: JSON.stringify({ locale: "en" }) }));
  ok("F1 — locale endpoint is 404 while the flag is off", loc.status === 404);
  ok("F1 — request locale is Hebrew without touching cookies()", (await getRequestLocale()) === "he");

  console.log("\n== M1 — ILS + USD owed by one customer ==");
  const a = await makeBusiness("A");
  const ilsInv = await invoice(a, "1000.00", "ILS");
  const usdInv = await invoice(a, "300.00", "USD");
  const m1 = (await inbox(a)).body;
  ok("M1 — one row per currency, never one mixed row", toCollectOf(m1) === "ILS:1000.00,USD:300.00", toCollectOf(m1));
  ok("M1 — headline is ILS 1000, not 1300", m1.summary.toCollect.amount === "1000.00" && m1.summary.toCollect.currency === "ILS", JSON.stringify(m1.summary.toCollect));
  ok("M1 — headline flags the mix", m1.summary.toCollect.isMixedCurrency === true);
  ok("M1 — the customer is counted once", m1.summary.toCollect.count === 1, String(m1.summary.toCollect.count));
  const ilsBefore = await prisma.billingDocument.findUnique({ where: { id: ilsInv.id } });
  ok("M1 — reading never changes stored amounts/currency", ilsBefore?.totalAmount.toFixed(2) === "1000.00" && ilsBefore?.currency === "ILS");

  console.log("\n== M2 — partial ILS payment ==");
  const r2 = await request(a, "400.00", "ILS", ilsInv.id);
  const p2 = await paid(a, r2.id, "400.00", "ILS");
  ok("M2 — settled", p2.error === null, String(p2.error));
  const m2 = (await inbox(a)).body;
  ok("M2 — ILS balance 600, USD untouched 300", toCollectOf(m2) === "ILS:600.00,USD:300.00", toCollectOf(m2));

  console.log("\n== M3 — USD payment for the USD invoice ==");
  const r3 = await request(a, "300.00", "USD", usdInv.id);
  const p3 = await paid(a, r3.id, "300.00", "USD");
  ok("M3 — settled in USD", p3.error === null, String(p3.error));
  const alloc = await prisma.billingPaymentAllocation.findMany({ where: { invoiceDocumentId: usdInv.id } });
  ok("M3 — allocation recorded in USD for 300.00", alloc.length === 1 && alloc[0].currency === "USD" && alloc[0].allocatedAmount.toFixed(2) === "300.00", JSON.stringify(alloc));
  const m3 = (await inbox(a)).body;
  ok("M3 — only the ILS balance remains", toCollectOf(m3) === "ILS:600.00", toCollectOf(m3));

  console.log("\n== M4 — wrong-currency payment is never allocated ==");
  const usd2 = await invoice(a, "100.00", "USD");
  const r4 = await request(a, "100.00", "ILS", usd2.id); // the request currency does not match the invoice
  const p4 = await paid(a, r4.id, "100.00", "ILS");
  const alloc4 = await prisma.billingPaymentAllocation.findMany({ where: { invoiceDocumentId: usd2.id } });
  ok("M4 — nothing allocated to the USD invoice from an ILS payment", alloc4.length === 0, JSON.stringify({ alloc4, err: p4.error, settled: p4.settled }));
  const m4 = (await inbox(a)).body;
  ok("M4 — USD 100 still owed", toCollectOf(m4).includes("USD:100.00"), toCollectOf(m4));

  console.log("\n== M5 — paid recently headline ==");
  const m5 = m4.summary.paidRecent;
  ok("M5 — headline currency is ILS", m5.currency === "ILS", JSON.stringify(m5));
  ok("M5 — ILS-only sum (400 + 100 ILS payments), USD 300 not added", m5.amount === "500.00", JSON.stringify(m5));
  ok("M5 — the mix is flagged", m5.isMixedCurrency === true, JSON.stringify(m5));

  console.log("\n== M6 — customer thread ==");
  const th = await thread(a);
  ok("M6 — 200", th.status === 200, JSON.stringify(th.body).slice(0, 200));
  const totals = th.body.totals;
  ok("M6 — ILS headline 600", totals.currency === "ILS" && totals.outstanding === "600.00", JSON.stringify(totals));
  ok("M6 — per-currency balances", JSON.stringify(totals.outstandingByCurrency) === JSON.stringify([{ currency: "ILS", outstanding: "600.00" }, { currency: "USD", outstanding: "100.00" }]), JSON.stringify(totals.outstandingByCurrency));
  ok("M6 — flagged mixed", totals.isMixedCurrency === true);

  console.log("\n== K1 — isolation + ILS-only business unchanged ==");
  const b = await makeBusiness("B");
  await invoice(b, "500.00", "ILS");
  const kb = (await inbox(b)).body;
  ok("K1 — B sees only its own debt", toCollectOf(kb) === "ILS:500.00", toCollectOf(kb));
  ok("K1 — B's headline is exactly as before (single currency, not flagged)", kb.summary.toCollect.amount === "500.00" && kb.summary.toCollect.currency === "ILS" && kb.summary.toCollect.isMixedCurrency === false, JSON.stringify(kb.summary.toCollect));
  ok("K1 — nothing of A leaks into B", !JSON.stringify(kb).includes(`"customerId":${a.customerId}`) && !JSON.stringify(kb).includes("Customer A"));
  const cross = await json(await threadRoute.GET(req(`/api/collection/customers/${a.customerId}`, b.token), { params: Promise.resolve({ customerId: String(a.customerId) }) }));
  ok("K1 — B cannot open A's customer thread", cross.status === 404 || cross.status === 403, `${cross.status} ${JSON.stringify(cross.body).slice(0, 120)}`);
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nmulti-currency battery: ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
