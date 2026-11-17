// Screenshots + measurements (writes into qa-evidence/home-v4). Run after build.mjs: node qa-evidence/home-v4/harness/shoot.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../../package.json"));
const { chromium } = require("playwright");
const OUT = path.join(here, "..");
fs.mkdirSync(OUT, { recursive: true });
const PAGE = pathToFileURL(path.join(here, "index.html")).href;
const NINE_AM_IL = new Date("2026-11-18T07:00:00Z");

const browser = await chromium.launch();
const report = {};

async function open(state, screen = "home", vp = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: vp.width < 768, hasTouch: true, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.clock.install({ time: NINE_AM_IL });
  await page.goto(`${PAGE}?state=${state}&screen=${screen}`);
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(1500);
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

async function shot(name, state, screen = "home", vp, full = false) {
  const { ctx, page, errors } = await open(state, screen, vp);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  const cards = await page.$$eval("main.h4-col > section", (els) => els.map((e) => e.querySelector("h2")?.textContent?.trim()));
  const requests = await page.evaluate(() => window.__requests);
  report[name] = { cards, errors: errors.filter((e) => !/fonts\.g/.test(e)), requests };
  await ctx.close();
}

// 1. the hero (reference) + every state
await shot("01-hero", "hero");
await shot("01-hero-full", "hero", "home", undefined, true);
for (const s of ["A", "B", "C", "D", "E", "F", "G", "H", "loading", "capsfail"]) await shot(`02-state-${s}`, s, "home", undefined, true);

// 2. tools: limited vs broad, more capabilities
await shot("03-tools-limited", "B", "tools", undefined, true);
await shot("03-tools-broad", "broad", "tools", undefined, true);
await shot("03-more-limited", "B", "more", undefined, true);

// 3. sizes: small phone, large phone, tablet (rail), desktop (sidebar)
await shot("04-size-320", "hero", "home", { width: 320, height: 640 }, true);
await shot("04-size-430", "hero", "home", { width: 430, height: 932 });
await shot("04-size-tablet-820", "hero", "home", { width: 820, height: 1180 });
await shot("04-size-desktop-1440", "hero", "home", { width: 1440, height: 900 });

// 4. floating bar proof: geometry + visible while scrolling down and up; "+" centred, not raised
{
  const { ctx, page } = await open("E");
  const measure = () => page.evaluate(() => {
    const bar = document.querySelector('[data-component="shell-bottom-bar"]').getBoundingClientRect();
    const plus = document.querySelector(".dz-bottom__new").getBoundingClientRect();
    const items = [...document.querySelectorAll('[data-component="shell-bottom-bar"] .dz-bottom__item')].map((e) => e.getBoundingClientRect());
    const labels = [...document.querySelectorAll('[data-component="shell-bottom-bar"] .dz-bottom__item')].map((e) => e.textContent.trim());
    const content = document.querySelector(".shell-content");
    return {
      scrollY: Math.round(scrollY), docHeight: document.documentElement.scrollHeight, vh: innerHeight, vw: innerWidth,
      bar: { top: bar.top, bottom: bar.bottom, left: bar.left, right: bar.right, height: bar.height, gapBottom: innerHeight - bar.bottom, gapLeft: bar.left, gapRight: innerWidth - bar.right },
      plus: { cx: plus.left + plus.width / 2, cy: plus.top + plus.height / 2, top: plus.top, bottom: plus.bottom, size: plus.width },
      barCenter: { cx: bar.left + bar.width / 2, cy: bar.top + bar.height / 2 },
      itemsTopMin: Math.min(...items.map((r) => r.top)),
      labelsInDomOrder: labels,
      rightToLeft: items.map((r) => Math.round(r.left)).join(" > "),
      contentPaddingBottom: getComputedStyle(content).paddingBottom,
      barPosition: getComputedStyle(document.querySelector('[data-component="shell-bottom-bar"]')).position,
    };
  });
  const top = await measure();
  await page.screenshot({ path: path.join(OUT, "05-scroll-top.png") });
  await page.mouse.wheel(0, 900); await page.waitForTimeout(300);
  const mid = await measure();
  await page.screenshot({ path: path.join(OUT, "05-scroll-mid.png") });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(300);
  const bottom = await measure();
  // the last card must end above the bar
  const lastCardBottom = await page.evaluate(() => { const s = [...document.querySelectorAll("main.h4-col > section")].pop(); return s.getBoundingClientRect().bottom; });
  await page.screenshot({ path: path.join(OUT, "05-scroll-bottom.png") });
  await page.mouse.wheel(0, -500); await page.waitForTimeout(300);
  const up = await measure();
  await page.screenshot({ path: path.join(OUT, "05-scroll-up.png") });
  report.floatingBar = { top, mid, bottom, up, lastCardBottom, lastCardClearsBar: lastCardBottom <= bottom.bar.top };

  // 5. create sheet: opens over the page without losing the scroll position
  await page.evaluate(() => scrollTo(0, 700)); await page.waitForTimeout(200);
  const before = await page.evaluate(() => scrollY);
  await page.click(".dz-bottom__new");
  await page.clock.runFor(800); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "06-create-sheet-broad.png") });
  const actions = await page.$$eval('[data-component="create-sheet"] [role="dialog"] button', (b) => b.map((x) => x.textContent.trim()));
  await page.keyboard.press("Escape");
  await page.clock.runFor(800); await page.waitForTimeout(300);
  const after = await page.evaluate(() => scrollY);
  report.createSheet = { scrollBefore: before, scrollAfter: after, preserved: before === after, actions };
  await ctx.close();
}
for (const [name, state] of [["06-create-sheet-limited", "B"], ["06-create-sheet-booking", "A"]]) {
  const { ctx, page } = await open(state);
  await page.click(".dz-bottom__new");
  await page.clock.runFor(800); await page.waitForTimeout(400);
  report[name] = await page.$$eval('[data-component="create-sheet"] [role="dialog"] button', (b) => b.map((x) => x.textContent.trim()));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await ctx.close();
}

// 6. interactions: expand metrics, customise sheet, secretary dismiss, for-you menu
{
  const { ctx, page } = await open("hero");
  await page.click(".h4-more");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "07-metrics-expanded.png"), fullPage: true });
  await page.click('button[aria-label="בחירת מדדים"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "07-metrics-customize.png") });
  await ctx.close();
}
{
  const { ctx, page } = await open("hero");
  const beforeTitle = await page.textContent(".h4-sec-title");
  await page.click(".h4-sec .h4-textbtn");
  await page.waitForTimeout(200);
  const afterTitle = await page.textContent(".h4-sec-title");
  await page.screenshot({ path: path.join(OUT, "07-secretary-after-dismiss.png") });
  await page.click('button[aria-label="אפשרויות לתוכן"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "07-foryou-menu.png") });
  report.secretaryDismiss = { beforeTitle, afterTitle };
  await ctx.close();
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
console.log("done");
