/**
 * Collection product runtime QA — real pages, real components, measured boxes.
 *
 * Same method as the payables harnesses: data is injected at the NETWORK layer,
 * so the real pages, the real React tree and the real CSS render it. No
 * database and no provider is touched; the server read models and actions are
 * proven separately against real PostgreSQL (.collection/battery.mts).
 *
 * What this proves, at seven widths (320 → 1920), RTL:
 *   - /collection: four segments, stage-aware default (attention first when present)
 *   - nothing overflows the viewport or spills out of its box; tap targets ≥ 40px
 *   - no delivery claim (sent/delivered/read) and no provider name anywhere
 *   - /collection/new: missing setup is shown BEFORE any form; a ready business
 *     gets customer → invoice → amount (default = full remaining, bounded) →
 *     create → channels; the owner is NEVER navigated to the payment page;
 *     WhatsApp opens with the link in the message
 *   - /collection/c/[id]: the thread renders; refund explains it does not
 *     cancel the receipt or reopen the invoice
 *   - legacy /payments, /payments/new, /payments/[id] land in the new product
 *
 * Run: build, `npx next start -p 3517`, then `node scripts/qa/collection-runtime-qa.mjs`.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3517";
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920];
const MUTATE = process.env.QA_MUTATE ?? "";
// Negative proof: QA_MUTATE=provider-leak plants a provider name in the data; the run must fail.
const LONG = (MUTATE === "provider-leak" ? "CardCom · " : "") + "עיריית תל אביב יפו — אגף הגבייה, מחלקת ארנונה עסקית ושילוט, סניף מרכז";
const PAY_URL = "https://pay.example.test/checkout/abc123";

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const req = (o) => ({ requestId: 1, customerId: 1, customerName: LONG, invoiceId: 11, invoiceNumber: "000123", amount: "12345678.90", currency: "ILS", state: "WAITING", createdAt: "2026-09-01T09:00:00.000Z", paidAt: null, paymentUrl: PAY_URL, ...o });
const INBOX = {
  businessName: "העסק של אלדד",
  summary: { toCollect: { amount: "25345678.90", count: 2, currency: "ILS" }, waiting: { amount: "12345678.90", count: 1 }, attention: { count: 4 }, paidRecent: { amount: "1000.00", count: 2 } },
  toCollect: [
    { customerId: 1, customerName: LONG, customerPhone: "0501234567", totalOutstanding: "12345678.90", currency: "ILS", awaitingSince: "2026-06-01T00:00:00.000Z", invoices: [{ id: 11, documentNumber: "000123", outstanding: "12345678.90", currency: "ILS", isPartiallySettled: true }], openRequestCount: 1 },
    { customerId: null, customerName: null, customerPhone: null, totalOutstanding: "13000000.00", currency: "ILS", awaitingSince: null, invoices: [{ id: 12, documentNumber: null, outstanding: "13000000.00", currency: "ILS", isPartiallySettled: false }], openRequestCount: 0 },
  ],
  waiting: [req({})],
  attention: [
    { kind: "PAYMENT_FAILED", request: req({ requestId: 2, state: "FAILED" }) },
    { kind: "LINK_EXPIRED", request: req({ requestId: 3, state: "EXPIRED" }) },
    { kind: "RECEIPT_ATTENTION", request: req({ requestId: 4, customerId: null, customerName: null, state: "PAID" }), paymentTransactionId: 44, reason: "NO_CUSTOMER" },
    { kind: "UNAPPLIED_EXCESS", request: req({ requestId: 5, state: "PAID" }), paymentTransactionId: 55, receiptId: 555, receiptNumber: "000777", unappliedAmount: "400.00", refundedAmount: "0.00" },
  ],
  paid: [
    { ...req({ requestId: 6, state: "PAID", paidAt: "2026-09-10T09:00:00.000Z" }), paymentTransactionId: 66, accounting: "RECEIPTED", attentionReason: null, receiptId: 666, receiptNumber: "000778", allocatedAmount: "600.00", unappliedAmount: "400.00" },
    { ...req({ requestId: 7, state: "PAID", paidAt: "2026-09-09T09:00:00.000Z" }), paymentTransactionId: 77, accounting: "NO_AUTOMATIC_RECEIPT", attentionReason: null, receiptId: null, receiptNumber: null, allocatedAmount: null, unappliedAmount: null },
  ],
  paidNextBefore: "2026-09-09T09:00:00.000Z",
};
const THREAD = {
  businessName: "העסק של אלדד",
  customer: { id: 1, name: LONG, phone: "0501234567", email: null },
  totals: { outstanding: "12345678.90", currency: "ILS", openInvoices: 1 },
  openInvoices: [{ id: 11, number: "000123", outstanding: "12345678.90", currency: "ILS" }],
  events: [
    { kind: "REFUND", at: "2026-09-12T09:00:00.000Z", requestId: 6, amount: "100.00", currency: "ILS", outcome: "PENDING" },
    { kind: "RECEIPT_ISSUED", at: "2026-09-10T09:01:00.000Z", receiptId: 666, number: "000778", amount: "1000.00", currency: "ILS", allocations: [{ invoiceId: 11, invoiceNumber: "000123", amount: "600.00" }], unappliedAmount: "400.00", automatic: true },
    { kind: "PAYMENT_VERIFIED", at: "2026-09-10T09:00:00.000Z", requestId: 6, paymentTransactionId: 66, amount: "1000.00", currency: "ILS", accounting: "RECEIPTED", attentionReason: null },
    { kind: "REQUEST_CREATED", at: "2026-09-01T09:00:00.000Z", requestId: 1, amount: "12345678.90", currency: "ILS", invoiceId: 11, invoiceNumber: "000123", status: "PENDING", paymentUrl: PAY_URL },
    { kind: "CREDIT_NOTE_ISSUED", at: "2026-08-15T09:00:00.000Z", documentId: 13, number: "000009", amount: "100.00", currency: "ILS", invoiceId: 11 },
    { kind: "INVOICE_ISSUED", at: "2026-06-01T09:00:00.000Z", invoiceId: 11, number: "000123", amount: "12346378.90", currency: "ILS", outstanding: "12345678.90" },
  ],
};
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function wire(context, { ready = true } = {}) {
  await context.addInitScript(() => localStorage.setItem("token", "qa-runtime-token"));
  await context.route("**/api/collection/inbox*", (r) => r.fulfill(json(r.request().url().includes("paidBefore") ? { ...INBOX, paid: [], paidNextBefore: null } : INBOX)));
  await context.route("**/api/collection/customers/*", (r) => r.fulfill(json(THREAD)));
  await context.route("**/api/collection/readiness", (r) =>
    r.fulfill(json(ready ? { ready: true, blockers: [] } : { ready: false, blockers: ["NO_PAYMENT_PROVIDER", "PAYMENT_PROVIDER_AMBIGUOUS", "BILLING_IDENTITY_INCOMPLETE"] })));
  await context.route("**/api/customers?*", (r) => r.fulfill(json({ customers: [{ id: 1, name: LONG }, { id: 2, name: "דנה" }] })));
  await context.route("**/api/payments/requests", (r) =>
    r.request().method() === "POST" ? r.fulfill(json({ id: 99, status: "PENDING", amount: JSON.parse(r.request().postData() ?? "{}").amount, currency: "ILS", paymentUrl: PAY_URL, description: null, provider: "CARDCOM", createdAt: "2026-09-22T09:00:00.000Z" }, 201)) : r.continue());
  await context.route("**/api/payments/requests/*/refund", (r) => r.fulfill(json({ settledAmount: "1000.00", refundedTotal: "0.00", refundableRemaining: "1000.00", currency: "ILS", hasUnresolvedRefund: false })));
  await context.route("**/api/payments/requests/5", (r) => r.fulfill(json({ request: { id: 5, customerId: 1 }, transactions: [], audit: [] })));
  await context.route("https://pay.example.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>CHECKOUT</h1>" }));
}

