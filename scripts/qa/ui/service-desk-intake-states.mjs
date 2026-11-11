/**
 * Service Desk — state and layout evidence for /service-desk/cases/[id]/intake (owner decision 2026-11-11: no customer
 * signature — the owner confirms the documented intake).
 *
 * Renders the REAL page (real components, real CSS) against STUBBED API responses, so every state can be captured without
 * any database or business data: data not yet documented, ready for the owner's confirmation (the confirmation is clicked
 * and its request checked), confirmed with the slip, and read-only. Synthetic data only.
 *
 * For each state and width it asserts:
 *   - RTL on the document, no horizontal overflow, the "חזרה" control present
 *   - the state's own content, that an action the server does not allow is NOT offered
 *   - NO signature pad, no canvas and no signature / terms wording anywhere
 *   - for the confirmation: the request the page sent (CHECK_IN with intakeConfirmed, the expected version, a UUIDv7 key)
 *
 *   AUDIT_BASE_URL=http://localhost:3197 AUDIT_OUT_DIR=<dir> node scripts/qa/ui/service-desk-intake-states.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3197";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".service-desk-intake");
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */
const NONE = { recordData: false, addPhoto: false, confirm: false, createSlip: false };
const INTAKE = { conditionNote: "שריטה בפינה הימנית", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, signed: false, signedAt: null, termsVersion: null, hasSignature: false, hasSlip: false };
const view = (o = {}) => ({
  intake: INTAKE, terms: null, activeTerms: { termsVersion: null, statutoryVersion: null, approved: false },
  photos: [{ id: 1, sha256: "c".repeat(64), mimeType: "image/png", byteSize: 70, createdAt: "2026-11-11T07:58:00.000Z" }, { id: 2, sha256: "d".repeat(64), mimeType: "image/png", byteSize: 70, createdAt: "2026-11-11T07:59:00.000Z" }],
  history: [{ seq: 2, step: null, occurredAt: "2026-11-11T07:57:00.000Z" }, { seq: 3, step: "PHOTO_ADDED", occurredAt: "2026-11-11T07:58:00.000Z" }, { seq: 4, step: "PHOTO_ADDED", occurredAt: "2026-11-11T07:59:00.000Z" }],
  confirmation: null,
  case: { caseNumber: 1042, kind: "IN_SHOP", status: "OPEN", version: 4 },
  allowed: { ...NONE, recordData: true, addPhoto: true, confirm: true },
  ...o,
});

const STATES = {
  "intake-incomplete": { access: "FULL", view: view({ intake: { ...INTAKE, accessoriesRecorded: false }, allowed: { ...NONE, recordData: true, addPhoto: true } }), expect: "לא נמסרו אביזרים", noConfirm: true },
  "intake-ready-to-confirm": { access: "FULL", view: view(), expect: "אישור קליטה וקבלת הפריט", act: "confirm" },
  "intake-confirmed": {
    access: "FULL",
    view: view({
      confirmation: { at: "2026-11-11T08:03:00.000Z", byUserId: 7, byName: "דנה כהן" },
      case: { caseNumber: 1042, kind: "IN_SHOP", status: "CHECKED_IN", version: 5 },
      allowed: { ...NONE, createSlip: true },
    }),
    expect: "הקליטה אושרה על ידי דנה כהן", noConfirm: true, noEdit: true, slip: true,
  },
  "intake-read-only": { access: "READ_ONLY", view: view(), expect: "לצפייה בלבד", noConfirm: true, noEdit: true },
};

/* -------------------------------------------------------------- stubs -- */
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installStubs(page, s, sent) {
  await page.route("**/api/**", (route) => json(route, {}));
  await page.route("**/api/business/capabilities", (route) =>
    json(route, { features: { service_desk: { allowed: true, reasonCode: "BUSINESS_ENABLED", reasonLabel: "" } } }));
  await page.route("**/api/service-desk/access", (route) => json(route, { mode: s.access }));
  await page.route("**/api/service-desk/cases/*/intake", (route) => json(route, s.view));
  await page.route("**/api/service-desk/cases/*/intake/photos/*", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
  await page.route("**/api/service-desk/cases/*/actions", (route) => {
    const req = route.request();
    sent.push({ key: req.headers()["idempotency-key"] ?? null, body: req.postDataJSON() });
    return json(route, { case: { version: 5 }, event: { seq: 5 }, replayed: false });
  });
}

/* ---------------------------------------------------------------- main -- */
async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const [key, s] of Object.entries(STATES)) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "he-IL", reducedMotion: "reduce", hasTouch: vp.width < 600 });
      const page = await ctx.newPage();
      const sent = [];
      await installStubs(page, s, sent);
      await page.addInitScript(() => { try { localStorage.setItem("token", "qa-stub-token"); } catch { /* ignore */ } });
      await page.goto(`${BASE}/service-desk/cases/7/intake`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await page.waitForSelector("text=אישור הקליטה", { timeout: 180000 });
      const tag = `${key} @${vp.width}`;

      check(`${tag}: RTL`, (await page.evaluate(() => document.documentElement.getAttribute("dir"))) === "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
      check(`${tag}: back control`, (await page.locator("[data-back-button], header button, header a").count()) > 0);
      check(`${tag}: title names the case`, (await page.locator("h1").innerText()).includes("1042"));
      check(`${tag}: state content (${s.expect})`, (await page.locator(`text=${s.expect}`).count()) > 0);
      check(`${tag}: no signature pad, no canvas, no signature / terms wording`,
        (await page.locator("canvas").count()) === 0 && !/חתימ|תנאי השירות/.test(await page.locator("main").innerText()));
      if (s.noConfirm) check(`${tag}: no confirmation button offered`, (await page.locator("text=אישור קליטה וקבלת הפריט").count()) === 0);
      if (s.noEdit) check(`${tag}: no data save / photo action offered`, (await page.locator("text=שמירת פרטי הקליטה").count()) === 0 && (await page.locator("text=צילום / הוספת תמונה").count()) === 0);
      if (s.slip) check(`${tag}: the slip action is offered after the confirmation`, (await page.locator("text=יצירת טופס קליטה (PDF)").count()) > 0);

      await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-fold.png`) });
      if (vp.width === 390) await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-full.png`), fullPage: true });

      if (s.act === "confirm" && vp.width === 390) {
        const btn = page.getByRole("button", { name: "אישור קליטה וקבלת הפריט" });
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ timeout: 15000 });
        await page.waitForSelector("text=הקליטה אושרה והפריט התקבל לטיפול", { timeout: 15000 }).catch(() => {});
        const r = sent[0];
        check(`${tag}: the confirmation request — CHECK_IN with intakeConfirmed, the expected version, a UUIDv7 key (no signature data)`,
          r && r.body?.action?.type === "CHECK_IN" && r.body.action.intakeConfirmed === true && r.body.expectedVersion === 4 && UUID_V7.test(r.key ?? "")
            && !JSON.stringify(r.body).includes("signature"), JSON.stringify({ key: r?.key, body: r?.body }));
        await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-after-confirm.png`) });
      }
      await ctx.close();
    }
  }
  await browser.close();
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
