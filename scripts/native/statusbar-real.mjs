// DIAGNOSTIC ONLY (branch diag/android-statusbar-overlay) — issue 2, part 2.
//
// Measures where the app's content REALLY is relative to the system bars, from
// Android itself — never from the safe-area values Capacitor reports to the page
// (those are 0 on the padded path whether or not the WebView moved, which is what
// blinded the first sweep):
//   - status / navigation bar frames: `dumpsys window` (InsetsSource frames, px);
//   - the WebView's frame on screen: the UI hierarchy (uiautomator, px);
//   - the first visible content element: its CSS rect × devicePixelRatio + the WebView top.
// A route FAILS when the WebView or its first content starts above the status bar's
// bottom edge, or the bottom navigation ends below the navigation bar's top edge.
//
// usage: node scripts/native/statusbar-real.mjs <mode> <outDir> <scenario>
//   scenario: routes | keyboard | sheet | landscape
import { _android as android } from "playwright";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [mode, outDir, scenario = "routes"] = process.argv.slice(2);
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
const ROUTES = ["/home", "/payables", "/documents", "/customers", "/calendar", "/tasks", "/inventory", "/settings", "/secretary", "/billing", "/login", "/forgot-password"];
mkdirSync(join(outDir, "shots"), { recursive: true });
const jsonl = join(outDir, `real-${mode}.jsonl`);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);

const [device] = await android.devices();
if (!device) throw new Error("no adb device");

