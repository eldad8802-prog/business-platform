// DIAGNOSTIC ONLY (branch diag/android-app-login) — issue 3: browsers and iPhone are unchanged.
// Desktop Chromium + iPhone (WebKit, iPhone 13 profile) against the same local build, with the
// apex rewrite (/ → /home) applied to localhost as in Production.
// usage: node scripts/native/browser-login-check.mjs <outDir> <mode>
import { chromium, webkit, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [OUT, MODE] = process.argv.slice(2);
const BASE = "http://localhost:3000";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
for (const [name, type, ctxOpts] of [
  ["desktop-chrome", chromium, { viewport: { width: 1280, height: 860 }, locale: "he-IL" }],
  ["iphone-webkit", webkit, { ...devices["iPhone 13"], locale: "he-IL" }],
]) {
  let browser;
  try {
    browser = await type.launch();
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.route("**/api/**", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
    const navs = [];
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(new URL(f.url()).pathname); });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const root = await page.evaluate(() => ({ path: location.pathname, dataShell: document.documentElement.getAttribute("data-shell"), marketing: /העסק שלך,/.test(document.body.innerText) }));
    await page.screenshot({ path: join(OUT, "shots", `${MODE}-${name}-root.png`) });
    await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const login = await page.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
      const h1 = document.querySelector("h1");
      return {
        path: location.pathname,
        dataShell: document.documentElement.getAttribute("data-shell"),
        title: h1 ? [...h1.querySelectorAll("span")].filter(vis).map((s) => s.textContent.trim()).join(" | ") || h1.textContent.trim() : null,
        badgeVisible: /כניסה מאובטחת/.test(document.body.innerText),
        subtitleVisible: /התחבר כדי להמשיך/.test(document.body.innerText),
        appTitleVisible: [...document.querySelectorAll('[data-shell-only="android"]')].some(vis),
      };
    });
    await page.screenshot({ path: join(OUT, "shots", `${MODE}-${name}-login.png`) });
    results.push({ mode: MODE, browser: name, navigations: navs, root, login });
  } catch (e) {
    results.push({ mode: MODE, browser: name, error: String(e).slice(0, 200) });
  } finally {
    await browser?.close();
  }
}
writeFileSync(join(OUT, `browsers-${MODE}.json`), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results));
