/**
 * Billing forensic audit — READ-ONLY.
 *
 * Measures the existing Billing surface across the full viewport matrix so the
 * adaptive design report rests on runtime evidence rather than code reading.
 * Creates nothing: Billing documents are fiscal objects, so this only observes
 * documents that already exist.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".billing-audit");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];
const ROUTES = [
  ["list", "/billing"],
  ["quote-draft", "/billing/40"],
  ["pending-review", "/billing/39"],
  ["issued-invoice", "/billing/36"],
  ["issued-quote", "/billing/38"],
  ["issued-receipt", "/billing/37"],
];

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector("main");
    const col = main ? main.firstElementChild : null;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    // Which stage branch actually rendered — identified by the landmarks the
    // stage sections carry, not by re-deriving the product's own conditions.
    const has = (sel) => !!document.querySelector(sel);
    const txt = (document.body.innerText || "");
    const stage = {
      stickyBar: has('[aria-label="פעולה מהירה"]'),
      linesEditor: has("#billing-lines-sticky-controls"),
      collapsible: txt.includes("פרטים נוספים") || txt.includes("עריכה נוספת"),
      issuerBadge: txt.includes("עוסק") && txt.includes("מספר"),
    };
    // Every sticky/fixed element on the page and where it sits.
    const pinned = Array.from(document.querySelectorAll("*"))
      .map((el) => ({ el, cs: getComputedStyle(el) }))
      .filter((o) => o.cs.position === "sticky" || o.cs.position === "fixed")
      .map((o) => ({
        pos: o.cs.position,
        z: o.cs.zIndex,
        label: o.el.getAttribute("aria-label") || o.el.id || o.el.tagName.toLowerCase(),
        box: rect(o.el),
      }))
      .filter((p) => p.box && p.box.h > 0);
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select"))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      iw: window.innerWidth,
      ih: window.innerHeight,
      sw: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
      docH: de.scrollHeight,
      mainW: rect(main) ? rect(main).w : null,
      colW: rect(col) ? rect(col).w : null,
      intent: (document.querySelector("[data-page-intent]") || {}).getAttribute
        ? document.querySelector("[data-page-intent]").getAttribute("data-page-intent")
        : null,
      stage,
      pinned,
      minTap: taps.length ? Math.round(Math.min.apply(null, taps.map((r) => r.height))) : null,
      dir: de.getAttribute("dir"),
    };
  });
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  const rows = [];
  for (const [name, route] of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      // Never measure the skeleton: WorkspaceSkeleton marks itself aria-busy,
      // so wait for it to clear (ready, error or not-found) before measuring.
      await page
        .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 40000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      const m = await measure(page);
      rows.push(Object.assign({ name, w }, m));
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png"), fullPage: w === 1920 });
      console.log(
        name + "@" + w + ": col=" + m.colW + " main=" + m.mainW +
        " overflow=" + (m.sw > m.iw + 1) + " docH=" + m.docH +
        " pinned=" + m.pinned.length + " minTap=" + m.minTap +
        " sticky=" + m.stage.stickyBar + " lines=" + m.stage.linesEditor
      );
    }
  }

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));

  console.log("\n=== OBSERVATIONS ===");
  const widths = [...new Set(rows.filter((r) => r.name !== "list").map((r) => r.colW))];
  console.log("detail column widths across 320..1920: " + widths.join(", "));
  const listW = [...new Set(rows.filter((r) => r.name === "list").map((r) => r.colW))];
  console.log("list column widths: " + listW.join(", "));
  const of = rows.filter((r) => r.sw > r.iw + 1);
  console.log("horizontal overflow: " + (of.length ? of.map((r) => r.name + "@" + r.w).join(", ") : "none"));
  const small = rows.filter((r) => r.minTap != null && r.minTap < 24);
  console.log("A-7 gating tap failures: " + (small.length ? small.map((r) => r.name + "@" + r.w + "=" + r.minTap).join(", ") : "none"));
  for (const r of rows.filter((x) => x.w === 390 && x.pinned.length)) {
    console.log("pinned@390 " + r.name + ": " + r.pinned.map((p) => p.label + "[" + p.pos + " z=" + p.z + " y=" + p.box.y + " h=" + p.box.h + "]").join(" | "));
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
