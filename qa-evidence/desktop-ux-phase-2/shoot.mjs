/**
 * Runtime visual QA for Desktop UX Phase 2 slice (PR #543).
 * Mocks /api so the local app paints without a database.
 * Not a product test — screenshot and composition evidence only.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const OUT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = new Date().toISOString();

let mode = "populated";

const names = ["נועה כהן", "יוסי לוי", "מאיה ברק", "דני אלון", "שירה גולן", "איתי מזרחי", "רותם חדד", "עדי פרץ"];

function customers(n) {
  return names.slice(0, n).map((name, i) => ({
    id: i + 1,
    name,
    phone: `050123450${i}`,
    email: `c${i + 1}@example.co.il`,
    city: ["תל אביב", "חיפה", "ירושלים", "באר שבע"][i % 4],
    isActive: true,
  }));
}

function customerCard(id) {
  const c = customers(8)[id - 1] || customers(1)[0];
  return {
    customer: {
      ...c,
      legalName: c.name,
      taxId: "514000001",
      taxIdType: "COMPANY",
      notes: "לקוח קבוע. מעדיף חשבונית במייל.",
      createdAt: now,
      updatedAt: now,
    },
    billingDocuments: {
      total: 2,
      items: [
        { id: 11, documentType: "TAX_INVOICE", status: "ISSUED", documentNumberFormatted: "1001", totalAmount: "1800.00", currency: "ILS", issuedAt: now, createdAt: now },
        { id: 12, documentType: "QUOTE", status: "DRAFT", documentNumberFormatted: null, totalAmount: "640.00", currency: "ILS", issuedAt: null, createdAt: now },
      ],
    },
    paymentRequests: { total: 1, items: [{ id: 3, provider: "CARDCOM", status: "PENDING", amount: "1800.00", currency: "ILS", paymentUrl: null, billingDocumentId: 11, createdAt: now, paidAt: null }] },
    conversations: { total: 0, items: [] },
    appointments: { total: 1, items: [{ id: 4, status: "SCHEDULED", title: "פגישת המשך", startsAt: now, createdAt: now }] },
    activity: { lastActivityAt: now, hasAnyActivity: true },
  };
}

function lead(i) {
  return {
    id: i + 1,
    name: names[i],
    phone: `052111220${i}`,
    email: `l${i + 1}@example.co.il`,
    status: "OPEN",
    sourceChannel: "whatsapp",
    followUpNote: "לחזור עם הצעת מחיר",
    lastActivityAt: now,
    createdAt: now,
    followUp: { kind: "due_today", at: now },
    needsAttention: true,
    customer: null,
    intelligence: null,
    priority: { score: 80 - i, reason: "FOLLOWUP_DUE_TODAY", label: "מעקב להיום", contributing: ["FOLLOWUP_DUE_TODAY"] },
  };
}

function leadCard(id) {
  const row = lead(id - 1);
  return {
    lead: {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      status: "OPEN",
      sourceChannel: "whatsapp",
      intentSnapshot: "מבקש הצעת מחיר לשירות חודשי",
      followUpNote: row.followUpNote,
      nextFollowUpAt: now,
      lastActivityAt: now,
      closedAt: null,
      lostReason: null,
      createdAt: now,
      updatedAt: now,
    },
    followUp: row.followUp,
    needsAttention: true,
    customer: null,
    conversations: { items: [], total: 0 },
    intelligence: null,
    priority: row.priority,
  };
}

function suppliers(n) {
  return ["ספק נייר", "הדפסות דרום", "לוגיסטיקה כחול", "אריזות הגליל", "קפה למשרד", "חשמל ועוד"].slice(0, n).map((name, i) => ({
    id: i + 1,
    name,
    isActive: true,
    phone: `03-555100${i}`,
    email: `s${i + 1}@example.co.il`,
  }));
}

function supplier(id) {
  const row = suppliers(6)[id - 1] || suppliers(1)[0];
  return {
    ...row,
    notes: "אספקה בימי שלישי.",
    defaultLeadTimeDays: 3,
    legalName: row.name,
    taxId: "515000002",
    taxIdType: "COMPANY",
    category: "כללי",
  };
}

function obligation(i, reason) {
  return {
    id: i + 1,
    obligeeName: ["שכירות", "חשמל", "ביטוח", "ספק נייר"][i],
    amount: ["4500.00", "820.00", "310.00", "640.00"][i],
    currency: "ILS",
    dueAt: now,
    state: "OPEN",
    source: "MANUAL",
    recurrence: i === 0 ? "MONTHLY" : "NONE",
    recurrenceSeriesId: null,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
    reason,
  };
}

function briefing() {
  if (mode === "secretary-new") {
    return { state: "STILL_SETTLING_IN", oriented: false, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 }, generatedAt: now };
  }
  const count = mode === "secretary-few" ? 1 : 4;
  const items = Array.from({ length: count }, (_, i) => obligation(i, i === 0 ? "DUE_TODAY" : "DUE_SOON"));
  return {
    state: count > 1 ? "BUSY" : "CRITICAL",
    oriented: true,
    attention: items.map((obligation) => ({ obligation, reason: obligation.reason })),
    watching: [],
    counts: { open: count, attention: count, breakToday: 1, watching: 0 },
    generatedAt: now,
  };
}

function docs(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    documentType: i % 3 === 0 ? "QUOTE" : "TAX_INVOICE",
    status: i % 4 === 0 ? "DRAFT" : "ISSUED",
    documentNumber: 1000 + i,
    documentNumberFormatted: String(1000 + i),
    customerId: (i % 4) + 1,
    customerNameSnapshot: names[i % names.length],
    totalAmount: (400 + i * 175).toFixed(2),
    currency: "ILS",
    issuedAt: i % 4 === 0 ? null : now,
    createdAt: now,
    updatedAt: now,
  }));
}

function items(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: ["קפה טחון", "סוכר", "כוסות", "חלב", "נייר", "סבון", "שקיות", "תה"][i],
    sku: `SKU-${i + 1}`,
    barcode: `72900000000${i}`,
    unitType: "UNIT",
    supplierName: "ספק נייר",
    currentQuantity: [2, 40, 12, 0, 8, 30, 4, 18][i],
    minimumQuantity: 5,
    reorderPoint: 8,
    costPerUnit: 10 + i,
    sellPricePerUnit: 18 + i,
    alerts: [],
    category: { id: 1, name: "מכולת" },
  }));
}

function inbox() {
  const debt = {
    customerId: 1,
    customerName: "נועה כהן",
    customerPhone: "0501234500",
    totalOutstanding: "1800.00",
    currency: "ILS",
    awaitingSince: now,
    invoices: [{ id: 11, documentNumber: "1001", outstanding: "1800.00", currency: "ILS", isPartiallySettled: false }],
    openRequestCount: 0,
  };
  return {
    businessName: "דוביז",
    summary: {
      toCollect: { amount: "1800.00", count: 1, currency: "ILS" },
      waiting: { amount: "640.00", count: 1 },
      attention: { count: 0 },
      paidRecent: { amount: "900.00", count: 1 },
    },
    toCollect: [debt],
    waiting: [],
    attention: [],
    paid: [],
    paidNextBefore: null,
  };
}

function thread() {
  return {
    businessName: "דוביז",
    customer: { id: 1, name: "נועה כהן", phone: "0501234500", email: "c1@example.co.il" },
    totals: { outstanding: "1800.00", currency: "ILS", openInvoices: 1 },
    openInvoices: [{ id: 11, number: "1001", outstanding: "1800.00", currency: "ILS" }],
    events: [
      { kind: "INVOICE_ISSUED", at: now, invoiceId: 11, number: "1001", amount: "1800.00", currency: "ILS", outstanding: "1800.00" },
      { kind: "REQUEST_CREATED", at: now, requestId: 3, amount: "1800.00", currency: "ILS", invoiceId: 11, invoiceNumber: "1001", status: "PENDING", paymentUrl: "https://example.com/pay" },
      { kind: "PAYMENT_VERIFIED", at: now, requestId: 9, paymentTransactionId: 4, amount: "900.00", currency: "ILS", accounting: "RECEIPTED", attentionReason: null },
      { kind: "RECEIPT_ISSUED", at: now, receiptId: 8, number: "2001", amount: "900.00", currency: "ILS", allocations: [{ invoiceId: 10, invoiceNumber: "0990", amount: "900.00" }], unappliedAmount: "0.00", automatic: true },
    ],
  };
}

function hub() {
  return {
    success: true,
    scope: { month: "2026-09", timezone: "Asia/Jerusalem" },
    financialPulse: {
      period: { month: "2026-09", from: now, toExclusive: now },
      fromFinancialRecords: { income: 0, expense: 0, net: 0, recordCount: 0 },
      inboxDocumentCounts: { pendingReview: 3, approvedDocuments: 12, totalPendingReview: 3 },
    },
    previousNet: null,
    nextPending: null,
    items: [],
    pagination: { limit: 1, nextCursor: null, hasMore: false },
  };
}

async function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const n = mode === "short" ? 2 : 8;
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  if (p === "/api/customers") return json({ customers: customers(mode === "short" ? 2 : 8) });
  if (/^\/api\/customers\/\d+$/.test(p)) return json(customerCard(Number(p.split("/").pop())));
  if (p === "/api/leads") return json({ leads: Array.from({ length: mode === "short" ? 2 : 6 }, (_, i) => lead(i)) });
  if (/^\/api\/leads\/\d+$/.test(p)) return json(leadCard(Number(p.split("/").pop())));
  if (p === "/api/inventory/suppliers") return json({ suppliers: suppliers(mode === "short" ? 2 : 6) });
  if (/^\/api\/inventory\/suppliers\/\d+$/.test(p)) return json({ supplier: supplier(Number(p.split("/").pop())) });
  if (p.startsWith("/api/crm/subjects/") && p.endsWith("/notes")) return json({ notes: [] });
  if (p.startsWith("/api/crm/subjects/") && p.endsWith("/attachments")) return json({ attachments: [] });
  if (p === "/api/collection/inbox") return json(inbox());
  if (/^\/api\/collection\/customers\/\d+$/.test(p)) return json(thread());
  if (p === "/api/documents/inbox") return json(hub());
  if (p === "/api/obligations/briefing") return json(briefing());
  if (p === "/api/obligations") {
    const b = briefing();
    const obligations = [...b.attention.map((a) => a.obligation), ...b.watching];
    return json({ obligations });
  }
  if (p === "/api/billing/documents") {
    const list = mode === "billing-empty" ? [] : docs(8);
    return json({ documents: list, nextCursor: null, totals: { all: list.length, invoices: 5, quotes: 3, drafts: 2, issued: 6 } });
  }
  if (p === "/api/billing/invoice-profile") return json({ identityComplete: true, profile: { billingLegalName: "דוביז בע״מ" } });
  if (p === "/api/inventory/items") return json({ items: items(mode === "short" ? 2 : 8) });
  if (p === "/api/inventory/unmatched") return json({ matches: [] });
  if (p === "/api/inventory/drafts") return json({ drafts: [] });
  if (p === "/api/inventory/supplier-purchases") return json({ drafts: [] });
  if (p === "/api/inventory/reorder-suggestions") return json({ suggestions: [] });
  if (p.startsWith("/api/")) return json({});
  return route.continue();
}

async function snap(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    return {
      title: document.title,
      overflow: de.scrollWidth > de.clientWidth + 2,
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 280),
      start: box(".wsl-start"),
      end: box(".wsl-end"),
      desk: box(".crm-unselected__desk"),
      queue: box(".col-desk__queue"),
      side: box(".col-desk__side"),
      threadSide: box(".col-thread__side"),
      threadQueue: box(".col-thread__queue"),
      pack: box(".dz-pack-desk"),
      packSide: box(".dz-pack-side"),
      home: box(".homeShell"),
      billing: box(".billing-hub-main"),
      actions: box(".billing-actions-section"),
      archive: box(".billing-archive"),
      table: box(".inv-desk-table"),
      cards: box(".inv-cards"),
    };
  });
  return { file, metrics };
}

const shots = [];

async function shoot(page, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(500);
  const result = await snap(page, `${label}-${width}`);
  shots.push({ label, width, ...result });
  console.log(label, width, result.metrics.overflow ? "OVERFLOW" : "ok", result.metrics.text.slice(0, 80));
}

async function open(page, routePath) {
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (document.body.innerText || "").trim().length > 20, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "he-IL" });
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA", businessId: 1 }));
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

const crm = [390, 768, 1024, 1280, 1440, 1600, 1920];

for (const [pathName, prefix] of [["/customers", "customers"], ["/leads", "leads"], ["/suppliers", "suppliers"]]) {
  mode = "populated";
  await open(page, pathName);
  for (const w of crm) await shoot(page, `${prefix}-empty`, w);
  await open(page, `${pathName}/1`);
  for (const w of [390, 1280, 1440, 1920]) await shoot(page, `${prefix}-selected`, w);
  mode = "short";
  await open(page, pathName);
  for (const w of [1440, 1920]) await shoot(page, `${prefix}-short`, w);
}

mode = "populated";
await open(page, "/collection");
for (const w of [390, 768, 1024, 1280, 1440, 1600, 1920]) await shoot(page, "collection-inbox", w);
await open(page, "/collection/c/1");
for (const w of [390, 1280, 1440, 1600, 1920]) await shoot(page, "collection-thread", w);

await open(page, "/documents/accountant-pack");
for (const w of [390, 768, 1024, 1280, 1440, 1600, 1920]) await shoot(page, "accountant-pack", w);

for (const [m, label] of [["secretary-new", "secretary-new"], ["secretary-few", "secretary-few"], ["populated", "secretary-several"]]) {
  mode = m;
  await open(page, "/secretary");
  for (const w of m === "populated" ? [390, 768, 1024, 1280, 1440, 1600, 1920] : [390, 1440, 1920]) {
    await shoot(page, label, w);
  }
}

for (const [m, label] of [["billing-empty", "billing-empty"], ["populated", "billing-populated"]]) {
  mode = m;
  await open(page, "/billing");
  for (const w of [390, 1280, 1440, 1600, 1920]) await shoot(page, label, w);
}

mode = "populated";
await open(page, "/inventory/items");
for (const w of [390, 1280, 1440, 1600, 1920]) await shoot(page, "inventory-items", w);

fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(shots, null, 2));
await browser.close();
console.log("SHOTS", shots.length);
