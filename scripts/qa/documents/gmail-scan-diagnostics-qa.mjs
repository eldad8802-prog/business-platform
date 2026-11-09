/**
 * Gmail email screen — scan diagnostics regression (2026-11-08; updated for B3-b 2026-11-09).
 *
 * Drives /documents/email in a real browser against a LOCAL server with every
 * /api call intercepted (no Google account, database or Production).
 *
 *   QA_BASE_URL=http://localhost:3000 node scripts/qa/documents/gmail-scan-diagnostics-qa.mjs
 *
 * Proves: a failed OAuth callback stays visible (and no scan starts by itself);
 * the scan counts are shown under "פרטי הסריקה"; the empty state names its reason;
 * low-score files are kept out of the list until opened; possibly-relevant files
 * are read-only; the bulk import takes only recommended files after a confirmation;
 * the import request keys are exactly as before; an older /sync answer (basic scan)
 * without the counters falls back to what the list proves.
 *
 * B3-b changed on purpose (owner decisions 2026-11-09): no automatic scan, "סרוק
 * מסמכים" instead of "סרוק שוב", bulk import behind a confirmation, low-score files
 * visible in a collapsed group.
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const att = (id, filename, mimeType, sizeBytes, subject) => ({
  messageId: `m-${id}`, attachmentId: `a-${id}`, partId: "1", filename, mimeType, sizeBytes,
  fromEmail: "billing@vendor.example", subject, sentAt: "2026-11-01T09:00:00.000Z",
});
const A = att("A", "invoice-100.pdf", "application/pdf", 200_000, "Your invoice"); // 65 recommended
const C = att("C", "INV-1234.pdf", "application/pdf", 40_000, "Monthly statement"); // 35 possible
const E = att("E", "logo.png", "image/png", 5_000, "Newsletter");                   // -25 hidden
const T = att("T", "tiny.pdf", "application/pdf", 15_000, "Doc");                   // 15 hidden
// partId added deliberately by the import attachment-resolution fix (2026-11-08).
const IMPORT_KEYS = ["messageId", "attachmentId", "filename", "mimeType", "sizeBytes", "fromEmail", "subject", "sentAt", "partId"].sort();

const pageOf = (s) => ({
  success: true, status: "complete", pageComplete: true, window: 30, capReached: false, hasMore: false, nextCursor: null, retryCursor: null,
  scannedTotal: s.scannedMessages ?? 0, ...s,
});

async function open(browser, viewport, { query = "", scan, sync, connected = true, unavailable = false }) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const calls = { scan: 0, sync: 0, imports: [] };
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/integrations/gmail/status") {
      return route.fulfill({ json: connected
        ? { success: true, connected: true, emailAddress: "old@example.com", connections: [{ id: 7, emailAddress: "old@example.com", status: "connected" }] }
        : { success: true, connected: false, connections: [] } });
    }
    if (p === "/api/integrations/gmail/scan") {
      calls.scan += 1;
      if (unavailable) return route.fulfill({ status: 503, json: { success: false, status: "unavailable", code: "scan_unavailable" } });
      return route.fulfill({ json: pageOf(scan ?? {}) });
    }
    if (p === "/api/integrations/gmail/sync") { calls.sync += 1; return route.fulfill({ json: { success: true, ...sync } }); }
    if (p === "/api/integrations/gmail/import") {
      calls.imports.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, imported: true, documentId: 1 } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email${query}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  return { context, page, calls };
}
const text = (page) => page.locator("body").innerText();
async function scanNow(page) {
  await page.locator(".dz-email-scan-button >> visible=true").click();
  await page.locator(".dz-email-completion >> visible=true").waitFor({ timeout: 30_000 });
  const details = page.locator(".dz-email-scan-details >> visible=true");
  if (await details.count()) await details.locator("summary").click();
  await page.waitForTimeout(300);
}

async function suite(browser, label, viewport) {
  console.log(`\n== ${label} ==`);

  // 1. OAuth failure stays visible; no scan starts by itself; a manual scan does not wipe it
  {
    const { context, page, calls } = await open(browser, viewport, {
      query: "?error=gmail_state_invalid",
      scan: { scannedMessages: 10, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] },
    });
    await page.waitForTimeout(1500);
    check(`${label}: no automatic scan`, calls.scan === 0 && calls.sync === 0);
    await scanNow(page);
    const t = await text(page);
    check(`${label}: connect error still visible after a scan`, t.includes("החיבור החדש ל-Gmail לא הושלם") && t.includes("משהו נקטע באמצע החיבור ל-Gmail"));
    check(`${label}: names the account actually connected`, t.includes("הסריקה רצה על החשבון שהיה מחובר קודם: old@example.com"));
    check(`${label}: shows the failure code`, t.includes("קוד: gmail_state_invalid"));
    check(`${label}: URL query stripped (no replay on refresh)`, !page.url().includes("error="));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { query: "?error=<script>x</script>" });
    check(`${label}: unknown code shown as "unknown", never echoed`, (await text(page)).includes("קוד: unknown") && !(await page.content()).includes("<script>x"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { query: "?error=google_access_denied", connected: false });
    const t = await text(page);
    check(`${label}: failure while not connected — error + no "previous account" line`, t.includes("החיבור החדש ל-Gmail לא הושלם") && !t.includes("שהיה מחובר קודם"));
    await context.close();
  }
  {
    const { context, page, calls } = await open(browser, viewport, { query: "?connected=1" });
    const t = await text(page);
    check(`${label}: success path — notice says to scan, no error box, nothing scanned`, t.includes("חובר בהצלחה") && t.includes("סרוק מסמכים") && !t.includes("לא הושלם") && calls.scan === 0);
    await context.close();
  }

  // 2. empty state names its reason + counts
  {
    const { context, page } = await open(browser, viewport, { scan: { scannedMessages: 0, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] } });
    await scanNow(page);
    const t = await text(page);
    check(`${label}: no messages → own message + "נסרקו 0"`, t.includes("לא נמצאו קבצים מצורפים בהודעות שנסרקו") && t.includes("נסרקו 0 הודעות · נמצאו 0 קבצים מצורפים"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { scan: { scannedMessages: 7, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] } });
    await scanNow(page);
    check(`${label}: messages without attachments → own message`, (await text(page)).includes("נסרקו 7 הודעות, אבל לא נמצאו בהן קבצים מצורפים"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { scan: { scannedMessages: 10, foundAttachments: 2, attachmentParts: 5, unsupportedType: 3, attachments: [E, T] } });
    await scanNow(page);
    const t = await text(page);
    check(`${label}: only low-score files → collapsed group, nothing importable`, t.includes("ניקוד נמוך (2)") && !t.includes("logo.png") && !t.includes("מומלצים לקליטה"));
    check(`${label}: breakdown line`, t.includes("סוג קובץ לא נתמך: 3 · ניקוד נמוך (מתחת ל-20): 2 · אולי (20–44): 0 · מומלץ (45+): 0"));
    check(`${label}: "סרוק מסמכים" offered`, (await page.locator(".dz-email-scan-button >> visible=true").count()) === 1);
    await context.close();
  }

  // 3. groups + import
  {
    const { context, page, calls } = await open(browser, viewport, { scan: { scannedMessages: 4, foundAttachments: 3, attachmentParts: 4, unsupportedType: 1, attachments: [A, C, E] } });
    await scanNow(page);
    const t = await text(page);
    check(`${label}: summary + breakdown`, t.includes("נסרקו 4 הודעות · נמצאו 4 קבצים מצורפים") && t.includes("סוג קובץ לא נתמך: 1 · ניקוד נמוך (מתחת ל-20): 1 · אולי (20–44): 1 · מומלץ (45+): 1"));
    const possibleRow = page.locator(`${viewport.width >= 1200 ? "tr" : ".dz-email-card"}[data-key="m-C:part:1"] >> visible=true`);
    check(`${label}: low-score hidden until opened; possible shown read-only`, !t.includes("logo.png") && t.includes("INV-1234.pdf") && (await possibleRow.locator("button").count()) === 0);
    await page.locator(".dz-email-import-all >> visible=true").click();
    await page.locator(".dz-email-confirm-import >> visible=true").click();
    await page.waitForFunction(() => document.body.innerText.includes("נקלט"), null, { timeout: 15_000 });
    check(`${label}: bulk import (after confirmation) imports only the recommended row`, calls.imports.length === 1 && calls.imports[0].attachmentId === "a-A");
    check(`${label}: import body keys unchanged`, JSON.stringify(Object.keys(calls.imports[0]).filter((k) => k !== "connectionId").sort()) === JSON.stringify(IMPORT_KEYS));
    await context.close();
  }

  // 4. an older /sync answer (basic scan while the extended scan is unavailable) without the two counters
  {
    const { context, page, calls } = await open(browser, viewport, { unavailable: true, sync: { scannedMessages: 4, foundAttachments: 1, attachments: [A] } });
    await page.locator(".dz-email-scan-button >> visible=true").click();
    await page.locator(".dz-email-basic-scan >> visible=true").click();
    await page.waitForFunction(() => document.body.innerText.includes("invoice-100.pdf"), null, { timeout: 30_000 });
    const details = page.locator(".dz-email-scan-details >> visible=true");
    if (await details.count()) await details.locator("summary").click();
    check(`${label}: old /sync answer → counts fall back to the list`, calls.sync === 1 && (await text(page)).includes("נסרקו 4 הודעות · נמצאו 1 קבצים מצורפים"));
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  await suite(browser, "mobile", { width: 390, height: 844 });
  await suite(browser, "desktop", { width: 1366, height: 900 });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
