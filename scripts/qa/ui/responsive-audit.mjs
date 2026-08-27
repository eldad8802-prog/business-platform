/**
 * Dubiz Full Responsive Audit — runtime evidence harness. READ-ONLY:
 * navigates authenticated GET routes, measures layout, screenshots.
 * Never clicks, submits, or mutates anything.
 *
 *   node scripts/qa/ui/responsive-audit.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".ui-audit");
const PROFILE =
  process.env.AUDIT_PROFILE_DIR ||
  "C:/Users/84D7~1/AppData/Local/Temp/claude/c--dev-business-platform/ff50b31f-2d66-4c99-bf1c-dd70619a0b0f/scratchpad/closure-smoke/pw-profile";

const REVIEW_DOC = process.env.AUDIT_REVIEW_DOC || "164"; // needs_review, biz 3

const ROUTES = [
  ["shell-home", "/app"],
  ["documents-hub", "/documents"],
  ["documents-inbox", "/documents/inbox"],
  ["documents-search", "/documents/search"],
  ["documents-dashboard", "/documents/dashboard"],
  ["documents-accountant", "/documents/accountant-pack"],
  ["documents-upload", "/documents/upload"],
  ["documents-review", `/documents/review/${REVIEW_DOC}`],
  ["inventory-hub", "/inventory"],
  ["inventory-items", "/inventory/items"],
  ["inventory-supplier-purchases", "/inventory/supplier-purchases"],
  ["customers", "/customers"],
  ["payments", "/payments"],
  ["suppliers", "/suppliers"],
  ["collection", "/collection"],
  ["attention", "/attention"],
  ["inbox", "/inbox"],
  ["secretary", "/secretary"],
  ["content", "/content"],
  ["settings-whatsapp", "/settings/whatsapp"],
  ["billing", "/billing"],
  ["revenue", "/revenue"],
  ["offers", "/offers"],
  ["opportunities", "/opportunities"],
  ["settings", "/settings"],
  ["settings-business", "/settings/business"],
  ["business-bot-settings", "/business/bot-settings"],
  ["dashboard-legacy", "/dashboard"],
  ["search-legacy", "/search"],
  ["promotions", "/promotions"],
];

const DEEP = new Set([
  "documents-hub",
  "documents-inbox",
  "documents-review",
  "inventory-hub",
  "inventory-items",
]);

const VIEWPORTS = [
  ["d1920", 1920, 1080],
  ["d1440", 1440, 900],
  ["d1280", 1280, 800],
  ["t1024", 1024, 768],
  ["t768", 768, 1024],
  ["m430", 430, 932],
  ["m390", 390, 844],
  ["m360", 360, 740],
  ["m320", 320, 568],
];
// Non-deep routes get a reduced viewport set to keep the run tractable.
const BASIC_VP = new Set(["d1920", "d1280", "t768", "m390", "m320"]);

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const iw = window.innerWidth;
    const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    // Widest constrained containers: elements with a px max-width and real size.
    const all = Array.from(document.querySelectorAll("body *")).slice(0, 4000);
    const constrained = [];
    const fixed = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 40) continue;
      if (cs.maxWidth && cs.maxWidth.endsWith("px")) {
        constrained.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 60),
          maxWidth: cs.maxWidth,
          width: Math.round(r.width),
          area: Math.round(r.width * r.height),
        });
      }
      if (cs.position === "fixed" && r.width > 100) {
        fixed.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
          top: Math.round(r.top),
          bottom: Math.round(window.innerHeight - r.bottom),
        });
      }
    }
    constrained.sort((a, b) => b.area - a.area);
    const main = document.querySelector("main");
    const mainRect = main ? main.getBoundingClientRect() : null;
    const table = document.querySelector("table");
    const tableRect = table ? table.getBoundingClientRect() : null;
    return {
      innerWidth: iw,
      scrollWidth: sw,
      hOverflow: sw > iw + 1,
      mainWidth: mainRect ? Math.round(mainRect.width) : null,
      tableWidth: tableRect ? Math.round(tableRect.width) : null,
      topConstrained: constrained.slice(0, 4),
      fixedCount: fixed.length,
      fixedSample: fixed.slice(0, 3),
      title: document.title,
      url: location.pathname,
    };
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const rows = [];
  for (const [name, route] of ROUTES) {
    for (const [vp, w, h] of VIEWPORTS) {
      if (!DEEP.has(name) && !BASIC_VP.has(vp)) continue;
      try {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`${BASE}${route}`, {
          waitUntil: "networkidle",
          timeout: 45000,
        });
        await page.waitForTimeout(700);
        const m = await measure(page);
        const redirected = !m.url.startsWith(route.split("?")[0].slice(0, 6));
        rows.push({ name, route, vp, w, ...m, redirected });
        const wantShot =
          DEEP.has(name) || vp === "d1920" || vp === "m390";
        if (wantShot) {
          await page.screenshot({
            path: path.join(OUT, "shots", `${name}__${vp}.png`),
            fullPage: false,
          });
        }
        console.log(
          `${name} @${vp}: main=${m.mainWidth} overflow=${m.hOverflow} top=${m.topConstrained[0]?.maxWidth ?? "-"} url=${m.url}`
        );
      } catch (e) {
        rows.push({ name, route, vp, w, error: String(e).slice(0, 120) });
        console.log(`${name} @${vp}: ERROR ${String(e).slice(0, 80)}`);
      }
    }
  }

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  console.log(`\nwrote ${rows.length} measurements → ${OUT}`);
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
