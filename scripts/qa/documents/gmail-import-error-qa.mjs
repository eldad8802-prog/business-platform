/**
 * Gmail email screen — import request + failure message regression (2026-11-08).
 *
 * LOCAL server, every /api call intercepted (no Google account, database or
 * Production). Proves the import request now carries the attachment's partId
 * (all other fields unchanged) and that a failed import names the file and the
 * reason in Hebrew instead of only "נכשל".
 *
 *   QA_BASE_URL=http://localhost:3000 node scripts/qa/documents/gmail-import-error-qa.mjs
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
const KEYS = ["attachmentId", "filename", "fromEmail", "messageId", "mimeType", "partId", "sentAt", "sizeBytes", "subject"];

async function run(browser, viewport, reply) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const sent = [];
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/integrations/gmail/status") return route.fulfill({ json: { success: true, connected: true, emailAddress: "owner@example.com", connections: [{ id: 7, emailAddress: "owner@example.com", status: "connected" }] } });
    if (p === "/api/integrations/gmail/sync") return route.fulfill({ json: { success: true, scannedMessages: 1, attachmentParts: 1, unsupportedType: 0, attachments: [PDF] } });
    if (p === "/api/integrations/gmail/import") {
      sent.push(route.request().postDataJSON());
      if (reply === "network") return route.abort();
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email`, { waitUntil: "domcontentloaded" });
  await page.locator("text=invoice-100.pdf >> visible=true").first().waitFor({ timeout: 60_000 });
  const scope = viewport.width >= 1200 ? page.locator(".dz-email-table tr", { hasText: "invoice-100.pdf" }) : page.locator(".dz-email-rows article", { hasText: "invoice-100.pdf" });
  await scope.getByRole("button", { name: "קלוט" }).click();
  await page.waitForTimeout(1200);
  const text = await page.locator("body").innerText();
  await context.close();
  return { sent, text };
}

const browser = await chromium.launch();
try {
  for (const [label, viewport] of [["mobile", { width: 390, height: 844 }], ["desktop", { width: 1366, height: 900 }]]) {
    console.log(`\n== ${label} ==`);
    {
      const { sent, text } = await run(browser, viewport, { status: 200, json: { success: true, imported: true, documentId: 5 } });
      check(`${label}: request carries partId "2"`, sent[0]?.partId === "2");
      check(`${label}: request keys = previous keys + partId (+connectionId)`, JSON.stringify(Object.keys(sent[0]).filter((k) => k !== "connectionId").sort()) === JSON.stringify(KEYS));
      check(`${label}: success unchanged — "נקלט · בתור", no error`, text.includes("נקלט · בתור") && !text.includes("לא הצלחנו לקלוט"));
    }
    {
      const { text } = await run(browser, viewport, { status: 404, json: { error: "הקובץ המצורף לא נמצא בהודעה", code: "ATTACHMENT_NOT_IN_MESSAGE" } });
      check(`${label}: not-found → file named + guidance`, text.includes('לא הצלחנו לקלוט את "invoice-100.pdf": לא הצלחנו לאתר את הקובץ בתוך ההודעה ב-Gmail. סרוק שוב ונסה לקלוט אותו שוב.'));
    }
    {
      const { text } = await run(browser, viewport, { status: 415, json: { error: "תוכן הקובץ אינו תואם לסוג שלו" } });
      check(`${label}: server reason shown as-is (Hebrew from server)`, text.includes('לא הצלחנו לקלוט את "invoice-100.pdf": תוכן הקובץ אינו תואם לסוג שלו'));
    }
    {
      const { text } = await run(browser, viewport, "network");
      check(`${label}: network failure → generic Hebrew retry line`, text.includes("הקליטה נכשלה. בדוק את החיבור ונסה שוב בעוד רגע."));
    }
    {
      const { text } = await run(browser, viewport, { status: 200, json: { success: true, imported: false, skipped: "duplicate" } });
      check(`${label}: duplicate unchanged — "כבר נקלט", no error`, text.includes("כבר נקלט") && !text.includes("לא הצלחנו לקלוט"));
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
