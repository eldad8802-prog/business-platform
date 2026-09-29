/**
 * Runtime visual QA for the Documents slice of Desktop UX Phase 2.
 * Mocks /api so the local app paints without a database.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const OUT = path.resolve("qa-evidence/desktop-ux-phase-2/documents");
fs.mkdirSync(OUT, { recursive: true });

let mode = "populated";
const now = "2026-09-12T08:00:00.000Z";

function inboxItem(i, status) {
  const vendors = ["דלק אלונים", "מכולת הגליל", "חשמל ועוד", "קפה למשרד", "אריזות הדרום", "הדפסות כחול"];
  const pending = status === "needs_review";
  return {
    documentId: i + 1,
    createdAt: now,
    groupMonth: "2026-09",
    status,
    source: i % 2 === 0 ? "upload" : "gmail",
    mimeType: "application/pdf",
    preview: { kind: "pdf", fileAvailable: true, thumbnailReady: false },
    extracted: pending
      ? {
          amount: 180 + i * 40,
          vendorName: vendors[i % vendors.length],
          date: "2026-09-10",
          direction: i % 3 === 0 ? "income" : "expense",
          category: i % 2 === 0 ? "fuel" : "general",
          confidenceScore: 0.9,
          amountConfidence: "high",
          vendorConfidence: "high",
          categoryConfidence: "medium",
        }
      : null,
    financial: pending
      ? undefined
      : {
          amount: 240 + i * 20,
          vendorName: vendors[i % vendors.length],
          date: "2026-09-08",
          direction: "expense",
          category: "general",
          approvedAt: now,
        },
    confidenceDots: { amount: "high", vendor: "high", dateProxy: "medium" },
    quickApprove: { eligible: pending && i % 2 === 0 },
  };
}

function inboxBody(summaryOnly) {
  const empty = mode === "empty";
  const pending = empty ? [] : [0, 1, 2, 3].map((i) => inboxItem(i, "needs_review"));
  const approved = empty ? [] : [4, 5].map((i) => inboxItem(i, "approved"));
  const items = summaryOnly ? [] : [...pending, ...approved];
  return {
    success: true,
    scope: { month: "2026-09", timezone: "Asia/Jerusalem" },
    pendingMonths: empty ? [] : ["2026-09"],
    financialPulse: {
      period: { month: "2026-09", from: now, toExclusive: now },
      fromFinancialRecords: {
        income: empty ? 0 : 4200,
        expense: empty ? 0 : 1800,
        net: empty ? 0 : 2400,
        recordCount: empty ? 0 : 6,
      },
      inboxDocumentCounts: {
        pendingReview: pending.length,
        approvedDocuments: empty ? 0 : 12,
        totalPendingReview: pending.length,
      },
    },
    previousNet: empty ? null : 900,
    nextPending: null,
    items,
    pagination: { limit: 30, nextCursor: null, hasMore: false },
  };
}

function searchResults() {
  if (mode === "empty") return { results: [] };
  const vendors = ["דלק אלונים", "מכולת הגליל", "חשמל ועוד", "קפה למשרד", "אריזות הדרום", "הדפסות כחול"];
  return {
    results: vendors.map((vendorName, i) => ({
      id: i + 1,
      documentId: i + 1,
      vendorName,
      category: i % 2 === 0 ? "fuel" : "general",
      amount: 120 + i * 35,
      date: "2026-09-08",
      direction: i % 3 === 0 ? "income" : "expense",
      document: { status: "approved", mimeType: "application/pdf", source: "upload", createdAt: now },
    })),
  };
}

function report() {
  if (mode === "empty") {
    return { totalIncome: 0, totalExpense: 0, profit: 0, categories: {}, count: 0 };
  }
  return {
    totalIncome: 18600,
    totalExpense: 9400,
    profit: 9200,
    count: 14,
    categories: { fuel: 2100, general: 4300, office: 3000 },
  };
}

function reviewDoc() {
  return {
    success: true,
    document: {
      id: 1,
      businessId: 1,
      fileUrl: "mock.pdf",
      source: "upload",
      mimeType: "application/pdf",
      status: "needs_review",
      createdAt: now,
    },
    extracted: {
      documentId: 1,
      amount: 348,
      vendorName: "דלק אלונים",
      category: "fuel",
      direction: "expense",
      date: "2026-09-10",
      confidenceScore: 0.92,
      amountConfidence: "high",
      vendorConfidence: "high",
      categoryConfidence: "medium",
    },
    outputProfile: {
      profileId: "financial_transaction",
      reviewMode: "full_financial",
      primaryFields: ["amount", "vendorName", "date", "direction", "category"],
      secondaryFields: [],
      hiddenFields: [],
    },
    outputProfileSource: "stored",
    outputProfileComputedAt: now,
    duplicateSignals: [],
    financialRecorded: false,
  };
}

function gmailStatus() {
  const connected = mode === "gmail-on" || (mode === "populated");
  if (!connected || mode === "gmail-off" || mode === "empty") {
    return { success: true, connected: false, emailAddress: "", connections: [] };
  }
  return {
    success: true,
    connected: true,
    emailAddress: "owner@gmail.com",
    connections: [{ id: 1, emailAddress: "owner@gmail.com", status: "connected", lastSyncedAt: now }],
  };
}

function gmailSync() {
  return {
    attachments: [
      {
        messageId: "m1",
        attachmentId: "a1",
        filename: "invoice-חשבונית.pdf",
        mimeType: "application/pdf",
        sizeBytes: 240000,
        fromEmail: "billing@supplier.co.il",
        subject: "חשבונית ספטמבר",
        sentAt: now,
      },
      {
        messageId: "m2",
        attachmentId: "a2",
        filename: "receipt-קבלה.pdf",
        mimeType: "application/pdf",
        sizeBytes: 180000,
        fromEmail: "fuel@example.co.il",
        subject: "קבלה",
        sentAt: now,
      },
      {
        messageId: "m3",
        attachmentId: "a3",
        filename: "statement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 320000,
        fromEmail: "bank@example.co.il",
        subject: "דף חשבון",
        sentAt: now,
      },
    ],
  };
}

async function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (p === "/api/documents/inbox") return json(inboxBody(url.searchParams.get("summaryOnly") === "1"));
  if (p === "/api/search") return json(searchResults());
  if (p === "/api/reports/summary") return json(report());
  if (/^\/api\/documents\/\d+$/.test(p)) return json(reviewDoc());
  if (/^\/api\/documents\/\d+\/file$/.test(p)) return json({ error: "missing" }, 404);
  if (p === "/api/integrations/gmail/status") return json(gmailStatus());
  if (p.startsWith("/api/integrations/gmail/sync")) return json(gmailSync());
  if (p.startsWith("/api/")) return json({});
  return route.continue();
}

const shots = [];

async function snap(page, name) {
  const file = path.join(OUT, `${name}.png`);
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
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 220),
      work: box(".dz-docs-work"),
      inspector: box(".dz-docs-inspector"),
      searchDesk: box(".dz-search-desk"),
      inboxDesk: box(".docs-inbox-desk"),
      review: box("[class*='reviewMain']"),
      email: box(".dz-email-desk, .dz-email-connect"),
      upload: box(".dz-upload-desk"),
      report: box(".dz-report-layout"),
      uniform: box(".dz-uniform-desk"),
      pack: box(".dz-pack-desk"),
    };
  });
  return { file, metrics };
}

async function shoot(page, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const result = await snap(page, `${label}-${width}`);
  shots.push({ label, width, overflow: result.metrics.overflow, text: result.metrics.text, boxes: result.metrics });
  console.log(label, width, result.metrics.overflow ? "OVERFLOW" : "ok", result.metrics.text.slice(0, 90));
}

async function open(page, routePath) {
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => (document.body.innerText || "").trim().length > 20, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

const ALL = [390, 768, 1024, 1280, 1440, 1600, 1920];
const DESK = [1280, 1440, 1600, 1920];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "he-IL" });
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA", businessId: 1 }));
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

if (process.env.QA_ONLY === "uniform") {
  mode = "populated";
  await open(page, "/documents/uniform-export");
  for (const w of [390, 1440]) await shoot(page, "docs-uniform", w);
  await browser.close();
  console.log("SHOTS", shots.length);
  process.exit(0);
}

mode = "empty";
await open(page, "/documents");
for (const w of ALL) await shoot(page, "docs-hub-empty", w);
await open(page, "/documents/search");
for (const w of [390, 1280, 1920]) await shoot(page, "docs-search-empty", w);
await open(page, "/documents/inbox");
for (const w of [390, 1280, 1920]) await shoot(page, "docs-inbox-empty", w);
await open(page, "/documents/dashboard");
for (const w of [390, 1280, 1920]) await shoot(page, "docs-report-empty", w);
await open(page, "/documents/upload");
for (const w of [390, 1280, 1920]) await shoot(page, "docs-upload-empty", w);
mode = "gmail-off";
await open(page, "/documents/email");
for (const w of [390, 1280, 1920]) await shoot(page, "docs-email-off", w);

mode = "populated";
await open(page, "/documents");
for (const w of ALL) await shoot(page, "docs-hub-populated", w);
await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".dz-docs-table tbody tr").first().click();
await page.waitForTimeout(200);
for (const w of DESK) await shoot(page, "docs-hub-selected", w);

if (process.env.QA_HUB === "1") {
  await open(page, "/documents/uniform-export");
  for (const w of [390, 1440, 1920]) await shoot(page, "docs-uniform", w);
  fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(shots, null, 2));
  await browser.close();
  console.log("SHOTS", shots.length);
  process.exit(0);
}

await open(page, "/documents/search");
for (const w of ALL) await shoot(page, "docs-search-populated", w);
await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".dz-search-table tbody tr").first().click();
await page.waitForTimeout(200);
for (const w of DESK) await shoot(page, "docs-search-selected", w);

await open(page, "/documents/inbox");
for (const w of ALL) await shoot(page, "docs-inbox-populated", w);
await page.setViewportSize({ width: 1440, height: 900 });
await page.locator(".docs-inbox-desktop tbody tr").first().click();
await page.waitForTimeout(200);
for (const w of DESK) await shoot(page, "docs-inbox-selected", w);

await open(page, "/documents/review/1");
for (const w of ALL) await shoot(page, "docs-review", w);

mode = "gmail-on";
await open(page, "/documents/email");
for (const w of ALL) await shoot(page, "docs-email-on", w);

mode = "populated";
await open(page, "/documents/upload");
for (const w of [390, 768, 1024, 1280, 1440, 1920]) await shoot(page, "docs-upload-populated", w);
await open(page, "/documents/dashboard");
for (const w of ALL) await shoot(page, "docs-report-populated", w);
await open(page, "/documents/uniform-export");
for (const w of ALL) await shoot(page, "docs-uniform", w);
await open(page, "/documents/accountant-pack");
for (const w of [1280, 1600, 1920]) await shoot(page, "docs-pack", w);

fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(shots, null, 2));
await browser.close();
const overflow = shots.filter((s) => s.overflow);
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length);
if (overflow.length) {
  console.log(overflow.map((s) => `${s.label}-${s.width}`).join(", "));
}
