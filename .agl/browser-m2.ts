/**
 * "Continue with Google", milestone 2 — end to end in a real browser (Chromium) against `next start` of this
 * build, the .agl lab database, and the local Google stand-in (.agl/mock-google.ts). Hebrew UI, three widths.
 *
 *   MODE=on   per width — desktop 1440×900, tablet 820×1180, phone 390×844:
 *               1 /login shows "המשך עם Google"; no horizontal overflow
 *               2 Google → /register/google: the verified address shown read-only; NOTHING exists in the DB;
 *                 the ticket cookie is invisible to JavaScript; /api/auth/me answers 401
 *               3 an empty business name is stopped in the form (no request)
 *               4 cancel → /login with the "cancelled" notice; still nothing in the DB
 *               5 back to Google → the form again → complete → /setup with a stored session; ONE account
 *                 with consent recorded
 *               6 signed out, Google again → /auth/google/done → /app, the same account, no second one
 *             once: an address of an existing, unlinked account → "existing" notice, no link, no session;
 *                   cancel at Google → "cancelled".
 *   MODE=off  the same build with the flag OFF: no button; the routes and pages answer 404.
 *
 * env: BASE, MOCK (stand-in base URL), OWNER_URL, SHOTS (screenshot directory), MODE. Synthetic only.
 */
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3611";
const MOCK = process.env.MOCK ?? "http://localhost:3901";
const MODE = process.env.MODE ?? "on";
const SHOTS = process.env.SHOTS ?? "";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const nextIs = (who: { sub: string; email: string; name: string } | { cancel: true }) =>
  fetch(`${MOCK}/__next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(who) });
const users = async (email: string) => owner.user.count({ where: { email } });
const tickets = async (sub: string) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND "endedAt" IS NULL`, sub)) as { c: number }[])[0].c);

