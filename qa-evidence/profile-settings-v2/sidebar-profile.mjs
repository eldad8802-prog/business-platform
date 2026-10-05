/**
 * Focused closure check: the sidebar business card opens /profile.
 *
 * Real app + local throwaway DB (seed-local.ts). Verifies the card link,
 * keyboard access, that the rest of the sidebar and Settings → Profile still
 * work, and that tablet (rail, no card) and mobile (bottom bar) are unchanged.
 *
 *   QA_BASE=http://localhost:3020 QA_TOKENS=<seed json> node qa-evidence/profile-settings-v2/sidebar-profile.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3020";
const TOKENS = JSON.parse(process.env.QA_TOKENS || "{}");
const OUT = path.resolve("qa-evidence/profile-settings-v2");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
async function page(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((t) => localStorage.setItem("token", t), TOKENS.full.token);
  return ctx.newPage();
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const card = 'nav.dz-sidebar a.dz-sidebar__business';

/* desktop */
{
  const p = await page(1440, 900);
  await p.goto(`${BASE}/app`);
  await p.waitForSelector(card, { timeout: 30000 });
  check("desktop: the business card is a link to /profile", (await p.getAttribute(card, "href")) === "/profile");
  check("desktop: it has an accessible name", ((await p.getAttribute(card, "aria-label")) || "").startsWith("פרופיל העסק"));
  check("desktop: Home shell has no horizontal overflow", await overflow(p));

  await p.click(card);
  await p.waitForURL(/\/profile$/, { timeout: 20000 });
  check("desktop: clicking the card opens /profile", p.url().endsWith("/profile"));
  await p.waitForSelector("text=השלמת פרטי העסק");
  check("desktop: on /profile the card is marked current", (await p.getAttribute(card, "aria-current")) === "page");
  check("desktop: /profile has no horizontal overflow", await overflow(p));
  await p.goto(`${BASE}/profile`);
  await p.waitForFunction(() => document.querySelectorAll('[role="status"]').length === 0, null, { timeout: 30000 });
  await p.mouse.move(0, 0);
  await p.waitForTimeout(400);
  const current = await p.$$eval("nav.dz-sidebar a[aria-current]", (as) => as.map((a) => a.getAttribute("href")));
  check("desktop: on a direct load of /profile only the business card is current", JSON.stringify(current) === '["/profile"]', JSON.stringify(current));
  await p.screenshot({ path: path.join(OUT, "sidebar-card-profile-1440.png") });

  // keyboard: from the brand link, Tab reaches the card; Enter opens it; focus is visible
  await p.goto(`${BASE}/settings`);
  await p.waitForSelector(card);
  await p.focus("nav.dz-sidebar a.dz-sidebar__brand");
  await p.keyboard.press("Tab");
  const focused = await p.evaluate(() => {
    const el = document.activeElement;
    const cs = el ? getComputedStyle(el) : null;
    return { cls: el?.className || "", outline: cs ? `${cs.outlineStyle} ${cs.outlineWidth}` : "" };
  });
  check("keyboard: Tab from the brand lands on the business card", String(focused.cls).includes("dz-sidebar__business"), focused.cls);
  check("keyboard: the focused card shows a focus ring", !focused.outline.startsWith("none"), focused.outline);
  await Promise.all([p.waitForURL(/\/profile$/, { timeout: 20000 }), p.keyboard.press("Enter")]);
  check("keyboard: Enter opens /profile", p.url().endsWith("/profile"));

  // the rest of the sidebar still navigates
  for (const [label, href] of [["שיחות", "/inbox"], ["לקוחות", "/customers"], ["הגדרות", "/settings"]]) {
    await p.click(`nav.dz-sidebar a[href="${href}"]`);
    await p.waitForURL(new RegExp(`${href}$`), { timeout: 20000 });
    check(`desktop: sidebar "${label}" still opens ${href}`, p.url().endsWith(href));
  }
  check("desktop: on /settings the card is not marked current", (await p.getAttribute(card, "aria-current")) === null);

  // Settings → Profile still works
  await p.waitForSelector('a[href="/profile"]:has-text("לפרופיל העסק")');
  await p.click('a[href="/profile"]:has-text("לפרופיל העסק")');
  await p.waitForURL(/\/profile$/, { timeout: 20000 });
  check("Settings → Profile (account card) still works", p.url().endsWith("/profile"));
  await p.context().close();
}

/* tablet — rail only, no business card */
{
  const p = await page(1024, 768);
  await p.goto(`${BASE}/profile`);
  await p.waitForSelector("text=השלמת פרטי העסק");
  check("tablet: the rail is shown", await p.isVisible("nav.dz-rail"));
  check("tablet: no business card is shown (none invented)", !(await p.isVisible(card)));
  check("tablet: no horizontal overflow", await overflow(p));
  await p.screenshot({ path: path.join(OUT, "sidebar-card-tablet-1024.png") });
  await p.context().close();
}

/* mobile — bottom bar unchanged */
{
  const p = await page(390, 844);
  await p.goto(`${BASE}/profile`);
  await p.waitForSelector("text=השלמת פרטי העסק");
  const tabs = await p.$$eval('[data-component="shell-bottom-bar"] a', (as) => as.map((a) => a.getAttribute("href")));
  check("mobile: bottom bar tabs unchanged (home, chats, documents, notifications)", JSON.stringify(tabs) === JSON.stringify(["/app", "/inbox", "/documents", "/notifications"]), JSON.stringify(tabs));
  check("mobile: no business card and no new Profile entry in the bar", !(await p.isVisible(card)) && !tabs.includes("/profile"));
  check("mobile: no horizontal overflow", await overflow(p));
  await p.context().close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "sidebar-profile-results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
