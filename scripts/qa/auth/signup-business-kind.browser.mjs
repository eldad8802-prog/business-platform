#!/usr/bin/env node
/**
 * The business kind at signup (#1103) in a REAL browser: this build under `next start` with public signup open,
 * every /api/** request answered here (nothing reaches a database; no account is created, no email sent).
 *
 *   BASE=http://localhost:3631 OUT=./shots node scripts/qa/auth/signup-business-kind.browser.mjs
 *
 * Android phone (390 px, the app's WebView UA) and desktop (1440 px):
 *   - /register shows the required kind select with exactly the three kinds in Hebrew, RTL, no horizontal overflow;
 *   - submitting without a kind is stopped in the form (message under the select) and nothing is posted;
 *   - with a kind chosen, the request carries exactly that businessKind;
 *   - the server's own refusal (400 field businessKind) lands under the select.
 * The Google completion form is covered by .agl/browser-m2.ts (real lab, three widths). Local server only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE || "http://localhost:3631").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "signup-business-kind-shots");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "android-390", width: 390, height: 844, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36" },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];
const results = [];
const check = (vp, name, cond, detail = "") => {
  results.push({ vp, name, pass: !!cond, detail });
  console.log(`${cond ? "  ok " : "FAIL "} [${vp}] ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
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
  await page.goto(`${BASE}/register`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const select = page.locator("#reg-business-kind");
  check(vp.name, "the kind select is shown", (await select.count()) === 1 && (await select.isVisible()));
  const options = await select.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.getAttribute("value"), t: o.textContent?.trim(), d: o.disabled })));
  check(vp.name, "exactly the three kinds (+ a disabled placeholder), in Hebrew",
    JSON.stringify(options.map((o) => o.v)) === JSON.stringify(["", "EXEMPT_DEALER", "AUTHORIZED_DEALER", "LTD_COMPANY"]) &&
      options[0].d === true && options[1].t === "עוסק פטור" && options[2].t === "עוסק מורשה" && options[3].t === "חברה בע״מ", JSON.stringify(options));
  check(vp.name, "the page is RTL", (await page.evaluate(() => getComputedStyle(document.querySelector("#reg-business-kind")).direction)) === "rtl");
  check(vp.name, "no horizontal overflow", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await page.screenshot({ path: path.join(OUT, `${vp.name}-register.png`), fullPage: true });

  await page.fill("#reg-name", "דנה כהן");
  await page.fill("#reg-business", "מאפיית דנה");
  await page.fill("#reg-email", `qa-${vp.name}@example.invalid`);
  await page.fill("#reg-password", "sup3rsecret!");
  await page.locator("#reg-terms").check({ force: true });
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  const msg = page.locator("#reg-business-kind-msg");
  check(vp.name, "no kind → stopped in the form, message under the select, nothing posted",
    (await msg.count()) === 1 && (await msg.innerText()).includes("סוג העסק") && posted.length === 0, String(posted.length));
  await page.screenshot({ path: path.join(OUT, `${vp.name}-register-missing-kind.png`), fullPage: true });

  answer = { status: 400, body: { error: "יש לבחור את סוג העסק: עוסק פטור, עוסק מורשה או חברה בע״מ", field: "businessKind" } };
  await select.selectOption("LTD_COMPANY");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(800);
  check(vp.name, "with a kind chosen the request carries exactly it", posted.length === 1 && posted[0].businessKind === "LTD_COMPANY", JSON.stringify(posted[0] ?? {}));
  check(vp.name, "the server's refusal (field businessKind) lands under the select", (await msg.count()) === 1 && (await msg.innerText()).includes("עוסק פטור"));
  await ctx.close();
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
