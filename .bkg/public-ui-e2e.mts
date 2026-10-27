/**
 * Milestone C, segment 3 — the customer's booking page and own link, in a real browser against a running app and a
 * lab database (never Production). Phone 375 / 390, tablet 820, desktop 1440.
 *
 *   P. per viewport: the manual flow end to end (service → staff → day/time → details → "ממתינה"), no horizontal
 *      scroll at any step, focus on each step's question, the personal link; the automatic flow ("נקבע").
 *   M. the customer's own link: view → cancel (confirm first) → "התור בוטל"; a garbage / truncated token → unavailable.
 *   E. edge cases: empty / invalid details stop before anything is sent; a double tap sends one booking; a time taken
 *      while filling in → the nearest free times; the limiter down (503) keeps the form and the same key; the page's
 *      loading, error-and-retry and "no free time this week" states.
 *   C. closed: public_booking DISABLED → the page says the link is unavailable; restored after.
 *   A. accessibility: axe-core (WCAG 2 A/AA) on every step, no serious or critical violation; private headers.
 *
 * env: E2E_BASE (default http://localhost:3702), PUBLIC_ID, BUSINESS_ID, OWNER_URL (the lab's owner role), OUT.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3702";
const PUBLIC_ID = process.env.PUBLIC_ID!;
const BUSINESS_ID = Number(process.env.BUSINESS_ID);
const OUT = process.env.OUT ?? "e2e-public-booking";
mkdirSync(OUT, { recursive: true });
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const fails: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { fails.push(name); console.log(`  [FAIL] ${name} — ${(e as Error).message.split("\n").slice(0, 4).join(" ⏎ ")}`); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const VIEWPORTS = [
  { name: "phone375", width: 375, height: 740, mobile: true },
  { name: "phone390", width: 390, height: 844, mobile: true },
  { name: "tablet", width: 820, height: 1180, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
] as const;
type Vp = (typeof VIEWPORTS)[number];

let ipSeq = 1;
let phoneSeq = Math.floor(Date.now() / 1000) % 10_000_000;
const nextPhone = () => `05${String(phoneSeq++).padStart(8, "0")}`;

async function ctx(browser: Browser, v: Vp): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE, locale: "he-IL", timezoneId: "Asia/Jerusalem",
    viewport: { width: v.width, height: v.height }, ...(v.mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    // Each context is its own visitor for the per-IP limits (5 submits a minute).
    extraHTTPHeaders: { "x-forwarded-for": `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}` },
  });
}
const shot = (p: Page, n: string) => p.screenshot({ path: join(OUT, `${n}.png`) });
const noHScroll = async (p: Page, where: string) => must(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal scroll at ${where}`);
const focusedHeading = async (p: Page) => p.evaluate(() => (document.activeElement?.tagName ?? "") + ":" + (document.activeElement?.textContent ?? "").trim());

async function axe(p: Page, where: string) {
  await p.addScriptTag({ path: AXE });
  const res = await p.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length }));
  });
  const bad = res.filter((v) => v.impact === "serious" || v.impact === "critical");
  must(bad.length === 0, `axe at ${where}: ${JSON.stringify(bad)}`);
}

/** Through the steps to the details form. Returns the chosen start (ISO). */
async function toDetails(p: Page, service: string, staff: string, opts: { axeAt?: string } = {}) {
  await p.goto(`/book/${PUBLIC_ID}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("heading", { name: "איזה שירות?" }).waitFor({ timeout: 60_000 });
  if (opts.axeAt) await axe(p, `${opts.axeAt}:service`);
  await p.getByRole("radio", { name: new RegExp(service) }).click();
  await p.getByRole("button", { name: "המשך" }).click();
  await p.getByRole("heading", { name: "אצל מי?" }).waitFor({ timeout: 20_000 });
  if (opts.axeAt) await axe(p, `${opts.axeAt}:staff`);
  await p.getByRole("radio", { name: new RegExp(staff) }).click();
  await p.getByRole("button", { name: "המשך" }).click();
  await p.getByRole("heading", { name: "מתי?" }).waitFor({ timeout: 20_000 });
  const firstTime = p.getByRole("radiogroup", { name: "שעה" }).getByRole("radio").first();
  await firstTime.waitFor({ timeout: 30_000 });
  if (opts.axeAt) await axe(p, `${opts.axeAt}:time`);
  const label = (await firstTime.textContent())?.trim() ?? "";
  await firstTime.click();
  await p.getByRole("button", { name: "המשך" }).click();
  await p.getByRole("heading", { name: "הפרטים שלך" }).waitFor({ timeout: 20_000 });
  // Regression: the "continue" click must not be completed as a submission of the details form.
  await p.waitForTimeout(300);
  must((await p.getByText("צריך שם מלא (לפחות שתי אותיות).").count()) === 0, "the details form was submitted by the continue click");
  if (opts.axeAt) await axe(p, `${opts.axeAt}:details`);
  return label;
}

async function fill(p: Page, name: string, phone: string, note = "") {
  await p.getByLabel("שם מלא").fill(name);
  await p.getByLabel("טלפון").fill(phone);
  if (note) await p.getByLabel("הערה לעסק (לא חובה)").fill(note);
}

async function main() {
  must(PUBLIC_ID && BUSINESS_ID, "PUBLIC_ID and BUSINESS_ID are required");
  const browser = await chromium.launch();
  let manageLink = "";
  try {
    for (const v of VIEWPORTS) {
      console.log(`== ${v.name} ${v.width}px`);
      const c = await ctx(browser, v);
      const p = await c.newPage();
      await check(`${v.name}: manual flow → "ממתינה לאישור", the personal link, no horizontal scroll`, async () => {
        const at = await toDetails(p, "תספורת", "כל איש צוות פנוי", { axeAt: v.name });
        must(/^\d\d:\d\d$/.test(at), `time label ${at}`);
        await noHScroll(p, "details");
        await shot(p, `${v.name}-details`);
        await fill(p, "נועה בדיקה", nextPhone(), "פעם ראשונה");
        await p.getByRole("button", { name: "שליחת בקשה לתור" }).click();
        await p.getByRole("heading", { name: /הבקשה נשלחה/ }).waitFor({ timeout: 30_000 });
        must((await focusedHeading(p)).includes("הבקשה נשלחה"), "focus is not on the answer");
        must(await p.getByText("ממתינה לאישור העסק").first().isVisible(), "no pending badge");
        const code = (await p.locator("code").textContent()) ?? "";
        must(code.includes("/book/manage#") && /#[A-Za-z0-9_-]{43}$/.test(code), `link ${code}`);
        if (v.name === "desktop") manageLink = code;
        await noHScroll(p, "answer");
        await axe(p, `${v.name}:answer`);
        await shot(p, `${v.name}-answer-pending`);
      });
      await c.close();
    }

    console.log("== the automatic flow and the customer's link");
    {
      const c = await ctx(browser, VIEWPORTS[1]);
      const p = await c.newPage();
      await check("auto-approved service → \"התור נקבע\" with the staff member", async () => {
        await toDetails(p, "צבע", "שירה");
        await fill(p, "רון בדיקה", nextPhone());
        await p.getByRole("button", { name: "קביעת התור" }).click();
        await p.getByRole("heading", { name: /התור נקבע/ }).waitFor({ timeout: 30_000 });
        must(await p.getByText("שירה").first().isVisible(), "staff name missing");
        await shot(p, "phone390-answer-confirmed");
      });
      await c.close();
    }
    {
      const c = await ctx(browser, VIEWPORTS[3]);
      const p = await c.newPage();
      await check("the personal link shows the pending request; cancel asks first, then \"התור בוטל\"", async () => {
        must(manageLink, "no link from the desktop flow");
        await p.goto(manageLink.replace(/^https?:\/\/[^/]+/, ""), { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { name: "ממתינה לאישור העסק" }).waitFor({ timeout: 60_000 });
        await axe(p, "manage:pending");
        await shot(p, "desktop-manage-pending");
        await p.getByRole("button", { name: "ביטול הבקשה" }).click();
        await p.getByRole("alertdialog").waitFor();
        await p.getByRole("button", { name: "כן, לבטל" }).click();
        await p.getByRole("heading", { name: "התור בוטל" }).waitFor({ timeout: 30_000 });
        must((await p.getByRole("button", { name: /ביטול/ }).count()) === 0, "a cancel button after cancelling");
        await shot(p, "desktop-manage-canceled");
      });
      await check("a garbage or truncated token → \"הקישור אינו זמין\"", async () => {
        await p.goto("/book/manage#not-a-token", { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { name: "הקישור אינו זמין" }).waitFor({ timeout: 30_000 });
        await p.goto(`/book/manage#${"A".repeat(43)}`, { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { name: "הקישור אינו זמין" }).waitFor({ timeout: 30_000 });
        await axe(p, "manage:gone");
      });
      await c.close();
    }

    console.log("== edge cases");
    {
      const c = await ctx(browser, VIEWPORTS[1]);
      const p = await c.newPage();
      const posts: { key: string | null }[] = [];
      p.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/requests")) posts.push({ key: r.headers()["idempotency-key"] ?? null }); });
      await check("empty or invalid details stop before anything is sent", async () => {
        await toDetails(p, "תספורת", "אבי");
        await p.getByRole("button", { name: "שליחת בקשה לתור" }).click();
        await p.getByText("צריך שם מלא (לפחות שתי אותיות).").waitFor();
        must(await p.getByText("צריך מספר טלפון.").isVisible(), "no phone error");
        must((await p.getByLabel("שם מלא").getAttribute("aria-invalid")) === "true", "aria-invalid missing");
        await fill(p, "דנה", "052-abc");
        await p.getByRole("button", { name: "שליחת בקשה לתור" }).click();
        await p.getByText("מספר הטלפון לא נראה תקין.").waitFor();
        must(posts.length === 0, `sent ${posts.length}`);
        await shot(p, "phone390-details-errors");
      });
      await check("a double tap sends one request and books once", async () => {
        const phone = nextPhone();
        await fill(p, "דנה בדיקה", phone);
        const btn = p.getByRole("button", { name: "שליחת בקשה לתור" });
        await btn.dblclick();
        await p.getByRole("heading", { name: /הבקשה נשלחה/ }).waitFor({ timeout: 30_000 });
        must(posts.length >= 1 && new Set(posts.map((x) => x.key)).size === 1, `posts ${JSON.stringify(posts)}`);
        const n = Number((await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "BookingRequest" WHERE "businessId" = ${BUSINESS_ID} AND "contactPhone" LIKE '%${phone.slice(1)}'`))[0].n);
        must(n === 1, `${n} requests for the phone`);
      });
      await c.close();
    }
    {
      const c = await ctx(browser, VIEWPORTS[1]);
      const p = await c.newPage();
      await check("a time taken while filling in → back to the times, with the nearest free ones", async () => {
        await toDetails(p, "תספורת", "כל איש צוות פנוי");
        await fill(p, "גל בדיקה", nextPhone());
        await p.route("**/api/public/booking/*/requests", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "SLOT_UNAVAILABLE", message: "השעה הזו כבר לא פנויה. אפשר לבחור שעה אחרת." }) }));
        await p.getByRole("button", { name: "שליחת בקשה לתור" }).click();
        await p.getByRole("heading", { name: "מתי?" }).waitFor({ timeout: 20_000 });
        const alert = p.getByRole("alert").filter({ hasText: "נתפסה" });
        await alert.waitFor();
        const alts = await alert.getByRole("button").count();
        must(alts >= 1 && alts <= 3, `${alts} alternatives`);
        await shot(p, "phone390-taken");
        await p.unroute("**/api/public/booking/*/requests");
        await alert.getByRole("button").first().click();
        await p.getByRole("button", { name: "המשך" }).click();
        await p.getByRole("heading", { name: "הפרטים שלך" }).waitFor();
        must((await p.getByLabel("שם מלא").inputValue()) === "גל בדיקה", "the details were lost");
        // Back on a filled form: nothing is sent until the customer presses send.
        await p.waitForTimeout(800);
        must(await p.getByRole("heading", { name: "הפרטים שלך" }).isVisible(), "the filled form was sent without a press");
      });
      await check("the limiter down (503): the form stays, the message says so, a retry uses the same key", async () => {
        const keys: string[] = [];
        let first = true;
        await p.route("**/api/public/booking/*/requests", async (r) => {
          keys.push(r.request().headers()["idempotency-key"] ?? "");
          if (first) { first = false; await r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "השירות עמוס כרגע. נסה שוב בעוד רגע.", code: "rate_limit_unavailable" }) }); }
          else await r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "השירות עמוס כרגע. נסה שוב בעוד רגע.", code: "rate_limit_unavailable" }) });
        });
        const send = p.getByRole("button", { name: "שליחת בקשה לתור" });
        if (!(await send.isVisible())) { await shot(p, "phone390-before-busy"); throw new Error(`no send button before 503; buttons: ${(await p.getByRole("button").allTextContents()).join(" | ")}; headings: ${(await p.getByRole("heading").allTextContents()).join(" | ")}`); }
        await send.click();
        await p.getByRole("alert").filter({ hasText: "עמוס" }).waitFor();
        await shot(p, "phone390-busy");
        const again = p.getByRole("button", { name: "שליחת בקשה לתור" });
        if (!(await again.isVisible())) throw new Error(`no send button after 503; buttons: ${(await p.getByRole("button").allTextContents()).join(" | ")}; heading: ${(await p.getByRole("heading").allTextContents()).join(" | ")}`);
        await again.click();
        await p.waitForTimeout(500);
        must(keys.length === 2 && keys[0] === keys[1] && keys[0].length > 8, `keys ${JSON.stringify(keys)}`);
        must((await p.getByLabel("שם מלא").inputValue()) === "גל בדיקה", "the form was cleared");
        await p.unroute("**/api/public/booking/*/requests");
      });
      await c.close();
    }
    {
      const c = await ctx(browser, VIEWPORTS[0]);
      const p = await c.newPage();
      await check("the page's loading state, then an error with a retry that recovers", async () => {
        // Every profile request fails until the error is on screen (a dev build mounts effects twice).
        let fail = true;
        await p.route(`**/api/public/booking/${PUBLIC_ID}`, async (r) => {
          await new Promise((x) => setTimeout(x, 1500));
          if (fail) await r.fulfill({ status: 500, contentType: "application/json", body: "{}" }).catch(() => undefined);
          else await r.continue().catch(() => undefined);
        });
        await p.goto(`/book/${PUBLIC_ID}`, { waitUntil: "domcontentloaded" });
        await p.locator("[aria-busy='true']").first().waitFor({ timeout: 30_000 });
        await shot(p, "phone375-loading");
        await p.getByRole("heading", { name: "לא הצלחנו לטעון את העמוד" }).waitFor({ timeout: 30_000 });
        await shot(p, "phone375-error");
        fail = false;
        await p.getByRole("button", { name: "נסה שוב" }).click();
        await p.getByRole("heading", { name: "איזה שירות?" }).waitFor({ timeout: 30_000 });
        await p.unroute(`**/api/public/booking/${PUBLIC_ID}`);
      });
      await check("a week with no free time says so and offers the next week", async () => {
        await p.route("**/slots?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ durationMinutes: 45, slots: [] }) }));
        await p.getByRole("radio", { name: /תספורת/ }).click();
        await p.getByRole("button", { name: "המשך" }).click();
        await p.getByRole("button", { name: "המשך" }).click();
        await p.getByText("אין שעות פנויות בשבוע הזה.").waitFor({ timeout: 20_000 });
        must(await p.getByRole("button", { name: "לשבוע הבא" }).isVisible(), "no next-week button");
        must((await p.getByRole("button", { name: "המשך" }).isDisabled()), "continue enabled without a time");
        await noHScroll(p, "empty week");
        await shot(p, "phone375-empty-week");
        await p.unroute("**/slots?*");
      });
      await c.close();
    }

    console.log("== closed (the production default)");
    const before = await owner.businessFeatureAccess.findFirst({ where: { businessId: BUSINESS_ID, featureKey: "public_booking" }, select: { state: true } });
    await owner.businessFeatureAccess.updateMany({ where: { businessId: BUSINESS_ID, featureKey: "public_booking" }, data: { state: "DISABLED" } });
    try {
      const c = await ctx(browser, VIEWPORTS[1]);
      const p = await c.newPage();
      await check("public_booking OFF: the page says the link is unavailable, and offers nothing", async () => {
        await p.goto(`/book/${PUBLIC_ID}`, { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { name: "הקישור אינו זמין" }).waitFor({ timeout: 60_000 });
        must((await p.getByRole("radio").count()) === 0, "services offered while closed");
        must((await p.getByRole("button", { name: "נסה שוב" }).count()) === 0, "a retry offered for a closed link");
        await axe(p, "closed");
        await shot(p, "phone390-closed");
      });
      await check("an unknown link looks exactly the same", async () => {
        await p.goto("/book/Zz_unknownPublicId_00000", { waitUntil: "domcontentloaded" });
        await p.getByRole("heading", { name: "הקישור אינו זמין" }).waitFor({ timeout: 60_000 });
      });
      await c.close();
    } finally {
      await owner.businessFeatureAccess.updateMany({ where: { businessId: BUSINESS_ID, featureKey: "public_booking" }, data: { state: before?.state ?? "ENABLED" } });
    }

    console.log("== privacy headers");
    await check("the page is noindex and sends no referrer", async () => {
      const html = await (await fetch(`${BASE}/book/${PUBLIC_ID}`)).text();
      must(/<meta name="robots" content="noindex, nofollow/.test(html), "robots meta missing");
      must(/<meta name="referrer" content="no-referrer"/.test(html), "referrer meta missing");
    });
  } finally {
    await browser.close();
    await owner.$disconnect();
  }
  console.log(`${pass} passed, ${fails.length} failed${fails.length ? ": " + fails.join(" | ") : ""}`);
  process.exit(fails.length ? 1 : 0);
}
main();