async function measure(page, label, width) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - window.innerWidth;
    const spills = [];
    for (const el of document.querySelectorAll("main *, body *")) {
      if (!(el instanceof HTMLElement) || el.children.length > 0) continue;
      const t = (el.textContent ?? "").trim();
      if (!t) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && getComputedStyle(el).whiteSpace === "nowrap") spills.push(t.slice(0, 40));
    }
    const small = [];
    for (const el of document.querySelectorAll("button, input, [role=tab], [role=option]")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.height < 40 && !(el instanceof HTMLInputElement && el.type === "radio")) small.push(`${el.tagName}:${Math.round(b.height)}:${(el.textContent ?? "").trim().slice(0, 15)}`);
    }
    const text = document.body.innerText;
    return { over, spills: spills.slice(0, 3), small: small.slice(0, 5), rtl: !!document.querySelector('[dir="rtl"]'), text };
  });
  check(`${label} @${width}: no horizontal overflow`, r.over <= 1, `overflow=${r.over}`);
  check(`${label} @${width}: no nowrap text spills its box`, r.spills.length === 0, JSON.stringify(r.spills));
  check(`${label} @${width}: tap targets ≥ 40px`, r.small.length === 0, JSON.stringify(r.small));
  check(`${label} @${width}: RTL`, r.rtl);
  check(`${label} @${width}: no delivery claim`, !/נמסר|נקרא|נשלח ללקוח|נשלחה ללקוח|נשלחה בקשה/.test(r.text));
  check(`${label} @${width}: no provider name`, !/cardcom|sumit|tranzila|paypal/i.test(r.text));
  return r;
}

