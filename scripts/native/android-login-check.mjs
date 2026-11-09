// DIAGNOSTIC ONLY (branch diag/android-app-login) — issue 3: the Android app opens on sign-in.
// Real Capacitor WebView on an emulator; the app is served on localhost:3000 with the apex
// rewrite (/ → /home) applied to localhost, exactly as promaxgroup.co.il does in Production.
// APIs are mocked per scenario (no database, no real account, no email is ever sent).
// usage: node scripts/native/android-login-check.mjs <outDir> <mode: before|after>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [OUT, MODE] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const save = () => writeFileSync(join(OUT, `login-${MODE}.json`), JSON.stringify(results, null, 1));
const log = (o) => { results.push({ mode: MODE, ...o }); save(); console.log(JSON.stringify(o).slice(0, 600)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const adbBuf = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
process.on("unhandledRejection", (e) => console.log("unhandledRejection", String(e).slice(0, 120)));

const [device] = await android.devices();
let page;
const navs = [];
const connect = async () => {
  const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
  page = await wv.page();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(new URL(f.url()).pathname); });
};
const shot = async (name) => writeFileSync(join(OUT, "shots", `${MODE}-${name}.png`), await device.screenshot());
const focusApp = () => (adb("shell", "dumpsys", "window").match(/mCurrentFocus=Window\{[^}]*\s(\S+)\}/)?.[1] || "?");

// API mocks for a scenario. `me` = what /api/auth/me answers.
const ME_OK = { id: 101, email: "owner@example.com", name: "בעלת עסק", role: "USER", businessId: 7, business: { id: 7, name: "עסק לדוגמה" } };
const mock = async ({ me = 401, login = null, forgot = 200, logout = 200 } = {}) => {
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await page.route("**/api/**", async (r) => {
    const u = new URL(r.request().url());
    const json = (status, body) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname === "/api/auth/me") return me === 200 ? json(200, { user: ME_OK, ...ME_OK }) : json(me, { error: "unauthorized" });
    if (u.pathname === "/api/auth/login" && login) return json(login.status, login.body);
    if (u.pathname === "/api/auth/password/forgot") return json(forgot, { ok: true });
    if (u.pathname === "/api/auth/logout" || u.pathname === "/api/auth/refresh/revoke") return json(logout, { ok: true });
    if (u.pathname.startsWith("/api/auth/refresh")) return json(401, { error: "no session" });
    return json(me === 200 ? 200 : 401, me === 200 ? {} : { error: "unauthorized" });
  });
};

// What the sign-in screen shows (owner-approved compact layout in the app).
const loginView = () => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
  const byText = (re) => [...document.querySelectorAll("a,button,span,h1,p,div")].find((e) => re.test(e.textContent || "") && e.children.length === 0);
  const h1 = document.querySelector("h1");
  const visibleTitle = h1 ? [...h1.querySelectorAll("span")].filter(vis).map((s) => s.textContent.trim()).join(" | ") || h1.textContent.trim() : null;
  const top = [...document.querySelectorAll("body *")].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 4 && r.width > 4).reduce((m, r) => Math.min(m, r.top), 1e9);
  return {
    path: location.pathname,
    dataShell: document.documentElement.getAttribute("data-shell"),
    title: visibleTitle,
    badgeVisible: vis(byText(/כניסה מאובטחת/)),
    subtitleVisible: vis(byText(/התחבר כדי להמשיך/)),
    emailHelpVisible: vis(document.querySelector("#login-email-msg")),
    dividerVisible: vis(byText(/כניסה מהירה ונקייה/)),
    email: vis(document.querySelector("#login-email")),
    password: vis(document.querySelector("#login-password")),
    showHide: vis(document.querySelector('button[aria-controls="login-password"]')),
    submit: vis(document.querySelector('button[type="submit"]')),
    forgot: vis(document.querySelector('[data-testid="forgot-password-link"]')),
    register: vis([...document.querySelectorAll("button")].find((b) => /הרשמה|להרשמה|הירשם/.test(b.textContent || ""))),
    googleButton: !!byText(/Google/),
    marketing: !!document.querySelector("main#main-content") || /העסק שלך,/.test(document.body.innerText),
    topmostY: Math.round(top),
    token: localStorage.getItem("token"),
  };
});
const settle = async (ms = 3500) => { await page.waitForLoadState("domcontentloaded").catch(() => {}); await page.waitForTimeout(ms); };
const gotoFull = async (path, ms) => { navs.length = 0; await withTimeout(page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45000 }), 60000, path); await settle(ms); };

