/**
 * Dubiz adaptive consistency sweep — READ-ONLY runtime pass.
 *
 * Loads every reachable app route at the canonical viewports and records what
 * a user would actually meet: horizontal overflow, how wide the content really
 * is, how many navigation surfaces are visible, and whether any interactive
 * target falls below the A-7 gating size. Navigates and measures only.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".consistency");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const VIEWPORTS = [390, 768, 1024, 1280, 1920];

/**
 * Every app route a signed-in owner can reach. Dynamic segments use ids that
 * exist in the dev tenant where one does, and a not-found id otherwise — a
 * not-found state still exercises the container and the shell contract.
 */
const ROUTES = [
  "/app", "/home-owner", "/dashboard",
  "/documents", "/documents/inbox", "/documents/uniform-export",
  "/inventory", "/inventory/items", "/inventory/count", "/inventory/supplier-purchases",
  "/customers", "/suppliers", "/opportunities", "/attention",
  "/billing", "/billing/999999",
  "/revenue", "/revenue?view=create", "/revenue?view=browse", "/revenue/redeem",
  "/payments", "/payments/new", "/collection",
  "/settings", "/settings/whatsapp", "/settings/workspace",
  "/secretary", "/inbox",
  "/content", "/content/goal", "/content/setup", "/content/generate", "/content/result",
  "/business", "/business/bot-settings",
  "/onboarding", "/pricing", "/posts", "/tools", "/search",
];

const rows = [];

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    const navs = Array.from(document.querySelectorAll("nav")).filter(
      (n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 40
    );
    // The widest thing the page actually paints inside the viewport — a proxy
    // for "does this surface use the width it was given".
    const main = document.querySelector("main") || body;
    const kids = Array.from(main.children).filter((e) => e.getBoundingClientRect().height > 0);
    const contentW = kids.length
      ? Math.max(...kids.map((e) => Math.round(e.getBoundingClientRect().width)))
      : null;
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
      .map((e) => ({ t: (e.textContent || "").trim().slice(0, 20), r: e.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0 && o.r.height > 0);
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, body.scrollWidth),
      contentW,
      intent: (document.querySelector("[data-page-intent]") || { getAttribute: () => null })
        .getAttribute("data-page-intent"),
      navs: navs.length,
      under24: taps
        .filter((o) => o.r.height < 24 || o.r.width < 24)
        .map((o) => (o.t || "(unlabelled)") + "=" + Math.round(o.r.height) + "x" + Math.round(o.r.width)),
      dir: de.getAttribute("dir"),
      textLen: (body.innerText || "").trim().length,
    };
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  for (const route of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      let ok = true;
      await page.goto(BASE + route, { waitUntil: "load", timeout: 45000 }).catch(() => { ok = false; });
      if (!ok) { rows.push({ route, w, error: "navigation failed" }); continue; }
      await page
        .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 12000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      const m = await measure(page).catch(() => null);
      if (!m) { rows.push({ route, w, error: "measure failed" }); continue; }
      rows.push({ route, w, ...m });
    }
    const at1920 = rows.find((r) => r.route === route && r.w === 1920) || {};
    console.log(
      route.padEnd(38) +
      " 1920: content=" + String(at1920.contentW).padStart(5) +
      " intent=" + String(at1920.intent).padEnd(9) +
      " nav=" + at1920.navs +
      " overflow@any=" + rows.filter((r) => r.route === route && r.sw > r.iw + 1).map((r) => r.w).join(",") || ""
    );
  }

  await writeFile(path.join(OUT, "sweep.json"), JSON.stringify(rows, null, 1));

  const ok = rows.filter((r) => !r.error);
  const overflow = ok.filter((r) => r.sw > r.iw + 1);
  const noNavDesktop = ok.filter((r) => r.w >= 1024 && r.navs === 0);
  const doubleNav = ok.filter((r) => r.navs > 1);
  const tiny = ok.filter((r) => r.under24 && r.under24.length);
  const ltr = ok.filter((r) => r.dir !== "rtl");
  const errors = rows.filter((r) => r.error);
  const unusedWidth = ok.filter((r) => r.w === 1920 && r.contentW !== null && r.contentW < 700);

  const group = (list) => {
    const m = {};
    for (const r of list) (m[r.route] = m[r.route] || []).push(r.w);
    return Object.entries(m).map(([k, v]) => "    " + k + " @ " + v.join(",")).join("\n");
  };

  console.log("\n=== RUNTIME FINDINGS (" + ok.length + " cells over " + ROUTES.length + " routes) ===");
  console.log("\n1. horizontal overflow (" + overflow.length + " cells):\n" + (group(overflow) || "    none"));
  console.log("\n2. no navigation at >=1024 (" + noNavDesktop.length + " cells):\n" + (group(noNavDesktop) || "    none"));
  console.log("\n3. two or more navigation surfaces (" + doubleNav.length + " cells):\n" + (group(doubleNav) || "    none"));
  console.log("\n4. A-7 gating failures (" + tiny.length + " cells):");
  const tinyByRoute = {};
  for (const r of tiny) (tinyByRoute[r.route] = tinyByRoute[r.route] || new Set()).add(r.under24.join(" | "));
  for (const [k, v] of Object.entries(tinyByRoute)) console.log("    " + k + ": " + [...v][0]);
  if (!tiny.length) console.log("    none");
  console.log("\n5. not RTL (" + ltr.length + " cells):\n" + (group(ltr) || "    none"));
  console.log("\n6. content under 700px at 1920 — width given but not used (" + unusedWidth.length + " routes):");
  for (const r of unusedWidth) console.log("    " + r.route + " -> " + r.contentW);
  console.log("\n7. routes that failed to load (" + errors.length + "):");
  for (const r of errors) console.log("    " + r.route + "@" + r.w + " " + r.error);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
