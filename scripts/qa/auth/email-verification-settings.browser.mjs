#!/usr/bin/env node
/**
 * Email verification in Settings → Security, in a REAL browser (#1065): this build under `next start`, every
 * /api/** request answered here (nothing reaches a database or a mail provider; resend is never really sent).
 *
 *   BASE=http://localhost:3621 OUT=./shots node scripts/qa/auth/email-verification-settings.browser.mjs
 *
 * Two viewports: an Android WebView (390 px, the app's UA with "; wv") and a desktop browser (1440 px).
 *   - /app and /documents: no verification banner, and the shell never asks for the status;
 *   - /settings/security: "האימייל טרם אומת" + resend → sent / 429 / 500 / offline messages;
 *   - back from Chrome: verified elsewhere, visibilitychange → "האימייל מאומת" without a reload;
 *   - verified / never asked / verification off; no horizontal overflow.
 * Screenshots + results.json in OUT. Local server only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE || "http://localhost:3621").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "email-verification-shots");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa", exp: 1893456000 })}.sig`;
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

async function ctxFor(browser, vp, state) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, userAgent: vp.userAgent, locale: "he-IL" });
  await ctx.addInitScript((t) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים", businessName: "עסק" }));
  }, TOKEN);
  const calls = [];
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const m = route.request().method();
    calls.push(`${m} ${u.pathname}`);
    const j = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/auth/email/status") {
      if (state.status === "off") return j({ verificationEnabled: false });
      return j({ verificationEnabled: true, required: state.status !== "notRequired", verified: state.status === "verified" });
    }
    if (u.pathname === "/api/auth/email/resend" && m === "POST") {
      if (state.resend === "offline") return route.abort("internetdisconnected");
      if (state.resend === "limited") return j({ error: "יותר מדי ניסיונות. כדאי לחכות כמה דקות ולנסות שוב.", code: "RATE_LIMITED" }, 429);
      if (state.resend === "fail") return j({ error: "שגיאת שרת", code: "SERVER_ERROR" }, 500);
      return j({ ok: true, message: "שלחנו קישור אימות לכתובת האימייל שלכם." });
    }
    if (u.pathname === "/api/auth/me") return j({ user: { id: 9, name: "בעלים", businessName: "עסק", email: "qa@example.invalid" } });
    if (u.pathname === "/api/business/capabilities") return j({ features: {} });
    if (u.pathname === "/api/security/google") return j({ linked: false, emailAtLink: null, linkedAt: null, lastUsedAt: null, hasPassword: true });
    if (m !== "GET") return j({ error: "not mocked" }, 404);
    return j({ error: "not mocked" }, 404);
  });
  return { ctx, calls };
}

const settle = async (p) => { await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(600); };

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  // 1. The shell: no notice above the screens even for an unverified owner.
  {
    const state = { status: "unverified" };
    const { ctx, calls } = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    for (const route of ["/app", "/documents"]) {
      await p.goto(BASE + route); await settle(p);
      const txt = await p.locator("body").innerText();
      check(vp.name, `${route}: no verification banner`, (await p.locator('[data-testid="verify-banner"]').count()) === 0 && !/לאמת את כתובת האימייל/.test(txt));
      check(vp.name, `${route}: the shell never asks for the status`, !calls.includes("GET /api/auth/email/status"));
    }
    await p.screenshot({ path: path.join(OUT, `${vp.name}-app-unverified.png`) });
    await ctx.close();
  }
  // 2. Settings → Security: unverified, resend outcomes.
  {
    const state = { status: "unverified", resend: "ok" };
    const { ctx } = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    await p.goto(BASE + "/settings/security"); await settle(p);
    const st = p.locator('[data-testid="email-verification-state"]');
    check(vp.name, "security: 'האימייל טרם אומת'", (await st.innerText().catch(() => "")).includes("האימייל טרם אומת"));
    check(vp.name, "security: the page header still renders", (await p.locator("h1").count()) >= 1);
    await p.screenshot({ path: path.join(OUT, `${vp.name}-security-unverified.png`), fullPage: true });
    const btn = p.locator('[data-testid="email-verification-resend"]');
    const msg = p.locator('[data-testid="email-verification-message"]');
    await btn.click(); await p.waitForTimeout(400);
    check(vp.name, "resend sent → server sentence (status role)", (await msg.innerText()).includes("שלחנו קישור אימות") && (await msg.getAttribute("role")) === "status");
    state.resend = "limited"; await btn.click(); await p.waitForTimeout(400);
    check(vp.name, "resend 429 → limit message (alert role)", (await msg.innerText()).includes("יותר מדי ניסיונות") && (await msg.getAttribute("role")) === "alert");
    state.resend = "fail"; await btn.click(); await p.waitForTimeout(400);
    check(vp.name, "resend 500 → server error shown", (await msg.innerText()).includes("שגיאת שרת"));
    state.resend = "offline"; await btn.click(); await p.waitForTimeout(400);
    check(vp.name, "resend offline → offline message", (await msg.innerText()).includes("אין חיבור"));
    await p.screenshot({ path: path.join(OUT, `${vp.name}-security-resend-offline.png`), fullPage: true });

    // 3. Back from Chrome: verified elsewhere, the app returns to the foreground.
    state.status = "verified";
    const other = await ctx.newPage(); await other.goto("about:blank"); await other.bringToFront();
    await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await p.waitForTimeout(1700);
    await p.bringToFront();
    await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await p.waitForTimeout(800);
    check(vp.name, "back from Chrome → 'האימייל מאומת' without reload", (await st.innerText().catch(() => "")).includes("האימייל מאומת") && (await btn.count()) === 0);
    await p.screenshot({ path: path.join(OUT, `${vp.name}-security-after-return.png`), fullPage: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(vp.name, "no horizontal overflow", !overflow);
    await ctx.close();
  }
  // 4. Verified / never asked / off.
  for (const [status, expect] of [["verified", "shown-verified"], ["notRequired", "absent"], ["off", "absent"]]) {
    const { ctx } = await ctxFor(browser, vp, { status });
    const p = await ctx.newPage();
    await p.goto(BASE + "/settings/security"); await settle(p);
    const n = await p.locator('[data-testid="email-verification-status"]').count();
    if (expect === "absent") check(vp.name, `security (${status}): section absent`, n === 0);
    else check(vp.name, `security (${status}): 'האימייל מאומת'`, (await p.locator('[data-testid="email-verification-state"]').innerText()).includes("האימייל מאומת"));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
