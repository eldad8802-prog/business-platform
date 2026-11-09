/**
 * Gmail email screen — B4 manual import of possibly-relevant / low-score files (2026-11-09).
 *
 * LOCAL server, every /api call intercepted (no Google account, database or Production; no real
 * import). Mobile (390×844) and desktop (1440×900). Proves: recommended files still import in one
 * tap; possibly-relevant and low-score files show "קלוט בכל זאת"; cancelling the confirmation sends
 * nothing; confirming sends exactly the existing import request, once (even on a double tap); the
 * status survives "טען עוד"; bulk import never includes these groups; a server refusal (e.g. an
 * unsupported file) is shown clearly and the file stays un-imported; the screens stay tidy.
 *
 *   QA_BASE_URL=http://localhost:3000 QA_SHOTS=/tmp/shots node scripts/qa/documents/gmail-b4-manual-import-qa.mjs
 */

import { chromium } from "playwright";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const SHOTS = process.env.QA_SHOTS || "";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const a = (messageId, partId, o = {}) => ({
  messageId, attachmentId: `att-${messageId}`, partId, filename: `${messageId}.pdf`, mimeType: "application/pdf",
  sizeBytes: 220_000, fromEmail: "billing@vendor.example", fromName: "Vendor", subject: "Your invoice", sentAt: "2026-11-01T09:00:00.000Z", ...o,
});
const REC = a("rec1", "1", { filename: "invoice-nov.pdf", fromName: "Kamatera", fromEmail: "billing@kamatera.com" });   // recommended
const REC2 = a("rec2", "2", { filename: "receipt-oct.pdf" });                                                          // recommended
const POS = a("pos1", "1", { filename: "scan-from-phone.jpg", mimeType: "image/jpeg", subject: "Photo", fromName: "רואה החשבון", fromEmail: "office@cpa.example" }); // possible (35)
const LOW = a("low1", "root", { filename: "statement.png", mimeType: "image/png", sizeBytes: 9_000, subject: "Hi", fromName: null, fromEmail: "noreply@bank.example" }); // low (0)
const NEXT = a("rec3", "1", { filename: "invoice-sep.pdf" });
const key = (x) => `${x.messageId}:part:${x.partId}`;
const pageBody = (attachments, o = {}) => ({
  success: true, status: "complete", window: 30, pageComplete: true, scannedMessages: 25, scannedTotal: 25, capReached: false,
  hasMore: true, nextCursor: "gsc1.NEXT", retryCursor: null, attachmentParts: attachments.length, unsupportedType: 0, attachments, ...o,
});

