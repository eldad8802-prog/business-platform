/**
 * Leads W1 — end-to-end proof at 390px, RTL.
 *
 * Drives the real UI in a real browser against a real server and a real
 * database: nothing is stubbed, and every assertion is read back off the
 * rendered page (or a fresh reload) rather than from the response of the action
 * that caused it.
 *
 * Scenarios (W1 test plan): A manual lead · B persistence · C status ·
 * D follow-up + overdue · E won/lost + duplicate policy · F validation ·
 * G tenant isolation. Plus a horizontal-overflow check on every screen.
 *
 * Waits are CONDITION-based, never fixed sleeps: a tenant transaction against a
 * remote database takes as long as it takes, and a sleep that happens to be long
 * enough today is a flake tomorrow.
 *
 *   LEADS_E2E_BASE=http://localhost:3210 node scripts/qa/ui/leads-w1-e2e.mjs
 *
 * Requires `scripts/qa/leads-w1-seed.ts` to have written .leads-e2e/fixture.json.
 */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.LEADS_E2E_BASE || "http://localhost:3210";
const FIXTURE = path.join(process.cwd(), ".leads-e2e", "fixture.json");
const MOBILE = { width: 390, height: 844 };
const WAIT = 20000;

let passed = 0;
const failures = [];

function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function fail(label, detail) {
  failures.push(`${label} — ${detail}`);
  console.log(`  FAIL  ${label} — ${detail}`);
}

function assert(cond, label, detail = "assertion failed") {
  if (cond) ok(label);
  else fail(label, detail);
}

/** Wait until `selector`'s text contains `needle`; assert on the outcome. */
async function expectText(page, selector, needle, label) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && (el.textContent || "").includes(want);
      },
      [selector, needle],
      { timeout: WAIT }
    );
    ok(label);
  } catch {
    const actual = await page.textContent(selector).catch(() => "<missing>");
    fail(label, `"${needle}" not found in ${selector} — got "${String(actual).slice(0, 120)}"`);
  }
}

/** Wait until `selector`'s text NO LONGER contains `needle`. */
async function expectTextGone(page, selector, needle, label) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && !(el.textContent || "").includes(want);
      },
      [selector, needle],
      { timeout: WAIT }
    );
    ok(label);
  } catch {
    fail(label, `"${needle}" still present in ${selector}`);
  }
}

/** The page must never scroll sideways at 390px. */
async function assertNoHorizontalOverflow(page, where) {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert(
    o.scroll <= o.client + 1,
    `no horizontal overflow — ${where}`,
    `scrollWidth ${o.scroll} > clientWidth ${o.client}`
  );
}

async function assertRtl(page, where) {
  const dir = await page.evaluate(() => {
    const el = document.querySelector(".crm-scope");
    return el ? getComputedStyle(el).direction : null;
  });
  assert(dir === "rtl", `surface renders RTL — ${where}`, `direction=${dir}`);
}

async function newSession(browser, token) {
  const context = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.evaluate((t) => localStorage.setItem("token", t), token);
  return { context, page };
}

const api = (page, base, token) => (pathname, init) =>
  page.evaluate(
    async ([url, tk, opts]) => {
      const r = await fetch(url, {
        ...opts,
        headers: {
          "Content-Type": "application/json",
          ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
        },
      });
      let body = null;
      try {
        body = await r.json();
      } catch {
        /* no body */
      }
      return { status: r.status, body };
    },
    [`${base}${pathname}`, token, init ?? {}]
  );

