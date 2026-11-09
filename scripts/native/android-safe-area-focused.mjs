// DIAGNOSTIC ONLY (branch diag/android-safe-area) — issue 2, final focused checks.
// Real Capacitor WebView + Chrome on the same emulator; app served on localhost:3000.
// usage: node scripts/native/android-safe-area-focused.mjs <outDir>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "focused"), { recursive: true });
const results = [];
const save = () => writeFileSync(join(OUT, "focused-results.json"), JSON.stringify(results, null, 1));
const log = (o) => { results.push(o); save(); console.log(JSON.stringify(o).slice(0, 400)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
process.on("unhandledRejection", (e) => console.log("unhandledRejection", String(e).slice(0, 120)));

const [device] = await android.devices();
const shot = async (name) => writeFileSync(join(OUT, "focused", `${name}.png`), await device.screenshot());
let page;
const connect = async () => {
  const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
  page = await wv.page();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
};
const relaunch = async () => {
  adb("shell", "am", "force-stop", PKG);
  await new Promise((r) => setTimeout(r, 2000));
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await new Promise((r) => setTimeout(r, 12000));
  await connect();
};
const measure = () => page.evaluate(() => {
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-top")) || 0;
  const bottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-bottom")) || 0;
  let underTop = 0;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if ((own || el.matches("a,button,input,svg,img")) && top > 0 && r.top < top) underTop++;
  }
  return {
    path: location.pathname, insetTop: top, insetBottom: bottom, underTop, innerHeight: window.innerHeight, innerWidth: window.innerWidth,
    viewport: [...document.querySelectorAll('meta[name="viewport"]')].map((m) => m.content),
  };
});
const visit = async (route, wait = 3000) => {
  await withTimeout(page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 45000 }), 60000, route);
  await page.waitForTimeout(wait);
  return measure();
};

await relaunch();
await page.evaluate(() => localStorage.setItem("token", "diag-token"));

// 1. The five flag-off notFound() pages (error-fallback documents).
for (const r of ["/auth/google/done", "/link/google", "/link/google/confirm", "/register/google", "/settings/inbound-email"]) {
  try { const m = await visit(r, 4000); await shot(`404${r.replace(/\//g, "_")}`); log({ check: "404-page", route: r, ...m, pass: m.insetTop === 0 && m.underTop === 0 }); }
  catch (e) { log({ check: "404-page", route: r, error: String(e).slice(0, 160) }); }
}

// 2. Keyboard: a form with the confirm button at the bottom.
const keyboard = async (route, withToken) => {
  await page.evaluate((t) => { if (t) localStorage.setItem("token", "diag-token"); else localStorage.removeItem("token"); }, withToken);
  const m0 = await visit(route, 3000);
  if (m0.path !== route) return { route, skipped: `redirected to ${m0.path}` };
  const field = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea').first();
  if (!(await field.count())) return { route, skipped: "no text field" };
  await withTimeout(field.click(), 20000, "field click");
  await page.waitForTimeout(3000);
  const ime = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
  const k = await page.evaluate(() => {
    const f = document.activeElement?.getBoundingClientRect();
    const btn = document.querySelector('button[type="submit"]') || [...document.querySelectorAll("form button")].pop();
    const b = btn?.getBoundingClientRect();
    btn?.scrollIntoView({ block: "nearest" });
    const b2 = btn?.getBoundingClientRect();
    return {
      innerHeightWithKeyboard: window.innerHeight,
      fieldVisible: !!f && f.top >= 0 && f.bottom <= window.innerHeight,
      submitLabel: btn ? (btn.textContent || "").trim().slice(0, 30) : null,
      submitVisibleAsIs: !!b && b.top >= 0 && b.bottom <= window.innerHeight,
      submitReachableByScroll: !!b2 && b2.top >= 0 && b2.bottom <= window.innerHeight,
    };
  });
  await shot(`keyboard${route.replace(/\//g, "_")}`);
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await page.waitForTimeout(1500);
  return { route, innerHeightBefore: m0.innerHeight, imeShown: ime, ...k };
};
for (const [r, t] of [["/forgot-password", false], ["/reset-password", false], ["/register", false], ["/inventory/items/create", true], ["/payables/bank", true]]) {
  try { const k = await withTimeout(keyboard(r, t), 90000, `keyboard ${r}`); log({ check: "keyboard", ...k, pass: k.skipped ? undefined : (k.imeShown === "true" && k.fieldVisible && k.submitReachableByScroll) }); }
  catch (e) { log({ check: "keyboard", route: r, error: String(e).slice(0, 160) }); }
}
await page.evaluate(() => localStorage.setItem("token", "diag-token"));

