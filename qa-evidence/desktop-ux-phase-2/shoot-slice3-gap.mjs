/**
 * Gap shots for slice 3 compositions that the first pass did not capture:
 * import, integrations, send, receive, cart, confirm, count sheet, blockers, payments overview.
 * Mocks /api. Does not submit an order, a receipt, or a collection request.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = "2026-09-12T08:00:00.000Z";
let readiness = { ready: true, blockers: [] };

function item(id, name, qty) {
  return {
    id,
    name,
    currentQuantity: qty,
    minimumQuantity: 2,
    reorderPoint: 4,
    unitType: "UNIT",
    costPerUnit: 12,
    sellPricePerUnit: 18,
    barcode: `72900000000${id}`,
    sku: `SKU-${id}`,
    category: { id: 1, name: "מכולת" },
    supplierName: "ספק הצפון",
    isActive: true,
  };
}

const purchaseOrder = {
  id: 41,
  supplierId: 3,
  supplierName: "ספק הצפון",
  externalOrderId: "PO-41",
  status: "CONFIRMED",
  orderDate: now,
  createdAt: now,
  lines: [
    { id: 1, itemId: 1, rawName: "חלב 3%", orderedQty: 12, unitCost: 8, unitType: "UNIT", status: "OPEN", receivedQty: 0, openQty: 12 },
    { id: 2, itemId: 2, rawName: "לחם אחיד", orderedQty: 6, unitCost: 4, unitType: "UNIT", status: "OPEN", receivedQty: 0, openQty: 6 },
  ],
};

function fulfill(route) {
  const p = new URL(route.request().url()).pathname;
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (p === "/api/inventory/items") return json({ items: [item(1, "חלב 3%", 0), item(2, "לחם אחיד", 3)] });
  if (p === "/api/inventory/categories") return json({ categories: [{ id: 1, name: "מכולת" }] });
  if (p === "/api/inventory/purchase-orders/41") return json({ purchaseOrder });
  if (p === "/api/inventory/purchase-orders") return json({ purchaseOrders: [purchaseOrder] });
  if (p === "/api/inventory/supplier-purchases") {
    return json({
      drafts: [{
        id: 7,
        supplierName: "ספק הצפון",
        externalOrderId: "PO-7",
        status: "APPROVED",
        orderDate: now,
        createdAt: now,
        lines: [
          { id: 11, rawName: "חלב 3%", quantity: 12, unitType: "UNIT" },
          { id: 12, rawName: "לחם אחיד", quantity: 6, unitType: "UNIT" },
        ],
      }],
    });
  }
  if (p === "/api/collection/readiness") return json(readiness);
  if (p === "/api/customers") return json({ customers: [{ id: 7, name: "יוסי כהן" }] });
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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "he-IL" });
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA", businessId: 1 }));
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();
const failures = [];

async function go(routePath, needle) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction((text) => (document.body.innerText || "").includes(text), needle, { timeout: 90000 });
  await page.waitForTimeout(400);
}

async function shot(dir, name, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const file = path.join(ROOT, dir, `${name}-${width}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 160),
  }));
  console.log(name, width, info.overflow ? "OVERFLOW" : "ok", info.text);
  if (info.overflow) failures.push(`${name}-${width}`);
}

const inv = "inventory";
const col = "collection-create";
const pay = "payments";

await go("/inventory/supplier-purchases/import", "לפני שהמלאי משתנה");
await shot(inv, "import", 1280);
await shot(inv, "import", 390);

await go("/inventory/supplier-purchases/integrations", "אינטגרציות");
await shot(inv, "integrations", 1280);
await shot(inv, "integrations", 390);

await go("/inventory/supplier-purchases/7/send", "חלב");
await shot(inv, "send", 1280);
await shot(inv, "send", 390);

await go("/inventory/supplier-purchases/41/receive", "קבלת סחורה");
await shot(inv, "receive", 1280);
await shot(inv, "receive", 390);

await go("/inventory/supplier-purchases/new", "חלב");
await page.setViewportSize({ width: 1280, height: 900 });
await page.locator(".inv-desk-table button", { hasText: "הוסף" }).first().click();
await page.getByRole("button", { name: "המשך לעגלה" }).first().click();
await page.waitForFunction(() => (document.body.innerText || "").includes("המשך לאישור"), { timeout: 20000 });
await shot(inv, "order-cart", 1280);
await shot(inv, "order-cart", 390);
await page.setViewportSize({ width: 1280, height: 900 });
await page.getByRole("button", { name: "המשך לאישור" }).first().click();
await page.waitForFunction(() => (document.body.innerText || "").includes("לפני שליחה"), { timeout: 20000 });
await shot(inv, "order-confirm", 1280);

await go("/inventory/count", "סריקת מוצרים");
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole("button", { name: "סריקת מוצרים" }).click();
await page.getByLabel("הזנת ברקוד ידנית").fill("729000000001");
await page.getByRole("button", { name: "אישור" }).click();
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForFunction(() => (document.body.innerText || "").includes("הפרש"), { timeout: 15000 });
await shot(inv, "count-sheet", 1440);
await shot(inv, "count-sheet", 390);

readiness = { ready: false, blockers: ["NO_PAYMENT_PROVIDER"] };
await go("/collection/new", "צריך לחבר חברת סליקה");
await shot(col, "blockers", 1440);
await shot(col, "blockers", 390);

await go("/payments", "פתוחים");
await shot(pay, "overview-redirect", 1280);
await shot(pay, "overview-redirect", 390);

await browser.close();
if (failures.length) {
  console.log("OVERFLOW", failures.join(", "));
  process.exitCode = 1;
}
console.log("GAP_DONE");