log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim() });

// 1. FIRST OPEN after install (no stored session), true cold start: screenshots every ~0.4 s.
try {
  adb("shell", "pm", "clear", PKG);
  await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  const t0 = Date.now();
  const frames = [];
  while (Date.now() - t0 < 7000) {
    const b = adbBuf("exec-out", "screencap", "-p");
    const at = Date.now() - t0;
    if (b) { writeFileSync(join(OUT, "shots", `${MODE}-firstopen-${String(at).padStart(5, "0")}ms.png`), b); frames.push(at); }
  }
  await sleep(3000);
  await connect();
  const v = await loginView();
  await shot("firstopen-final");
  log({ check: "first-open", frames, ...v, historyLength: await page.evaluate(() => history.length) });
} catch (e) { log({ check: "first-open", error: String(e).slice(0, 200) }); }

// 2. BACK on the first screen: the app goes to the background (never back to the marketing page).
try {
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(2500);
  const afterBack = focusApp();
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(3000);
  const resumed = await loginView();
  await shot("back-then-resume");
  log({ check: "back-button", focusAfterBack: afterBack, leftApp: !afterBack.includes(PKG), resumedPath: resumed.path, resumedMarketing: resumed.marketing });
} catch (e) { log({ check: "back-button", error: String(e).slice(0, 200) }); }

// 3. KEYBOARD on the sign-in form.
try {
  await mock({ me: 401 });
  await gotoFull("/login", 3000);
  await page.locator("#login-email").click();
  await page.waitForTimeout(2500);
  const ime = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
  const k = await page.evaluate(() => {
    const f = document.activeElement?.getBoundingClientRect();
    const b = document.querySelector('button[type="submit"]');
    b?.scrollIntoView({ block: "nearest" });
    const br = b?.getBoundingClientRect();
    return { innerHeight: window.innerHeight, fieldVisible: !!f && f.top >= 0 && f.bottom <= window.innerHeight, submitReachable: !!br && br.top >= 0 && br.bottom <= window.innerHeight };
  });
  await shot("keyboard");
  log({ check: "keyboard", imeShown: ime, ...k });
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await page.waitForTimeout(1500);
} catch (e) { log({ check: "keyboard", error: String(e).slice(0, 200) }); }

// 4. WRONG PASSWORD: the server's Hebrew error is shown clearly.
try {
  await mock({ me: 401, login: { status: 401, body: { error: "האימייל או הסיסמה שגויים", code: "INVALID_CREDENTIALS" } } });
  await gotoFull("/login", 3000);
  await page.fill("#login-email", "owner@example.com");
  await page.fill("#login-password", "wrong-password-1");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  const alert = await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()).filter(Boolean));
  await shot("wrong-password");
  log({ check: "wrong-password", path: await page.evaluate(() => location.pathname), alerts: alert });
} catch (e) { log({ check: "wrong-password", error: String(e).slice(0, 200) }); }

// 5. SIGNED-IN launch: the app's launch URL (/) with a valid stored session → business home, no form.
try {
  await mock({ me: 200 });
  await page.evaluate(() => { localStorage.setItem("token", "diag-token"); localStorage.setItem("sessionId", "diag-sid"); });
  navs.length = 0;
  const timeline = [];
  const p = page.goto(BASE + "/", { waitUntil: "commit", timeout: 45000 }).catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const b = adbBuf("exec-out", "screencap", "-p");
    const at = Date.now() - t0;
    if (b) { writeFileSync(join(OUT, "shots", `${MODE}-signedin-${String(at).padStart(5, "0")}ms.png`), b); timeline.push(at); }
  }
  await p;
  await settle(2500);
  const v = await page.evaluate(() => ({ path: location.pathname, marketing: !!document.querySelector("main#main-content") || /העסק שלך,/.test(document.body.innerText), loginForm: !!document.querySelector("#login-email") }));
  await shot("signedin-final");
  log({ check: "signed-in-launch", navigations: [...navs], frames: timeline, ...v });
} catch (e) { log({ check: "signed-in-launch", error: String(e).slice(0, 200) }); }

