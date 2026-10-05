/**
 * /business/identity redesign + /tools retirement — runtime evidence against the REAL app and a
 * local throwaway database (seed-local.ts). No API mocking.
 *
 *   QA_BASE=http://localhost:3030 QA_TOKENS=<seed json> node qa-evidence/identity-landing/shoot.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3030";
const TOKENS = JSON.parse(process.env.QA_TOKENS || "{}");
const OUT = path.resolve("qa-evidence/identity-landing");
const WIDTHS = [[390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
async function page(token, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((t) => localStorage.setItem("token", t), token);
  return ctx.newPage();
}
const ready = (p) => p.waitForSelector("#identity-orient", { timeout: 45000 }).then(() => p.waitForTimeout(500));
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shoot(p, file) {
  await p.mouse.move(0, 0);
  const vp = p.viewportSize();
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  await p.setViewportSize({ width: vp.width, height: Math.max(vp.height, h) });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, file) });
  await p.setViewportSize(vp);
}

/* identity screen, both tenants, all widths */
for (const tenant of ["partial", "empty"]) {
  for (const [w, h] of tenant === "partial" ? WIDTHS : [[390, 844], [768, 1024], [1440, 900]]) {
    const p = await page(TOKENS[tenant].token, w, h);
    await p.goto(`${BASE}/business/identity`);
    await ready(p);
    check(`${tenant} ${w}: no horizontal overflow`, await overflow(p));
    check(`${tenant} ${w}: RTL`, (await p.evaluate(() => getComputedStyle(document.querySelector("[data-shell-root]")).direction)) === "rtl");
    if (w === 390 && tenant === "partial") {
      const readiness = await p.textContent('section[aria-labelledby="identity-orient"]');
      check("partial: readiness is a chapter count, not a percentage", /\d מתוך 4/.test(readiness) && !/%/.test(readiness), readiness.replace(/\s+/g, " ").slice(0, 120));
      check("partial: preview marked not published", await p.isVisible("text=טיוטה · לא פורסם"));
      check("partial: approved description shows in the preview", await p.isVisible('[aria-label="תצוגה מקדימה, לא פורסמה"] >> text=שירותי ניקיון לבתים'));
      check("partial: internal specialization is NOT in the preview", !(await p.isVisible('[aria-label="תצוגה מקדימה, לא פורסמה"] >> text=ניקיון אחרי שיפוץ')));
      check("partial: internal guarantee claim is NOT in the preview", !(await p.locator('[aria-label="תצוגה מקדימה, לא פורסמה"]').textContent()).includes("7 ימים"));
      check("partial: call-to-action is the usable CALL path", await p.isVisible('[aria-label="תצוגה מקדימה, לא פורסמה"] >> text=להתקשר'));
      check("partial: learned suggestions come from real services", await p.isVisible("text=שירות עד הבית"));
      const strategyHref = await p.getAttribute('a:has-text("לאילו כיווני דף נחיתה")', "href");
      const strategyRes = await p.request.get(`${BASE}${strategyHref}`);
      check("preview links to the P3-B strategy directions page", strategyHref === "/business/landing-strategy" && strategyRes.status() === 200, `${strategyHref} ${strategyRes.status()}`);
    }
    if (w === 390 && tenant === "empty") {
      check("empty: 0 of 4 chapters", (await p.textContent('section[aria-labelledby="identity-orient"]')).includes("0 מתוך 4"));
      check("empty: learned shows the honest empty state", await p.isVisible("text=עדיין אין מספיק פעילות"));
    }
    await shoot(p, `identity-${tenant}-${w}.png`);
    await p.context().close();
  }
}

/* mobile step flow + one real adoption */
{
  const p = await page(TOKENS.partial.token, 390, 844);
  await p.goto(`${BASE}/business/identity`);
  await ready(p);
  const openNow = await p.$$eval('[aria-expanded="true"]', (els) => els.length);
  check("mobile: exactly one chapter open at a time", openNow === 1, String(openNow));
  await p.click('button:has-text("לפרק הבא")');
  await p.waitForTimeout(400);
  check("mobile: 'next chapter' opens the next chapter", (await p.$$eval('[aria-expanded="true"]', (els) => els.length)) === 1);
  await shoot(p, "identity-partial-390-step.png");
  const adopt = p.locator('li:has-text("שירות עד הבית") button:has-text("אשר והוסף")');
  const before = await adopt.count();
  if (before) {
    const [resp] = await Promise.all([
      p.waitForResponse((r) => r.url().includes("/api/business/identity/suggestions") && r.request().method() === "POST"),
      adopt.first().click(),
    ]);
    check("learned: 'אשר והוסף' uses the existing adopt endpoint", resp.status() === 200 || resp.status() === 201, `HTTP ${resp.status()}`);
    await p.waitForTimeout(800);
    check("learned: the adopted suggestion leaves the learned list", (await adopt.count()) === 0);
  } else {
    check("learned: home-service suggestion present to adopt", false);
  }
  await p.context().close();
}

/* /tools retirement and back targets */
{
  const p = await page(TOKENS.partial.token, 1440, 900);
  const res = await p.request.get(`${BASE}/tools`, { maxRedirects: 0 });
  check("/tools root redirects (307) to /app", res.status() === 307 && (res.headers()["location"] || "").endsWith("/app"), `${res.status()} → ${res.headers()["location"]}`);
  for (const slug of ["money", "customers", "operations"]) {
    const r = await p.request.get(`${BASE}/tools/${slug}`);
    check(`/tools/${slug} family screen still served`, r.status() === 200, `HTTP ${r.status()}`);
  }
  await p.goto(`${BASE}/tools#group-money`);
  await p.waitForURL(/\/app/, { timeout: 30000 });
  check("an old /tools#group-* link lands on Home", new URL(p.url()).pathname === "/app", p.url());
  await p.goto(`${BASE}/billing`);
  await p.waitForTimeout(1500);
  const billingBack = p.locator('button[aria-label="חזרה"]').first();
  if (await billingBack.count()) {
    await Promise.all([p.waitForURL(/\/app$/, { timeout: 20000 }), billingBack.click()]);
    check("billing back goes to Home, not /tools", p.url().endsWith("/app"), p.url());
  }
  await p.goto(`${BASE}/business`);
  await p.waitForTimeout(1500);
  const businessBack = p.locator('a[href="/settings"], button[aria-label="חזרה"]').first();
  if (await businessBack.count()) {
    await Promise.all([p.waitForURL(/\/settings$/, { timeout: 20000 }), businessBack.click()]);
    check("business back goes to Settings, not /tools", p.url().endsWith("/settings"), p.url());
  }
  await p.context().close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
