// Responsive pass: the same Home at phone, tablet and desktop widths (harness, mocked data — not Production).
// Writes qa-evidence/home-v4/widths/. Run after build.mjs: node qa-evidence/home-v4/harness/widths.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../../package.json"));
const { chromium } = require("playwright");
const OUT = path.join(here, "..", "widths");
fs.mkdirSync(OUT, { recursive: true });
const PAGE = pathToFileURL(path.join(here, "index.html")).href;
const NINE_AM_IL = new Date("2026-11-18T07:00:00Z");

const WIDTHS = [
  { w: 320, h: 640, tier: "phone" },
  { w: 390, h: 844, tier: "phone" },
  { w: 768, h: 1024, tier: "tablet" }, // portrait
  { w: 820, h: 1180, tier: "tablet" }, // iPad Air portrait
  { w: 1024, h: 768, tier: "tablet" }, // landscape
  { w: 1180, h: 820, tier: "tablet" }, // iPad Air landscape
  { w: 1280, h: 800, tier: "desktop" },
  { w: 1440, h: 900, tier: "desktop" },
  { w: 1920, h: 1080, tier: "desktop" },
];
// E = busy business, A = brand-new, B = few capabilities, G = no secretary items, H = partial failure, loading.
const STATES = ["E", "A", "B", "G", "H", "loading"];

const browser = await chromium.launch();
const report = {};

async function open(state, vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.w >= 1280 ? 1 : 2, isMobile: vp.w < 768, hasTouch: vp.w < 1280, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g/.test(m.text()) && errors.push(m.text()));
  await page.clock.install({ time: NINE_AM_IL });
  await page.goto(`${PAGE}?state=${state}&screen=home`, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(state === "loading" ? 100 : 1500);
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

const measure = (page) => page.evaluate(() => {
  const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const main = document.querySelector("main.h4-col");
  const cards = [...document.querySelectorAll("main.h4-col > section")].map((s) => {
    const r = s.getBoundingClientRect();
    return { area: (s.className.match(/h4-(a-\w+|sec)\b/) || [])[1] || null, title: s.querySelector("h2")?.textContent?.trim() ?? null, x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const cols = new Set(cards.map((c) => c.x)).size;
  const sidebar = document.querySelector(".dz-sidebar");
  return {
    vw: innerWidth,
    nav: { bottomBar: vis('[data-component="shell-bottom-bar"]'), rail: vis(".dz-rail"), sidebar: vis(".dz-sidebar") },
    sidebarOnRight: sidebar ? sidebar.getBoundingClientRect().left > innerWidth / 2 : null,
    sidebarLabels: sidebar ? [...sidebar.querySelectorAll(".dz-sidebar__group:first-of-type a")].map((a) => a.textContent.trim()) : null,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    columns: cols,
    widestCard: Math.max(0, ...cards.map((c) => c.w)),
    cards,
    sideScroll: document.documentElement.scrollWidth > innerWidth + 1,
    dir: document.documentElement.dir || getComputedStyle(document.body).direction,
  };
});

for (const vp of WIDTHS) {
  for (const state of STATES) {
    // Every state at the three widths the owner named; the main states at the others.
    const key = `${vp.w}-${state}`;
    const named = [1024, 1440, 1920].includes(vp.w);
    if (!named && !["E", "A", "B"].includes(state)) continue;
    const { ctx, page, errors } = await open(state, vp);
    const m = await measure(page);
    await page.screenshot({ path: path.join(OUT, `${key}.png`), fullPage: true });
    report[key] = { tier: vp.tier, ...m, errors };
    await ctx.close();
  }
}

// The tools screens at the wide widths (they share the Home column; scoped so the Home grid never applies to them).
for (const vp of WIDTHS.filter((x) => [390, 1024, 1440, 1920].includes(x.w))) {
  for (const screen of ["tools", "more"]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.w >= 1280 ? 1 : 2, isMobile: vp.w < 768, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.clock.install({ time: NINE_AM_IL });
    await page.goto(`${PAGE}?state=E&screen=${screen}`, { timeout: 120_000 });
    await page.clock.runFor(1500);
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const main = document.querySelector("main.h4-col");
      const grid = document.querySelector(".mt-grid");
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : null;
      return { mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null, display: main ? getComputedStyle(main).display : null, tileColumns: cols, sideScroll: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    await page.screenshot({ path: path.join(OUT, `${vp.w}-${screen}.png`), fullPage: true });
    report[`${vp.w}-${screen}`] = { tier: vp.tier, ...m, errors };
    console.log(`${vp.w}-${screen}`.padEnd(14), JSON.stringify(m), errors.length ? `errors=${errors.length}` : "");
    await ctx.close();
  }
}

// Resize a live window across the breakpoints: the nav swaps, nothing scrolls sideways, the areas keep their order.
{
  const { ctx, page, errors } = await open("E", WIDTHS[1]);
  const steps = [];
  for (const w of [390, 767, 768, 899, 900, 1023, 1024, 1279, 1280, 1599, 1600, 1920, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    const m = await measure(page);
    steps.push({ w, nav: m.nav, columns: m.columns, sideScroll: m.sideScroll, order: m.cards.map((c) => c.area) });
  }
  report.resize = { steps, errors };
  await ctx.close();
}

// Keyboard: Tab from the top reaches the navigation and the Home actions; focus is visible (desktop).
{
  const { ctx, page } = await open("E", WIDTHS[5]);
  const seen = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}:${(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 24)}` : null; }));
  }
  report.keyboard1440 = seen;
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "widths-report.json"), JSON.stringify(report, null, 2));
for (const [k, v] of Object.entries(report)) {
  if (k === "resize" || k === "keyboard1440" || !v.nav) continue;
  const nav = Object.entries(v.nav).filter(([, on]) => on).map(([n]) => n).join("+") || "none";
  console.log(k.padEnd(14), `nav=${nav}`.padEnd(18), `cols=${v.columns}`, `main=${v.mainWidth}`, `widest=${v.widestCard}`, v.sideScroll ? "SIDE-SCROLL" : "", v.errors.length ? `errors=${v.errors.length}` : "", `areas=${v.cards.map((c) => c.area).join(",")}`);
}
console.log("resize:", report.resize.steps.map((s) => `${s.w}:${Object.entries(s.nav).filter(([, on]) => on).map(([n]) => n).join("+")}/${s.columns}${s.sideScroll ? "!" : ""}`).join(" "));