// 6. LOGOUT from Settings → sign-in screen.
try {
  await mock({ me: 200 });
  await gotoFull("/settings", 4000);
  const btn = page.locator("button", { hasText: "התנתקות" }).first();
  let found = await btn.count();
  if (found) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await withTimeout(btn.click(), 15000, "logout click");
    await page.waitForTimeout(1500);
    const confirm = page.locator("button", { hasText: /^התנתקות$|^כן|אישור/ }).last();
    if ((await confirm.count()) && (await page.evaluate(() => location.pathname)) !== "/login") await confirm.click().catch(() => {});
    await page.waitForTimeout(3500);
  }
  const v = await loginView();
  await shot("after-logout");
  log({ check: "logout", logoutButtonFound: !!found, ...v });
} catch (e) { log({ check: "logout", error: String(e).slice(0, 200) }); }

// 7. EXPIRED session at launch: stored token rejected → sign-in form, stale token cleared.
try {
  await mock({ me: 401 });
  await page.evaluate(() => localStorage.setItem("token", "expired-token"));
  await gotoFull("/", 4000);
  const v = await loginView();
  await shot("expired");
  log({ check: "expired-session", navigations: [...navs], ...v });
} catch (e) { log({ check: "expired-session", error: String(e).slice(0, 200) }); }

// 8. REGISTER from the sign-in screen: opens inside the app.
try {
  await mock({ me: 401 });
  await gotoFull("/login", 3000);
  const reg = page.locator("button", { hasText: /הרשמה|להרשמה|הירשם/ }).first();
  const has = await reg.count();
  if (has) { await reg.click(); await page.waitForTimeout(3500); }
  const v = await page.evaluate(() => ({ path: location.pathname, nameField: !!document.querySelector("input"), marketing: !!document.querySelector("main#main-content") }));
  await shot("register");
  log({ check: "register", linkFound: !!has, focus: focusApp(), ...v });
} catch (e) { log({ check: "register", error: String(e).slice(0, 200) }); }

// 9. FORGOT PASSWORD from the sign-in screen (request mocked: no email is sent).
try {
  await mock({ me: 401, forgot: 200 });
  await gotoFull("/login", 3000);
  const fp = page.locator('[data-testid="forgot-password-link"]');
  const has = await fp.count();
  let after = null;
  if (has) {
    await fp.click();
    await page.waitForTimeout(3500);
    const path = await page.evaluate(() => location.pathname);
    await shot("forgot");
    const input = page.locator('input[type="email"]').first();
    if (await input.count()) {
      await input.fill("owner@example.com");
      await page.locator('button[type="submit"]').first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    after = { path, status: await page.evaluate(() => [...document.querySelectorAll('[role="status"],[role="alert"]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3)) };
    await shot("forgot-sent");
  }
  log({ check: "forgot-password", linkFound: !!has, focus: focusApp(), ...after });
} catch (e) { log({ check: "forgot-password", error: String(e).slice(0, 200) }); }

// 10. In-app navigation to the marketing page (privacy page header logo → /home).
try {
  await mock({ me: 401 });
  await gotoFull("/privacy", 3500);
  const logo = page.locator('a[href="/home"]').first();
  const has = await logo.count();
  if (has) { await logo.click(); await page.waitForTimeout(4000); }
  const v = await page.evaluate(() => ({ path: location.pathname, marketing: !!document.querySelector("main#main-content") && /העסק שלך,/.test(document.body.innerText) }));
  await shot("privacy-logo");
  log({ check: "in-app-nav-to-marketing", logoFound: !!has, ...v });
} catch (e) { log({ check: "in-app-nav-to-marketing", error: String(e).slice(0, 200) }); }

// 11. Landscape sign-in, then dark mode (cold start, no session).
try {
  await mock({ me: 401 });
  await page.evaluate(() => localStorage.clear());
  await gotoFull("/login", 3000);
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "settings", "put", "system", "user_rotation", "1");
  await page.waitForTimeout(4000);
  const land = await loginView();
  await shot("landscape");
  adb("shell", "settings", "put", "system", "user_rotation", "0");
  await page.waitForTimeout(3000);
  log({ check: "landscape", ...land });
} catch (e) { log({ check: "landscape", error: String(e).slice(0, 200) }); }
try {
  adb("shell", "cmd", "uimode", "night", "yes");
  adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(9000);
  await connect();
  const v = await loginView();
  await shot("dark");
  log({ check: "dark-mode", ...v });
} catch (e) { log({ check: "dark-mode", error: String(e).slice(0, 200) }); }
adb("shell", "cmd", "uimode", "night", "no");

await device.close();
