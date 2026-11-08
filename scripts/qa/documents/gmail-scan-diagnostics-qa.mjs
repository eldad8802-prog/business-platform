/**
 * Gmail email screen — scan diagnostics regression (2026-11-08).
 *
 * Drives /documents/email in a real browser against a LOCAL server with every
 * /api call intercepted (no Google account, database or Production).
 *
 *   QA_BASE_URL=http://localhost:3000 node scripts/qa/documents/gmail-scan-diagnostics-qa.mjs
 *
 * Proves: a failed OAuth callback stays visible after the automatic scan; the
 * scan counts are shown; the empty state names its reason (no messages / no
 * attachments / all filtered); the list, the import buttons and the import
 * request are exactly as before.
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const att = (id, filename, mimeType, sizeBytes, subject) => ({
  messageId: `m-${id}`, attachmentId: `a-${id}`, filename, mimeType, sizeBytes,
  fromEmail: "billing@vendor.example", subject, sentAt: "2026-11-01T09:00:00.000Z",
});
const A = att("A", "invoice-100.pdf", "application/pdf", 200_000, "Your invoice"); // 65 recommended
const C = att("C", "INV-1234.pdf", "application/pdf", 40_000, "Monthly statement"); // 35 possible
const E = att("E", "logo.png", "image/png", 5_000, "Newsletter");                   // -25 hidden
const T = att("T", "tiny.pdf", "application/pdf", 15_000, "Doc");                   // 15 hidden
// partId added deliberately by the import attachment-resolution fix (2026-11-08).
const IMPORT_KEYS = ["messageId", "attachmentId", "filename", "mimeType", "sizeBytes", "fromEmail", "subject", "sentAt", "partId"].sort();

async function open(browser, viewport, { query = "", sync, connected = true }) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const calls = { sync: 0, imports: [] };
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/integrations/gmail/status") {
      return route.fulfill({ json: connected
        ? { success: true, connected: true, emailAddress: "old@example.com", connections: [{ id: 7, emailAddress: "old@example.com", status: "connected" }] }
        : { success: true, connected: false, connections: [] } });
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
  if (connected) await page.waitForFunction(() => !document.body.innerText.includes("סורק מיילים..."), null, { timeout: 30_000 });
  await page.waitForTimeout(600);
  return { context, page, calls };
}
const text = (page) => page.locator("body").innerText();

async function suite(browser, label, viewport) {
  console.log(`\n== ${label} ==`);

  // 1. OAuth failure stays visible after the automatic scan
  {
    const { context, page, calls } = await open(browser, viewport, {
      query: "?error=gmail_state_invalid",
      sync: { scannedMessages: 10, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] },
    });
    await page.waitForTimeout(1500);
    const t = await text(page);
    check(`${label}: automatic scan still ran`, calls.sync === 1);
    check(`${label}: connect error still visible after the scan`, t.includes("החיבור החדש ל-Gmail לא הושלם") && t.includes("משהו נקטע באמצע החיבור ל-Gmail"));
    check(`${label}: names the account actually scanned`, t.includes("הסריקה רצה על החשבון שהיה מחובר קודם: old@example.com"));
    check(`${label}: shows the failure code`, t.includes("קוד: gmail_state_invalid"));
    check(`${label}: URL query stripped (no replay on refresh)`, !page.url().includes("error="));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { query: "?error=<script>x</script>", sync: { scannedMessages: 0, attachments: [] } });
    check(`${label}: unknown code shown as "unknown", never echoed`, (await text(page)).includes("קוד: unknown") && !(await page.content()).includes("<script>x"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { query: "?error=google_access_denied", connected: false, sync: {} });
    const t = await text(page);
    check(`${label}: failure while not connected — error + no "previous account" line`, t.includes("החיבור החדש ל-Gmail לא הושלם") && !t.includes("שהיה מחובר קודם"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { query: "?connected=1", sync: { scannedMessages: 3, attachmentParts: 1, unsupportedType: 0, attachments: [A] } });
    const t = await text(page);
    check(`${label}: success path — notice, no error box`, t.includes("חובר בהצלחה") && !t.includes("לא הושלם"));
    await context.close();
  }

  // 2. empty state names its reason + counts
  {
    const { context, page } = await open(browser, viewport, { sync: { scannedMessages: 0, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] } });
    const t = await text(page);
    check(`${label}: no messages → own message + "נסרקו 0"`, t.includes("Gmail לא החזיר הודעות עם קבצים מצורפים") && t.includes("נסרקו 0 הודעות · נמצאו 0 קבצים מצורפים"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { sync: { scannedMessages: 7, foundAttachments: 0, attachmentParts: 0, unsupportedType: 0, attachments: [] } });
    check(`${label}: messages without attachments → own message`, (await text(page)).includes("נסרקו 7 הודעות, אבל לא נמצאו בהן קבצים מצורפים"));
    await context.close();
  }
  {
    const { context, page } = await open(browser, viewport, { sync: { scannedMessages: 10, foundAttachments: 2, attachmentParts: 5, unsupportedType: 3, attachments: [E, T] } });
    const t = await text(page);
    check(`${label}: all filtered → reasons with counts`, t.includes("נמצאו 5 קבצים מצורפים, אבל כולם סוננו: 3 מסוג קובץ לא נתמך, 2 עם ניקוד נמוך"));
    check(`${label}: breakdown line`, t.includes("סוג קובץ לא נתמך: 3 · ניקוד נמוך (מתחת ל-20): 2 · אולי (20–44): 0 · מומלץ (45+): 0"));
    check(`${label}: "סרוק שוב" still offered`, (await page.getByRole("button", { name: "סרוק שוב" }).count()) === 1);
    await context.close();
  }

  // 3. list + import unchanged
  {
    const { context, page, calls } = await open(browser, viewport, { sync: { scannedMessages: 4, foundAttachments: 3, attachmentParts: 4, unsupportedType: 1, attachments: [A, C, E] } });
    const t = await text(page);
    check(`${label}: summary + breakdown with visible rows`, t.includes("נסרקו 4 הודעות · נמצאו 4 קבצים מצורפים") && t.includes("סוג קובץ לא נתמך: 1 · ניקוד נמוך (מתחת ל-20): 1 · אולי (20–44): 1 · מומלץ (45+): 1"));
    check(`${label}: rows as before — hidden not shown, possible still "לא מסמך"`, !t.includes("logo.png") && t.includes("INV-1234.pdf") && t.includes("לא מסמך"));
    const btn = viewport.width >= 1200 ? page.locator("button.dz-email-import") : page.locator(".dz-email-bottom button");
    await btn.first().evaluate((el) => el.click()); // the mobile bar may sit under the shell nav (pre-existing; PR #1000)
    await page.waitForFunction(() => !document.body.innerText.includes("מייבא..."), null, { timeout: 15_000 });
    check(`${label}: "ייבא הכל" imports only the recommended row`, calls.imports.length === 1 && calls.imports[0].attachmentId === "a-A");
    check(`${label}: import body keys unchanged`, JSON.stringify(Object.keys(calls.imports[0]).filter((k) => k !== "connectionId").sort()) === JSON.stringify(IMPORT_KEYS));
    await context.close();
  }

  // 4. an older server (skew-pinned client) without the two counters
  {
    const { context, page } = await open(browser, viewport, { sync: { scannedMessages: 4, foundAttachments: 1, attachments: [A] } });
    check(`${label}: old server response → counts fall back to the list`, (await text(page)).includes("נסרקו 4 הודעות · נמצאו 1 קבצים מצורפים"));
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
