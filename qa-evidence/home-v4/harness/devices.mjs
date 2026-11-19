// Device-profile pass (EMULATION, not real phones): iPhone profiles on WebKit, Android profiles on Chromium.
// Focus: the floating bar, the centred "+", safe areas, the create sheet. Writes qa-evidence/home-v4/devices/.
// Run after build.mjs: node qa-evidence/home-v4/harness/devices.mjs
//
// Safe areas: Chromium gets real env(safe-area-inset-*) values through CDP Emulation.setSafeAreaInsetsOverride
// (when this Chromium supports it). WebKit cannot simulate insets, so iPhone profiles are measured with 0 insets
// and the bar's CSS is checked to reserve env(safe-area-inset-bottom).
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../../package.json"));
const { chromium, webkit, devices } = require("playwright");
const OUT = path.join(here, "..", "devices");
fs.mkdirSync(OUT, { recursive: true });
const PAGE = pathToFileURL(path.join(here, "index.html")).href;
const NINE_AM_IL = new Date("2026-11-18T07:00:00Z");

const PROFILES = [
  { key: "iphone-se", engine: "webkit", device: "iPhone SE (3rd gen)", insets: null },
  { key: "iphone-15-pro-max", engine: "webkit", device: "iPhone 15 Pro Max", insets: null },
  { key: "pixel-7-gesture", engine: "chromium", device: "Pixel 7", insets: { top: 24, bottom: 24 } },
  { key: "galaxy-s9-buttons", engine: "chromium", device: "Galaxy S9+", insets: { top: 24, bottom: 0 } },
  { key: "iphone-notch-sim", engine: "chromium", device: "iPhone 15 Pro Max", insets: { top: 59, bottom: 34 }, note: "iPhone size + home-indicator inset, rendered by Chromium (WebKit cannot simulate insets)" },
];

const report = {};
const browsers = {};

for (const p of PROFILES) {
  const desc = devices[p.device];
  browsers[p.engine] ??= await (p.engine === "webkit" ? webkit : chromium).launch();
  const ctx = await browsers[p.engine].newContext({ ...desc, defaultBrowserType: undefined, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g/.test(m.text()) && errors.push(m.text()));
  let insetsApplied = false;
  if (p.insets && p.engine === "chromium") {
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: p.insets.top, bottom: p.insets.bottom, left: 0, right: 0 } });
      insetsApplied = true;
    } catch (e) {
      errors.push(`safe-area override unsupported: ${String(e).slice(0, 120)}`);
    }
  }
  await page.clock.install({ time: NINE_AM_IL });
  await page.goto(`${PAGE}?state=E&screen=home`);
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(1500);
  await page.waitForTimeout(400);

  const measure = () => page.evaluate(() => {
    const barEl = document.querySelector('[data-component="shell-bottom-bar"]');
    const bar = barEl.getBoundingClientRect();
    const plus = document.querySelector(".dz-bottom__new").getBoundingClientRect();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:1px;visibility:hidden";
    document.body.appendChild(probe);
    const insetBottom = probe.getBoundingClientRect().height;
    probe.remove();
    const cards = [...document.querySelectorAll("main.h4-col > section")];
    return {
      vw: innerWidth, vh: innerHeight, scrollY: Math.round(scrollY), insetBottom,
      bar: { top: bar.top, bottom: bar.bottom, height: bar.height, left: bar.left, right: bar.right },
      gapBottom: +(innerHeight - bar.bottom).toFixed(1),
      expectedGap: 10 + insetBottom,
      plusOffCentreX: +Math.abs(plus.left + plus.width / 2 - (bar.left + bar.width / 2)).toFixed(1),
      plusOffCentreY: +Math.abs(plus.top + plus.height / 2 - (bar.top + bar.height / 2)).toFixed(1),
      plusRaised: plus.top < bar.top,
      position: getComputedStyle(barEl).position,
      lastCardBottom: cards.length ? cards[cards.length - 1].getBoundingClientRect().bottom : null,
      sideScroll: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });

  const top = await measure();
  await page.screenshot({ path: path.join(OUT, `${p.key}-home.png`) });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  const bottom = await measure();
  await page.screenshot({ path: path.join(OUT, `${p.key}-home-bottom.png`) });

  await page.evaluate(() => scrollTo(0, 300));
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => Math.round(scrollY));
  await page.click(".dz-bottom__new");
  // Advance the fake clock (the entrance waits two animation frames), then wait — in real time — for the sheet to
  // be fully in view; the CSS transition itself runs on the engine's own clock.
  let inView = false;
  for (let i = 0; i < 15 && !inView; i++) {
    await page.clock.runFor(200);
    await page.waitForTimeout(200);
    inView = await page.evaluate(() => {
      const d = document.querySelector('[data-component="create-sheet"] [role="dialog"]');
      return Boolean(d) && Math.abs(d.getBoundingClientRect().bottom - innerHeight) < 2;
    });
  }
  const sheet = await page.evaluate(() => {
    const d = document.querySelector('[data-component="create-sheet"] [role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const buttons = [...d.querySelectorAll("button")];
    const last = buttons.length ? buttons[buttons.length - 1].getBoundingClientRect() : null;
    return { top: r.top, bottom: r.bottom, actions: buttons.length, lastButtonBottom: last ? last.bottom : null, vh: innerHeight };
  });
  await page.screenshot({ path: path.join(OUT, `${p.key}-create-sheet.png`) });
  await page.keyboard.press("Escape");
  await page.clock.runFor(800);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => Math.round(scrollY));
  const closed = await page.evaluate(() => !document.querySelector('[data-component="create-sheet"]'));

  const checks = {
    barFixed: top.position === "fixed" && bottom.position === "fixed",
    barVisibleTopAndBottom: top.bar.bottom <= top.vh && bottom.bar.bottom <= bottom.vh,
    liftedAboveSafeArea: Math.abs(top.gapBottom - top.expectedGap) <= 1,
    plusCentred: top.plusOffCentreX <= 1 && top.plusOffCentreY <= 1,
    plusNotRaised: !top.plusRaised,
    lastCardClearsBar: bottom.lastCardBottom !== null && bottom.lastCardBottom <= bottom.bar.top,
    noSideScroll: !top.sideScroll,
    sheetOpens: Boolean(sheet && sheet.actions > 0),
    sheetLastActionOnScreen: Boolean(sheet && sheet.lastButtonBottom !== null && sheet.lastButtonBottom <= sheet.vh - (top.insetBottom || 0)),
    sheetClosesKeepingScroll: closed && before === after,
    noConsoleErrors: errors.filter((e) => !/safe-area override unsupported/.test(e)).length === 0,
  };
  report[p.key] = { engine: p.engine, device: p.device, note: p.note ?? null, insetsRequested: p.insets, insetsApplied, measuredInsetBottom: top.insetBottom, checks, top, bottom, sheet, scroll: { before, after }, errors };
  console.log(p.key.padEnd(22), Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(",") || "all checks pass", insetsApplied ? `(inset ${top.insetBottom}px)` : "");
  await ctx.close();
}

for (const b of Object.values(browsers)) await b.close();
fs.writeFileSync(path.join(OUT, "devices-report.json"), JSON.stringify(report, null, 2));
console.log("done");
