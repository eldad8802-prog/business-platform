/**
 * Desktop UX Phase 2 final audit: one representative state of every product
 * domain at the final desktop widths (1280 / 1440 / 1920), and an overflow
 * check at 390 / 768 / 1024 on the same routes without screenshots.
 *
 * Every /api call is answered in the browser. GETs the audit does not model
 * answer {} so a page shows its own empty state; every write is refused.
 * Nothing is sent, published, connected or generated.
 *
 *   node qa-evidence/desktop-ux-phase-2/shoot-final-audit.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2/final-audit");
const DESK = [1280, 1440, 1920];
const SMALL = [390, 768, 1024];

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function fulfill(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  if (req.method() !== "GET") return route.fulfill(json({ error: "qa-mock: writes are disabled" }, 409));
  if (p.includes("/api/auth/me")) {
    return route.fulfill(json({ user: { name: "נועה לוי", email: "noa@example.com", businessName: "קפה נועה" } }));
  }
  if (p.includes("/api/integrations/whatsapp/connection")) {
    return route.fulfill(json({ connection: { status: "CONNECTED", displayPhoneNumber: "+972 50-000-0000", phoneNumberId: "pn", wabaId: "waba" } }));
  }
  return route.fulfill(json({}));
}

// [slug, route, text that proves the page rendered ("" = wait briefly)]
//
// Home (/app), collection, collection create, secretary, payables and
// notifications are not here: with an empty {} answer they fail to load, which
// says nothing about their composition. They were audited by re-running the
// slice 1–5 scripts, whose mocks model their data, against the same HEAD.
const ROUTES = [
  ["customers", "/customers", ""],
  ["leads", "/leads", ""],
  ["suppliers", "/suppliers", ""],
  ["documents", "/documents", ""],
  ["documents-search", "/documents/search", ""],
  ["documents-inbox", "/documents/inbox", ""],
  ["documents-upload", "/documents/upload", ""],
  ["accountant-pack", "/documents/accountant-pack", ""],
  ["billing", "/billing", ""],
  ["inventory", "/inventory", ""],
  ["attention", "/attention", ""],
  ["search", "/search", ""],
  ["settings", "/settings", ""],
  ["business", "/business", ""],
  ["coupons", "/revenue", ""],
  ["content", "/content", ""],
  ["inbox", "/inbox", ""],
  ["tools", "/tools", ""],
  ["tools-category", "/tools/customers", ""],
  ["legacy-content-mode", "/content/mode", ""],
];

async function settle(page, needle) {
  await page.waitForFunction(
    (n) => {
      const text = document.body.innerText || "";
      return !text.includes("Compiling") && !text.includes("טוען…") && !text.includes("טוען...") && (!n || text.includes(n));
    },
    needle,
    { timeout: 90000 },
  );
  await page.waitForTimeout(600);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "he-IL", timezoneId: "Asia/Jerusalem", reducedMotion: "reduce" });
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "נועה", businessId: 1 }));
  localStorage.setItem("dubiz.home.identity.v1", "dubiz");
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal{display:none!important}";
    document.head.appendChild(style);
  });
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();
fs.mkdirSync(ROOT, { recursive: true });

const results = [];
for (const [slug, route, needle] of ROUTES) {
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => {
      const overlay = document.querySelector("[data-dubiz-intro-overlay]");
      return !overlay || getComputedStyle(overlay).opacity === "0";
    }, null, { timeout: 90000 });
    await settle(page, needle);
    for (const width of [...DESK, ...SMALL]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page, needle);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      if (DESK.includes(width)) await page.screenshot({ path: path.join(ROOT, `${slug}-${width}.png`) });
      results.push({ slug, route, width, overflow, url: page.url().replace(BASE, "") });
      console.log(slug, width, overflow ? "OVERFLOW" : "ok", page.url().replace(BASE, ""));
    }
  } catch (error) {
    console.error("FAILED", slug, error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}
await browser.close();
const overflow = results.filter((r) => r.overflow);
fs.writeFileSync(path.join(ROOT, "..", "final-audit-metrics.json"), JSON.stringify({ checks: results.length, overflow: overflow.length, results }, null, 2));
console.log("CHECKS", results.length, "OVERFLOW", overflow.length);