async function bars() {
  const out = (await device.shell("dumpsys window")).toString();
  const frame = (types) => {
    for (const line of out.split("\n")) {
      if (!types.some((t) => line.includes(`type=${t}`))) continue;
      const m = line.match(/frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
      if (!m) continue;
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      if (x2 > x1 && y2 > y1) return { x1, y1, x2, y2 };
    }
    return null;
  };
  return { status: frame(["statusBars", "ITYPE_STATUS_BAR"]), nav: frame(["navigationBars", "ITYPE_NAVIGATION_BAR"]) };
}

// The WebView's frame from the UI hierarchy through adb's own uiautomator (Playwright's
// device.info() needs its driver APK, which this emulator does not have — run 42677048086).
async function webViewFrame() {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    last = (await withTimeout(device.shell("uiautomator dump /sdcard/dz-ui.xml >/dev/null 2>&1; cat /sdcard/dz-ui.xml"), 30000, "uiautomator dump")).toString();
    const m = last.match(/<node[^>]*class="android\.webkit\.WebView"[^>]*bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
    if (m) {
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      return { x1, y1, x2, y2 };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no WebView in the UI hierarchy: ${last.slice(0, 120)}`);
}

const inPage = () => {
  const dpr = window.devicePixelRatio;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.visibility !== "hidden" && s.opacity !== "0";
  };
  const candidates = [...document.querySelectorAll("h1,h2,header,button,a,input,img,svg,[role=button],[role=heading]")].filter(visible);
  let first = null;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (!first || r.top < first.top) first = { top: r.top, label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30) };
  }
  // the fixed bottom navigation, if this screen has one
  let bottomNav = null;
  for (const el of document.querySelectorAll("nav, [role=navigation], [role=tablist]")) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if ((s.position === "fixed" || s.position === "sticky") && r.height > 20 && r.bottom > innerHeight - 4) bottomNav = { top: r.top, bottom: r.bottom };
  }
  const dialog = [...document.querySelectorAll("[role=dialog],[aria-modal=true]")].filter(visible).map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  })[0] ?? null;
  const f = document.activeElement && document.activeElement !== document.body ? document.activeElement.getBoundingClientRect() : null;
  return { dpr, innerHeight, innerWidth, path: location.pathname, first, bottomNav, dialog, focused: f ? { top: f.top, bottom: f.bottom } : null };
};

function verdict(b, wv, p) {
  const fails = [];
  const sb = b.status;
  const nav = b.nav;
  if (!sb) fails.push("no status bar frame");
  if (sb && wv.y1 < sb.y2 - 1) fails.push(`WebView top ${wv.y1}px < status bar bottom ${sb.y2}px`);
  const contentTop = p.first ? Math.round(wv.y1 + p.first.top * p.dpr) : null;
  if (sb && contentTop !== null && contentTop < sb.y2 - 1) fails.push(`first content "${p.first.label}" at ${contentTop}px < status bar bottom ${sb.y2}px`);
  // navigation bar at the bottom (portrait): the WebView and the bottom navigation must end above it
  if (nav && nav.y1 > 0 && nav.x2 - nav.x1 > nav.y2 - nav.y1) {
    if (wv.y2 > nav.y1 + 1) fails.push(`WebView bottom ${wv.y2}px > navigation bar top ${nav.y1}px`);
    if (p.bottomNav) {
      const bnBottom = Math.round(wv.y1 + p.bottomNav.bottom * p.dpr);
      if (bnBottom > nav.y1 + 1) fails.push(`bottom navigation ends at ${bnBottom}px > navigation bar top ${nav.y1}px`);
    }
  }
  // navigation bar on a side (landscape): the WebView must not cover it
  if (nav && nav.y2 - nav.y1 > nav.x2 - nav.x1) {
    if (nav.x1 > 0 && wv.x2 > nav.x1 + 1) fails.push(`WebView right ${wv.x2}px > navigation bar left ${nav.x1}px`);
    if (nav.x1 <= 0 && wv.x1 < nav.x2 - 1) fails.push(`WebView left ${wv.x1}px < navigation bar right ${nav.x2}px`);
  }
  if (p.dialog && sb) {
    const dTop = Math.round(wv.y1 + p.dialog.top * p.dpr);
    if (dTop < sb.y2 - 1) fails.push(`sheet top ${dTop}px < status bar bottom ${sb.y2}px`);
  }
  return { contentTop, fails };
}

let page;
async function connect() {
  const webview = await device.webView({ pkg: PKG }, { timeout: 60000 });
  page = await webview.page();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
}

async function measure(label, extra = {}) {
  const b = await bars();
  const wv = await webViewFrame();
  const p = await page.evaluate(inPage);
  const v = verdict(b, wv, p);
  const shot = `${mode}-${scenario}-${label.replace(/[^\w]+/g, "_")}.png`;
  writeFileSync(join(outDir, "shots", shot), await device.screenshot());
  const rec = { mode, scenario, label, statusBar: b.status, navBar: b.nav, webView: wv, ...p, contentTop: v.contentTop, ok: v.fails.length === 0, fails: v.fails, shot, ...extra };
  appendFileSync(jsonl, JSON.stringify(rec) + "\n");
  console.log(`[${mode}/${scenario}] ${label} ${rec.ok ? "PASS" : "FAIL"} status=${b.status ? `${b.status.y1}-${b.status.y2}` : "?"} webView=${wv.y1}-${wv.y2} content=${v.contentTop} nav=${b.nav ? `${b.nav.y1}-${b.nav.y2}` : "?"} ${v.fails.join("; ")}`);
  return rec;
}

if (scenario === "chrome") {
  // Plain Chrome on the same device: no Android shell interface → the switch must stay off.
  try {
    const ctx = await withTimeout(device.launchBrowser(), 60000, "launchBrowser");
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${BASE}/login`, { waitUntil: "load", timeout: 45000 });
    await p.waitForTimeout(2000);
    const r = await p.evaluate(() => ({
      viewport: [...document.querySelectorAll('meta[name="viewport"]')].map((m) => m.content),
      flag: typeof window.__dzStatusBarBelow,
      shell: typeof window.CapacitorSystemBarsAndroidInterface,
    }));
    const ok = r.flag === "undefined" && r.shell === "undefined" && r.viewport.every((c) => c.includes("viewport-fit=cover")) && errors.length === 0;
    writeFileSync(join(outDir, "shots", `${mode}-chrome-login.png`), await device.screenshot());
    appendFileSync(jsonl, JSON.stringify({ mode, scenario, label: "chrome /login", ok, ...r, errors }) + "\n");
    console.log(`[${mode}/chrome] ${ok ? "PASS" : "FAIL"} ${JSON.stringify(r)} errors=${errors.length}`);
    await ctx.close();
  } catch (e) { console.log(`[${mode}/chrome] ERROR ${String(e).slice(0, 140)}`); }
  process.exit(0);
}

await connect();
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("token", "diag-token"));
const go = async (route) => {
  await page.evaluate(() => { if (!localStorage.getItem("token")) localStorage.setItem("token", "diag-token"); }).catch(() => {});
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (e) {
    // a client-side redirect aborts the navigation Playwright waits on; the page that loads is still measured
    if (!/ERR_ABORTED|frame was detached/.test(String(e))) throw e;
  }
  await page.waitForTimeout(2500);
};

