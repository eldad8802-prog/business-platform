/**
 * Runtime QA for the CRM general-note wrap fix (.crm-note__body).
 *
 * Customer and supplier detail, three notes each: one long unbroken run (the
 * Production case), intentional line breaks, and ordinary Hebrew text. Every
 * /api call is answered in the browser; nothing is written.
 *
 * Page-level overflow cannot see this defect: in RTL the run escapes to the
 * LEFT and is clipped instead of scrolling. So the check is per element: the
 * note body must fit inside its card. Each shot is also measured once with the
 * fix neutralised, to show the check fails without it.
 *
 *   QA_BASE=http://localhost:3011 node qa-evidence/prod-reliability/shoot-crm-note.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3011";
const OUT = path.resolve("qa-evidence/prod-reliability/crm-note");
const WIDTHS = [390, 768, 1024, 1440, 1920];
const now = new Date().toISOString();

const NOTES = {
  unbroken: "ל".repeat(160),
  linebreaks: "שורה ראשונה של הערה.\nשורה שנייה — אחרי ירידת שורה מכוונת.\n\nפסקה אחרי שורה ריקה.",
  normal: "לקוח קבוע. מעדיף חשבונית במייל ומשלם בהעברה בנקאית בסוף החודש. English words mixed in stay readable.",
};
let note = NOTES.unbroken;

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function fulfill(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  if (req.method() !== "GET") return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"qa: writes disabled"}' });
  if (p === "/api/customers") {
    return json(route, { customers: [1, 2, 3].map((id) => ({ id, name: `לקוח בדיקה ${id}`, phone: "0501234500", email: `c${id}@example.co.il`, city: "תל אביב", isActive: true })) });
  }
  if (/^\/api\/customers\/\d+$/.test(p)) {
    return json(route, {
      customer: { id: 1, name: "לקוח בדיקה 1", phone: "0501234500", email: "c1@example.co.il", city: "תל אביב", isActive: true,
        legalName: "לקוח בדיקה 1", taxId: "514000001", taxIdType: "COMPANY", notes: note, createdAt: now, updatedAt: now },
      billingDocuments: { total: 0, items: [] }, paymentRequests: { total: 0, items: [] },
      conversations: { total: 0, items: [] }, appointments: { total: 0, items: [] },
      activity: { lastActivityAt: now, hasAnyActivity: false },
    });
  }
  if (p === "/api/inventory/suppliers") {
    return json(route, { suppliers: [1, 2].map((id) => ({ id, name: `ספק בדיקה ${id}`, isActive: true, phone: "035551000", email: `s${id}@example.co.il` })) });
  }
  if (/^\/api\/inventory\/suppliers\/\d+$/.test(p)) {
    return json(route, { supplier: { id: 1, name: "ספק בדיקה 1", isActive: true, phone: "035551000", email: "s1@example.co.il",
      notes: note, defaultLeadTimeDays: 3, legalName: "ספק בדיקה 1", taxId: "515000002", taxIdType: "COMPANY", category: "כללי" } });
  }
  if (p.endsWith("/notes")) return json(route, { notes: [] });
  if (p.endsWith("/attachments")) return json(route, { attachments: [] });
  return json(route, {});
}

/** Does the note body fit inside its card? Measured on the text's own box. */
async function measure(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".crm-note");
    const body = document.querySelector(".crm-note__body");
    if (!card || !body) return { present: false };
    const c = card.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(body);
    const t = range.getBoundingClientRect();
    const de = document.documentElement;
    return {
      present: true,
      fits: t.left >= c.left - 1 && t.right <= c.right + 1 && body.scrollWidth <= body.clientWidth + 1,
      textWidth: Math.round(t.width),
      cardWidth: Math.round(c.width),
      lines: Math.round(t.height / parseFloat(getComputedStyle(body).lineHeight)),
      pageOverflow: de.scrollWidth > de.clientWidth + 2,
      overflowWrap: getComputedStyle(body).overflowWrap,
      whiteSpace: getComputedStyle(body).whiteSpace,
    };
  });
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", reducedMotion: "reduce" });
await ctx.addInitScript(() => {
  localStorage.setItem("token", "qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA", businessId: 1 }));
  document.addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.head.appendChild(s);
  });
});
await ctx.route("**/api/**", fulfill);
const page = await ctx.newPage();

const results = [];
let failed = 0;
for (const [surface, route] of [["customer", "/customers/1"], ["supplier", "/suppliers/1"]]) {
  for (const [variant, text] of Object.entries(NOTES)) {
    note = text;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 120000 });
      await page.locator(".crm-note__body").first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(300);
      await page.locator(".crm-note").first().scrollIntoViewIfNeeded();
      const after = await measure(page);
      await page.screenshot({ path: path.join(OUT, `${surface}-${variant}-${width}.png`) });
      // The same page with the fix neutralised: proves the check detects the defect.
      const style = await page.addStyleTag({ content: ".crm-note__body{overflow-wrap:normal!important}" });
      const before = await measure(page);
      await style.evaluate((el) => el.remove());
      const ok = after.present && after.fits && !after.pageOverflow;
      if (!ok) failed++;
      results.push({ surface, variant, width, ok, after, withoutFix: { fits: before.fits, textWidth: before.textWidth } });
      console.log(surface, variant, width, ok ? "ok" : "FAIL", `fits=${after.fits} text=${after.textWidth}/${after.cardWidth} lines=${after.lines}`, `| without fix fits=${before.fits} text=${before.textWidth}`);
    }
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, "..", "crm-note-metrics.json"), JSON.stringify({ checks: results.length, failed, results }, null, 2));
console.log("CHECKS", results.length, "FAILED", failed);
if (failed) process.exitCode = 1;
