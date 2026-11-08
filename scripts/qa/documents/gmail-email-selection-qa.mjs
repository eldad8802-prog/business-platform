/**
 * Gmail email screen — selection restore regression (pre-2026-06-22 behaviour).
 *
 * Drives /documents/email in a real browser against a LOCAL server. Every /api
 * call is intercepted (Gmail status/sync/import + anything else the shell asks
 * for), so no Google account, database or Production is touched. The import
 * endpoint is a recorder: the test asserts exactly which attachments the screen
 * sends and in what shape.
 *
 *   QA_BASE_URL=http://localhost:3000 node scripts/qa/documents/gmail-email-selection-qa.mjs
 *
 * Fixture buckets (lib/services/email-import/scoring.ts, unchanged):
 *   A invoice-100.pdf  200KB             → 65 recommended
 *   B scan.pdf         500KB             → 50 recommended
 *   C INV-1234.pdf     40KB              → 35 possible
 *   D photo.jpg        2MB               → 35 possible
 *   E logo.png         5KB               → -25 hidden (never shown)
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const att = (id, filename, mimeType, sizeBytes, subject) => ({
  messageId: `m-${id}`,
  attachmentId: `a-${id}`,
  filename,
  mimeType,
  sizeBytes,
  fromEmail: "billing@vendor.example",
  subject,
  sentAt: "2026-11-01T09:00:00.000Z",
});
const FIXTURES = [
  att("A", "invoice-100.pdf", "application/pdf", 200_000, "Your invoice"),
  att("B", "scan.pdf", "application/pdf", 500_000, "Scan"),
  att("C", "INV-1234.pdf", "application/pdf", 40_000, "Monthly statement"),
  att("D", "photo.jpg", "image/jpeg", 2_000_000, "Photo"),
  att("E", "logo.png", "image/png", 5_000, "Newsletter"),
];
const IMPORT_KEYS = [
  "messageId", "attachmentId", "filename", "mimeType", "sizeBytes", "fromEmail", "subject", "sentAt",
].sort();

/** Fresh page with mocked APIs. `importReply(body)` decides each import response. */
async function openScreen(browser, viewport, importReply = () => ({ status: 200, json: { success: true, imported: true, documentId: 1 } })) {
  const context = await browser.newContext({ viewport, locale: "he-IL" });
  await context.addInitScript(() => window.localStorage.setItem("token", "qa-fake-token"));
  const page = await context.newPage();
  const imports = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/integrations/gmail/status") {
      return route.fulfill({ json: { success: true, connected: true, emailAddress: "owner@example.com", connections: [{ id: 7, emailAddress: "owner@example.com", status: "connected" }] } });
    }
    if (p === "/api/integrations/gmail/sync") {
      return route.fulfill({ json: { success: true, scannedMessages: 5, foundAttachments: FIXTURES.length, attachments: FIXTURES } });
    }
    if (p === "/api/integrations/gmail/import") {
      const body = route.request().postDataJSON();
      imports.push(body);
      const r = importReply(body);
      return route.fulfill({ status: r.status, json: r.json });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/documents/email`, { waitUntil: "domcontentloaded" });
  await page.locator("text=invoice-100.pdf >> visible=true").first().waitFor({ state: "visible", timeout: 60_000 });
  return { context, page, imports };
}

const scope = (page, desktop) => page.locator(desktop ? ".dz-email-table" : ".dz-email-rows");
const rowOf = (page, desktop, name) =>
  scope(page, desktop).locator(desktop ? "tr" : "article", { hasText: name });
const importSelectedBtn = (page, desktop) =>
  desktop ? page.locator("button.dz-email-import", { hasText: "ייבא נבחרים" }) : page.locator(".dz-email-bottom button", { hasText: "ייבא נבחרים" });
const importAllBtn = (page, desktop) =>
  desktop ? page.locator("button.dz-email-import", { hasText: "ייבא הכל" }) : page.locator(".dz-email-bottom button", { hasText: "ייבא הכל" });

async function runSuite(browser, label, viewport, desktop) {
  console.log(`\n== ${label} (${viewport.width}x${viewport.height}) ==`);

  // ---- 1. what is shown --------------------------------------------------
  {
    const { context, page } = await openScreen(browser, viewport);
    const s = scope(page, desktop);
    const text = await s.innerText();
    check(`${label}: 4 visible rows, hidden logo.png not shown`, !text.includes("logo.png") && (await s.locator('input[type="checkbox"]').count()) === 4);
    check(`${label}: "לא מסמך" label is gone`, !(await page.content()).includes("לא מסמך"));
    check(`${label}: possible rows carry "אולי רלוונטי"`,
      (await rowOf(page, desktop, "INV-1234.pdf").innerText()).includes("אולי רלוונטי") &&
      (await rowOf(page, desktop, "photo.jpg").innerText()).includes("אולי רלוונטי"));
    check(`${label}: recommended rows carry no "אולי רלוונטי"`,
      !(await rowOf(page, desktop, "invoice-100.pdf").innerText()).includes("אולי רלוונטי"));
    for (const name of ["invoice-100.pdf", "scan.pdf", "INV-1234.pdf", "photo.jpg"]) {
      check(`${label}: ${name} has an import button`, (await rowOf(page, desktop, name).getByRole("button", { name: "קלוט" }).count()) === 1);
    }
    const checked = async (name) => rowOf(page, desktop, name).locator('input[type="checkbox"]').isChecked();
    check(`${label}: recommended pre-selected, possible not`,
      (await checked("invoice-100.pdf")) && (await checked("scan.pdf")) && !(await checked("INV-1234.pdf")) && !(await checked("photo.jpg")));
    check(`${label}: "ייבא נבחרים (2)" present`, (await importSelectedBtn(page, desktop).innerText()).includes("2"));
    check(`${label}: "ייבא הכל (2)" unchanged (recommended only)`, (await importAllBtn(page, desktop).innerText()).includes("2"));
    check(`${label}: bucket counts line`, (await page.getByText("2 מומלצים · 2 אולי רלוונטיים").count()) === 1);
    if (!desktop) {
      // The bulk buttons must be reachable — nothing (e.g. the shell's mobile nav) on top of them.
      const btn = importSelectedBtn(page, desktop);
      await btn.scrollIntoViewIfNeeded();
      const onTop = await btn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el || el.contains(hit);
      });
      check(`${label}: ייבא נבחרים is not covered by the shell nav`, onTop);
    }

    // select all / clear
    await page.getByRole("button", { name: "בחר הכל" }).click();
    check(`${label}: select all → ייבא נבחרים (4)`, (await importSelectedBtn(page, desktop).innerText()).includes("4"));
    await page.getByRole("button", { name: "נקה בחירה" }).click();
    check(`${label}: clear → ייבא נבחרים disabled (0)`, await importSelectedBtn(page, desktop).isDisabled());
    await context.close();
  }

  // ---- 2. import selected: owner's pick incl. a "possible" row -------------
  {
    const { context, page, imports } = await openScreen(browser, viewport);
    await rowOf(page, desktop, "INV-1234.pdf").locator('input[type="checkbox"]').check();
    check(`${label}: ticking a possible row → ייבא נבחרים (3)`, (await importSelectedBtn(page, desktop).innerText()).includes("3"));
    await importSelectedBtn(page, desktop).click();
    await page.waitForFunction(() => !document.body.innerText.includes("מייבא..."), null, { timeout: 15_000 });
    const sent = imports.map((b) => b.attachmentId).sort();
    check(`${label}: import selected sent exactly A,B,C`, JSON.stringify(sent) === JSON.stringify(["a-A", "a-B", "a-C"]), sent.join(","));
    check(`${label}: request body shape unchanged (+connectionId)`,
      imports.every((b) => JSON.stringify(Object.keys(b).filter((k) => k !== "connectionId").sort()) === JSON.stringify(IMPORT_KEYS) && b.connectionId === 7));
    check(`${label}: imported rows show "נקלט · בתור" and lock their checkbox`,
      (await rowOf(page, desktop, "INV-1234.pdf").innerText()).includes("נקלט · בתור") &&
      (await rowOf(page, desktop, "INV-1234.pdf").locator('input[type="checkbox"]').isDisabled()));
    check(`${label}: unselected possible row D untouched (still importable)`,
      (await rowOf(page, desktop, "photo.jpg").getByRole("button", { name: "קלוט" }).count()) === 1);

    // per-row import of the other possible row
    await rowOf(page, desktop, "photo.jpg").getByRole("button", { name: "קלוט" }).click();
    await rowOf(page, desktop, "photo.jpg").getByText("נקלט · בתור").waitFor({ timeout: 15_000 });
    check(`${label}: per-row import of a possible row sends it`, imports.some((b) => b.attachmentId === "a-D"));
    check(`${label}: nothing selected left → ייבא נבחרים disabled`, await importSelectedBtn(page, desktop).isDisabled());
    await context.close();
  }

  // ---- 3. "ייבא הכל" keeps its existing behaviour ---------------------------
  {
    const { context, page, imports } = await openScreen(browser, viewport);
    await rowOf(page, desktop, "photo.jpg").locator('input[type="checkbox"]').check();
    await importAllBtn(page, desktop).click();
    await page.waitForFunction(() => !document.body.innerText.includes("מייבא..."), null, { timeout: 15_000 });
    const sent = imports.map((b) => b.attachmentId).sort();
    check(`${label}: ייבא הכל sends only recommended A,B (as today)`, JSON.stringify(sent) === JSON.stringify(["a-A", "a-B"]), sent.join(","));
    await context.close();
  }

  // ---- 4. server outcomes still mapped as before ---------------------------
  {
    const { context, page } = await openScreen(browser, viewport, (b) =>
      b.attachmentId === "a-A"
        ? { status: 200, json: { success: true, imported: false, skipped: "duplicate", reason: "message_attachment" } }
        : { status: 500, json: { error: "x" } });
    await importSelectedBtn(page, desktop).click();
    await page.waitForFunction(() => !document.body.innerText.includes("מייבא..."), null, { timeout: 15_000 });
    check(`${label}: duplicate → "כבר נקלט"`, (await rowOf(page, desktop, "invoice-100.pdf").innerText()).includes("כבר נקלט"));
    check(`${label}: server error → "נכשל"`, (await rowOf(page, desktop, "scan.pdf").innerText()).includes("נכשל"));
    await context.close();
  }
  {
    const { context, page } = await openScreen(browser, viewport, () => ({ status: 409, json: { needsReconnect: true, error: "x" } }));
    await rowOf(page, desktop, "INV-1234.pdf").getByRole("button", { name: "קלוט" }).click();
    await page.getByText("החיבור ל-Gmail פג").first().waitFor({ timeout: 15_000 });
    check(`${label}: 409 needsReconnect → reconnect message`, true);
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  await runSuite(browser, "mobile", { width: 390, height: 844 }, false);
  await runSuite(browser, "desktop", { width: 1366, height: 900 }, true);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
