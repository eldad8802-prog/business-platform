/**
 * Service Desk 1.3b-C — state and layout evidence for /service-desk/cases/[id]/intake.
 *
 * Renders the REAL page (real components, real CSS) against STUBBED API responses, so every state can be captured without
 * any database or business data: no approved terms (the signature is not offered), ready to present the terms, ready to
 * sign (a real stroke is drawn and the signature sent), signed with its slip, and read-only. Synthetic data only.
 *
 * For each state and width it asserts:
 *   - RTL on the document, no horizontal overflow, the "חזרה" control present
 *   - the state's own content, and that an action the server does not allow is NOT offered
 *   - for the signature: the request the page sent (a PNG base64, the expected version, a UUIDv7 Idempotency-Key)
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
// A 1×1 PNG, for photo / signature stubs.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */
const NONE = { recordData: false, addPhoto: false, presentTerms: false, sign: false, createSlip: false };
const TERMS = {
  presentedAt: "2026-11-11T08:00:00.000Z", termsVersion: 2, statutoryVersion: 1, termsSha256: "a".repeat(64), statutorySha256: "b".repeat(64),
  termsBody: "1. המעבדה תבדוק את המכשיר ותמסור הצעת מחיר לפני כל תיקון בתשלום.\n2. מכשיר שלא נאסף תוך 90 יום מההודעה — יחולו הוראות הדין.",
  statutoryBody: "זכויותיך לפי חוק הגנת הצרכן אינן נגרעות מתנאים אלה.",
};
const view = (o = {}) => ({
  intake: { conditionNote: "שריטה בפינה הימנית", accessoriesNote: "מטען וכיסוי שקוף", conditionRecorded: true, accessoriesRecorded: true, signed: false, signedAt: null, termsVersion: null, hasSignature: false, hasSlip: false },
  terms: null,
  activeTerms: { termsVersion: 2, statutoryVersion: 1, approved: true },
  photos: [{ id: 1, sha256: "c".repeat(64), mimeType: "image/png", byteSize: 70, createdAt: "2026-11-11T07:58:00.000Z" }, { id: 2, sha256: "d".repeat(64), mimeType: "image/png", byteSize: 70, createdAt: "2026-11-11T07:59:00.000Z" }],
  history: [{ seq: 2, step: null, occurredAt: "2026-11-11T07:57:00.000Z" }, { seq: 3, step: "PHOTO_ADDED", occurredAt: "2026-11-11T07:58:00.000Z" }, { seq: 4, step: "PHOTO_ADDED", occurredAt: "2026-11-11T07:59:00.000Z" }],
  case: { caseNumber: 1042, kind: "IN_SHOP", status: "OPEN", version: 4 },
  allowed: { ...NONE, recordData: true, addPhoto: true },
  ...o,
});

const STATES = {
  "intake-no-approved-terms": { access: "FULL", view: view({ activeTerms: { termsVersion: 1, statutoryVersion: 1, approved: false } }), expect: "אושר משפטית", noPad: true, noSlip: true },
  "intake-present-terms": { access: "FULL", view: view({ allowed: { ...NONE, recordData: true, addPhoto: true, presentTerms: true } }), expect: "הצגת התנאים ללקוח", noPad: true },
  "intake-ready-to-sign": { access: "FULL", view: view({ terms: TERMS, allowed: { ...NONE, recordData: true, addPhoto: true, sign: true } }), expect: "אישור וחתימה", act: "sign" },
  "intake-signed": {
    access: "FULL",
    view: view({
      terms: TERMS,
      intake: { ...view().intake, signed: true, signedAt: "2026-11-11T08:03:00.000Z", termsVersion: "T2-S1", hasSignature: true, hasSlip: false },
      history: [...view().history, { seq: 5, step: "TERMS_PRESENTED", occurredAt: "2026-11-11T08:00:00.000Z" }, { seq: 6, step: "SIGNED", occurredAt: "2026-11-11T08:03:00.000Z" }],
      allowed: { ...NONE, createSlip: true },
    }),
    expect: "יצירת טופס קליטה (PDF)", noPad: true, noEdit: true,
  },
  "intake-read-only": { access: "READ_ONLY", view: view({ terms: TERMS, allowed: { ...NONE, recordData: true, addPhoto: true, sign: true } }), expect: "לצפייה בלבד", noPad: true, noEdit: true },
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
  await page.route("**/api/service-desk/cases/*/intake/signature", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
  await page.route("**/api/service-desk/cases/*/intake/sign", (route) => {
    const req = route.request();
    sent.push({ key: req.headers()["idempotency-key"] ?? null, body: req.postDataJSON() });
    return json(route, { case: { version: 5 }, replayed: false });
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
      await page.waitForSelector("text=מצב המכשיר בקליטה", { timeout: 180000 });
      const tag = `${key} @${vp.width}`;

      const dir = await page.evaluate(() => document.documentElement.getAttribute("dir"));
      check(`${tag}: RTL`, dir === "rtl", dir);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
      check(`${tag}: back control`, (await page.locator("[data-back-button], header button, header a").count()) > 0);
      check(`${tag}: title names the case`, (await page.locator("h1").innerText()).includes("1042"));
      check(`${tag}: state content (${s.expect})`, (await page.locator(`text=${s.expect}`).count()) > 0);
      if (s.noPad) check(`${tag}: no signature pad offered`, (await page.locator("canvas").count()) === 0);
      if (s.noSlip) check(`${tag}: no slip action offered`, (await page.locator("text=טופס קליטה (PDF)").count()) === 0);
      if (s.noEdit) check(`${tag}: no data save / photo action offered`, (await page.locator("text=שמירת פרטי הקליטה").count()) === 0 && (await page.locator("text=צילום / הוספת תמונה").count()) === 0);

      await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-fold.png`) });
      if (vp.width === 390) await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-full.png`), fullPage: true });

      if (s.act === "sign" && vp.width === 390) {
        const signBtn = page.getByRole("button", { name: "אישור וחתימה" });
        check(`${tag}: signing is disabled until the customer draws`, await signBtn.isDisabled());
        await page.locator("canvas").scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollBy(0, 120));
        const box = await page.locator("canvas").boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
          await page.mouse.down();
          for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + box.width * (0.15 + i * 0.03), box.y + box.height * (0.5 + Math.sin(i / 2) * 0.2));
          await page.mouse.up();
        }
        check(`${tag}: a drawn stroke enables signing`, !(await signBtn.isDisabled()));
        await signBtn.scrollIntoViewIfNeeded();
        await signBtn.click({ timeout: 15000 });
        await page.waitForSelector("text=הקליטה נחתמה", { timeout: 15000 }).catch(() => {});
        const r = sent[0];
        check(`${tag}: the signature request — a PNG base64, the expected version, a UUIDv7 key`,
          r && typeof r.body?.signaturePngBase64 === "string" && Buffer.from(r.body.signaturePngBase64, "base64").subarray(1, 4).toString("latin1") === "PNG"
            && r.body.expectedVersion === 4 && UUID_V7.test(r.key ?? ""), JSON.stringify({ key: r?.key, v: r?.body?.expectedVersion }));
        await page.screenshot({ path: path.join(OUT, `${key}-${vp.width}-after-sign.png`) });
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
