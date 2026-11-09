// DIAGNOSTIC ONLY (branch diag/android-safe-area) — issue 2, status-bar overlap.
//
// Drives the REAL Capacitor WebView on an emulator through Playwright's Android
// support and visits every page route of the app served on localhost:3000 (the
// APK's server.url, via `adb reverse`). For each route it records, in CSS px:
//   - the inset the page must reserve itself (Capacitor's --safe-area-inset-*,
//     non-zero only on the edge-to-edge/passthrough path),
//   - visible text/controls lying under the status bar or the navigation bar,
//   - horizontal overflow, and whether the page rendered at all,
// plus a full-device screenshot (status bar included). API calls are answered
// with an empty 200 so screens render without a database or any secret.
//
// usage: node scripts/native/android-safe-area-sweep.mjs <mode> <routes.txt> <outDir> [--shots all|some]
import { _android as android } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, routesFile, outDir, , shotsArg = "all"] = process.argv.slice(2);
process.on("unhandledRejection", (e) => console.log(`[${mode}] unhandledRejection ${String(e).slice(0, 120)}`));
const EXTRAS = process.env.SWEEP_EXTRAS === "1";
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
const SAMPLE = { id: "1", publicId: "demo", slug: "demo", token: "demo", businessId: "9", customerId: "1", supplierId: "1" };

const routes = readFileSync(routesFile, "utf8").split(/\r?\n/).filter(Boolean)
  .map((r) => r.replace(/\[\.\.\.(\w+)\]/g, "x").replace(/\[(\w+)\]/g, (_, k) => SAMPLE[k] ?? "1"));
mkdirSync(join(outDir, "shots"), { recursive: true });

const [device] = await android.devices();
if (!device) throw new Error("no adb device");
console.log(`device ${device.model()} serial=${device.serial()}`);
// Hard ceiling for every step: a stuck CDP call must not stall the whole sweep
// (run 42547728818 hung on one route with no timeout).
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);
let page;
const connect = async () => {
  const webview = await device.webView({ pkg: PKG }, { timeout: 60000 });
  page = await webview.page();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
};
await connect();

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("token", "diag-token"));
// Some screens clear the session; restore it before every route so later
// screens are not measured as a redirect (run 42543742763, API 34).
const ensureToken = async () => {
  try {
    await page.evaluate(() => { if (!localStorage.getItem("token")) localStorage.setItem("token", "diag-token"); });
  } catch {}
};

const measure = () => {
  const root = getComputedStyle(document.documentElement);
  const top = parseFloat(root.getPropertyValue("--safe-area-inset-top")) || 0;
  const bottom = parseFloat(root.getPropertyValue("--safe-area-inset-bottom")) || 0;
  const vp = document.querySelector('meta[name="viewport"]:last-of-type')?.getAttribute("content") ?? "";
  const H = window.innerHeight;
  const under = { top: [], bottom: [] };
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const interactive = el.matches("a,button,input,select,textarea,[role=button],[role=tab],[role=link]");
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!interactive && !ownText && el.tagName !== "svg" && el.tagName !== "IMG") continue;
    const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
    if (top > 0 && r.top < top && r.bottom > 0) under.top.push(label);
    if (bottom > 0 && interactive && r.bottom > H - bottom && r.top < H) under.bottom.push(label);
  }
  const text = document.body.innerText || "";
  return {
    insetTop: top, insetBottom: bottom, viewport: vp, innerHeight: H, innerWidth: window.innerWidth,
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    underTop: [...new Set(under.top)].slice(0, 8), underTopCount: under.top.length,
    underBottom: [...new Set(under.bottom)].slice(0, 8), underBottomCount: under.bottom.length,
    crashed: /Application error|This page couldn.t load|client-side exception/i.test(text),
    path: location.pathname, empty: text.trim().length < 3,
  };
};

const results = [];
let i = 0;
for (const route of routes) {
  i++;
  const rec = { route };
  try {
    await withTimeout((async () => {
      await ensureToken();
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      Object.assign(rec, await page.evaluate(measure));
    })(), 60000, route);
    if (shotsArg === "all" || i % 10 === 1 || /^\/(home|payables|login)$/.test(route)) {
      const name = `${mode}-${String(i).padStart(3, "0")}-${route.replace(/[^\w]+/g, "_") || "root"}.png`;
      writeFileSync(join(outDir, "shots", name), await device.screenshot());
      rec.shot = name;
    }
  } catch (e) {
    rec.error = String(e).slice(0, 160);
    if (/timeout 60000ms/.test(rec.error)) {
      // reconnect to a fresh page of the same WebView before the next route
      try { await withTimeout(connect(), 90000, "reconnect"); rec.reconnected = true; } catch (e2) { rec.reconnectError = String(e2).slice(0, 120); }
    }
  }
  results.push(rec);
  writeFileSync(join(outDir, `sweep-${mode}.json`), JSON.stringify(results, null, 1));
  console.log(`[${mode}] ${i}/${routes.length} ${route} top=${rec.insetTop} underTop=${rec.underTopCount} underBottom=${rec.underBottomCount} h=${rec.hScroll} ${rec.crashed ? "CRASH" : ""}${rec.error ? "ERR" : ""}`);
}

