// DIAGNOSTIC ONLY (branch diag/android-safe-area) — issue 2b: StatusBar overlay on Android <= 14.
// Measures in SCREEN PIXELS, not CSS insets: the WebView's on-screen bounds (uiautomator) and
// the first visible header element mapped to screen pixels, against the status bar, the display
// cutout and the navigation bar frames reported by the window manager.
// usage: node scripts/native/android-statusbar-check.mjs <outDir> <mode: before|after>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [OUT, MODE] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const save = () => writeFileSync(join(OUT, `results-${MODE}.json`), JSON.stringify(results, null, 1));
const log = (o) => { results.push({ mode: MODE, ...o }); save(); console.log(JSON.stringify(o).slice(0, 500)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
process.on("unhandledRejection", (e) => console.log("unhandledRejection", String(e).slice(0, 120)));

const [device] = await android.devices();
let page;
const connect = async () => {
  const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
  page = await wv.page();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
};
const relaunch = async () => {
  adb("shell", "am", "force-stop", PKG);
  await sleep(2000);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(12000);
  await connect();
};
const shot = async (name) => writeFileSync(join(OUT, "shots", `${MODE}-${name}.png`), await device.screenshot());

// Window-manager frames (screen px). API 34+ prints "type=statusBars frame=[l,t][r,b]"; older "ITYPE_STATUS_BAR".
const frames = () => {
  const d = adb("shell", "dumpsys", "window");
  const pick = (re) => {
    const all = [...d.matchAll(re)].map((m) => m.slice(1, 5).map(Number)).filter(([l, t, r, b]) => r > l && b > t);
    return all.length ? all[0] : null;
  };
  return {
    statusBar: pick(/(?:type=statusBars|ITYPE_STATUS_BAR)[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g),
    navBar: pick(/(?:type=navigationBars|ITYPE_NAVIGATION_BAR)[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g),
    cutout: pick(/(?:type=displayCutout|ITYPE_[A-Z_]*CUTOUT[A-Z_]*)[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g),
  };
};
// The app's WebView bounds on screen (uiautomator).
const webviewBounds = () => {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const x = adb("shell", "cat", "/sdcard/ui.xml");
  const m = x.match(/class="android\.webkit\.WebView"[^>]*?package="il\.co\.promaxgroup\.dubiz"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    || x.match(/package="il\.co\.promaxgroup\.dubiz"[^>]*?class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    || x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  return m ? m.slice(1, 5).map(Number) : null;
};
const statusIconsLight = () => /APPEARANCE_LIGHT_STATUS_BARS/.test(adb("shell", "dumpsys", "window", "windows").split("Window #").find((w) => w.includes(PKG)) || "");

const pageInfo = () => page.evaluate(() => {
  const dpr = window.devicePixelRatio;
  const insetTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-top")) || 0;
  // topmost visible interactive / text element
  let topEl = null;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.opacity === "0") continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!(own || el.matches("a,button,input,svg,img"))) continue;
    if (!topEl || r.top < topEl.top) topEl = { top: r.top, tag: el.tagName, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30) };
  }
  return { path: location.pathname, dpr, insetTop, innerHeight: window.innerHeight, innerWidth: window.innerWidth, topEl };
});

const measure = async (label) => {
  const f = frames();
  const wv = webviewBounds();
  const p = await pageInfo();
  const sbBottom = f.statusBar ? f.statusBar[3] : null;
  // a cutout along the top edge (wider than tall); in landscape it moves to a side edge
  const topCutout = f.cutout && f.cutout[1] === 0 && f.cutout[2] - f.cutout[0] > f.cutout[3] - f.cutout[1];
  const cutBottom = topCutout ? f.cutout[3] : 0;
  const sideCutout = f.cutout && !topCutout ? f.cutout : null;
  const topLimit = Math.max(sbBottom ?? 0, cutBottom);
  const topElScreenY = wv && p.topEl ? Math.round(wv[1] + p.topEl.top * p.dpr) : null;
  const navTop = f.navBar && f.navBar[1] > 0 ? f.navBar[1] : null; // bottom nav bar (portrait)
  const r = {
    label, ...p, webview: wv, statusBar: f.statusBar, cutout: f.cutout, navBar: f.navBar, topElScreenY,
    // the checks the owner asked for, in screen pixels
    headerBelowStatusBar: topElScreenY != null ? topElScreenY >= topLimit : null,
    webviewTopGapPx: wv && sbBottom != null ? wv[1] - topLimit : null, // >0 with page top content also padded = double spacing
    doublePadding: wv != null && wv[1] >= topLimit && wv[1] > 0 && p.insetTop > 0, // native offset AND css inset
    webviewClearOfSideCutout: wv && sideCutout ? (sideCutout[0] === 0 ? wv[0] >= sideCutout[2] : wv[2] <= sideCutout[0]) : null,
    webviewAboveNavBar: wv && navTop != null ? wv[3] <= navTop : null,
    // APPEARANCE_LIGHT_STATUS_BARS = the bar is light, so its icons are DARK
    statusIconsDark: statusIconsLight(),
  };
  return r;
};

const visit = async (route, wait = 3500) => {
  await withTimeout(page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 45000 }), 60000, route);
  await page.waitForTimeout(wait);
};

log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim(), model: adb("shell", "getprop", "ro.product.model").trim() });