async function main() {
  const browser = await chromium.launch();

  for (const width of WIDTHS) {
    const context = await browser.newContext({ locale: "he-IL", viewport: { width, height: 900 } });
    await wire(context);
    const page = await context.newPage();

    await page.goto(`${BASE}/collection`, { waitUntil: "networkidle" });
    const selected = await page.getByRole("tab", { selected: true }).innerText();
    check(`/collection @${width}: opens on דורש טיפול when something needs attention`, selected.includes("דורש טיפול"), selected);
    await measure(page, "/collection attention", width);
    for (const tab of ["צריך לגבות", "ממתין", "שולם"]) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      await measure(page, `/collection ${tab}`, width);
    }
    await page.getByRole("tab", { name: /ממתין/ }).click();
    await page.getByRole("button", { name: "בטל בקשה" }).first().click();
    check(`/collection @${width}: cancel asks for confirmation`, await page.getByRole("dialog").isVisible().catch(() => false) || (await page.getByText("לבטל את בקשת התשלום?").isVisible()));
    await page.keyboard.press("Escape");

    await page.goto(`${BASE}/collection/new?customerId=1`, { waitUntil: "networkidle" });
    const amount = page.locator("#amount");
    check(`/collection/new @${width}: the single open invoice is preselected with its full remaining`, (await amount.inputValue()) === "12345678.9", await amount.inputValue());
    await amount.fill("99999999");
    check(`/collection/new @${width}: over the remaining is refused before submit`, await page.getByRole("alert").first().isVisible());
    await amount.fill("450");
    check(`/collection/new @${width}: partial is explained`, await page.getByText("גבייה חלקית").isVisible());
    await measure(page, "/collection/new form", width);
    const popupPromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.getByRole("button", { name: /צור בקשה/ }).click();
    await page.getByRole("button", { name: "שליחה בוואטסאפ" }).waitFor();
    check(`/collection/new @${width}: the owner stays in Dubiz (never sent to checkout)`, new URL(page.url()).pathname === "/collection/new", page.url());
    await measure(page, "/collection/new share", width);
    await page.getByRole("button", { name: "שליחה בוואטסאפ" }).click();
    const popup = await popupPromise;
    const waUrl = popup ? popup.url() : "";
    check(`/collection/new @${width}: WhatsApp opens to the customer with the link`, waUrl.startsWith("https://wa.me/") || waUrl.startsWith("https://api.whatsapp.com/"), waUrl);
    if (popup) {
      const decoded = decodeURIComponent(waUrl);
      check(`/collection/new @${width}: message carries the payment link and amount`, decoded.includes(PAY_URL) && decoded.includes("450"), decoded.slice(0, 120));
      await popup.close();
    }
    check(`/collection/new @${width}: WhatsApp is 'opened', never 'sent'`, await page.getByText("Dubiz לא רואה אם ההודעה נשלחה").isVisible());

    await page.goto(`${BASE}/collection/c/1`, { waitUntil: "networkidle" });
    await measure(page, "/collection/c/1", width);
    await page.getByRole("button", { name: "החזר כסף" }).first().click();
    check(`/collection/c/1 @${width}: refund says it does not cancel the receipt or reopen the invoice`, await page.getByText(/לא מבטל את הקבלה ולא פותח מחדש את החשבונית/).isVisible());
    await page.keyboard.press("Escape");

    await context.close();
  }

  // Missing setup is shown before any form.
  {
    const context = await browser.newContext({ locale: "he-IL", viewport: { width: 390, height: 900 } });
    await wire(context, { ready: false });
    const page = await context.newPage();
    await page.goto(`${BASE}/collection/new?customerId=1`, { waitUntil: "networkidle" });
    check("/collection/new not ready: three blockers, each with its fix", (await page.getByText("צריך לחבר חברת סליקה").isVisible()) && (await page.getByText("מחוברות כמה חברות סליקה").isVisible()) && (await page.getByText("חסרים פרטי העסק לקבלות").isVisible()));
    check("/collection/new not ready: no form, no create button", (await page.locator("#amount").count()) === 0 && (await page.getByRole("button", { name: /צור בקשה/ }).count()) === 0);
    await context.close();
  }

  // Legacy routes land in the new product.
  {
    const context = await browser.newContext({ locale: "he-IL", viewport: { width: 390, height: 900 } });
    await wire(context);
    const page = await context.newPage();
    await page.goto(`${BASE}/payments`, { waitUntil: "networkidle" });
    check("legacy /payments → /collection", new URL(page.url()).pathname === "/collection", page.url());
    await page.goto(`${BASE}/payments/new?customerId=1`, { waitUntil: "networkidle" });
    check("legacy /payments/new → /collection/new (customer kept)", page.url().includes("/collection/new?customerId=1"), page.url());
    await page.goto(`${BASE}/payments/5`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/collection\/c\/1\?request=5/, { timeout: 8000 }).catch(() => {});
    check("legacy /payments/5 → the customer's thread, anchored", page.url().includes("/collection/c/1?request=5"), page.url());
    await context.close();
  }

  await browser.close();
  console.log(`\nCollection runtime QA: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
