/* eslint-disable @typescript-eslint/no-explicit-any -- E2E harness: loose JSON */
/**
 * Collection — FULL-STACK end-to-end on a real app server and a real database.
 *
 * Real: the built Next.js server (next start), its pages, its API routes, the
 * owner's bearer token, PostgreSQL, the payment store, the webhook
 * orchestration, the settlement engine, receipt issuance, the recovery
 * endpoint over HTTP, and the owner's clicks in a real browser at phone and
 * desktop widths. Simulated: ONLY the provider — a synthetic adapter inside the
 * real webhook service, because a live checkout needs provider credentials.
 *
 * The owner journey:
 *   E1 full        debt 1000 → request 1000 → verified 1000 → receipt 1000 → allocated 1000 → remaining 0
 *   E2 partial     debt 1000 → request 400  → receipt 400, allocated 400, remaining 600 (invoice screen: שולם 400 · נותר 600)
 *   E3 overpay     remaining 600 → verified 1000 → receipt 1000, allocated 600, unapplied 400 → דורש טיפול: עודף
 *   E4 ad-hoc      customer payment 400, no invoice → receipt 400, zero allocations
 *   E5 duplicate   the same verified settlement redelivered → still one receipt
 *   E6 concurrent  four settle calls at once → one receipt
 *   E7 crash       verified + durable PENDING, process "died" → recovery ENDPOINT (HTTP, CRON_SECRET) → one receipt
 *   E8 failed      provider refused → no receipt; UI: נכשל under דורש טיפול
 *   E9 unknown     provider pending → no receipt; request stays ממתין (never PAID/FAILED by guess)
 *   E10 no customer verified, payer unknown → דורש טיפול → the owner picks the customer in the UI → one receipt
 *   E11 cancel     the owner cancels a waiting request in the UI → CANCELLED
 *   E12 tenancy    another business's owner sees none of it
 *
 * Run: build, `next start -p 3517` with DATABASE_URL/AUTH_TOKEN_SECRET/CRON_SECRET, then
 *      `npx tsx .collection/e2e-fullstack.mts`.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Page } from "playwright";
import { signAuthToken } from "../lib/auth-token";
import { runWithTenantContext } from "../lib/tenant/context";
import { processPaymentWebhook } from "../lib/services/payments/payment-webhook.service";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import { settleVerifiedPayment } from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import { createReceiptDraft } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";

const BASE = process.env.QA_BASE ?? "http://localhost:3517";
const SHOTS = process.env.E2E_SHOTS ?? "";
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

async function business(label: string) {
  const b = await prisma.business.create({ data: { name: `e2e-${label}-${uniq()}` } });
  const u = await prisma.user.create({ data: { email: `e2e-${uniq()}@example.test`, password: "x", businessId: b.id, role: "USER" } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: "עסק לדוגמה בע\"מ", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "רחוב הדוגמה 1", billingPhone: "0500000000", billingEmail: "e2e@example.test" } });
  await prisma.businessPaymentConnection.create({ data: { businessId: b.id, provider: "CARDCOM", isActive: true, merchantId: "m" } });
  const yossi = await prisma.customer.create({ data: { businessId: b.id, name: "יוסי כהן", phone: "0501234567" } });
  const dana = await prisma.customer.create({ data: { businessId: b.id, name: "דנה לוי", phone: "0527654321" } });
  return { id: b.id, userId: u.id, token: signAuthToken(u.id), yossi: yossi.id, dana: dana.id };
}
type Biz = Awaited<ReturnType<typeof business>>;
let invNo = 0;
async function invoice(b: Biz, customerId: number, total: string) {
  invNo++;
  return prisma.billingDocument.create({
    data: {
      businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId,
      customerNameSnapshot: customerId === b.yossi ? "יוסי כהן" : "דנה לוי", currency: "ILS", subtotalAmount: "0", vatAmount: "0",
      totalAmount: total, documentNumber: 900000 + invNo, documentNumberFormatted: String(900000 + invNo), issuedAt: new Date(Date.now() - 60 * DAY),
    },
  });
}
/** A request as the provider leaves it after creating its checkout link. */
async function paymentRequest(b: Biz, amount: string, customerId: number | null, invoiceId: number | null) {
  const providerRequestId = `pr-${uniq()}`;
  const r = await prisma.paymentRequest.create({
    data: { businessId: b.id, customerId, billingDocumentId: invoiceId, provider: "CARDCOM", amount, currency: "ILS", status: "PENDING", providerRequestId, paymentUrl: `https://pay.example.test/${providerRequestId}` },
  });
  await prisma.paymentProviderRouting.create({ data: { provider: "CARDCOM", providerRequestId, paymentRequestId: r.id, businessId: b.id } });
  return r;
}
function adapter(outcome: "PAID" | "FAILED" | "PENDING", providerRequestId: string, providerTransactionId: string) {
  return {
    provider: "CARDCOM", supportedCurrencies: null,
    async verifyWebhook() { return { ok: true }; },
    parseWebhook() { return { providerEventId: `evt-${uniq()}`, eventType: "e2e", providerRequestId, providerTransactionId, outcome, amount: null, currency: null, correlationValue: null }; },
    async getPaymentStatus() { return { outcome, providerTransactionId }; },
  } as never;
}
async function providerCallback(r: { providerRequestId: string | null }, outcome: "PAID" | "FAILED" | "PENDING", ptx = `ptx-${uniq()}`) {
  return processPaymentWebhook(
    { provider: "CARDCOM", rawBody: "{}", parsedBody: {} },
    { store, resolveProvider: () => adapter(outcome, r.providerRequestId!, ptx), decryptConnectionCredential: () => null, settleAccounting: async (e) => { await settleVerifiedPayment(e); } }
  );
}
const txOf = (requestId: number) => prisma.paymentTransaction.findFirstOrThrow({ where: { paymentRequestId: requestId, amount: { gt: 0 } } });
const receiptsOf = (ptxId: number) => prisma.billingDocument.findMany({ where: { sourcePaymentTransactionId: ptxId }, include: { paymentAllocationsAsReceipt: true } });
async function api(token: string, path: string) {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function main() {
  const b = await business("owner");
  const other = await business("other");

  console.log("\n== Setup: debts ==");
  const inv1 = await invoice(b, b.yossi, "1000.00");
  const inv2 = await invoice(b, b.yossi, "1000.00");
  const inv3 = await invoice(b, b.dana, "1000.00");
  const manual = await createReceiptDraft({ businessId: b.id, documentType: BillingDocumentType.RECEIPT, actorUserId: b.userId, customerId: b.dana, currency: "ILS", paymentLines: [{ method: "CASH", amount: "400.00", paymentDate: new Date().toISOString() }] });
  await setReceiptAllocations({ businessId: b.id, receiptDocumentId: manual.id, allocations: [{ invoiceDocumentId: inv3.id, allocatedAmount: "400.00" }] });
  await issueBillingDocument({ businessId: b.id, billingDocumentId: manual.id, actorUserId: b.userId });

  console.log("\n== E1 full ==");
  const r1 = await paymentRequest(b, "1000.00", b.yossi, inv1.id);
  const ptx1 = `ptx-e1-${uniq()}`;
  await providerCallback(r1, "PAID", ptx1);
  const t1 = await txOf(r1.id);
  const rc1 = await receiptsOf(t1.id);
  ok("E1 — one receipt 1000, allocated 1000, unapplied 0", rc1.length === 1 && rc1[0].totalAmount.toFixed(2) === "1000.00" && rc1[0].paymentAllocationsAsReceipt[0]?.allocatedAmount.toFixed(2) === "1000.00" && rc1[0].unappliedAmount.toFixed(2) === "0.00");
  const v1 = await api(b.token, `/api/collection/invoices/${inv1.id}`);
  ok("E1 — invoice remaining 0 (over HTTP)", v1.body?.remaining === "0.00", JSON.stringify(v1.body));

  console.log("\n== E2 partial ==");
  const r2 = await paymentRequest(b, "400.00", b.yossi, inv2.id);
  await providerCallback(r2, "PAID");
  const v2 = await api(b.token, `/api/collection/invoices/${inv2.id}`);
  ok("E2 — שולם 400 · נותר 600 (over HTTP)", v2.body?.paid === "400.00" && v2.body?.remaining === "600.00", JSON.stringify(v2.body));

  console.log("\n== E3 overpayment ==");
  const r3 = await paymentRequest(b, "1000.00", b.dana, inv3.id);
  await providerCallback(r3, "PAID");
  const rc3 = await receiptsOf((await txOf(r3.id)).id);
  ok("E3 — receipt 1000, allocated 600, unapplied 400", rc3.length === 1 && rc3[0].paymentAllocationsAsReceipt[0]?.allocatedAmount.toFixed(2) === "600.00" && rc3[0].unappliedAmount.toFixed(2) === "400.00");
  ok("E3 — invoice remaining 0", (await api(b.token, `/api/collection/invoices/${inv3.id}`)).body?.remaining === "0.00");

  console.log("\n== E4 ad-hoc ==");
  const r4 = await paymentRequest(b, "400.00", b.dana, null);
  await providerCallback(r4, "PAID");
  const rc4 = await receiptsOf((await txOf(r4.id)).id);
  ok("E4 — receipt 400, zero allocations", rc4.length === 1 && rc4[0].paymentAllocationsAsReceipt.length === 0 && rc4[0].unappliedAmount.toFixed(2) === "0.00");

  console.log("\n== E5 duplicate delivery ==");
  const dup = await providerCallback(r1, "PAID", ptx1);
  ok("E5 — redelivery is a duplicate; still one receipt", dup.duplicate === true && (await receiptsOf(t1.id)).length === 1);

  console.log("\n== E6 concurrent ==");
  const r6 = await paymentRequest(b, "250.00", b.yossi, null);
  const t6 = await runWithTenantContext({ businessId: b.id }, () => store.createTransaction({ paymentRequestId: r6.id, provider: "CARDCOM", providerTransactionId: `ptx-${uniq()}`, amount: "250.00", currency: "ILS", status: "PAID", rawPayload: {}, openAccountingSettlement: { businessId: b.id } }));
  await Promise.all([0, 1, 2, 3].map(() => settleVerifiedPayment({ businessId: b.id, paymentTransactionId: t6.id })));
  ok("E6 — four concurrent settlements → one receipt", (await receiptsOf(t6.id)).length === 1);

  console.log("\n== E7 crash → recovery endpoint over HTTP ==");
  const r7 = await paymentRequest(b, "300.00", b.yossi, null);
  const t7 = await runWithTenantContext({ businessId: b.id }, () => store.createTransaction({ paymentRequestId: r7.id, provider: "CARDCOM", providerTransactionId: `ptx-${uniq()}`, amount: "300.00", currency: "ILS", status: "PAID", rawPayload: {}, openAccountingSettlement: { businessId: b.id } }));
  ok("E7 — after the crash: PENDING, no receipt", (await prisma.paymentAccountingSettlement.findUnique({ where: { paymentTransactionId: t7.id } }))?.status === "PENDING" && (await receiptsOf(t7.id)).length === 0);
  const bad = await fetch(`${BASE}/api/payments/settlement-recovery`, { method: "POST", headers: { authorization: "Bearer wrong" } });
  ok("E7 — recovery refuses a wrong secret", bad.status === 401);
  const rec = await fetch(`${BASE}/api/payments/settlement-recovery`, { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const recBody = await rec.json();
  ok("E7 — recovery endpoint 200", rec.status === 200 && recBody.ok === true, JSON.stringify(recBody));
  ok("E7 — recovered to exactly one receipt, no provider involved", (await receiptsOf(t7.id)).length === 1);

  console.log("\n== E8 failed / E9 unknown ==");
  const r8 = await paymentRequest(b, "200.00", b.dana, null);
  await providerCallback(r8, "FAILED");
  ok("E8 — FAILED, no money row, no receipt", (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r8.id } })).status === "FAILED" && (await prisma.paymentTransaction.count({ where: { paymentRequestId: r8.id, status: "PAID" } })) === 0);
  const r9 = await paymentRequest(b, "150.00", b.dana, null);
  await providerCallback(r9, "PENDING");
  ok("E9 — unknown stays PENDING, no money row", (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r9.id } })).status === "PENDING" && (await prisma.paymentTransaction.count({ where: { paymentRequestId: r9.id } })) === 0);

  console.log("\n== E10 payer unknown → owner resolves in the UI ==");
  const r10 = await paymentRequest(b, "175.00", null, null);
  await providerCallback(r10, "PAID");
  const t10 = await txOf(r10.id);
  ok("E10 — paused: REQUIRES_ATTENTION NO_CUSTOMER, no receipt", (await prisma.paymentAccountingSettlement.findUnique({ where: { paymentTransactionId: t10.id } }))?.attentionReason === "NO_CUSTOMER" && (await receiptsOf(t10.id)).length === 0);

  const browser = await chromium.launch();
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ locale: "he-IL", viewport: { width, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("token", t), b.token);
    await ctx.route("https://pay.example.test/**", (r) => r.fulfill({ status: 200, body: "CHECKOUT" }));
    const page: Page = await ctx.newPage();

    await page.goto(`${BASE}/collection`, { waitUntil: "networkidle" });
    ok(`UI @${width} — opens on דורש טיפול (real data)`, (await page.getByRole("tab", { selected: true }).innerText()).includes("דורש טיפול"));
    const attentionText = await page.locator("[role=tabpanel]").innerText();
    ok(`UI @${width} — attention shows the refused payment`, attentionText.includes("נכשל"));
    ok(`UI @${width} — attention shows the excess 400`, attentionText.includes("עודף") && attentionText.includes("400"));
    ok(`UI @${width} — attention shows the unknown payer`, attentionText.includes("לא ידוע מי שילם"));
    await page.getByRole("tab", { name: /שולם/ }).click();
    const paidText = await page.locator("[role=tabpanel]").innerText();
    ok(`UI @${width} — שולם lists receipts`, paidText.includes("הופקה") && paidText.includes("יוסי כהן") && paidText.includes("דנה לוי"));
    await page.getByRole("tab", { name: /ממתין/ }).click();
    ok(`UI @${width} — ממתין shows the unknown-outcome request`, (await page.locator("[role=tabpanel]").innerText()).includes("150"));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-waiting-${width}.png`, fullPage: true });

    await page.goto(`${BASE}/collection/c/${b.yossi}`, { waitUntil: "networkidle" });
    const thread = await page.locator("ol").innerText();
    ok(`UI @${width} — thread: receipts with allocations`, thread.includes("שויכו") && thread.includes("קבלה"));
    ok(`UI @${width} — thread: a paid request is never offered for cancel/share`, (await page.getByRole("button", { name: "בטל בקשה" }).count()) === 0);
    ok(`UI @${width} — thread: remaining 600 on the partially paid invoice`, (await page.locator("header").innerText()).includes("600"));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-thread-${width}.png`, fullPage: true });

    await page.goto(`${BASE}/billing/${inv2.id}`, { waitUntil: "networkidle" });
    const invText = (await page.locator("section", { hasText: "נותר" }).last().innerText()).replace(/[‎‏]/g, "");
    ok(`UI @${width} — invoice screen: שולם 400 · נותר 600 · גבה 600`, /שולם\s*400/.test(invText) && /נותר\s*600/.test(invText) && /גבה\s*600/.test(invText), JSON.stringify(invText));
    await ctx.close();
  }

  // The owner resolves the unknown payer and cancels a waiting request — real clicks, real API, real DB.
  {
    const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 390, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("token", t), b.token);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/collection`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "בחר לקוח" }).click();
    await page.getByRole("option", { name: "יוסי כהן" }).click();
    await page.getByText("הקבלה הופקה והתשלום שויך.").waitFor({ timeout: 15000 }).catch(() => {});
    ok("E10 — resolved in the UI → exactly one receipt", (await receiptsOf(t10.id)).length === 1);
    ok("E10 — payer recorded on the request", (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r10.id } })).customerId === b.yossi);

    console.log("\n== E11 cancel in the UI ==");
    await page.getByRole("tab", { name: /ממתין/ }).click();
    await page.getByRole("button", { name: "בטל בקשה" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "בטל בקשה" }).click();
    await page.getByText(/הבקשה בוטלה/).waitFor({ timeout: 15000 }).catch(() => {});
    ok("E11 — the waiting request is CANCELLED in the database", (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r9.id } })).status === "CANCELLED");
    ok("E11 — cancellation audited as the owner", (await prisma.paymentAuditEvent.findFirst({ where: { paymentRequestId: r9.id, eventType: "PAYMENT_REQUEST_CANCELLED" } }))?.actorUserId === b.userId);
    await ctx.close();
  }

  console.log("\n== E12 tenancy ==");
  const otherInbox = await api(other.token, "/api/collection/inbox");
  const leak = JSON.stringify(otherInbox.body);
  ok("E12 — another owner's inbox has none of this business's collection", otherInbox.status === 200 && !leak.includes("יוסי כהן") && !leak.includes("דנה לוי") || (otherInbox.body.paid.length === 0 && otherInbox.body.attention.length === 0));
  ok("E12 — another owner cannot open this customer's thread", (await api(other.token, `/api/collection/customers/${b.yossi}`)).status === 404);
  ok("E12 — another owner cannot read this invoice", (await api(other.token, `/api/collection/invoices/${inv2.id}`)).status === 404);

  await browser.close();
  console.log(`\nCollection full-stack E2E: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error("E2E ERROR", e); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
