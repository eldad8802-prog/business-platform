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
 *             the server-side cancel (migration 20261101090000):
 *               8 cancel ends the ticket; its cookie copied into another browser shows "unavailable" and
 *                 cannot complete;
 *               9 the database refuses the cancel → a clear message ON the form, the ticket still held;
 *                 the retry → /login "cancelled";
 *              10 the signup completed in another browser first → cancel shows "already completed", the
 *                 account untouched, and leads to /login.
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
const cancelled = async (sub: string) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND "endedReason" = 'CANCELLED'`, sub)) as { c: number }[])[0].c);
const TICKET_COOKIE = "dz_google_signup";
// Each browser below arrives from its own address: the register limit (3 an hour per address) is spent by
// the three completions above, and these flows test the cancel, not the limiter.
let addressSeq = 0;
const ownAddress = () => ({ "x-forwarded-for": `198.51.100.${++addressSeq}` });
/** Google → the completion form, in a fresh browser of the given width. */
async function toForm(browser: Browser, who: { sub: string; email: string; name: string }, width = 1440, height = 900) {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width, height }, extraHTTPHeaders: ownAddress() });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await nextIs(who);
  await page.getByTestId("google-button").click();
  await page.waitForURL(/\/register\/google$/, { timeout: 30_000 });
  await page.getByTestId("google-signup-form").waitFor({ state: "visible" });
  return { ctx, page };
}

async function serverCancel(browser: Browser) {
  console.log("\n— the server-side cancel —");
  const stamp = Date.now();

  // 8 — cancel, then a copy of the ticket cookie in another browser.
  const w8 = { sub: `browser-copy-${stamp}`, email: `agl-browser-copy-${stamp}@lab.invalid`, name: "דנה כהן" };
  const a = await toForm(browser, w8);
  const copy = (await a.ctx.cookies()).find((c) => c.name === TICKET_COOKIE);
  ok("8 the ticket cookie exists (httpOnly) before the cancel", !!copy && copy.httpOnly);
  await a.page.getByTestId("google-signup-cancel").click();
  await a.page.waitForURL(/\/login\?google=cancelled$/);
  await a.page.getByTestId("google-notice").waitFor({ state: "visible" });
  ok("8 cancel → /login with the 'cancelled' notice", (await a.page.getByTestId("google-notice").getAttribute("data-notice")) === "cancelled");
  ok("8 …the ticket is CANCELLED on the server", (await cancelled(w8.sub)) === 1 && (await tickets(w8.sub)) === 0);
  await a.ctx.close();
  const b = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, extraHTTPHeaders: ownAddress() });
  await b.addCookies([copy!]);
  const pageB = await b.newPage();
  await pageB.goto(`${BASE}/register/google`);
  await pageB.getByTestId("google-signup-expired").waitFor({ state: "visible", timeout: 30_000 });
  ok("8 the copied cookie in another browser → the 'unavailable' screen, no form", (await pageB.getByTestId("google-signup-form").count()) === 0);
  await shot(pageB, "desktop-8-copy-refused");
  // The page's read (401) made this browser forget the copy; put it back, so the completion carries it.
  await b.addCookies([copy!]);
  const forged = await pageB.request.post(`${BASE}/api/auth/google/complete`, {
    headers: { origin: BASE }, data: { name: "דנה כהן", businessName: `מאפייה ${stamp}`, acceptTerms: true },
  });
  ok("8 …and a completion with the copy is refused (409), no account", forged.status() === 409 && (await users(w8.email)) === 0);
  await b.close();

  // 9 — the database refuses the cancel; the person stays on the form and retries.
  const w9 = { sub: `browser-fail-${stamp}`, email: `agl-browser-fail-${stamp}@lab.invalid`, name: "דנה כהן" };
  const c = await toForm(browser, w9, 390, 844);
  await owner.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION public.auth_oauth_ticket_cancel(text, text) FROM app_auth`);
  try {
    await c.page.getByTestId("google-signup-cancel").click();
    await c.page.getByTestId("google-signup-form-error").waitFor({ state: "visible", timeout: 30_000 });
    ok("9 a refused cancel → a clear message on the form", (await c.page.getByTestId("google-signup-form-error").innerText()).includes("הביטול לא הושלם"));
    ok("9 …the person stays on the form (no redirect, no 'cancelled' notice)", new URL(c.page.url()).pathname === "/register/google"
      && (await c.page.getByTestId("google-signup-form").count()) === 1);
    ok("9 …the ticket cookie is still held and the ticket still open", !!(await c.ctx.cookies()).find((k) => k.name === TICKET_COOKIE) && (await tickets(w9.sub)) === 1);
    ok("9 …the cancel button is usable again", await c.page.getByTestId("google-signup-cancel").isEnabled());
    ok("9 no horizontal overflow with the message", await noOverflow(c.page));
    await shot(c.page, "phone-9-cancel-failed");
  } finally {
    await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_cancel(text, text) TO app_auth`);
  }
  await c.page.getByTestId("google-signup-cancel").click();
  await c.page.waitForURL(/\/login\?google=cancelled$/, { timeout: 30_000 });
  ok("9 the retry → /login 'cancelled', the ticket CANCELLED", (await cancelled(w9.sub)) === 1 && (await tickets(w9.sub)) === 0);
  await c.ctx.close();

  // 10 — the signup is completed in another browser first; then this one cancels.
  const w10 = { sub: `browser-done-${stamp}`, email: `agl-browser-done-${stamp}@lab.invalid`, name: "דנה כהן" };
  const d = await toForm(browser, w10);
  const held = (await d.ctx.cookies()).find((k) => k.name === TICKET_COOKIE)!;
  const e = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, extraHTTPHeaders: ownAddress() });
  await e.addCookies([held]);
  const pageE = await e.newPage();
  await pageE.goto(`${BASE}/register/google`);
  await pageE.getByTestId("google-signup-form").waitFor({ state: "visible", timeout: 30_000 });
  await pageE.locator("#g-business").fill(`מאפיית דנה ${stamp}`);
  await pageE.locator("#g-terms").check();
  await pageE.getByTestId("google-signup-submit").click();
  await pageE.waitForURL(/\/setup/, { timeout: 30_000 });
  const before = await owner.user.findUnique({ where: { email: w10.email }, select: { id: true, businessId: true } });
  await e.close();
  await d.page.getByTestId("google-signup-cancel").click();
  await d.page.getByTestId("google-signup-completed").waitFor({ state: "visible", timeout: 30_000 });
  ok("10 cancel after the signup completed elsewhere → 'already completed'", (await d.page.locator("h1").innerText()).includes("ההרשמה כבר הושלמה"));
  const after = await owner.user.findUnique({ where: { email: w10.email }, select: { id: true, businessId: true } });
  ok("10 …the account is untouched: one user, the same business, its identity", (await users(w10.email)) === 1 && !!before
    && after?.id === before.id && after?.businessId === before.businessId && (await owner.userIdentity.count({ where: { userId: before.id } })) === 1);
  await shot(d.page, "desktop-10-already-completed");
  await d.page.getByTestId("google-signup-completed-login").click();
  await d.page.waitForURL(/\/login/, { timeout: 30_000 });
  ok("10 …and it leads to /login", new URL(d.page.url()).pathname === "/login");
  await d.ctx.close();
}

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
    ok(`${vp.name} 4 …and the ticket is ended on the server (CANCELLED)`, (await tickets(who.sub)) === 0 && (await cancelled(who.sub)) === 1);
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
  ok("OFF: DELETE /api/auth/google/ticket → 404", (await page.request.delete(`${BASE}/api/auth/google/ticket`, { headers: { origin: BASE } })).status() === 404);
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
    else {
      await onMode(browser);
      await serverCancel(browser);
    }
  } finally {
    await browser.close();
  }
  console.log(`\n[oauth-identity-browser-${MODE}] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
