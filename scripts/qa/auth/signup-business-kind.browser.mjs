#!/usr/bin/env node
/**
 * Signup in three steps with the business's legal identity (owner decision 2026-11-12; extends #1103) in a REAL
 * browser: this build under `next start` with public signup open, every /api/** request answered here (nothing
 * reaches a database; no account is created, no email sent).
 *
 *   BASE=http://localhost:3631 OUT=./shots node scripts/qa/auth/signup-business-kind.browser.mjs
 *
 * Android WebView (390 px), iPhone-sized (390 px, iOS Safari UA — Chromium engine: layout only, not WebKit) and
 * desktop (1440 px). Per width:
 *   S1 step 1: "שלב 1 מתוך 3", no business field yet, RTL, no horizontal overflow; empty → errors under the
 *      fields, nothing posted;
 *   S2 step 2: the kind select with exactly the three kinds in Hebrew; no identity field until a kind is chosen;
 *      the labels follow the kind (company vs dealer); the business email starts as the sign-in address; empty →
 *      an error under every required field; a bad check digit → an error under the number that does not repeat
 *      it; nothing posted; no overflow;
 *   S3 step 3: the review shows every value and the lock notice; Back keeps the values; no terms → stopped;
 *      with terms → exactly one request carrying exactly the identity fields (no businessName);
 *   S4 the server's refusal naming taxId returns to step 2 with the message under the number.
 * The Google completion form is covered by .agl/browser-m2.ts (real lab, three widths). Local server only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright";

const BASE = (process.env.BASE || "http://localhost:3631").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "signup-business-kind-shots");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// ENGINE=webkit runs the iPhone viewport on real WebKit (iOS Safari engine) instead of the full Chromium set.
const ENGINE = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const ALL_VIEWPORTS = [
  { name: "android-390", width: 390, height: 844, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36" },
  { name: "iphone-390", width: 390, height: 844, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];
const VIEWPORTS = ENGINE === "webkit"
  ? ALL_VIEWPORTS.filter((v) => v.name === "iphone-390").map((v) => ({ ...v, name: "iphone-390-webkit" }))
  : ALL_VIEWPORTS;
const VALID_TAX = "000000018"; // valid Israeli check digit, synthetic
const BAD_TAX = "123456789"; // fails the check digit

const results = [];
const check = (vp, name, cond, detail = "") => {
  results.push({ vp, name, pass: !!cond, detail });
  console.log(`${cond ? "  ok " : "FAIL "} [${vp}] ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const stepText = async (page) => (await page.locator('[data-testid="signup-step"]').innerText()).trim();
const text = async (page, sel) => ((await page.locator(sel).count()) ? (await page.locator(sel).innerText()).trim() : "");
const next = (page) => page.locator('[data-testid="signup-next"]').click();

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, userAgent: vp.userAgent, locale: "he-IL" });
  const posted = [];
  let answer = { status: 200, body: { success: true, token: "t", user: { id: 1, email: "x@y.z", name: "n", businessId: 1, businessName: "b" } } };
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === "/api/auth/register" && req.method() === "POST") {
      posted.push(JSON.parse(req.postData() || "{}"));
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${vp.name}-${n}.png`), fullPage: true });
  await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator("#reg-name").waitFor({ timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  // ---- S1
  check(vp.name, "S1 step 1 of 3", (await stepText(page)).includes("שלב 1 מתוך 3"), await stepText(page));
  check(vp.name, "S1 no business field on step 1", (await page.locator("#reg-kind").count()) === 0 && (await page.locator("#reg-business").count()) === 0);
  check(vp.name, "S1 RTL", (await page.evaluate(() => getComputedStyle(document.querySelector("#reg-name")).direction)) === "rtl");
  check(vp.name, "S1 no horizontal overflow", await noOverflow(page));
  await shot("1-account");
  await next(page);
  await page.waitForTimeout(300);
  check(vp.name, "S1 empty → errors under name, email, password; still step 1; nothing posted",
    (await page.locator("#reg-name-msg").count()) === 1 && (await page.locator("#reg-email-msg").count()) === 1
      && (await page.locator("#reg-password-msg[role=alert]").count()) === 1 && (await stepText(page)).includes("שלב 1") && posted.length === 0);

  await page.fill("#reg-name", "דנה כהן");
  await page.fill("#reg-email", `qa-${vp.name}@example.invalid`);
  await page.fill("#reg-password", "sup3rsecret!");
  await next(page);
  await page.waitForTimeout(400);

  // ---- S2
  check(vp.name, "S2 step 2 of 3", (await stepText(page)).includes("שלב 2 מתוך 3"), await stepText(page));
  const select = page.locator("#reg-kind");
  const options = await select.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.getAttribute("value"), t: o.textContent?.trim(), d: o.disabled })));
  check(vp.name, "S2 exactly the three kinds (+ a disabled placeholder), in Hebrew",
    JSON.stringify(options.map((o) => o.v)) === JSON.stringify(["", "EXEMPT_DEALER", "AUTHORIZED_DEALER", "LTD_COMPANY"]) &&
      options[0].d === true && options[1].t === "עוסק פטור" && options[2].t === "עוסק מורשה" && options[3].t === "חברה בע״מ", JSON.stringify(options));
  check(vp.name, "S2 no identity field before a kind is chosen", (await page.locator("#reg-legalName").count()) === 0);
  await next(page);
  await page.waitForTimeout(300);
  check(vp.name, "S2 no kind → message under the select, nothing posted",
    (await text(page, "#reg-kind-msg")).includes("סוג העסק") && posted.length === 0);

  await select.selectOption("LTD_COMPANY");
  check(vp.name, "S2 company labels", (await text(page, 'label[for="reg-legalName"]')) === "שם החברה המשפטי"
    && (await text(page, 'label[for="reg-taxId"]')) === "מספר ח״פ" && (await text(page, 'label[for="reg-address"]')) === "כתובת החברה");
  await select.selectOption("EXEMPT_DEALER");
  check(vp.name, "S2 dealer labels", (await text(page, 'label[for="reg-legalName"]')) === "שם משפטי של בעל העסק"
    && (await text(page, 'label[for="reg-taxId"]')) === "מספר עוסק");
  check(vp.name, "S2 the number hint says format only, not verified", (await text(page, "#reg-taxId-hint")).includes("אינו מאומת"));
  check(vp.name, "S2 business email starts as the sign-in address", (await page.inputValue("#reg-businessEmail")) === `qa-${vp.name}@example.invalid`);
  await next(page);
  await page.waitForTimeout(300);
  const required = ["legalName", "taxId", "address", "phone"];
  const missing = [];
  for (const f of required) if ((await page.locator(`#reg-${f}-msg`).count()) !== 1) missing.push(f);
  check(vp.name, "S2 empty → an error under every required field; trade name optional; nothing posted",
    missing.length === 0 && (await page.locator("#reg-tradeName-msg").count()) === 0 && posted.length === 0, missing.join(","));
  await page.fill("#reg-legalName", "דנה כהן");
  await page.fill("#reg-taxId", BAD_TAX);
  await page.fill("#reg-address", "הרצל 1, תל אביב");
  await page.fill("#reg-phone", "050-123-4567");
  await next(page);
  await page.waitForTimeout(300);
  const taxMsg = await text(page, "#reg-taxId-msg");
  check(vp.name, "S2 bad check digit → error under the number, never repeating it", taxMsg.includes("אינו תקין") && !taxMsg.includes(BAD_TAX), taxMsg);
  check(vp.name, "S2 no horizontal overflow", await noOverflow(page));
  await shot("2-business-errors");
  await page.fill("#reg-taxId", VALID_TAX);
  await next(page);
  await page.waitForTimeout(400);

  // ---- S3
  check(vp.name, "S3 step 3 of 3", (await stepText(page)).includes("שלב 3 מתוך 3"), await stepText(page));
  const review = await text(page, '[data-testid="signup-review"]');
  check(vp.name, "S3 review shows every value", ["דנה כהן", "עוסק פטור", VALID_TAX, "הרצל 1, תל אביב", "050-123-4567"].every((v) => review.includes(v)), review);
  check(vp.name, "S3 lock notice shown", (await text(page, '[data-testid="signup-lock-notice"]')).includes("יינעלו"));
  check(vp.name, "S3 no horizontal overflow", await noOverflow(page));
  await shot("3-review");
  await page.locator('[data-testid="signup-back"]').click();
  await page.waitForTimeout(300);
  check(vp.name, "S3 Back → step 2 with the values kept", (await stepText(page)).includes("שלב 2") && (await page.inputValue("#reg-taxId")) === VALID_TAX);
  await next(page);
  await page.waitForTimeout(300);
  await page.locator('[data-testid="signup-submit"]').click();
  await page.waitForTimeout(300);
  check(vp.name, "S3 no terms → stopped, nothing posted", (await page.locator("#reg-terms-msg").count()) === 1 && posted.length === 0);

  answer = { status: 400, body: { error: "מספר עוסק אינו תקין. יש להזין 9 ספרות כפי שהן מופיעות במסמכים הרשמיים.", field: "taxId" } };
  await page.locator("#reg-terms").check({ force: true });
  await page.locator('[data-testid="signup-submit"]').click();
  await page.waitForTimeout(800);
  const body = posted[0] ?? {};
  check(vp.name, "S3 exactly one request with exactly the identity fields",
    posted.length === 1 && body.businessKind === "EXEMPT_DEALER" && body.legalName === "דנה כהן" && body.taxId === VALID_TAX
      && body.tradeName === null && body.address === "הרצל 1, תל אביב" && body.phone === "050-123-4567"
      && body.businessEmail === `qa-${vp.name}@example.invalid` && body.acceptTerms === true && !("businessName" in body),
    JSON.stringify(body));

  // ---- S4
  check(vp.name, "S4 server refusal (taxId) → back on step 2, message under the number",
    (await stepText(page)).includes("שלב 2") && (await text(page, "#reg-taxId-msg")).includes("אינו תקין"));
  await shot("4-server-refusal");
  await ctx.close();
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
