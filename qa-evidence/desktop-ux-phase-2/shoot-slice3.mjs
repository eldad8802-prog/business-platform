/**
 * Runtime visual QA for Desktop UX Phase 2 slice 3:
 * inventory operations, collection create, and payments.
 * Mocks /api. Does not submit a collection or call a provider.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = "2026-09-12T08:00:00.000Z";

let mode = "populated";

function item(id, name, qty, min, reorder) {
  return {
    id,
    name,
    currentQuantity: qty,
    minimumQuantity: min,
    reorderPoint: reorder,
    unitType: "UNIT",
    costPerUnit: 12,
    sellPricePerUnit: 18,
    lastPurchaseCost: 11,
    barcode: `72900000000${id}`,
    sku: `SKU-${id}`,
    category: { id: 1, name: "מכולת" },
    supplierName: "ספק הצפון",
    imageUrl: null,
    isActive: true,
  };
}

const items = [
  item(1, "חלב 3%", 0, 2, 4),
  item(2, "לחם אחיד", 3, 1, 6),
  item(3, "קפה שחור", 20, 2, 5),
];

function orders() {
  if (mode === "empty") return [];
  return [
    {
      id: 41,
      supplierId: 3,
      supplierName: "ספק הצפון",
      externalOrderId: "PO-41",
      status: "CONFIRMED",
      orderDate: now,
      createdAt: now,
      lines: [
        { id: 1, orderedQty: 12, unitCost: 8, receivedQty: 0, openQty: 12 },
        { id: 2, orderedQty: 6, unitCost: 4, receivedQty: 0, openQty: 6 },
      ],
    },
    {
      id: 42,
      supplierId: 3,
      supplierName: "מחלבה",
      externalOrderId: "PO-42",
      status: "SENT",
      orderDate: now,
      createdAt: now,
      lines: [{ id: 3, orderedQty: 4, unitCost: 15, receivedQty: 0, openQty: 4 }],
    },
  ];
}

function purchaseDrafts() {
  if (mode === "empty") return [];
  return [
    {
      id: 7,
      supplierName: "ספק הצפון",
      status: "PENDING_REVIEW",
      createdAt: now,
      lines: [
        { id: 11, rawName: "חלב 3%", quantity: 12, unitType: "UNIT", matchedItemId: 1 },
        { id: 12, rawName: "לחם", quantity: 6, unitType: "UNIT", matchedItemId: null },
      ],
    },
    {
      id: 8,
      supplierName: "מחלבה",
      status: "APPROVED",
      createdAt: now,
      lines: [{ id: 21, rawName: "יוגורט", quantity: 8, decision: "CREATE_NEW" }],
    },
  ];
}

function thread() {
  return {
    customer: { id: 7, name: "יוסי כהן", phone: "0500000000" },
    businessName: "המכולת",
    totals: { outstanding: "450.00", currency: "ILS", openInvoices: 1 },
    openInvoices: [{ id: 15, number: "1008", outstanding: "450.00", currency: "ILS" }],
    events: [
      { kind: "INVOICE_ISSUED", at: now, invoiceId: 15, number: "1008", amount: "450.00", currency: "ILS", outstanding: "450.00" },
      { kind: "REQUEST_CREATED", at: now, requestId: 3, amount: "450.00", currency: "ILS", invoiceId: 15, invoiceNumber: "1008", status: "PENDING", paymentUrl: "https://pay.example/qa" },
      { kind: "PAYMENT_FAILED", at: now, requestId: 2, amount: "120.00", currency: "ILS" },
      { kind: "PAYMENT_VERIFIED", at: now, requestId: 1, paymentTransactionId: 9, amount: "80.00", currency: "ILS", accounting: "RECEIPTED", attentionReason: null },
    ],
  };
}

function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const empty = mode === "empty";

  if (p === "/api/inventory/items") return json({ items: empty ? [] : items });
  if (p === "/api/inventory/categories") return json({ categories: [{ id: 1, name: "מכולת" }] });
  if (p === "/api/inventory/alerts") {
    return json({
      alerts: empty
        ? []
        : [
            { id: 1, type: "CRITICAL_STOCK", message: "נשארו 0", isResolved: false, createdAt: now, item: { id: 1, name: "חלב 3%", currentQuantity: 0 } },
            { id: 2, type: "LOW_STOCK", message: "נשארו 3", isResolved: false, createdAt: now, item: { id: 2, name: "לחם אחיד", currentQuantity: 3 } },
            { id: 3, type: "UNMATCHED_POS_PRODUCT", message: "מכירה לא זוהתה", isResolved: false, createdAt: now, item: null },
          ],
    });
  }
  if (p === "/api/inventory/drafts") {
    return json({
      drafts: empty
        ? []
        : [
            {
              id: 5,
              detectedName: "יוגורט טבעי",
              detectedCategory: "חלב",
              detectedBarcode: "7290001111111",
              detectedUnitType: "UNIT",
              confidenceScore: 0.91,
              status: "PENDING_REVIEW",
              matches: [{ itemId: 1, itemName: "חלב 3%", matchScore: 0.4, reason: "קטגוריה" }],
            },
          ],
    });
  }
  if (p === "/api/inventory/unmatched") {
    return json({
      pendingMatches: empty
        ? []
        : [
            {
              id: 9,
              businessId: 1,
              externalSaleId: "SALE-9",
              status: "PENDING",
              createdAt: now,
              metadata: { externalSaleId: "SALE-9", sku: null, barcode: "729000000001", name: "חלב 3%", quantity: 2, source: "POS" },
            },
          ],
    });
  }
  if (p === "/api/inventory/purchase-orders") return json({ purchaseOrders: orders() });
  if (p === "/api/inventory/supplier-purchases") return json({ drafts: purchaseDrafts() });
  if (p === "/api/collection/readiness") return json({ ready: true, blockers: [] });
  if (p === "/api/customers") return json({ customers: [{ id: 7, name: "יוסי כהן" }] });
  if (p === "/api/collection/customers/7") return json(thread());
  if (p === "/api/collection/inbox") {
    return json({
      businessName: "המכולת",
      summary: {
        toCollect: { amount: "450.00", count: 1, currency: "ILS" },
        waiting: { amount: "450.00", count: 1 },
        attention: { count: 1 },
        paidRecent: { amount: "80.00", count: 1 },
      },
      toCollect: [],
      waiting: [],
      attention: [],
      paid: [],
      paidNextBefore: null,
    });
  }
  if (p.startsWith("/api/")) return json({});
  return route.continue();
}

const shots = [];

async function snap(page, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      overflow: de.scrollWidth > de.clientWidth + 2,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
      ops: box(".inv-ops"),
      side: box(".inv-ops__side"),
      attn: box(".inv-hm-attn-desk"),
      create: box(".col-create"),
      thread: box(".col-thread"),
      pick: box(".col-thread__pick"),
    };
  });
  return { file, metrics };
}

async function shoot(page, dir, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(400);
  const result = await snap(page, dir, `${label}-${width}`);
  shots.push({ domain: path.basename(dir), label, width, overflow: result.metrics.overflow, text: result.metrics.text, boxes: result.metrics });
  console.log(path.basename(dir), label, width, result.metrics.overflow ? "OVERFLOW" : "ok", result.metrics.text.slice(0, 80));
}

async function open(page, routePath) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => (document.body.innerText || "").trim().length > 20, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(500);
      return;
    } catch (error) {
      last = error;
      await page.waitForTimeout(1500);
    }
  }
  throw last;
}

async function clickRow(page) {
  const row = page.locator("tbody tr").first();
  if (await row.count()) await row.click().catch(() => {});
  await page.waitForTimeout(250);
}

const ALL = [390, 768, 1024, 1280, 1440, 1600, 1920];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "he-IL" });
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA", businessId: 1 }));
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

const inv = path.join(ROOT, "inventory");
const col = path.join(ROOT, "collection-create");
const pay = path.join(ROOT, "payments");

mode = "populated";
await open(page, "/inventory");
for (const width of [390, 768, 1024, 1280, 1600, 1920]) await shoot(page, inv, "home-populated", width);
await page.setViewportSize({ width: 1440, height: 900 });
await clickRow(page);
await shoot(page, inv, "home-selected", 1440);

mode = "empty";
await open(page, "/inventory");
for (const width of [390, 1280]) await shoot(page, inv, "home-empty", width);

mode = "populated";
await open(page, "/inventory/alerts");
for (const width of [390, 1024, 1280]) await shoot(page, inv, "alerts", width);
await page.setViewportSize({ width: 1440, height: 900 });
await clickRow(page);
await shoot(page, inv, "alerts-selected", 1440);
mode = "empty";
await open(page, "/inventory/alerts");
await shoot(page, inv, "alerts-empty", 1280);

mode = "populated";
await open(page, "/inventory/drafts");
await shoot(page, inv, "drafts", 390);
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + "/inventory/drafts", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
await clickRow(page);
await shoot(page, inv, "drafts-selected", 1440);

await open(page, "/inventory/unmatched");
await shoot(page, inv, "unmatched", 390);
await page.setViewportSize({ width: 1440, height: 900 });
await open(page, "/inventory/unmatched");
await clickRow(page);
await shoot(page, inv, "unmatched-selected", 1440);

await open(page, "/inventory/supplier-purchases");
await shoot(page, inv, "purchases", 390);
await page.setViewportSize({ width: 1440, height: 900 });
await open(page, "/inventory/supplier-purchases");
await clickRow(page);
await shoot(page, inv, "purchases-selected", 1440);
await shoot(page, inv, "purchases-selected", 1600);

await open(page, "/inventory/supplier-purchases/pending");
await page.setViewportSize({ width: 1440, height: 900 });
await clickRow(page);
await shoot(page, inv, "pending-selected", 1440);
await open(page, "/inventory/supplier-purchases/history");
await clickRow(page);
await shoot(page, inv, "history-selected", 1280);
await open(page, "/inventory/supplier-purchases/new");
await shoot(page, inv, "order-new", 1280);
await shoot(page, inv, "order-new", 390);
await open(page, "/inventory/count");
await shoot(page, inv, "count-empty", 390);
await shoot(page, inv, "count-empty", 1440);
await open(page, "/inventory/sales");
await shoot(page, inv, "sales", 1280);
await open(page, "/inventory/items/create");
await shoot(page, inv, "create-item", 1280);
await shoot(page, inv, "create-item", 390);
await open(page, "/inventory/sales/create");
await shoot(page, inv, "create-sale", 1440);

mode = "populated";
await open(page, "/collection/new");
for (const width of [390, 768, 1280, 1920]) await shoot(page, col, "entry", width);
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole("option", { name: "יוסי כהן" }).click();
await page.waitForTimeout(700);
await shoot(page, col, "customer-selected", 1440);
await page.locator("#amount").fill("99999");
await page.waitForTimeout(200);
await shoot(page, col, "validation", 1440);
await page.locator("#amount").fill("200");
await page.waitForTimeout(200);
await shoot(page, col, "configured", 1440);
await page.setViewportSize({ width: 390, height: 900 });
await shoot(page, col, "configured", 390);

await open(page, "/payments");
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(800);
await shoot(page, pay, "overview-redirect", 1280);
await open(page, "/collection/c/7");
for (const width of [390, 1024, 1280, 1920]) await shoot(page, pay, "thread", width);
await page.setViewportSize({ width: 1440, height: 900 });
await clickRow(page);
await shoot(page, pay, "thread-selected", 1440);
await page.locator("tbody tr").nth(2).click().catch(() => {});
await page.waitForTimeout(200);
await shoot(page, pay, "thread-failed", 1600);

await browser.close();
fs.writeFileSync(path.join(ROOT, "slice3-metrics.json"), JSON.stringify({ shots }, null, 2));
const overflow = shots.filter((s) => s.overflow);
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length);
if (overflow.length) console.log(overflow.map((s) => `${s.domain}/${s.label}-${s.width}`).join(", "));
