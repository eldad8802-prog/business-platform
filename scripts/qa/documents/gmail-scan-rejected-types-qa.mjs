/**
 * Gmail email screen — refused-by-type breakdown (2026-11-08 B1).
 *
 * LOCAL server, every /api call intercepted (no Google account, database or
 * Production). Proves the scan summary shows the non-zero refused groups in
 * Hebrew, hides the line when nothing was refused or the server is older, never
 * echoes an unknown key, and leaves the file list unchanged.
 *
 *   QA_BASE_URL=http://localhost:3000 node scripts/qa/documents/gmail-scan-rejected-types-qa.mjs
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const PDF = {
  messageId: "m-1", attachmentId: "a-1", partId: "2", filename: "invoice-100.pdf", mimeType: "application/pdf",
  sizeBytes: 200_000, fromEmail: "billing@vendor.example", subject: "Your invoice", sentAt: "2026-11-01T09:00:00.000Z",
};
const LINE = "פירוט הסוגים שלא נתמכו:";

async function run(browser, viewport, sync) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/integrations/gmail/status") return route.fulfill({ json: { success: true, connected: true, emailAddress: "owner@example.com", connections: [{ id: 7, emailAddress: "owner@example.com", status: "connected" }] } });
    // B3-b (2026-11-09): the screen scans through /scan, only after "סרוק מסמכים".
    if (p === "/api/integrations/gmail/scan") return route.fulfill({ json: { success: true, status: "complete", pageComplete: true, window: 30, scannedMessages: 5, scannedTotal: 5, capReached: false, hasMore: false, nextCursor: null, retryCursor: null, attachments: [PDF], ...sync } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email`, { waitUntil: "domcontentloaded" });
  await page.locator(".dz-email-scan-button >> visible=true").click({ timeout: 60_000 });
  await page.locator(".dz-email-scan-details summary >> visible=true").click({ timeout: 60_000 });
  await page.locator(".dz-email-scan-diag >> visible=true").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  const diag = await page.locator(".dz-email-scan-diag").first().innerText();
  const listed = await page.locator("text=invoice-100.pdf >> visible=true").count();
  await context.close();
  return { diag, listed };
}

const browser = await chromium.launch();
try {
  for (const [label, viewport] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1366, height: 900 }]]) {
    console.log(`\n== ${label} ==`);
    {
      const { diag, listed } = await run(browser, viewport, {
        attachmentParts: 5, unsupportedType: 4,
        rejectedByType: { pdf_mislabeled: 2, office: 1, zip: 0, calendar: 1, image_other: 0, other: 0 },
      });
      check(`${label}: breakdown line shown`, diag.includes(LINE));
      check(`${label}: non-zero groups in Hebrew, fixed order`, diag.includes("בשם PDF אך סומן בסוג אחר: 2 · Word / Excel / Office: 1 · הזמנת יומן: 1"));
      check(`${label}: zero groups omitted`, !diag.includes("ZIP / קובץ דחוס") && !diag.includes("תמונה בפורמט אחר") && !diag.includes("אחר: 0"));
      check(`${label}: existing summary + breakdown unchanged`, diag.includes("נסרקו 5 הודעות · נמצאו 5 קבצים מצורפים") && diag.includes("סוג קובץ לא נתמך: 4"));
      check(`${label}: file list unchanged (PDF still listed)`, listed > 0);
    }
    {
      const { diag } = await run(browser, viewport, { attachmentParts: 1, unsupportedType: 0, rejectedByType: { pdf_mislabeled: 0, office: 0, zip: 0, calendar: 0, image_other: 0, other: 0 } });
      check(`${label}: nothing refused → no breakdown line`, !diag.includes(LINE));
    }
    {
      const { diag } = await run(browser, viewport, { attachmentParts: 3, unsupportedType: 2 });
      check(`${label}: older server (no breakdown) → no line, no error`, !diag.includes(LINE) && diag.includes("סוג קובץ לא נתמך: 2"));
    }
    {
      const { diag } = await run(browser, viewport, { attachmentParts: 3, unsupportedType: 2, rejectedByType: { other: 2, "secret-invoice.pdf": 5 } });
      check(`${label}: unknown keys never shown`, diag.includes("אחר: 2") && !diag.includes("secret-invoice"));
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
