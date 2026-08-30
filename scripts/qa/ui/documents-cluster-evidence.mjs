/**
 * Documents-cluster evidence — full viewport/visual regression proof
 * (Spec v1 §20). Local prod build; screenshots for every route × viewport.
 *
 *   AUDIT_BASE_URL=http://localhost:3118 AUDIT_TOKEN_FILE=... node scripts/qa/ui/documents-cluster-evidence.mjs
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3118";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".docs-cluster");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

// route, expected intent (data-page-intent attr), expected main width @1920
const ROUTES = [
  ["hub", "/documents", null, 960],
  ["inbox", "/documents/inbox", "data", 1280],
  ["search", "/documents/search", "data", 1280],
  ["dashboard", "/documents/dashboard", "data", 1280],
  ["upload", "/documents/upload", "focused", 560],
  ["email", "/documents/email", "focused", 560],
  ["accountant", "/documents/accountant-pack", "standard", 760],
  ["uniform", "/documents/uniform-export", "focused", 560],
];
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
      await page.waitForTimeout(1400);
      // Wait past loading skeletons on the two data-loading screens so the
      // measurement/screenshot captures the real composition. Bounded and
      // best-effort: static screens have no skeleton to wait for.
      if (name === "hub") {
        await page.waitForSelector(".dz-hero", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else if (name === "inbox") {
        await page
          .waitForSelector("section[aria-live], table", { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(400);
      }
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const main = document.querySelector("main, [data-page-intent]");
        const grid = main ? getComputedStyle(main).display : null;
        return {
          iw: window.innerWidth,
          sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
          mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
          display: grid,
          intent: document.querySelector("[data-page-intent]")?.getAttribute("data-page-intent") ?? null,
        };
      });
      rows.push({ name, w, ...m });
      await page.screenshot({ path: path.join(OUT, "shots", `${name}__${w}.png`) });
      console.log(`${name}@${w}: main=${m.mainW} display=${m.display} intent=${m.intent ?? "-"} overflow=${m.sw > m.iw + 1}`);
    }
  }

  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("cluster: zero horizontal overflow (8 routes × 7 viewports)", of.length === 0,
    of.map((r) => `${r.name}@${r.w}`).join(", "));

  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  for (const [name, , intent, w1920] of ROUTES) {
    const r = by(name, 1920);
    check(`${name} @1920 width = ${w1920}`, r?.mainW === w1920, `main=${r?.mainW}`);
    if (intent) check(`${name} declares intent=${intent}`, r?.intent === intent, `intent=${r?.intent}`);
    const rm = by(name, 390);
    check(`${name} @390 mobile column intact`, (rm?.mainW ?? 0) <= 390, `main=${rm?.mainW}`);
  }
  const hub1024 = by("hub", 1024);
  check("hub @1024 recomposed to grid", hub1024?.display === "grid", `display=${hub1024?.display}`);
  const hub390 = by("hub", 390);
  check("hub @390 NOT grid (mobile flow untouched)", hub390?.display !== "grid", `display=${hub390?.display}`);

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