// 5. After the 15 s observer window: client-side navigation + rotation keep the padded layout.
try {
  const first = await visit("/home", 1000);
  await page.waitForTimeout(20000); // observer has disconnected
  const link = page.locator('a[href="/payables"], a[href^="/payables"]').first();
  let nav = "no in-app link found";
  if (await link.count()) {
    await withTimeout(link.click(), 20000, "spa click");
    await page.waitForTimeout(3000);
    nav = "spa";
  } else {
    await page.evaluate(() => history.pushState({}, "", "/payables"));
    await page.waitForTimeout(1000);
    nav = "pushState";
  }
  const afterNav = await measure();
  await shot("after15s-nav");
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "settings", "put", "system", "user_rotation", "1");
  await page.waitForTimeout(4000);
  const land = await measure();
  await shot("after15s-landscape");
  adb("shell", "settings", "put", "system", "user_rotation", "0");
  await page.waitForTimeout(4000);
  const back = await measure();
  await shot("after15s-portrait-again");
  log({ check: "after-15s", nav, first, afterNav, landscape: land, portraitAgain: back,
    pass: [afterNav, land, back].every((m) => m.insetTop === 0 && m.underTop === 0) });
} catch (e) { log({ check: "after-15s", error: String(e).slice(0, 200) }); }

// 4. Dark mode: status icons must follow the system (light icons on the dark strip).
try {
  adb("shell", "cmd", "uimode", "night", "yes");
  await relaunch();
  await page.evaluate(() => localStorage.setItem("token", "diag-token"));
  const m = await visit("/home", 4000);
  await shot("dark-home");
  const win = adb("shell", "dumpsys", "window", "windows");
  const appearance = (win.match(/appearance=\[[^\]]*\]|mAppearance=0x[0-9a-f]+|APPEARANCE_LIGHT_STATUS_BARS/gi) || []).slice(0, 6);
  log({ check: "dark-mode", ...m, uimode: adb("shell", "cmd", "uimode", "night").trim(), appearanceFlags: appearance,
    lightStatusBarIconsFlagPresent: /APPEARANCE_LIGHT_STATUS_BARS/.test(win) });
  adb("shell", "cmd", "uimode", "night", "no");
} catch (e) { log({ check: "dark-mode", error: String(e).slice(0, 200) }); adb("shell", "cmd", "uimode", "night", "no"); }

// 3. Plain Chrome on the same emulator: the switch must NOT run there.
try {
  adb("shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
  adb("shell", "sh", "-c", "echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line");
  const browser = await withTimeout(device.launchBrowser(), 90000, "launchBrowser");
  const bp = await browser.newPage();
  await withTimeout(bp.goto(BASE + "/home", { waitUntil: "domcontentloaded" }), 60000, "chrome goto");
  await bp.waitForTimeout(4000);
  const r = await bp.evaluate(() => ({
    hasInterface: typeof window.CapacitorSystemBarsAndroidInterface !== "undefined",
    viewport: [...document.querySelectorAll('meta[name="viewport"]')].map((m) => m.content),
    ua: navigator.userAgent.slice(0, 90),
  }));
  writeFileSync(join(OUT, "focused", "chrome-home.png"), await device.screenshot());
  log({ check: "plain-chrome", ...r, pass: !r.hasInterface && r.viewport.every((c) => /viewport-fit=cover/.test(c)) });
  await browser.close();
} catch (e) { log({ check: "plain-chrome", error: String(e).slice(0, 240) }); }

await device.close();