async function open(browser, vp, { importReply = () => ({ status: 200, json: { success: true, imported: true, documentId: 501 } }), importDelay = 0 } = {}) {
  const context = await browser.newContext({ viewport: vp, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const calls = { scan: [], imports: [] };
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === "/api/integrations/gmail/status") return route.fulfill({ json: { success: true, connected: true, emailAddress: "owner@example.com", connections: [{ id: 7, emailAddress: "owner@example.com", status: "connected" }] } });
    if (p === "/api/integrations/gmail/scan") {
      calls.scan.push(Object.fromEntries(u.searchParams));
      const body = calls.scan.length === 1 ? pageBody([REC, REC2, POS, LOW]) : pageBody([NEXT, POS], { scannedTotal: 50, hasMore: false, nextCursor: null });
      return route.fulfill({ json: body });
    }
    if (p === "/api/integrations/gmail/import") {
      const body = JSON.parse(route.request().postData() || "{}");
      calls.imports.push(body);
      if (importDelay) await new Promise((r) => setTimeout(r, importDelay));
      const r = importReply(body);
      return route.fulfill({ status: r.status, json: r.json });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email`, { waitUntil: "domcontentloaded" });
  await page.locator(".dz-email-scan-button >> visible=true").click({ timeout: 90_000 });
  await page.locator(".dz-email-completion >> visible=true").waitFor({ timeout: 30_000 });
  return { context, page, calls };
}
const desk = (vp) => vp.width >= 1200;
const rowOf = (page, vp, x) => page.locator(`${desk(vp) ? "tr" : ".dz-email-card"}[data-key="${key(x)}"] >> visible=true`);
const anyway = (page, vp, x) => rowOf(page, vp, x).locator(".dz-email-card-import-anyway");
const confirmBox = (page) => page.locator(".dz-email-confirm-one >> visible=true");
const text = (page) => page.evaluate(() => document.body.innerText);

const browser = await chromium.launch();
try {
  for (const [label, vp] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]]) {
    console.log(`\n== ${label} ==`);

    // 1–5, 10: recommended unchanged; possible + low show the button; cancel → nothing; confirm → the existing request.
    {
      const { context, page, calls } = await open(browser, vp);
      await rowOf(page, vp, REC).locator("button").click();
      await rowOf(page, vp, REC).locator("text=נקלט").waitFor({ timeout: 10_000 });
      check(`${label}: 1. a recommended file still imports in one tap (no confirmation)`, calls.imports.length === 1 && calls.imports[0].messageId === "rec1" && (await confirmBox(page).count()) === 0);
      check(`${label}: 2. a possibly-relevant file shows "קלוט בכל זאת"`, (await anyway(page, vp, POS).count()) === 1 && (await anyway(page, vp, POS).innerText()).includes("קלוט בכל זאת"));
      await page.locator(".dz-email-low-toggle >> visible=true").click();
      check(`${label}: 3. a low-score file shows "קלוט בכל זאת" once the group is opened`, (await anyway(page, vp, LOW).count()) === 1);

      await anyway(page, vp, POS).click();
      let t = await text(page);
      check(`${label}: possible → its own warning, with "ביטול" and "קלוט לבדיקה"`, t.includes("המערכת לא זיהתה בוודאות שהקובץ הוא מסמך פיננסי. האם לקלוט אותו לבדיקה?") && (await confirmBox(page).count()) === 1);
      if (SHOTS) await rowOf(page, vp, POS).screenshot({ path: path.join(SHOTS, `b4-${label}-confirm-possible.png`) }).catch(() => {});
      await page.locator(".dz-email-confirm-one-no >> visible=true").click();
      await page.waitForTimeout(500);
      check(`${label}: 4. cancelling sends no import`, calls.imports.length === 1 && (await confirmBox(page).count()) === 0 && (await anyway(page, vp, POS).count()) === 1);

      await anyway(page, vp, LOW).click();
      t = await text(page);
      check(`${label}: low score → the stronger warning`, t.includes("המערכת מעריכה שהקובץ כנראה אינו מסמך פיננסי. אם אתה מזהה אותו כמסמך שקשור לעסק, אפשר לקלוט אותו לבדיקה."));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b4-${label}-confirm-low.png`), fullPage: !desk(vp) });
      await page.locator(".dz-email-confirm-one-yes >> visible=true").click();
      await rowOf(page, vp, LOW).locator("text=נקלט").waitFor({ timeout: 10_000 });
      const req = calls.imports[1] || {};
      check(`${label}: 5. confirming sends the existing import request (same fields, partId "root", the results' account)`, calls.imports.length === 2 && req.messageId === "low1" && req.partId === "root" && req.connectionId === 7 && req.attachmentId === LOW.attachmentId && JSON.stringify(Object.keys(req).sort()) === JSON.stringify(["attachmentId", "connectionId", "filename", "fromEmail", "messageId", "mimeType", "partId", "sentAt", "sizeBytes", "subject"]), JSON.stringify(req));
      check(`${label}: 10. the imported file shows "נקלט · בתור" (the regular review queue)`, (await rowOf(page, vp, LOW).innerText()).includes("נקלט · בתור"));
      await context.close();
    }

    // 6–7: a double tap sends one request; status survives "טען עוד".
    {
      const { context, page, calls } = await open(browser, vp, { importDelay: 1200 });
      await anyway(page, vp, POS).click();
      await page.locator(".dz-email-confirm-one-yes >> visible=true").dblclick();
      await page.waitForTimeout(300);
      check(`${label}: 6. a double tap sends a single import request`, calls.imports.length === 1, String(calls.imports.length));
      await rowOf(page, vp, POS).locator("text=נקלט").waitFor({ timeout: 10_000 });
      await page.locator(".dz-email-load-more >> visible=true").click();
      await page.waitForFunction(() => document.body.innerText.includes("נסרקו 50 הודעות"), null, { timeout: 30_000 });
      check(`${label}: 7. status kept after "טען עוד" (POS repeats on page 2, still one row, still imported)`, (await rowOf(page, vp, POS).count()) === 1 && (await rowOf(page, vp, POS).innerText()).includes("נקלט") && calls.imports.length === 1);
      await context.close();
    }

    // 8: bulk import = recommended only.
    {
      const { context, page, calls } = await open(browser, vp);
      const bulk = page.locator(".dz-email-import-all >> visible=true");
      check(`${label}: 8a. bulk button counts the 2 recommended files only`, (await bulk.innerText()).includes("(2)"));
      await bulk.click();
      await page.locator(".dz-email-confirm-import >> visible=true").click();
      await page.waitForFunction(() => document.body.innerText.includes("נקלט"), null, { timeout: 15_000 });
      await page.waitForTimeout(1500);
      check(`${label}: 8b. bulk import sent only the recommended files`, JSON.stringify(calls.imports.map((r) => r.messageId).sort()) === JSON.stringify(["rec1", "rec2"]));
      check(`${label}: possible / low still offer their own button afterwards`, (await anyway(page, vp, POS).count()) === 1);
      await context.close();
    }

    // 9, 11: the server refuses (unsupported content) → clear error, file not imported.
    {
      const { context, page, calls } = await open(browser, vp, {
        importReply: (body) => body.messageId === "low1"
          ? { status: 400, json: { error: "סוג הקובץ אינו נתמך. אפשר לקלוט PDF, JPG או PNG." } }
          : { status: 200, json: { success: true, imported: true, documentId: 9 } },
      });
      await page.locator(".dz-email-low-toggle >> visible=true").click();
      await anyway(page, vp, LOW).click();
      await page.locator(".dz-email-confirm-one-yes >> visible=true").click();
      await page.locator("[role=alert] >> visible=true").first().waitFor({ timeout: 10_000 });
      const t = await text(page);
      check(`${label}: 9 + 11. a server refusal is shown clearly (file + reason) and the file is not imported`, calls.imports.length === 1 && t.includes("statement.png") && t.includes("סוג הקובץ אינו נתמך") && (await rowOf(page, vp, LOW).innerText()).includes("נכשל"));
      await context.close();
    }

    // 13: tidy at this width.
    {
      const { context, page } = await open(browser, vp);
      await page.locator(".dz-email-low-toggle >> visible=true").click();
      await anyway(page, vp, POS).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label}: 13. no sideways scroll with a confirmation open`, overflow <= 1, String(overflow));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b4-${label}-groups.png`), fullPage: !desk(vp) });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
