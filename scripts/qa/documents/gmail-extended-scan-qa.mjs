/**
 * Gmail email screen — extended scan (B3-b, 2026-11-09).
 *
 * LOCAL server, every /api call intercepted (no Google account, no database, no Production, no real
 * scan or import). Mobile (390×844) and desktop (1440×900). Proves the owner's 14 required checks:
 * opening and choosing a period never scan; the scan uses the chosen period + account; "טען עוד"
 * appends without duplicates; import statuses survive; nothing that changes the list during an
 * import; partial / stopped / quota / expired are never shown as success and never wipe results;
 * low-score files are shown read-only; Hebrew + English names; the phone's import bar is never
 * under the shell navigation and the last card is reachable; import requests are unchanged; the
 * legacy /sync is used only by an explicit basic scan.
 *
 *   QA_BASE_URL=http://localhost:3000 QA_SHOTS=/tmp/shots node scripts/qa/documents/gmail-extended-scan-qa.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const SHOTS = process.env.QA_SHOTS || "";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const LONG = "חשבונית-מס-קבלה-INV-2026-000123-Kamatera-Cloud-Servers-November-2026-final-version.pdf";
const a = (messageId, partId, o = {}) => ({
  messageId, attachmentId: `att-${messageId}-${partId}-${o.v ?? 1}`, partId,
  filename: `${messageId}.pdf`, mimeType: "application/pdf", sizeBytes: 220_000,
  fromEmail: "billing@vendor.example", fromName: null, subject: "Your invoice", sentAt: "2026-11-01T09:00:00.000Z", ...o,
});
// Page 1: 3 recommended (one long Hebrew/English name), 1 possible (image), 2 low-score (tiny logos).
const PAGE1 = [
  a("m1", "1", { filename: LONG, fromName: "Kamatera", fromEmail: "billing@kamatera.com" }),
  a("m2", "root", { filename: "invoice-vercel-nov.pdf", fromName: "Vercel Inc.", fromEmail: "invoice@vercel.com" }),
  a("m3", "2", { filename: "קבלה-12.pdf", fromName: "חשבונית ירוקה", fromEmail: "noreply@greeninvoice.co.il" }),
  a("m4", "1", { filename: "photo-from-trip.jpg", mimeType: "image/jpeg", sizeBytes: 200_000, subject: "Photo" }),
  a("m5", "1", { filename: "logo.png", mimeType: "image/png", sizeBytes: 5_000, subject: "Newsletter" }),
  a("m6", "1", { filename: "signature.png", mimeType: "image/png", sizeBytes: 4_000, subject: "Hi" }),
];
// Page 2 repeats m2 (Gmail gave it a NEW attachment id) and adds two.
const PAGE2 = [
  a("m2", "root", { v: 2, filename: "invoice-vercel-nov.pdf", fromName: "Vercel Inc.", fromEmail: "invoice@vercel.com" }),
  a("m7", "1", { filename: "invoice-hosting-oct.pdf" }),
  a("m8", "3", { filename: "receipt-oct.pdf" }),
];
const pageBody = (attachments, o = {}) => ({
  success: true, status: "complete", window: 90, pageComplete: true, scannedMessages: 25, scannedTotal: 25,
  failedMessages: 0, capReached: false, hasMore: true, nextCursor: "gsc1.NEXT", retryCursor: null,
  foundAttachments: attachments.length, attachmentParts: attachments.length, unsupportedType: 0,
  rejectedByType: { pdf_mislabeled: 0, office: 0, zip: 0, calendar: 0, image_other: 0, other: 0 }, attachments, ...o,
});

/** A fresh page with a scripted /scan. `script` is a list of responses for successive /scan calls. */
async function open(browser, viewport, { script = [], accounts = 1, importDelay = 0 } = {}) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const calls = { scan: [], sync: [], imports: [] };
  const conns = [{ id: 7, emailAddress: "owner@example.com", status: "connected" }];
  if (accounts > 1) conns.push({ id: 8, emailAddress: "books@example.com", status: "connected" });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/integrations/gmail/status") return route.fulfill({ json: { success: true, connected: true, emailAddress: "owner@example.com", connections: conns } });
    if (p === "/api/integrations/gmail/scan") {
      calls.scan.push(Object.fromEntries(url.searchParams));
      const r = script[Math.min(calls.scan.length - 1, script.length - 1)] ?? { status: 200, json: pageBody([]) };
      return route.fulfill({ status: r.status ?? 200, json: r.json });
    }
    if (p === "/api/integrations/gmail/sync") {
      calls.sync.push(Object.fromEntries(url.searchParams));
      return route.fulfill({ json: { success: true, scannedMessages: 30, attachmentParts: 1, unsupportedType: 0, attachments: [a("m9", "1", { filename: "basic-scan-invoice.pdf" })] } });
    }
    if (p === "/api/integrations/gmail/import") {
      calls.imports.push(JSON.parse(route.request().postData() || "{}"));
      if (importDelay) await new Promise((r) => setTimeout(r, importDelay));
      return route.fulfill({ json: { success: true, imported: true, documentId: 100 + calls.imports.length } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email`, { waitUntil: "domcontentloaded" });
  await page.locator(".dz-email-scan-button").waitFor({ timeout: 90_000 });
  return { context, page, calls };
}

const vis = (page, sel) => page.locator(`${sel} >> visible=true`);
const isDesktop = (vp) => vp.width >= 1200;
/** The visible row of one attachment (card on the phone, table row on desktop). */
const row = (page, vp, key) => vis(page, isDesktop(vp) ? `tr[data-key="${key}"]` : `.dz-email-card[data-key="${key}"]`);
const keyOf = (x) => (x.partId ? `${x.messageId}:part:${x.partId}` : `${x.messageId}:${x.attachmentId}`);
async function texts(page) {
  return page.evaluate(() => document.body.innerText);
}

const browser = await chromium.launch();
try {
  for (const [label, vp] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]]) {
    console.log(`\n== ${label} ==`);

    // 1–3. No scan on open or on a period change; the scan uses the chosen period + account.
    {
      const { context, page, calls } = await open(browser, vp, { accounts: 2, script: [{ json: pageBody(PAGE1) }] });
      await page.waitForTimeout(2500);
      check(`${label}: 1. opening the screen does not scan`, calls.scan.length === 0 && calls.sync.length === 0);
      await vis(page, '[data-period="90"]').click();
      await vis(page, ".dz-email-account-chip >> text=books@example.com").click();
      await page.waitForTimeout(800);
      check(`${label}: 2. choosing a period / account does not scan`, calls.scan.length === 0 && calls.sync.length === 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b3b-${label}-0-before-scan.png`), fullPage: false });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-completion").waitFor({ timeout: 30_000 });
      check(`${label}: 3. "סרוק מסמכים" scans the chosen period and account`, calls.scan.length === 1 && calls.scan[0].window === "90" && calls.scan[0].connectionId === "8" && !calls.scan[0].cursor, JSON.stringify(calls.scan[0]));
      const body = await texts(page);
      check(`${label}: summary + "more to scan" (not "all scanned")`, body.includes("נסרקו 25 הודעות") && body.includes("יש עוד הודעות") && !body.includes("נסרקו כל ההודעות"));
      // 11. names in Hebrew and English, sender name + address, date.
      check(`${label}: 11. sender names (Hebrew + English) with their addresses`, body.includes("חשבונית ירוקה") && body.includes("Vercel Inc.") && body.includes("invoice@vercel.com") && body.includes("Kamatera"));
      check(`${label}: groups: recommended (3) and possible (1) open, low score (2) collapsed`, body.includes("מומלצים לקליטה (3)") && body.includes("אולי רלוונטיים (1)") && body.includes("ניקוד נמוך (2)") && (await row(page, vp, keyOf(PAGE1[4])).count()) === 0);
      if (!isDesktop(vp)) {
        const card = vis(page, `.dz-email-card[data-key="${keyOf(PAGE1[0])}"]`);
        const fit = await card.evaluate((el) => {
          const name = el.querySelector(".dz-email-card-name");
          const lh = parseFloat(getComputedStyle(name).lineHeight);
          return { overflowX: el.scrollWidth - el.clientWidth, lines: Math.round(name.getBoundingClientRect().height / lh), dir: name.getAttribute("dir") };
        });
        check(`${label}: long mixed-language filename: max 2 lines, no sideways overflow, dir=auto`, fit.overflowX <= 1 && fit.lines <= 2 && fit.dir === "auto", JSON.stringify(fit));
        const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`${label}: no sideways scroll on the page`, docOverflow <= 1, String(docOverflow));
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b3b-${label}-1-first-page.png`), fullPage: !isDesktop(vp) });
      await context.close();
    }

    // 4–6. Load more appends without duplicates; statuses survive; nothing changes during an import.
    {
      const { context, page, calls } = await open(browser, vp, {
        importDelay: 1800,
        script: [{ json: pageBody(PAGE1) }, { json: pageBody(PAGE2, { scannedTotal: 50, nextCursor: "gsc1.N3" }) }],
      });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-load-more").waitFor({ timeout: 30_000 });
      // Import m3 (slow): while it runs, load more / period / scan are disabled.
      await row(page, vp, keyOf(PAGE1[2])).locator("button").click();
      await page.waitForTimeout(300);
      const during = {
        loadMore: await vis(page, ".dz-email-load-more").isDisabled(),
        scan: await vis(page, ".dz-email-scan-button").isDisabled(),
        period: await vis(page, '[data-period="365"]').isDisabled(),
      };
      check(`${label}: 6. during an import: load more, scan and period are blocked`, during.loadMore && during.scan && during.period, JSON.stringify(during));
      await row(page, vp, keyOf(PAGE1[2])).locator("text=נקלט").waitFor({ timeout: 10_000 });
      await vis(page, ".dz-email-load-more").click();
      await page.waitForFunction(() => document.body.innerText.includes("נסרקו 50 הודעות"), null, { timeout: 30_000 });
      const keys = await page.evaluate((desk) => [...document.querySelectorAll(desk ? "tr[data-key]" : ".dz-email-card[data-key]")].filter((e) => e.offsetParent !== null).map((e) => e.getAttribute("data-key")), isDesktop(vp));
      check(`${label}: 4. "טען עוד" uses the server's cursor and appends without duplicates`, calls.scan[1]?.cursor === "gsc1.NEXT" && calls.scan[1]?.window === "30" && new Set(keys).size === keys.length && keys.includes(keyOf(PAGE2[1])) && keys.filter((k) => k === keyOf(PAGE1[1])).length === 1, JSON.stringify({ c: calls.scan[1], n: keys.length }));
      check(`${label}: 5. import status kept after loading more`, (await row(page, vp, keyOf(PAGE1[2])).locator("text=נקלט").count()) === 1);
      // 13. the import request is the existing one: same fields, partId (incl. root), the results' account.
      const req = calls.imports[0] || {};
      check(`${label}: 13. import request unchanged (fields + partId + account)`, req.messageId === "m3" && req.partId === "2" && req.connectionId === 7 && req.attachmentId === PAGE1[2].attachmentId && !("fromName" in req), JSON.stringify(req));
      await context.close();
    }

    // 7–8. Partial page: not success, results kept, retry = same page; then stopped.
    {
      const { context, page, calls } = await open(browser, vp, {
        script: [
          { json: pageBody(PAGE1) },
          { json: pageBody([PAGE2[1]], { success: false, status: "incomplete", pageComplete: false, nextCursor: null, retryCursor: "gsc1.SAME", scannedTotal: 25 }) },
          { json: pageBody([], { success: false, status: "stopped_unfinished", pageComplete: false, nextCursor: null, retryCursor: null, scannedTotal: 25 }) },
        ],
      });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-load-more").click();
      await vis(page, '.dz-email-completion[data-completion="incomplete"]').waitFor({ timeout: 30_000 });
      let body = await texts(page);
      check(`${label}: 7. a partial page is not shown as success`, body.includes("חלק מההודעות בעמוד האחרון לא נקראו") && !body.includes("נסרקו כל ההודעות") && (await vis(page, ".dz-email-load-more").count()) === 0);
      check(`${label}: 8. results kept after the partial page`, (await row(page, vp, keyOf(PAGE1[0])).count()) === 1 && (await row(page, vp, keyOf(PAGE2[1])).count()) === 1);
      await vis(page, ".dz-email-retry").click();
      await vis(page, '.dz-email-completion[data-completion="stopped"]').waitFor({ timeout: 30_000 });
      body = await texts(page);
      check(`${label}: retry asks for the SAME page; a stopped scan says so and keeps results`, calls.scan[2]?.cursor === "gsc1.SAME" && body.includes("הסריקה נעצרה ולא הושלמה") && (await row(page, vp, keyOf(PAGE1[0])).count()) === 1);
      await context.close();
    }

    // 9. Quota (wait shown, no auto-retry) and an expired cursor (results kept, restart offered).
    {
      const { context, page, calls } = await open(browser, vp, {
        script: [
          { json: pageBody(PAGE1) },
          { status: 429, json: { success: false, status: "budget_exhausted", code: "scan_budget_exhausted", retryCursor: "gsc1.NEXT" } },
          { status: 400, json: { error: "x", code: "scan_cursor_invalid", reason: "expired" } },
        ],
      });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-load-more").click();
      await vis(page, '.dz-email-completion[data-completion="budget"]').waitFor({ timeout: 30_000 });
      const body = await texts(page);
      const cont = vis(page, ".dz-email-continue");
      check(`${label}: 9a. Gmail quota: clear message + wait time, "המשך" disabled while waiting, results kept`, body.includes("הגענו למכסה הזמנית מול Gmail") && /אפשר להמשיך בעוד \d+ שניות/.test(body) && (await cont.isDisabled()) && (await row(page, vp, keyOf(PAGE1[0])).count()) === 1);
      await page.waitForTimeout(2500);
      check(`${label}: no automatic retry while waiting`, calls.scan.length === 2);
      await context.close();
      const second = await open(browser, vp, { script: [{ json: pageBody(PAGE1) }, { status: 400, json: { code: "scan_cursor_invalid" } }] });
      await vis(second.page, ".dz-email-scan-button").click();
      await vis(second.page, ".dz-email-load-more").click();
      await vis(second.page, '.dz-email-completion[data-completion="expired"]').waitFor({ timeout: 30_000 });
      check(`${label}: 9b. expired cursor: explained, results kept, "התחל סריקה חדשה" offered`, (await texts(second.page)).includes("תוקף הסריקה פג") && (await row(second.page, vp, keyOf(PAGE1[0])).count()) === 1 && (await vis(second.page, ".dz-email-restart").count()) === 1);
      await second.context.close();
    }

    // 10. Low score shown read-only; possible read-only.
    {
      const { context, page } = await open(browser, vp, { script: [{ json: pageBody(PAGE1) }] });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-low-toggle").waitFor({ timeout: 30_000 });
      await vis(page, ".dz-email-low-toggle").click();
      const low = row(page, vp, keyOf(PAGE1[4]));
      const poss = row(page, vp, keyOf(PAGE1[3]));
      check(`${label}: 10. low-score files visible after opening, with a reason, no import button`, (await low.count()) === 1 && (await low.locator("button").count()) === 0 && (await low.innerText()).includes("סיבה:"));
      check(`${label}: possibly-relevant files visible, no import button`, (await poss.count()) === 1 && (await poss.locator("button").count()) === 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b3b-${label}-2-groups.png`), fullPage: !isDesktop(vp) });
      await context.close();
    }

    // 12. Phone: the import bar is above the shell navigation; the last card is reachable above it.
    if (!isDesktop(vp)) {
      const { context, page } = await open(browser, vp, { script: [{ json: pageBody(PAGE1) }] });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, ".dz-email-bottom .dz-email-import-all").waitFor({ timeout: 30_000 });
      await vis(page, ".dz-email-low-toggle").click();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
      const geo = await page.evaluate(() => {
        const nav = document.querySelector('[data-component="shell-bottom-bar"]');
        const bar = document.querySelector(".dz-email-bottom");
        const cards = [...document.querySelectorAll(".dz-email-card")].filter((e) => e.offsetParent !== null);
        const last = cards[cards.length - 1];
        return {
          navTop: nav ? nav.getBoundingClientRect().top : null,
          barTop: bar.getBoundingClientRect().top,
          barBottom: bar.getBoundingClientRect().bottom,
          lastBottom: last ? last.getBoundingClientRect().bottom : null,
          barZ: getComputedStyle(bar).zIndex,
        };
      });
      check(`${label}: 12a. the import bar sits above the shell navigation`, geo.navTop !== null && geo.barBottom <= geo.navTop + 1, JSON.stringify(geo));
      check(`${label}: 12b. the last card is fully visible above the import bar`, geo.lastBottom !== null && geo.lastBottom <= geo.barTop + 1, JSON.stringify(geo));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `b3b-${label}-3-bottom.png`), fullPage: false });
      await context.close();
    }

    // Bulk import: confirmation first, recommended only, stoppable.
    {
      const { context, page, calls } = await open(browser, vp, { importDelay: 700, script: [{ json: pageBody(PAGE1) }] });
      await vis(page, ".dz-email-scan-button").click();
      const bulk = vis(page, ".dz-email-import-all");
      await bulk.waitFor({ timeout: 30_000 });
      check(`${label}: bulk button counts the recommended only`, (await bulk.innerText()).includes("(3)"));
      await bulk.click();
      check(`${label}: bulk import asks first (nothing imported yet)`, (await texts(page)).includes("לקלוט 3 מסמכים מומלצים?") && calls.imports.length === 0);
      await vis(page, "button >> text=ביטול").click();
      await page.waitForTimeout(400);
      check(`${label}: cancel imports nothing`, calls.imports.length === 0);
      await vis(page, ".dz-email-import-all").click();
      await vis(page, ".dz-email-confirm-import").click();
      await vis(page, ".dz-email-stop-import").waitFor({ timeout: 10_000 });
      await vis(page, ".dz-email-stop-import").click();
      await page.waitForFunction(() => document.body.innerText.includes("הקליטה נעצרה"), null, { timeout: 15_000 });
      const imported = calls.imports.map((r) => r.messageId);
      check(`${label}: stop works between files; only recommended files were sent`, imported.length >= 1 && imported.length < 3 && imported.every((m) => ["m1", "m2", "m3"].includes(m)), JSON.stringify(imported));
      await context.close();
    }

    // 14 + more states: /sync only by an explicit basic scan; cap; complete; confirm before clearing 50+.
    {
      const { context, page, calls } = await open(browser, vp, { script: [{ status: 503, json: { success: false, status: "unavailable", code: "scan_unavailable", retryCursor: null } }] });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, '.dz-email-completion[data-completion="unavailable"]').waitFor({ timeout: 30_000 });
      check(`${label}: 14a. unavailable: /sync not called until "סריקה בסיסית" is tapped`, calls.sync.length === 0 && (await texts(page)).includes("הסריקה המורחבת אינה זמינה כרגע"));
      await vis(page, ".dz-email-basic-scan").click();
      await page.waitForFunction(() => document.body.innerText.includes("basic-scan-invoice.pdf"), null, { timeout: 30_000 });
      check(`${label}: 14b. basic scan = legacy /sync, latest 30, labelled as partial`, calls.sync.length === 1 && calls.sync[0].maxMessages === "30" && (await texts(page)).includes("סריקה בסיסית בודקת רק את 30 ההודעות האחרונות"));
      await context.close();
    }
    {
      const { context, page } = await open(browser, vp, { script: [{ json: pageBody(PAGE1, { capReached: true, hasMore: true, nextCursor: null, scannedTotal: 500 }) }] });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, '.dz-email-completion[data-completion="cap_reached"]').waitFor({ timeout: 30_000 });
      const body = await texts(page);
      check(`${label}: 500 cap: persistent "may be more" message, no load more, never "all scanned"`, body.includes("נסרקו 500 ההודעות האחרונות") && body.includes("ייתכנו מסמכים נוספים") && (await vis(page, ".dz-email-load-more").count()) === 0 && !body.includes("נסרקו כל ההודעות"));
      await context.close();
    }
    {
      const many = Array.from({ length: 55 }, (_, i) => a(`n${i}`, "1", { filename: `invoice-${i}.pdf` }));
      const { context, page, calls } = await open(browser, vp, { script: [{ json: pageBody(many, { hasMore: false, nextCursor: null }) }] });
      await vis(page, ".dz-email-scan-button").click();
      await vis(page, '.dz-email-completion[data-completion="complete"]').waitFor({ timeout: 30_000 });
      check(`${label}: a finished window says so`, (await texts(page)).includes("נסרקו כל ההודעות עם קבצים מצורפים ב־90 הימים האחרונים") === false && (await texts(page)).includes("נסרקו כל ההודעות עם קבצים מצורפים ב־30 הימים האחרונים"));
      await vis(page, '[data-period="90"]').click();
      check(`${label}: changing the period marks the results as the previous scan's`, (await texts(page)).includes("התוצאות שמוצגות שייכות לסריקה הקודמת") && calls.scan.length === 1);
      await vis(page, ".dz-email-scan-button").click();
      check(`${label}: more than 50 files → asks before clearing; "השאר" keeps the list`, (await texts(page)).includes("סריקה חדשה תנקה את הרשימה") && calls.scan.length === 1);
      await vis(page, "button >> text=השאר את הרשימה").click();
      check(`${label}: list kept`, (await row(page, vp, keyOf(many[0])).count()) === 1 && calls.scan.length === 1);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
if (SHOTS) console.log(`screenshots: ${fs.readdirSync(SHOTS).filter((f) => f.startsWith("b3b-")).join(", ")}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
