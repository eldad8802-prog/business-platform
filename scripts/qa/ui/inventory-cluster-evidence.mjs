/**
 * Inventory-cluster evidence — the acceptance gate (Spec v1 §21).
 * 20 routes × 7 viewports, measurements + screenshots + intent assertions.
 *
 *   AUDIT_BASE_URL=... AUDIT_TOKEN_FILE=... node scripts/qa/ui/inventory-cluster-evidence.mjs
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3120";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".inv-cluster");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const ITEM_ID = process.env.AUDIT_ITEM_ID || "";

// name, route, expected intent, expected content width @1920
const ROUTES = [
  ["hub", "/inventory", "content", 960],
  ["items", "/inventory/items", "data", 1280],
  ["alerts", "/inventory/alerts", "data", 1280],
  ["drafts", "/inventory/drafts", "data", 1280],
  ["sales", "/inventory/sales", "data", 1280],
  ["unmatched", "/inventory/unmatched", "data", 1280],
  ["sp", "/inventory/supplier-purchases", "data", 1280],
  ["sp-pending", "/inventory/supplier-purchases/pending", "data", 1280],
  ["sp-history", "/inventory/supplier-purchases/history", "data", 1280],
  ["count", "/inventory/count", "standard", 760],
  ["items-create", "/inventory/items/create", "standard", 760],
  ["sales-create", "/inventory/sales/create", "standard", 760],
  ["sp-import", "/inventory/supplier-purchases/import", "standard", 760],
  ["sp-integrations", "/inventory/supplier-purchases/integrations", "standard", 760],
  ["sp-new", "/inventory/supplier-purchases/new", "standard", 760],
  ["sp-cart", "/inventory/supplier-purchases/new/cart", "standard", 760],
  ["sp-confirm", "/inventory/supplier-purchases/new/confirm", "standard", 760],
];
if (ITEM_ID) ROUTES.push(["item-detail", `/inventory/items/${ITEM_ID}`, "standard", 760]);

const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  const rows = [];
  for (const [name, route] of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 60000 });
      // Wait for the module shell itself, not just page load: several inventory
      // screens client-fetch and render a bare loading state first, which has
      // no content container — measuring then reports null and looks like a
      // layout failure when the page is in fact fine.
      await page
        .waitForSelector('.inv-subpage-main, .inv-hm-frame', { timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(900);
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        // The measured surface: the module's content shell (sub-pages) or the
        // home frame (hub).
        const el =
          document.querySelector(".inv-subpage-main") ||
          document.querySelector(".inv-hm-frame") ||
          document.querySelector("main");
        const host = document.querySelector("[data-page-intent]");
        return {
          iw: window.innerWidth,
          sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
          mainW: el ? Math.round(el.getBoundingClientRect().width) : null,
          intent: host?.getAttribute("data-page-intent") ?? null,
          contentMax: host ? getComputedStyle(host).getPropertyValue("--inv-content-max").trim() : "",
          display: el ? getComputedStyle(el).display : null,
          url: location.pathname,
        };
      });
      rows.push({ name, w, ...m });
      await page.screenshot({ path: path.join(OUT, "shots", `${name}__${w}.png`) });
      console.log(`${name}@${w}: main=${m.mainW} intent=${m.intent ?? "-"} contentMax=${m.contentMax || "-"} overflow=${m.sw > m.iw + 1}`);
    }
  }

  const of = rows.filter((r) => r.sw > r.iw + 1);
  check(`cluster: zero horizontal overflow (${ROUTES.length} routes × ${VIEWPORTS.length} viewports)`,
    of.length === 0, of.map((r) => `${r.name}@${r.w}`).join(", "));

  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  for (const [name, , intent, w1920] of ROUTES) {
    const r = by(name, 1920);
    check(`${name}: intent=${intent}`, r?.intent === intent, `got=${r?.intent}`);
    // Width within the intent budget (padding/gutters shave a few px).
    check(`${name} @1920 within ${w1920}`, (r?.mainW ?? 0) > 0 && r.mainW <= w1920 + 2 && r.mainW >= w1920 - 80,
      `main=${r?.mainW}`);
    const rm = by(name, 390);
    check(`${name} @390 mobile intact`, (rm?.mainW ?? 0) <= 390, `main=${rm?.mainW}`);
  }
  // Data routes must actually grow between tiers (no accidental cap).
  const items1024 = by("items", 1024), items1920 = by("items", 1920);
  check("items grows expanded→wide (960 → 1280)", (items1920?.mainW ?? 0) > (items1024?.mainW ?? 0),
    `1024=${items1024?.mainW} 1920=${items1920?.mainW}`);
  // Focused/standard must NOT grow past their intent at 1920.
  const count1920 = by("count", 1920);
  check("standard stays 760 at 1920 (not stretched)", (count1920?.mainW ?? 0) <= 762, `main=${count1920?.mainW}`);

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => `${f.name} ${f.detail}`).join("\n - "));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