async function onMode(browser: Browser) {
  for (const vp of VIEWPORTS) {
    console.log(`\n— ${vp.name} ${vp.width}×${vp.height} —`);
    const who = { sub: `browser-${vp.name}-${Date.now()}`, email: `agl-browser-${vp.name}-${Date.now()}@lab.invalid`, name: "דנה כהן" };
    const biz = `מאפיית דנה ${vp.name} ${Date.now()}`;
    const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/login`);
    const button = page.getByTestId("google-button");
    await button.waitFor({ state: "visible", timeout: 30_000 });
    ok(`${vp.name} 1 /login shows "המשך עם Google"`, (await button.innerText()).includes("המשך עם Google"));
    ok(`${vp.name} 1 the page is RTL and has no horizontal overflow`, (await page.evaluate(() => getComputedStyle(document.body).direction)) === "rtl" && (await noOverflow(page)));
    await shot(page, `${vp.name}-1-login`);

    await nextIs(who);
    await button.click();
    await page.waitForURL(/\/register\/google$/, { timeout: 30_000 });
    await page.getByTestId("google-signup-form").waitFor({ state: "visible" });
    ok(`${vp.name} 2 the completion form shows the verified address read-only`, (await page.getByTestId("google-email").innerText()).trim() === who.email);
    ok(`${vp.name} 2 the name from Google is prefilled`, (await page.locator("#g-name").inputValue()) === who.name);
    ok(`${vp.name} 2 there is no password field`, (await page.locator('input[type="password"]').count()) === 0);
    ok(`${vp.name} 2 NOTHING exists yet: no account`, (await users(who.email)) === 0);
    ok(`${vp.name} 2 the ticket cookie is invisible to JavaScript`, !(await page.evaluate(() => document.cookie)).includes("dz_google_signup"));
    ok(`${vp.name} 2 no business API answers (/api/auth/me → 401)`, (await page.evaluate(async () => (await fetch("/api/auth/me")).status)) === 401);
    ok(`${vp.name} 2 no horizontal overflow`, await noOverflow(page));
    await shot(page, `${vp.name}-2-complete-form`);

    await page.getByTestId("google-signup-submit").click();
    await page.locator("#g-business-msg").waitFor({ state: "visible" });
    ok(`${vp.name} 3 an empty business name is stopped in the form`, (await page.locator("#g-business-msg").innerText()).includes("שם עסק") && (await users(who.email)) === 0);
    await shot(page, `${vp.name}-3-form-errors`);

    await page.getByTestId("google-signup-cancel").click();
    await page.waitForURL(/\/login\?google=cancelled$/);
    await page.getByTestId("google-notice").waitFor({ state: "visible" });
    ok(`${vp.name} 4 cancel → /login with the "cancelled" notice`, (await page.getByTestId("google-notice").getAttribute("data-notice")) === "cancelled");
    ok(`${vp.name} 4 …still no account`, (await users(who.email)) === 0);
    await shot(page, `${vp.name}-4-cancelled`);

    await nextIs(who);
    await page.getByTestId("google-button").click();
    await page.waitForURL(/\/register\/google$/);
    await page.getByTestId("google-signup-form").waitFor({ state: "visible" });
    ok(`${vp.name} 5 back to Google → the form again (one open ticket)`, (await tickets(who.sub)) === 1);
    await page.locator("#g-business").fill(biz);
    await page.locator("#g-terms").check();
    await page.getByTestId("google-signup-submit").click();
    await page.waitForURL(/\/setup/, { timeout: 30_000 });
    ok(`${vp.name} 5 completion → /setup with a stored session`, !!(await page.evaluate(() => localStorage.getItem("token"))));
    const u = await owner.user.findUnique({ where: { email: who.email }, select: { id: true, businessId: true, password: true, termsAcceptedAt: true, termsVersion: true } });
    ok(`${vp.name} 5 ONE account, no password, consent recorded`, (await users(who.email)) === 1 && u?.password === null && !!u?.termsAcceptedAt && !!u?.termsVersion);
    ok(`${vp.name} 5 its business is the one typed`, (await owner.business.findUnique({ where: { id: u!.businessId }, select: { name: true } }))?.name === biz);
    await shot(page, `${vp.name}-5-setup`);
    await ctx.close();

    const ctx2 = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${BASE}/login`);
    await nextIs(who);
    await page2.getByTestId("google-button").click();
    // /auth/google/done → /app; a business that has not finished /setup is sent on there by the Home.
    await page2.waitForURL(/\/(app|setup)/, { timeout: 30_000 });
    ok(`${vp.name} 6 signed out, Google again → into the app`,
      /^\/(app|setup)/.test(new URL(page2.url()).pathname) && !!(await page2.evaluate(() => localStorage.getItem("token"))));
    ok(`${vp.name} 6 …the same account, no second one`, (await users(who.email)) === 1
      && (await owner.authSession.count({ where: { userId: u!.id } })) === 2);
    await shot(page2, `${vp.name}-6-app`);
    await ctx2.close();
  }

  console.log("\n— an existing, unlinked account; cancel at Google —");
  const biz = await owner.business.create({ data: { name: `agl-browser-pw-${Date.now()}` }, select: { id: true } });
  const email = `agl-browser-pw-${Date.now()}@lab.invalid`;
  const pw = await owner.user.create({ data: { email, password: "$2b$10$" + "A".repeat(53), name: "פ", businessId: biz.id }, select: { id: true } });
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await nextIs({ sub: `browser-existing-${Date.now()}`, email, name: "פ" });
  await page.getByTestId("google-button").click();
  await page.waitForURL(/\/login\?google=existing$/);
  await page.getByTestId("google-notice").waitFor({ state: "visible" });
  ok("existing address → the 'existing' notice", (await page.getByTestId("google-notice").getAttribute("data-notice")) === "existing");
  ok("…no link, no session, no second account",
    (await owner.userIdentity.count({ where: { userId: pw.id } })) === 0 && (await owner.authSession.count({ where: { userId: pw.id } })) === 0 && (await users(email)) === 1);
  await shot(page, "desktop-7-existing-account");
  await nextIs({ cancel: true });
  await page.getByTestId("google-button").click();
  await page.waitForURL(/\/login\?google=cancelled$/);
  ok("cancel at Google → the 'cancelled' notice", (await page.getByTestId("google-notice").getAttribute("data-notice")) === "cancelled");
  await ctx.close();
}

async function offMode(browser: Browser) {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator("#login-email").waitFor({ state: "visible", timeout: 30_000 });
  ok("OFF: /login has no Google button", (await page.getByTestId("google-button").count()) === 0);
  await shot(page, "off-phone-login");
  for (const p of ["/api/auth/google/start", "/api/auth/google/callback?code=c&state=s", "/api/auth/google/ticket"]) {
    ok(`OFF: GET ${p.split("?")[0]} → 404`, (await page.request.get(`${BASE}${p}`, { maxRedirects: 0 })).status() === 404);
  }
  ok("OFF: POST /api/auth/google/complete → 404", (await page.request.post(`${BASE}/api/auth/google/complete`, { data: {} })).status() === 404);
  for (const p of ["/register/google", "/auth/google/done"]) {
    ok(`OFF: ${p} → 404`, (await page.request.get(`${BASE}${p}`)).status() === 404);
  }
  await ctx.close();
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    if (MODE === "off") await offMode(browser);
    else await onMode(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n[oauth-identity-browser-${MODE}] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
