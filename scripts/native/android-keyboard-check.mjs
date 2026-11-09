// DIAGNOSTIC ONLY (branch diag/android-app-login) — issue 3: with the keyboard open on the sign-in
// screen, can a REAL finger scroll to the sign-in button and tap it? Real input only: adb taps,
// adb text, adb swipe (no JavaScript clicks or scrolling). Success = the sign-in request reaches the
// (mocked) server and its Hebrew error is shown.
// usage: node scripts/native/android-keyboard-check.mjs <outDir> <mode>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [OUT, MODE] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const log = (o) => { results.push({ mode: MODE, ...o }); writeFileSync(join(OUT, `keyboard-${MODE}.json`), JSON.stringify(results, null, 1)); console.log(JSON.stringify(o).slice(0, 700)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [device] = await android.devices();
adb("shell", "am", "force-stop", PKG);
await sleep(1500);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
await sleep(10000);
const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
const page = await wv.page();
let loginCalls = 0;
await page.route("**/api/**", async (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p === "/api/auth/login") { loginCalls++; return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "האימייל או הסיסמה שגויים", code: "INVALID_CREDENTIALS" }) }); }
  return r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' });
});
const shot = async (n) => writeFileSync(join(OUT, "shots", `${MODE}-kb-${n}.png`), await device.screenshot());
const webviewBounds = () => {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const x = adb("shell", "cat", "/sdcard/ui.xml");
  const m = x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  return m ? m.slice(1, 5).map(Number) : null;
};
// Element rect → screen pixels, and whether it is fully inside the visible WebView.
const onScreen = async (selector) => {
  const wb = webviewBounds();
  const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, dpr: devicePixelRatio, scrollY: scrollY, innerHeight }; }, selector);
  if (!wb || !r) return { wb, r };
  const s = { top: Math.round(wb[1] + r.top * r.dpr), bottom: Math.round(wb[1] + r.bottom * r.dpr), x: Math.round(wb[0] + ((r.left + r.right) / 2) * r.dpr) };
  return { webview: wb, scrollY: r.scrollY, innerHeight: r.innerHeight, screen: s, fullyVisible: s.top >= wb[1] && s.bottom <= wb[3] };
};
const tapCenter = async (selector) => { const o = await onScreen(selector); adb("shell", "input", "tap", String(o.screen.x), String(Math.round((o.screen.top + o.screen.bottom) / 2))); return o; };

log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim(), model: adb("shell", "getprop", "ro.product.model").trim() });
await page.evaluate(() => localStorage.clear());
await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

// Type with the real keyboard: tap the field, type, tap the next field, type. Keyboard stays open.
await tapCenter("#login-email");
await sleep(1500);
adb("shell", "input", "text", "owner@example.com");
await sleep(800);
await tapCenter("#login-password");
await sleep(1500);
adb("shell", "input", "text", "wrongpass123");
await sleep(1500);
const ime = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
const before = await onScreen('button[type="submit"]');
await shot("1-typed-keyboard-open");
log({ check: "keyboard-open", imeShown: ime, button: before });

// Scroll with a real finger: swipe up in the middle of the visible area (above the keyboard).
let after = before;
const swipes = [];
for (let i = 0; i < 3 && !after.fullyVisible; i++) {
  const wb = after.webview;
  const x = Math.round((wb[0] + wb[2]) / 2);
  const y1 = Math.round(wb[1] + (wb[3] - wb[1]) * 0.75);
  const y2 = Math.round(wb[1] + (wb[3] - wb[1]) * 0.30);
  adb("shell", "input", "swipe", String(x), String(y1), String(x), String(y2), "400");
  await sleep(1200);
  after = await onScreen('button[type="submit"]');
  swipes.push({ scrollY: after.scrollY, fullyVisible: after.fullyVisible, buttonScreen: after.screen });
}
const imeAfterSwipe = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
await shot("2-after-scroll");
log({ check: "scroll", swipes, imeStillShown: imeAfterSwipe, button: after });

// Tap the sign-in button with a real tap; the request must reach the server and the error show.
const callsBefore = loginCalls;
await tapCenter('button[type="submit"]');
await sleep(3000);
const alerts = await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()).filter(Boolean));
await shot("3-after-tap");
log({ check: "tap", loginRequestSent: loginCalls > callsBefore, alerts, pass: loginCalls > callsBefore && alerts.some((a) => a.includes("שגויים")) });

await device.close();