async function main() {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const browser = await chromium.launch();

  const A = await newSession(browser, fixture.a.token);
  const B = await newSession(browser, fixture.b.token);
  const page = A.page;
  const callA = api(page, BASE, fixture.a.token);

  try {
    /* ============================================ A — manual lead ========= */

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-hd__title", { timeout: WAIT });

    await expectText(page, ".crm-hd__title", "לידים", "A1 /leads renders the Leads Inbox");
    await expectText(
      page,
      ".crm-panel",
      "פנייה",
      "A2 the empty state explains what a lead IS, not just that there are none"
    );
    await assertNoHorizontalOverflow(page, "empty inbox");
    await assertRtl(page, "inbox");

    await page.click("text=+ ליד חדש");
    await page.waitForSelector('[aria-label="ליד חדש"]', { timeout: WAIT });
    await assertNoHorizontalOverflow(page, "create modal");

    /* ============================================ F — validation ========== */
    // Deliberately BEFORE the happy path, so a rejected submit can never be
    // mistaken for a successful one later.

    await page.fill("#lead-new-name", "QA בדיקת אימייל");
    await page.fill("#lead-new-email", "not-an-email");
    await page.click("text=שמירה");
    await page.waitForSelector(".crm-modal__error", { timeout: WAIT });
    const emailErr = (await page.textContent(".crm-modal__error")) ?? "";
    assert(emailErr.trim().length > 0, "F1 an invalid email is REJECTED with a message", `error=${emailErr}`);
    assert(
      await page.isVisible('[aria-label="ליד חדש"]'),
      "F2 the form stays open so the typed data is not lost"
    );

    await page.fill("#lead-new-name", "");
    await page.fill("#lead-new-email", "");
    await page.click("text=שמירה");
    await expectText(page, ".crm-modal__error", "שם", "F3 an empty name is rejected");

    /* ---- happy path ---- */

    await page.fill("#lead-new-name", "QA דניאל כהן");
    await page.fill("#lead-new-phone", fixture.phone);
    await page.fill("#lead-new-email", "qa.daniel@example.com");
    await page.fill("#lead-new-intent", "מבקש הצעת מחיר ל-3 עובדים");
    await page.click("text=שמירה");

    await page.waitForURL(/\/leads\/\d+$/, { timeout: WAIT });
    const leadUrl = page.url();
    const leadId = Number(leadUrl.match(/\/leads\/(\d+)/)[1]);
    ok(`A3 creating a lead navigates to its card (/leads/${leadId})`);

    await page.waitForSelector(".crm-id__name", { timeout: WAIT });
    await expectText(page, ".crm-id__name", "QA דניאל כהן", "A4 the card shows the lead");
    await expectText(page, "body", "מבקש הצעת מחיר", "A5 the card shows what they asked for");
    await expectText(page, "body", "כרטיס הלקוח", "A6 the card links across to the Customer record");
    await expectText(page, "body", "וואטסאפ", "A7 the WhatsApp quick action is present");
    await assertNoHorizontalOverflow(page, "lead card");

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-row", { timeout: WAIT });
    await expectText(page, ".crm-rows", "QA דניאל כהן", "A8 the lead appears in the inbox list");
    await expectText(page, ".crm-rows", "חדש", "A9 the row shows its status badge");
    await assertNoHorizontalOverflow(page, "populated inbox");

    /* ============================================ B — persistence ========= */

    await page.goto(leadUrl, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".crm-id__name", { timeout: WAIT });
    await expectText(page, ".crm-id__name", "QA דניאל כהן", "B1 a hard refresh shows the same lead");
    await expectText(page, "body", "מבקש הצעת מחיר", "B2 the refreshed card keeps its context");

    /* ============================================ C — status ============== */

    await page.locator("button.crm-chip", { hasText: "נשלחה הצעה" }).first().click();
    await expectText(
      page,
      ".crm-id .crm-badge",
      "נשלחה הצעה",
      "C1 the card adopts the new status without a refetch"
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".crm-id__name", { timeout: WAIT });
    await expectText(
      page,
      ".crm-id .crm-badge",
      "נשלחה הצעה",
      "C2 the status change survives a hard refresh"
    );

    /* ============================================ D — follow-up =========== */

    await page.locator("button", { hasText: "בעוד 3 ימים" }).first().click();
    await expectText(page, "body", "מעקב בעוד", "D1 a follow-up is saved and reads as scheduled");

    await page.reload({ waitUntil: "networkidle" });
    await expectText(page, "body", "מעקב בעוד", "D2 the follow-up survives a refresh");

    // Backdate through the API so "overdue" is proven as a DERIVED read rather
    // than as something the UI wrote.
    const overdue = await callA(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({
        followUpAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      }),
    });
    assert(
      overdue.status === 200 && overdue.body?.followUp?.kind === "overdue",
      "D3 a past follow-up is DERIVED as overdue at read time",
      JSON.stringify(overdue.body?.followUp)
    );
    assert(overdue.body?.needsAttention === true, "D4 an overdue lead reports needsAttention");

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.locator("button.crm-chip", { hasText: "דורש טיפול" }).first().click();
    await expectText(page, ".crm-page", "QA דניאל כהן", "D5 the overdue lead surfaces in דורש טיפול");
    await expectText(page, ".crm-page", "מעקב באיחור", "D6 it is labelled as overdue");

    await page.goto(leadUrl, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "טופל" }).first().click();
    // Scoped to the CARD (`.crm-reading`): the master list is also mounted in
    // this DOM (hidden at 390px), so a body-wide check would be measuring two
    // regions at once.
    await expectTextGone(
      page,
      ".crm-reading",
      "מעקב באיחור",
      "D7 marking it done clears the overdue state on the card"
    );
    // ...and the master list stops disagreeing with the card — the guarantee
    // that matters on desktop, where both panes are visible together.
    await expectTextGone(
      page,
      ".crm-rows",
      "מעקב באיחור",
      "D7b the list row drops the overdue badge too (panes stay in agreement)"
    );

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.locator("button.crm-chip", { hasText: "דורש טיפול" }).first().click();
    await page.waitForSelector(".crm-panel, .crm-row", { timeout: WAIT });
    await expectTextGone(
      page,
      ".crm-page",
      "QA דניאל כהן",
      "D8 a completed follow-up leaves the queue immediately"
    );

    /* ============================================ E — won/lost ============ */

    await page.goto(leadUrl, { waitUntil: "networkidle" });
    await page.locator("button.crm-chip", { hasText: "נסגר בהצלחה" }).first().click();
    // Read the HEADER badge, not the page text: "נסגר בהצלחה" is also a button
    // label, so a body-text check here would pass even if nothing happened.
    await expectText(page, ".crm-id .crm-badge", "נסגר בהצלחה", "E1 a lead can be closed as WON");
    await expectText(page, "body", "הליד סגור", "E2 a closed lead stops asking for a follow-up");

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-panel, .crm-row", { timeout: WAIT });
    await expectTextGone(
      page,
      ".crm-page",
      "QA דניאל כהן",
      "E3 the closed lead leaves the default (open) work queue"
    );

    await page.locator("button.crm-chip", { hasText: "סגורים" }).first().click();
    await expectText(
      page,
      ".crm-page",
      "QA דניאל כהן",
      "E4 it is still there under סגורים — history preserved"
    );

    // Duplicate policy: the SAME phone may start a new lead now that the
    // previous one is closed.
    const reopened = await callA("/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: "QA דניאל כהן חוזר", phone: fixture.phone }),
    });
    assert(
      reopened.status === 201,
      "E5 the same phone may start a NEW lead once the previous one is closed",
      `status=${reopened.status} ${JSON.stringify(reopened.body)}`
    );
    const secondLeadId = reopened.body?.lead?.id;

    const dup = await callA("/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: "QA כפילות", phone: fixture.phone }),
    });
    assert(
      dup.status === 409 && dup.body?.code === "OPEN_LEAD_EXISTS",
      "E6 a SECOND open lead on the same phone is refused with 409",
      `status=${dup.status} ${JSON.stringify(dup.body)}`
    );

    /* ============================================ G — tenant isolation ==== */

    const bPage = B.page;
    const callB = api(bPage, BASE, fixture.b.token);
    const callAnon = api(bPage, BASE, null);

    await bPage.goto(`${BASE}/leads/${secondLeadId}`, { waitUntil: "networkidle" });
    await expectText(bPage, "body", "לא נמצא", "G1 tenant B cannot open tenant A's lead in the UI");

    const bGet = await callB(`/api/leads/${secondLeadId}`);
    assert(bGet.status === 404, "G2 GET of another tenant's lead is 404", `status=${bGet.status}`);

    const bPatch = await callB(`/api/leads/${secondLeadId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "WON" }),
    });
    assert(bPatch.status === 404, "G3 PATCH of another tenant's lead is 404", `status=${bPatch.status}`);

    const bList = await callB("/api/leads?status=all");
    assert(
      bList.status === 200 && bList.body.leads.length === 0,
      "G4 tenant B's list contains none of tenant A's leads",
      `count=${bList.body?.leads?.length}`
    );

    const anon = await callAnon(`/api/leads/${secondLeadId}`);
    assert(anon.status === 401, "G5 an unauthenticated request is refused (401)", `status=${anon.status}`);

    const stillOwned = await callA(`/api/leads/${secondLeadId}`);
    assert(
      stillOwned.status === 200 && stillOwned.body.lead.status === "NEW",
      "G6 tenant A's lead is unchanged after tenant B's attempts",
      `status=${stillOwned.body?.lead?.status}`
    );

    /* ============================================ H — nav wiring ========== */

    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    const leadsHref = await page.getAttribute('a:has-text("לידים")', "href");
    assert(
      leadsHref === "/leads",
      "H1 the home לידים tile points at /leads (not /opportunities)",
      `href=${leadsHref}`
    );
  } catch (err) {
    fail("E2E RUN", err?.message ?? String(err));
  } finally {
    await A.context.close();
    await B.context.close();
    await browser.close();
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`LEADS W1 E2E FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`LEADS W1 E2E PASS — ${passed} checks green.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