if (scenario === "routes" || scenario === "landscape") {
  const list = scenario === "landscape" ? ["/home", "/payables", "/documents", "/forgot-password"] : ROUTES;
  for (const route of list) {
    try { await withTimeout(go(route), 60000, route); await measure(route); }
    catch (e) { console.log(`[${mode}/${scenario}] ${route} ERROR ${String(e).slice(0, 140)}`); appendFileSync(jsonl, JSON.stringify({ mode, scenario, label: route, error: String(e).slice(0, 200) }) + "\n"); }
  }
}

if (scenario === "keyboard") {
  for (const route of ["/forgot-password", "/login"]) {
    try {
      await go(route);
      const field = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio])').first();
      const before = await page.evaluate(() => innerHeight);
      await withTimeout(field.click(), 20000, "focus");
      await page.waitForTimeout(2500);
      const kb = await page.evaluate(() => {
        const f = document.activeElement.getBoundingClientRect();
        const btn = document.querySelector('button[type="submit"]');
        btn?.scrollIntoView({ block: "nearest" });
        const b = btn?.getBoundingClientRect();
        return { innerHeightWithKeyboard: innerHeight, fieldVisible: f.top >= 0 && f.bottom <= innerHeight, submitReachable: !!b && b.top >= 0 && b.bottom <= innerHeight };
      });
      const rec = await measure(`${route}-keyboard`, { innerHeightBefore: before, ...kb, keyboardOpened: kb.innerHeightWithKeyboard < before });
      if (!kb.fieldVisible || !kb.submitReachable || !rec.keyboardOpened) console.log(`[${mode}/keyboard] ${route} KEYBOARD-FAIL ${JSON.stringify(kb)} before=${before}`);
      await page.keyboard.press("Escape").catch(() => {});
      break;
    } catch (e) { console.log(`[${mode}/keyboard] ${route} ERROR ${String(e).slice(0, 140)}`); }
  }
}

if (scenario === "sheet") {
  // The bottom navigation's centre "+" opens the quick-create sheet; navigation between tabs is a client transition.
  try {
    await go("/home");
    const plus = page.locator('nav button, nav a').filter({ hasText: /^\s*\+?\s*$/ }).first();
    const opener = (await plus.count()) ? plus : page.locator('[aria-label*="חדש"], [aria-label*="הוספ"], [aria-label*="Create"], [aria-label*="New"]').first();
    await withTimeout(opener.click(), 20000, "open sheet");
    await page.waitForTimeout(1500);
    await measure("home-sheet-open");
    await page.keyboard.press("Escape").catch(() => {});
    await page.goBack().catch(() => {});
  } catch (e) { console.log(`[${mode}/sheet] ERROR ${String(e).slice(0, 140)}`); }
  try {
    await go("/home");
    const tab = page.locator('nav a[href="/documents"], nav a[href*="documents"]').first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(2500);
      await measure("nav-home-to-documents (client transition)");
    }
  } catch (e) { console.log(`[${mode}/sheet] nav ERROR ${String(e).slice(0, 140)}`); }
}
process.exit(0);
