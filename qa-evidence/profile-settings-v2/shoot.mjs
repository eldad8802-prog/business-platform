/**
 * Profile + Settings v2 — runtime evidence against the REAL app and a local
 * throwaway database (no API mocking: every value on screen came from the
 * routes under test).
 *
 *   1. Reference captures: the approved profile.html / settings.html at 390.
 *   2. "full" tenant: Profile before the logo (initials, 87%), then the real
 *      camera-button upload of a 1600px PNG → logo shown, completion 100%.
 *   3. Profile and the Settings hub at 390 / 768 / 1024 / 1280 / 1440 / 1920.
 *   4. "empty" tenant: honest empty states at 390 / 768 / 1440.
 *   5. Every hub destination opens a real page; no horizontal overflow at any
 *      width; sign-out returns to /login.
 *
 *   QA_BASE=http://localhost:3020 QA_TOKENS=<seed json> REF_DIR=<dir with the two html files> \
 *     node qa-evidence/profile-settings-v2/shoot.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3020";
const TOKENS = JSON.parse(process.env.QA_TOKENS || "{}");
const REF_DIR = process.env.REF_DIR || "";
const OUT = path.resolve("qa-evidence/profile-settings-v2");
const WIDTHS = [
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function context(browser, token, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: "he-IL" });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("token", t);
    } catch {}
  }, token);
  return ctx;
}

async function settle(page, selector) {
  await page.waitForSelector(selector, { timeout: 30000 });
  // Wait until no skeleton is left (every value loaded or deliberately absent).
  await page.waitForFunction(() => document.querySelectorAll('[role="status"]').length === 0, null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function noOverflow(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${label}: no horizontal overflow`, m.sw <= m.iw, `scrollWidth=${m.sw} innerWidth=${m.iw}`);
}

/**
 * A full-height capture with the viewport grown to the content, so the fixed
 * navigation sits at the bottom where a device shows it (a plain fullPage
 * capture leaves a fixed bar floating mid-page).
 */
async function shoot(page, file) {
  const vp = page.viewportSize();
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, h) });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.setViewportSize(vp);
}

async function makeLogoFile(browser) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1600;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1600, 1600);
    grad.addColorStop(0, "#f2b97a");
    grad.addColorStop(1, "#a0601f");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1600, 1600);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.25})`;
      g.fillRect(Math.random() * 1600, Math.random() * 1600, 6, 6);
    }
    g.fillStyle = "#fffdfa";
    g.font = "bold 760px serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("ש", 800, 860);
    return c.toDataURL("image/png");
  });
  await page.close();
  const file = path.join(OUT, "_synthetic-logo-1600.png");
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  return file;
}

const browser = await chromium.launch();
fs.mkdirSync(OUT, { recursive: true });

/* 1 — the approved references at 390 */
if (REF_DIR) {
  for (const name of ["profile", "settings"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto("file:///" + path.join(REF_DIR, `${name}.html`).replace(/\\/g, "/"));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await shoot(page, `reference-${name}-390.png`);
    await page.close();
  }
}

/* 2 — full tenant: before the logo, then the real upload */
{
  const ctx = await context(browser, TOKENS.full.token, 390, 844);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/profile`);
  await settle(page, "text=השלמת פרטי העסק");
  await shoot(page, "profile-full-390-before-logo.png");
  check("before upload: completion is 87% (7 of 8 — no logo)", await page.isVisible("text=87%"));

  const logo = await makeLogoFile(browser);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/billing/invoice-profile") && r.request().method() === "PATCH"),
    page.setInputFiles('input[type="file"]', logo),
  ]);
  check("logo upload: PATCH accepted", resp.status() === 200, `HTTP ${resp.status()}`);
  const sent = JSON.parse(resp.request().postData() || "{}").billingLogoDataUrl || "";
  check("logo upload: a 1600px PNG was shrunk to the server's limit", sent.length > 0 && sent.length <= 500000, `${sent.length} chars`);
  await page.waitForSelector('img[alt^="הלוגו של"]');
  await page.waitForSelector("text=100%");
  check("after upload: the logo shows and completion is 100%", true);
  await shoot(page, "profile-full-390-after-logo.png");
  await ctx.close();
}

/* 3 — all widths, full tenant */
for (const [w, h] of WIDTHS) {
  const ctx = await context(browser, TOKENS.full.token, w, h);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/profile`);
  await settle(page, 'img[alt^="הלוגו של"]');
  await shoot(page, `profile-full-${w}.png`);
  await noOverflow(page, `profile ${w}`);
  await page.goto(`${BASE}/settings`);
  await settle(page, "text=חיבורים ואינטגרציות");
  await page.waitForSelector("text=3 פעילים", { timeout: 15000 }).catch(() => {});
  await shoot(page, `settings-full-${w}.png`);
  await noOverflow(page, `settings ${w}`);
  if (w === 390) {
    check("settings: the live connections value is shown (3 פעילים)", await page.isVisible("text=3 פעילים"));
    check("settings: subscription row says בקרוב and is not a link", (await page.locator('a:has-text("תוכנית המנוי")').count()) === 0);
  }
  await ctx.close();
}

/* 4 — empty tenant */
for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
  const ctx = await context(browser, TOKENS.empty.token, w, h);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/profile`);
  await settle(page, "text=השלמת פרטי העסק");
  await shoot(page, `profile-empty-${w}.png`);
  await noOverflow(page, `profile empty ${w}`);
  if (w === 390) {
    check("empty: completion 0%", await page.isVisible("text=0%"));
    check("empty: no contact lines, an add-details link instead", await page.isVisible("text=הוספת פרטי התקשרות"));
  }
  await page.goto(`${BASE}/settings`);
  await settle(page, "text=חיבורים ואינטגרציות");
  await page.waitForSelector("text=אין פעילים", { timeout: 15000 }).catch(() => {});
  await shoot(page, `settings-empty-${w}.png`);
  await ctx.close();
}

/* 5 — every hub destination opens a real page, then sign out */
{
  const ctx = await context(browser, TOKENS.empty.token, 1440, 900);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/settings`);
  await settle(page, "text=חיבורים ואינטגרציות");
  const hrefs = await page.$$eval("main a[href], a[href]", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  const internal = hrefs.filter((h) => h && h.startsWith("/") && !h.startsWith("//"));
  for (const href of internal) {
    const res = await page.request.get(`${BASE}${href}`);
    check(`hub link ${href} opens a page`, res.status() < 400, `HTTP ${res.status()}`);
  }
  check("support link is the support mailbox", hrefs.includes("mailto:support@promaxgroup.co.il"));
  await page.goto(`${BASE}/profile`);
  await settle(page, "text=השלמת פרטי העסק");
  const profileHrefs = await page.$$eval("a[href]", (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
  for (const href of profileHrefs.filter((h) => h && h.startsWith("/"))) {
    const res = await page.request.get(`${BASE}${href}`);
    check(`profile link ${href} opens a page`, res.status() < 400, `HTTP ${res.status()}`);
  }
  await page.goto(`${BASE}/settings`);
  await settle(page, "text=חיבורים ואינטגרציות");
  await Promise.all([page.waitForURL(/\/login/, { timeout: 20000 }), page.click("text=יציאה מהחשבון")]);
  check("sign-out returns to /login", page.url().includes("/login"), page.url());
  // The harness re-injects the token on every load, so the proof is server-side:
  // the token the page used must no longer authenticate.
  const me = await page.request.get(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${TOKENS.empty.token}` } });
  check("sign-out revoked the session server-side", me.status() === 401, `HTTP ${me.status()}`);
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
