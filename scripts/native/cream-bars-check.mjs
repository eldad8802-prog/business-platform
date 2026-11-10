// DIAGNOSTIC ONLY (branch diag/android-cream-bars) — consolidated release stage 1 on a real emulator.
// For one installed APK ("old" = today's native, versionCode 1; "new" = cream theme, versionCode 2) against
// the branch's web build: cold start, light and dark mode, rotation, keyboard and the status / navigation bar
// — measured from screenshots (bar colour + dark icon pixels) and window frames, not from CSS.
// usage: node scripts/native/cream-bars-check.mjs <outDir> <variant>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { PNG } = require("playwright-core/lib/utilsBundle");
const [OUT, VARIANT] = process.argv.slice(2);
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const log = (o) => { results.push({ variant: VARIANT, ...o }); writeFileSync(join(OUT, `cream-${VARIANT}.json`), JSON.stringify(results, null, 1)); console.log(JSON.stringify(o).slice(0, 500)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const adbBuf = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [device] = await android.devices();

const frames = () => {
  const d = adb("shell", "dumpsys", "window");
  const pick = (re) => { const m = [...d.matchAll(re)].map((x) => x.slice(1, 5).map(Number)).filter(([l, t, r, b]) => r > l && b > t); return m[0] ?? null; };
  return {
    statusBar: pick(/(?:type=statusBars|ITYPE_STATUS_BAR)[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g),
    navBar: pick(/(?:type=navigationBars|ITYPE_NAVIGATION_BAR)[^\n]*?frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g),
  };
};
const webview = () => { adb("shell", "uiautomator", "dump", "/sdcard/ui.xml"); const x = adb("shell", "cat", "/sdcard/ui.xml"); const m = x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/); return m ? m.slice(1, 5).map(Number) : null; };
const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

// Colour of a band: the most common colour, and how many clearly dark pixels (icons / text) sit in it.
const band = (png, [l, t, r, b]) => {
  const counts = new Map(); let dark = 0; let light = 0; let n = 0;
  for (let y = Math.max(0, t); y < Math.min(png.height, b); y += 2) for (let x = Math.max(0, l); x < Math.min(png.width, r); x += 2) {
    const i = (png.width * y + x) * 4; const R = png.data[i], G = png.data[i + 1], B = png.data[i + 2];
    const k = hex(R & 0xfc, G & 0xfc, B & 0xfc); counts.set(k, (counts.get(k) || 0) + 1); n++;
    const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B; if (lum < 90) dark++; if (lum > 200) light++;
  }
  const top = [...counts.entries()].sort((a, c) => c[1] - a[1])[0] || ["?", 0];
  return { dominant: top[0], dominantShare: +(top[1] / Math.max(1, n)).toFixed(2), darkPixels: dark, lightPixels: light };
};
const snapshot = async (name) => {
  const buf = await device.screenshot();
  writeFileSync(join(OUT, "shots", `${VARIANT}-${name}.png`), buf);
  const png = PNG.sync.read(buf);
  const f = frames(); const wv = webview();
  return {
    statusBand: f.statusBar ? band(png, f.statusBar) : null,
    navBand: f.navBar && f.navBar[1] > 0 ? band(png, f.navBar) : null,
    statusBar: f.statusBar, navBar: f.navBar, webview: wv,
    webviewBelowStatusBar: wv && f.statusBar ? wv[1] >= f.statusBar[3] : null,
    webviewAboveNavBar: wv && f.navBar && f.navBar[1] > 0 ? wv[3] <= f.navBar[1] : null,
  };
};
const coldStart = async (label) => {
  adb("shell", "am", "force-stop", PKG); await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  const t0 = Date.now(); const timeline = [];
  for (const t of [800, 1600, 2600, 4000, 6000, 9000]) {
    await sleep(Math.max(0, t0 + t - Date.now()));
    const b = adbBuf("exec-out", "screencap", "-p"); if (!b) continue;
    const png = PNG.sync.read(b); const f = frames();
    timeline.push({ t, statusBand: f.statusBar ? band(png, f.statusBar) : null, webviewTop: webview()?.[1] ?? null });
    writeFileSync(join(OUT, "shots", `${VARIANT}-${label}-cold-${t}ms.png`), b);
  }
  return timeline;
};

log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim(), versionCode: (adb("shell", "dumpsys", "package", PKG).match(/versionCode=(\d+)/) || [])[1] });

for (const mode of ["light", "dark"]) {
  try {
    adb("shell", "cmd", "uimode", "night", mode === "dark" ? "yes" : "no"); await sleep(2000);
    const timeline = await coldStart(mode);
    const steady = await snapshot(`${mode}-steady`);
    log({ check: `cold-start-${mode}`, timeline, steady });

    // Rotation (configuration change) and back.
    adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    adb("shell", "settings", "put", "system", "user_rotation", "1"); await sleep(4500);
    const land = await snapshot(`${mode}-landscape`);
    adb("shell", "settings", "put", "system", "user_rotation", "0"); await sleep(4500);
    const back = await snapshot(`${mode}-portrait-again`);
    log({ check: `rotation-${mode}`, landscape: land, portraitAgain: back });
  } catch (e) { log({ check: `mode-${mode}`, error: String(e).slice(0, 200) }); }
}
adb("shell", "cmd", "uimode", "night", "no"); await sleep(2000);

// Keyboard on the sign-in screen (real taps / typing).
try {
  await coldStart("kb");
  const wv = await device.webView({ pkg: PKG }, { timeout: 45000 }); const page = await wv.page(); await page.waitForTimeout(2000);
  const r = await page.evaluate(() => { const e = document.querySelector("#login-email")?.getBoundingClientRect(); return e ? { x: e.x + e.width / 2, y: e.y + e.height / 2, dpr: devicePixelRatio, path: location.pathname } : { path: location.pathname }; });
  const w = webview();
  if (r.x && w) adb("shell", "input", "tap", String(Math.round(w[0] + r.x * r.dpr)), String(Math.round(w[1] + r.y * r.dpr)));
  await sleep(2500);
  adb("shell", "input", "text", "owner@example.com"); await sleep(1500);
  const ime = adb("shell", "dumpsys", "input_method").match(/mInputShown=(\w+)/)?.[1] ?? "?";
  const k = await page.evaluate(() => { const f = document.activeElement?.getBoundingClientRect(); const b = document.querySelector('button[type="submit"]'); b?.scrollIntoView({ block: "nearest" }); const br = b?.getBoundingClientRect();
    return { focusedVisible: !!f && f.top >= 0 && f.bottom <= innerHeight, submitReachable: !!br && br.top >= 0 && br.bottom <= innerHeight, innerHeight }; });
  const s = await snapshot("keyboard");
  log({ check: "keyboard", path: r.path, imeShown: ime, ...k, statusBand: s.statusBand, webviewBelowStatusBar: s.webviewBelowStatusBar, webview: s.webview });
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
} catch (e) { log({ check: "keyboard", error: String(e).slice(0, 200) }); }

await device.close();