await relaunch();
await page.evaluate(() => localStorage.setItem("token", "diag-token"));

// 1. Screens, portrait, light mode.
for (const r of ["/home", "/payables", "/documents", "/customers", "/inventory", "/login"]) {
  try {
    if (r === "/login") await page.evaluate(() => localStorage.removeItem("token"));
    await visit(r);
    const m = await measure(r);
    await shot(`portrait${r.replace(/\//g, "_")}`);
    log({ check: "screen", ...m });
  } catch (e) { log({ check: "screen", route: r, error: String(e).slice(0, 160) }); }
}
await page.evaluate(() => localStorage.setItem("token", "diag-token"));

// 2. Keyboard: form with the confirm button.
try {
  await visit("/inventory/items/create");
  const field = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea').first();
  await withTimeout(field.click(), 20000, "field click");
  await page.waitForTimeout(3000);
  const ime = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
  const m = await measure("keyboard");
  const k = await page.evaluate(() => {
    const f = document.activeElement?.getBoundingClientRect();
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    const btn = document.querySelector('button[type="submit"]')
      || buttons.find((b) => /שמיר|שמור|הוספ|יציר|צור|אישור/.test(b.textContent || ""))
      || buttons.pop();
    btn?.scrollIntoView({ block: "nearest" });
    const b = btn?.getBoundingClientRect();
    return {
      fieldVisible: !!f && f.top >= 0 && f.bottom <= window.innerHeight,
      submitLabel: btn ? (btn.textContent || "").trim().slice(0, 30) : null,
      submitReachable: !!b && b.top >= 0 && b.bottom <= window.innerHeight,
    };
  });
  await shot("keyboard");
  log({ check: "keyboard", imeShown: ime, ...m, ...k });
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await page.waitForTimeout(1500);
} catch (e) { log({ check: "keyboard", error: String(e).slice(0, 160) }); }

// 3. Navigation between screens: in-app link (SPA) and a full reload, after 20 s.
try {
  await visit("/home", 1000);
  await page.waitForTimeout(20000);
  const link = page.locator('a[href^="/payables"], a[href^="/documents"], a[href^="/customers"]').first();
  let nav = "pushState";
  if (await link.count()) { await withTimeout(link.click(), 20000, "spa click"); nav = "spa-click"; } else await page.evaluate(() => history.pushState({}, "", "/payables"));
  await page.waitForTimeout(3000);
  const spa = await measure("after-spa-nav");
  await shot("nav-spa");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const reload = await measure("after-full-reload");
  await shot("nav-reload");
  log({ check: "navigation", nav, spa, reload });
} catch (e) { log({ check: "navigation", error: String(e).slice(0, 160) }); }

// 4. Rotation (landscape, cutout side) and back.
try {
  await visit("/payables");
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "settings", "put", "system", "user_rotation", "1");
  await page.waitForTimeout(4500);
  const land = await measure("landscape");
  await shot("landscape");
  adb("shell", "settings", "put", "system", "user_rotation", "0");
  await page.waitForTimeout(4500);
  const back = await measure("portrait-again");
  await shot("portrait-again");
  log({ check: "rotation", landscape: land, portraitAgain: back });
} catch (e) { log({ check: "rotation", error: String(e).slice(0, 160) }); }

// 5. Cold start: the bar state right after launch (the JS call lands after hydration).
try {
  adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  const t0 = Date.now();
  const timeline = [];
  for (const t of [1500, 3000, 5000, 9000]) {
    await sleep(Math.max(0, t0 + t - Date.now()));
    timeline.push({ t, at: Date.now() - t0, webview: webviewBounds() });
    writeFileSync(join(OUT, "shots", `${MODE}-coldstart-${t}ms.png`), await device.screenshot());
  }
  log({ check: "cold-start", timeline });
  await connect();
} catch (e) { log({ check: "cold-start", error: String(e).slice(0, 160) }); }

// 6. Dark mode.
try {
  adb("shell", "cmd", "uimode", "night", "yes");
  await relaunch();
  await page.evaluate(() => localStorage.setItem("token", "diag-token"));
  await visit("/payables");
  const m = await measure("dark");
  await shot("dark");
  log({ check: "dark-mode", ...m });
} catch (e) { log({ check: "dark-mode", error: String(e).slice(0, 160) }); }
adb("shell", "cmd", "uimode", "night", "no");

await device.close();
