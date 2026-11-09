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
const BASE = "http://localhost:3000";
const PKG = "il.co.promaxgroup.dubiz";
const SAMPLE = { id: "1", publicId: "demo", slug: "demo", token: "demo", businessId: "9", customerId: "1", supplierId: "1" };

const routes = readFileSync(routesFile, "utf8").split(/\r?\n/).filter(Boolean)
  .map((r) => r.replace(/\[\.\.\.(\w+)\]/g, "x").replace(/\[(\w+)\]/g, (_, k) => SAMPLE[k] ?? "1"));
mkdirSync(join(outDir, "shots"), { recursive: true });

const [device] = await android.devices();
if (!device) throw new Error("no adb device");
console.log(`device ${device.model()} serial=${device.serial()}`);
const webview = await device.webView({ pkg: PKG }, { timeout: 60000 });
const page = await webview.page();
await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.setItem("token", "diag-token"));

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
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    Object.assign(rec, await page.evaluate(measure));
    if (shotsArg === "all" || i % 10 === 1 || /^\/(home|payables|login)$/.test(route)) {
      const name = `${mode}-${String(i).padStart(3, "0")}-${route.replace(/[^\w]+/g, "_") || "root"}.png`;
      writeFileSync(join(outDir, "shots", name), await device.screenshot());
      rec.shot = name;
    }
  } catch (e) {
    rec.error = String(e).slice(0, 160);
  }
  results.push(rec);
  console.log(`[${mode}] ${i}/${routes.length} ${route} top=${rec.insetTop} underTop=${rec.underTopCount} underBottom=${rec.underBottomCount} h=${rec.hScroll} ${rec.crashed ? "CRASH" : ""}${rec.error ? "ERR" : ""}`);
}

// Keyboard: focus the first text field on /login and check the submit stays reachable.
try {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator("input").first().click();
  await page.waitForTimeout(2500);
  const kb = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') || [...document.querySelectorAll("button")].pop();
    const r = btn?.getBoundingClientRect();
    return { innerHeight: window.innerHeight, submitTop: r?.top ?? null, submitBottom: r?.bottom ?? null };
  });
  writeFileSync(join(outDir, "shots", `${mode}-zz-keyboard-login.png`), await device.screenshot());
  results.push({ route: "(keyboard /login)", ...kb });
  console.log(`[${mode}] keyboard ${JSON.stringify(kb)}`);
} catch (e) {
  results.push({ route: "(keyboard /login)", error: String(e).slice(0, 160) });
}

writeFileSync(join(outDir, `sweep-${mode}.json`), JSON.stringify(results, null, 1));
await device.close();
