/**
 * Runtime visual QA for Desktop UX Phase 2 slice 5.
 * Mocks /api. Does not issue a document, record a payment, or call a provider.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = "2026-09-28T08:00:00.000+03:00";

let mode = "bill-open";

function line(description, total) {
  return {
    id: 1,
    lineIndex: 0,
    description,
    quantity: "1",
    unitPrice: total,
    vatRatePercent: "18",
    lineSubtotal: total,
    vatAmount: "0.00",
    lineTotal: total,
  };
}

function doc(partial) {
  return {
    id: 41,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    documentNumber: 41,
    documentNumberFormatted: "2026-0041",
    customerId: 7,
    customerNameSnapshot: "חברת החשמל",
    validUntil: null,
    convertedToInvoiceId: null,
    subtotalAmount: "1000.00",
    vatAmount: "180.00",
    totalAmount: "1180.00",
    currency: "ILS",
    issuedAt: now,
    createdAt: now,
    updatedAt: now,
    lines: [line("חשמל ספטמבר", "1180.00")],
    ...partial,
  };
}

function collection(partial) {
  return {
    customerId: 7,
    currency: "ILS",
    total: "1180.00",
    paid: "0.00",
    credited: "0.00",
    remaining: "1180.00",
    latestRequest: null,
    ...partial,
  };
}

function obligation(partial) {
  return {
    id: 1,
    obligeeName: "שכירות",
    amount: "4500",
    currency: "ILS",
    dueAt: "2026-09-20T09:00:00.000+03:00",
    state: "OPEN",
    source: "manual",
    recurrence: "MONTHLY",
    recurrenceSeriesId: "rent",
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

const obligations = [
  obligation({ id: 1, obligeeName: "שכירות", dueAt: "2026-09-20T09:00:00.000+03:00", recurrence: "MONTHLY" }),
  obligation({ id: 2, obligeeName: "חשמל", amount: "820", dueAt: "2026-09-28T09:00:00.000+03:00", recurrence: "NONE" }),
  obligation({ id: 3, obligeeName: "רואה חשבון", amount: "1500", dueAt: "2026-10-20T09:00:00.000+03:00", recurrence: "NONE", note: "פריסת תשלומים 2/6" }),
  obligation({ id: 4, obligeeName: "ארנונה", amount: "640", dueAt: "2026-09-02T09:00:00.000+03:00", state: "MET", metAt: "2026-09-02T09:00:00.000+03:00" }),
];

function briefing() {
  return {
    state: "BUSY",
    oriented: true,
    attention: [{ obligation: obligations[0], reason: "OVERDUE" }],
    watching: obligations.filter((item) => item.state === "OPEN"),
    counts: { open: 3, attention: 1, breakToday: 1, watching: 2 },
    generatedAt: now,
  };
}

function commitment(partial) {
  return {
    id: 9,
    title: "שכירות ספטמבר",
    payeeId: 3,
    payeeNameSnapshot: "בעל הנכס",
    currency: "ILS",
    scheduleKind: "INSTALLMENT_PLAN",
    status: "ACTIVE",
    total: "54000.00",
    paid: "4500.00",
    remaining: "49500.00",
    installmentCount: 12,
    next: { id: 2, sequence: 2, dueAt: "2026-09-28T09:00:00.000+03:00", scheduled: "4500.00", remaining: "4500.00", state: "DUE" },
    attention: "DUE",
    isLegacy: false,
    ...partial,
  };
}

function installment(sequence, state, remaining) {
  return {
    id: sequence,
    sequence,
    dueAt: "2026-09-28T09:00:00.000+03:00",
    scheduled: "4500.00",
    paid: state === "PAID" ? "4500.00" : "0.00",
    remaining,
    state,
    status: "OPEN",
    legacyAssertedBy: null,
    legacyMetAt: null,
    allocations: [],
  };
}

function preparation(status) {
  return {
    id: 5,
    status,
    amount: "4500.00",
    currency: "ILS",
    method: "BANK_TRANSFER",
    payee: { id: 3, name: "בעל הנכס" },
    commitment: { id: 9, title: "שכירות ספטמבר" },
    installment: { id: 2, sequence: 2, dueAt: "2026-09-28T09:00:00.000+03:00" },
    source: { id: 1, label: "עו\"ש", masked: "****4471", isActive: true },
    destination: { id: 4, label: "חשבון השכירות", beneficiaryName: "בעל הנכס", masked: "****8821", isActive: true, verification: "UNVERIFIED" },
    reference: null,
    note: null,
    approvedAt: status === "APPROVED" || status === "COMPLETED" || status === "FAILED" ? now : null,
    cancelledAt: null,
    cancellationReason: null,
    completedAt: status === "COMPLETED" ? now : null,
    completionSource: status === "COMPLETED" ? "OWNER_ASSERTED" : null,
    paymentId: status === "COMPLETED" ? 12 : null,
    executions: status === "FAILED" ? [{ id: 1, provider: "none", status: "FAILED", providerReference: null, failureCode: "NO_PROVIDER", requestedAt: now }] : [],
    createdAt: now,
    actions: {
      approve: status === "PREPARED",
      cancel: status === "PREPARED" || status === "APPROVED" || status === "FAILED",
      reportCompleted: status === "APPROVED" || status === "FAILED",
      execute: status === "APPROVED",
    },
  };
}

function detail(prepStatus) {
  return {
    id: 9,
    title: "שכירות ספטמבר",
    payeeId: 3,
    payeeNameSnapshot: "בעל הנכס",
    currency: "ILS",
    scheduleKind: "INSTALLMENT_PLAN",
    recurrence: "NONE",
    status: "ACTIVE",
    note: "חוזה שנתי",
    total: "54000.00",
    paid: "4500.00",
    remaining: "49500.00",
    isLegacy: false,
    legacy: null,
    installments: [installment(1, "PAID", "0.00"), installment(2, "DUE", "4500.00")],
    payments: [{
      id: 8,
      amount: "4500.00",
      allocated: "4500.00",
      unallocated: "0.00",
      status: "RECORDED",
      method: "BANK_TRANSFER",
      paidAt: "2026-08-28T09:00:00.000+03:00",
      externalReference: "AUG-1",
    }],
    audit: [{ id: 1, eventType: "PREPARED", source: "owner", summary: "הוכן תשלום", occurredAt: now }],
    prepStatus,
  };
}

function json(body) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

async function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  if (mode === "bill-error" && p.startsWith("/api/billing/documents/")) {
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "אירעה שגיאה בטעינת המסמך" }) });
  }
  if (mode === "bill-missing" && p.startsWith("/api/billing/documents/")) {
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "missing" }) });
  }
  if (mode === "pay-error" && p.startsWith("/api/payables/")) {
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "טעינה נכשלה" }) });
  }
  if (p.startsWith("/api/billing/documents/")) {
    const documents = {
      "bill-draft": doc({ status: "DRAFT", documentNumber: null, documentNumberFormatted: null, customerNameSnapshot: null, customerId: null, issuedAt: null, lines: [] }),
      "bill-lines": doc({ status: "DRAFT", documentNumber: null, documentNumberFormatted: null, issuedAt: null }),
      "bill-ready": doc({ status: "DRAFT", documentNumber: null, documentNumberFormatted: null, issuedAt: null }),
      "bill-quote": doc({ documentType: "QUOTE", status: "DRAFT", documentNumber: null, documentNumberFormatted: null, issuedAt: null, validUntil: "2026-10-31T00:00:00.000+03:00" }),
      "bill-converted": doc({ documentType: "QUOTE", status: "ISSUED", documentNumberFormatted: "Q-12", convertedToInvoiceId: 80 }),
      "bill-pending": doc({ status: "PENDING_REVIEW", documentNumber: null, documentNumberFormatted: null, issuedAt: null }),
      "bill-open": doc({}),
      "bill-partial": doc({}),
      "bill-paid": doc({}),
      "bill-none": doc({}),
      "bill-warn": doc({}),
    };
    return route.fulfill(json({ document: documents[mode] ?? doc({}) }));
  }
  if (p.startsWith("/api/collection/invoices/")) {
    if (mode === "bill-warn") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (mode === "bill-paid") return route.fulfill(json(collection({ paid: "1180.00", remaining: "0.00" })));
    if (mode === "bill-partial") return route.fulfill(json(collection({ paid: "400.00", remaining: "780.00", latestRequest: { id: 3, status: "PENDING", amount: "780.00", createdAt: now } })));
    if (mode === "bill-open") return route.fulfill(json(collection({ latestRequest: { id: 3, status: "PENDING", amount: "1180.00", createdAt: now } })));
    return route.fulfill(json(collection()));
  }
  if (p.startsWith("/api/billing/invoice-profile")) return route.fulfill(json({ taxId: "514000000" }));
  if (p.startsWith("/api/obligations/briefing")) return route.fulfill(json(briefing()));
  if (p.startsWith("/api/obligations")) {
    const list = mode === "sec-empty" ? [] : obligations;
    return route.fulfill(json({ obligations: list }));
  }
  if (p === "/api/payables/commitments") {
    if (mode === "pay-empty") return route.fulfill(json({ commitments: [] }));
    return route.fulfill(json({
      commitments: [
        commitment({}),
        commitment({ id: 10, title: "חשמל", payeeNameSnapshot: "חברת החשמל", scheduleKind: "ONE_OFF", installmentCount: 1, attention: "OVERDUE", paid: "0.00", remaining: "820.00", total: "820.00", next: { id: 1, sequence: 1, dueAt: "2026-09-20T09:00:00.000+03:00", scheduled: "820.00", remaining: "820.00", state: "OVERDUE" } }),
      ],
    }));
  }
  if (p.startsWith("/api/payables/commitments/")) {
    const current = detail(mode === "pay-approved" ? "APPROVED" : mode === "pay-done" ? "COMPLETED" : mode === "pay-failed" ? "FAILED" : "PREPARED");
    return route.fulfill(json({ commitment: current }));
  }
  if (p.startsWith("/api/payables/preparations")) {
    const status = mode === "pay-approved" ? "APPROVED" : mode === "pay-done" ? "COMPLETED" : mode === "pay-failed" ? "FAILED" : "PREPARED";
    return route.fulfill(json({ preparations: [preparation(status)] }));
  }
  if (p.startsWith("/api/payables/outbound-providers")) return route.fulfill(json({ providers: [], live: false }));
  if (p.startsWith("/api/payables/cheques")) return route.fulfill(json({ cheques: [] }));
  if (p.startsWith("/api/payables/bank-accounts")) {
    return route.fulfill(json({
      configured: mode !== "pay-setup",
      accounts: mode === "pay-setup" ? [] : [{ id: 1, label: "עו\"ש", last4: "4471", masked: "****4471", isActive: true, isDefault: true, note: null, createdAt: now }],
    }));
  }
  if (p.startsWith("/api/payables/bank-lines")) {
    return route.fulfill(json({
      lines: mode === "pay-bank-empty" ? [] : [{
        id: 1,
        source: "CSV",
        direction: "DEBIT",
        amount: "4500.00",
        currency: "ILS",
        bookedAt: now,
        counterpartyName: "בעל הנכס",
        reference: "RENT",
        description: "הוראת קבע",
        sourceAccount: { id: 1, label: "עו\"ש", last4: "4471" },
        state: "OPEN",
        matchedPayment: null,
        dismissReason: null,
      }],
    }));
  }
  if (p.includes("/suggestions")) {
    return route.fulfill(json({
      document: { id: 15, amount: "820.00", date: now, vendorName: "חברת החשמל", direction: "OUT" },
      candidates: [],
      ambiguous: false,
      attachedTo: null,
    }));
  }
  return route.fulfill(json({}));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function snap(page, domain, file) {
  const dir = path.join(ROOT, domain);
  ensureDir(dir);
  await page.screenshot({ path: path.join(dir, file), fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      overflow: de.scrollWidth > de.clientWidth + 2,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 220),
    };
  });
  return { file: `${domain}/${file}`, ...metrics };
}

const shots = [];

let readyNeedle = "";

async function shoot(page, domain, label, width) {
  await page.setViewportSize({ width, height: 900 });
  if (readyNeedle) {
    await page.waitForFunction(
      (needle) => (document.body.innerText || "").includes(needle),
      readyNeedle,
      { timeout: 20000 },
    );
  }
  await page.waitForTimeout(300);
  const result = await snap(page, domain, `${label}-${width}.png`);
  shots.push({ domain, label, width, ...result });
  console.log(domain, label, width, result.overflow ? "OVERFLOW" : "ok", result.text.slice(0, 80));
}

async function open(page, routePath, readyText) {
  readyNeedle = readyText;
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    (needle) => {
      const overlay = document.querySelector("[data-dubiz-intro-overlay]");
      const fading = overlay && getComputedStyle(overlay).opacity === "0";
      const text = document.body.innerText || "";
      return (!overlay || fading) && text.includes(needle);
    },
    readyText,
    { timeout: 25000 },
  );
  await page.waitForTimeout(250);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "he-IL",
  timezoneId: "Asia/Jerusalem",
  reducedMotion: "reduce",
});
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "נועה", businessId: 1 }));
  localStorage.setItem("dubiz.home.identity.v1", "dubiz");
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

const bill = [
  ["bill-draft", "טיוטה", "draft", [390, 1440]],
  ["bill-lines", "חברת החשמל", "lines", [1280]],
  ["bill-ready", "הפקה", "ready", [1600]],
  ["bill-quote", "הצעת מחיר", "quote", [1440]],
  ["bill-converted", "Q-12", "converted", [1440]],
  ["bill-pending", "ממתין", "pending", [1440]],
  ["bill-open", "גבייה", "open-request", [390, 768, 1024, 1280, 1440, 1600, 1920]],
  ["bill-partial", "780", "partial", [1440]],
  ["bill-paid", "סגורה", "paid", [1440]],
  ["bill-none", "נותר", "no-activity", [1440]],
  ["bill-warn", "לא הצלחנו לטעון את מצב הגבייה", "warning", [1440]],
  ["bill-error", "אירעה שגיאה", "error", [390, 1440]],
];

for (const [nextMode, needle, label, widths] of bill) {
  mode = nextMode;
  await open(page, "/billing/41", needle);
  for (const width of widths) await shoot(page, "billing-detail", label, width);
}

mode = "sec-many";
await open(page, "/secretary?screen=all", "כל ההתחייבויות");
for (const width of [390, 768, 1440, 1920]) await shoot(page, "secretary", "many", width);
await page.getByRole("button", { name: /שכירות/ }).first().click();
await page.waitForTimeout(200);
await shoot(page, "secretary", "selected", 1440);

await open(page, "/secretary?screen=detail&id=1", "שכירות");
await shoot(page, "secretary", "overdue-recurring", 1440);
await open(page, "/secretary?screen=detail&id=2", "חשמל");
await shoot(page, "secretary", "today", 1280);
await open(page, "/secretary?screen=detail&id=3", "פריסת");
await shoot(page, "secretary", "installment-future", 1600);
await open(page, "/secretary?screen=detail&id=4", "טופל");
await shoot(page, "secretary", "handled", 1440);
await open(page, "/secretary?screen=watching", "במעקב");
await shoot(page, "secretary", "watching", 1440);
await open(page, "/secretary?screen=bank", "קבועות");
await shoot(page, "secretary", "bank", 1024);
await shoot(page, "secretary", "bank", 1920);
await open(page, "/secretary?screen=capture", "תשלום רגיל");
await shoot(page, "secretary", "capture", 1440);
await open(page, "/secretary?screen=update&id=1", "עריכת");
await shoot(page, "secretary", "edit", 768);
await open(page, "/secretary?screen=remind&id=2", "תזכורת");
await shoot(page, "secretary", "remind", 390);
await open(page, "/secretary?screen=loops&id=1&loopMode=met", "טיפלנו");
await shoot(page, "secretary", "loop", 1440);

mode = "sec-empty";
await open(page, "/secretary?screen=all", "אין עדיין");
await shoot(page, "secretary", "empty", 1440);

mode = "pay-list";
await open(page, "/payables", "שכירות ספטמבר");
for (const width of [390, 768, 1024, 1280, 1440, 1600, 1920]) await shoot(page, "payables", "queue", width);
await page.getByRole("button", { name: /שכירות ספטמבר/ }).first().click();
await page.waitForTimeout(200);
await shoot(page, "payables", "selected", 1440);
await open(page, "/payables?new=1", "סכום כולל");
await shoot(page, "payables", "new", 1440);

mode = "pay-prepared";
await open(page, "/payables/9", "אין ספק");
await shoot(page, "payables", "prepared", 1440);
await shoot(page, "payables", "prepared", 1920);
mode = "pay-approved";
await open(page, "/payables/9", "ביצוע אוטומטי אינו זמין");
await shoot(page, "payables", "approved-no-provider", 1600);
mode = "pay-done";
await open(page, "/payables/9", "נרשם כתשלום");
await shoot(page, "payables", "completed", 1280);
mode = "pay-failed";
await open(page, "/payables/9", "הביצוע נכשל");
await shoot(page, "payables", "failed", 1440);

mode = "pay-bank";
await open(page, "/payables/bank", "אין חיבור ישיר לבנק");
await shoot(page, "payables", "bank-evidence", 1440);
mode = "pay-bank-empty";
await open(page, "/payables/bank", "אין תנועות");
await shoot(page, "payables", "bank-empty", 1440);
mode = "pay-cheques";
await open(page, "/payables/cheques", "חשבונות הבנק");
await shoot(page, "payables", "cheques", 1024);
await shoot(page, "payables", "cheques", 1600);
mode = "pay-match";
await open(page, "/payables/match/15", "חברת החשמל");
await shoot(page, "payables", "match", 1440);
mode = "pay-empty";
await open(page, "/payables", "אין התחייבויות");
await shoot(page, "payables", "empty", 1440);
mode = "pay-error";
await open(page, "/payables", "טעינה נכשלה");
await shoot(page, "payables", "error", 390);

await browser.close();
const overflow = shots.filter((shot) => shot.overflow);
fs.writeFileSync(path.join(ROOT, "slice5-metrics.json"), JSON.stringify({ shots: shots.length, overflow: overflow.length, shots }, null, 2));
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length);
if (overflow.length) process.exitCode = 2;