if (EXTRAS) {
// Keyboard: on the first screen that renders a text field, focus it and check the
// field and the confirm button stay inside the visible viewport.
for (const route of ["/forgot-password", "/register", "/login", "/contact"]) {
  try {
    await ensureToken();
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const field = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea').first();
    if (!(await field.count()) || !(await field.isVisible())) continue;
    const h0 = await page.evaluate(() => window.innerHeight);
    await withTimeout(field.click(), 20000, "keyboard click");
    await page.waitForTimeout(2500);
    const kb = await page.evaluate(() => {
      const f = document.activeElement?.getBoundingClientRect();
      const btn = document.querySelector('button[type="submit"]') || [...document.querySelectorAll("form button, main button")].pop();
      const b = btn?.getBoundingClientRect();
      if (btn) btn.scrollIntoView({ block: "nearest" });
      const b2 = btn?.getBoundingClientRect();
      return {
        innerHeightWithKeyboard: window.innerHeight,
        fieldVisible: !!f && f.top >= 0 && f.bottom <= window.innerHeight,
        submitVisibleAsIs: !!b && b.top >= 0 && b.bottom <= window.innerHeight,
        submitReachableByScroll: !!b2 && b2.top >= 0 && b2.bottom <= window.innerHeight,
      };
    });
    writeFileSync(join(outDir, "shots", `${mode}-zz-keyboard${route.replace(/\//g, "_")}.png`), await device.screenshot());
    results.push({ route: `(keyboard ${route})`, innerHeightBefore: h0, ...kb });
    console.log(`[${mode}] keyboard ${route} h0=${h0} ${JSON.stringify(kb)}`);
    break;
  } catch (e) {
    results.push({ route: `(keyboard ${route})`, error: String(e).slice(0, 160) });
  }
}

// Load stability: sample the viewport during the first 3 s of a cold load. A
// jump in innerHeight / the inset means the layout moved after first paint.
for (const route of ["/home", "/payables", "/documents", "/forgot-password"]) {
  try {
    await ensureToken();
    await withTimeout(page.goto(`${BASE}${route}`, { waitUntil: "commit" }), 30000, "stability goto");
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      try {
        samples.push(await withTimeout(page.evaluate(() => ({
          h: window.innerHeight,
          top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-top")) || 0,
          ready: document.readyState,
        })), 5000, "sample"));
      } catch {}
      await page.waitForTimeout(80);
    }
    const heights = [...new Set(samples.map((s) => s.h))];
    const tops = [...new Set(samples.map((s) => s.top))];
    results.push({ route: `(stability ${route})`, samples: samples.length, heights, tops, stable: heights.length === 1 && tops.length === 1 });
    console.log(`[${mode}] stability ${route} samples=${samples.length} heights=${heights} tops=${tops}`);
  } catch (e) {
    results.push({ route: `(stability ${route})`, error: String(e).slice(0, 160) });
  }
}

// A plain Android browser (Chrome on the same device) must keep viewport-fit=cover:
// the switch is for the app shell only.
if (mode === "after") {
  try {
    const browser = await withTimeout(device.launchBrowser(), 60000, "launchBrowser");
    const bpage = await browser.newPage();
    await withTimeout(bpage.goto(`${BASE}/forgot-password`, { waitUntil: "domcontentloaded" }), 60000, "chrome goto");
    await bpage.waitForTimeout(2500);
    const vp = await bpage.evaluate(() => [...document.querySelectorAll('meta[name="viewport"]')].map((m) => m.content));
    const hasInterface = await bpage.evaluate(() => typeof window.CapacitorSystemBarsAndroidInterface !== "undefined");
    results.push({ route: "(chrome browser /forgot-password)", viewport: vp, hasInterface, keepsCover: vp.every((c) => /viewport-fit=cover/.test(c)) });
    console.log(`[${mode}] chrome browser viewport=${JSON.stringify(vp)} interface=${hasInterface}`);
    await browser.close();
  } catch (e) {
    results.push({ route: "(chrome browser /forgot-password)", error: String(e).slice(0, 200) });
  }
}

} // EXTRAS
writeFileSync(join(outDir, `sweep-${mode}.json`), JSON.stringify(results, null, 1));
await device.close();
