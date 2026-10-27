/**
 * "Continue with Google", milestone 3 — linking Google to an EXISTING account, end to end in a real browser
 * (Chromium) against `next start` of this build, the .agl lab database (all three oauth migrations) and the
 * local Google stand-in (.agl/mock-google.ts). Hebrew UI. No email leaves the lab: delivery is OFF, and the
 * test reads the emailed link from the outbox row the way the email would render it.
 *
 *   MODE=on   per width — desktop 1440×900, tablet 820×1180, phone 390×844:
 *               1 an existing account's address back from Google → the link screen; nothing linked, no session
 *               2 a wrong password → a clear message on the screen
 *               3 the right password → into the app; ONE identity
 *             once (desktop unless noted):
 *               4 "email me a link" → the sent notice → the emailed link in THIS browser → an explicit confirm
 *                 → into the app
 *               5 the emailed link opened in ANOTHER browser (as a mail scanner would) → "open it where you
 *                 started"; nothing changes
 *               6 cancel on the link screen → /login "cancelled"; the ticket ended on the server
 *               7 Settings → Security: "connected to Google" → disconnect with the password → "not connected"
 *                 (desktop and phone)
 *   MODE=off  the same build with the flag OFF: the link pages and every link / settings route answer 404.
 *
 * env: BASE, MOCK, OWNER_URL, SHOTS, MODE, AUTH_TOKEN_SECRET (the server's, to render the emailed link).
 */
import fs from "node:fs";
import bcrypt from "bcrypt";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

import { buildEmailLink } from "@/lib/auth/email-link";

const BASE = process.env.BASE ?? "http://localhost:3611";
const MOCK = process.env.MOCK ?? "http://localhost:3901";
const MODE = process.env.MODE ?? "on";
const SHOTS = process.env.SHOTS ?? "";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const PASSWORD = "Correct-Horse-Battery-9";

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
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/m3-${name}.png`, fullPage: true }); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const nextIs = (who: { sub: string; email: string; name: string }) =>
  fetch(`${MOCK}/__next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(who) });
let addressSeq = 100;
// Each browser arrives from its own address: login's per-IP limit is for people, not for this test.
const newContext = (browser: Browser, width = 1440, height = 900) =>
  browser.newContext({ locale: "he-IL", viewport: { width, height }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${++addressSeq}` } });

type Acct = { sub: string; email: string; name: string; userId: number };
async function existingAccount(tag: string): Promise<Acct> {
  const stamp = `${Date.now()}-${++addressSeq}`;
  const email = `agl-m3-browser-${tag}-${stamp}@lab.invalid`;
  const b = await owner.business.create({ data: { name: `מאפיית דנה ${tag} ${stamp}` }, select: { id: true } });
  const u = await owner.user.create({ data: { email, password: await bcrypt.hash(PASSWORD, 10), name: "דנה כהן", businessId: b.id }, select: { id: true } });
  return { sub: `m3-browser-${tag}-${stamp}`, email, name: "דנה כהן", userId: u.id };
}
const identities = async (a: Acct) => owner.userIdentity.count({ where: { userId: a.userId } });
const openLinkTickets = async (a: Acct) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1 AND purpose = 'LINK' AND "endedAt" IS NULL`, a.sub)) as { c: number }[])[0].c);
async function emailedLink(a: Acct): Promise<string> {
  const rows = (await owner.$queryRawUnsafe(`SELECT payload FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'LINK_GOOGLE' ORDER BY id DESC LIMIT 1`, a.userId)) as { payload: { tokenId: string } }[];
  return buildEmailLink(BASE, rows[0].payload.tokenId, "LINK_GOOGLE");
}
async function toLinkScreen(ctx: BrowserContext, a: Acct): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await nextIs({ sub: a.sub, email: a.email, name: a.name });
  await page.getByTestId("google-button").click();
  await page.waitForURL(/\/link\/google$/, { timeout: 30_000 });
  await page.getByTestId("google-link-screen").waitFor({ state: "visible" });
  return page;
}

async function onMode(browser: Browser) {
  for (const vp of VIEWPORTS) {
    console.log(`\n— ${vp.name} ${vp.width}×${vp.height} —`);
    const a = await existingAccount(vp.name);
    const ctx = await newContext(browser, vp.width, vp.height);
    const page = await toLinkScreen(ctx, a);
    ok(`${vp.name} 1 the link screen shows the account's address`, (await page.getByTestId("google-link-email").innerText()).trim() === a.email);
    ok(`${vp.name} 1 NOTHING linked and nobody signed in (/api/auth/me → 401)`, (await identities(a)) === 0
      && (await page.evaluate(async () => (await fetch("/api/auth/me")).status)) === 401);
    ok(`${vp.name} 1 the LINK cookie is invisible to JavaScript; RTL; no horizontal overflow`, !(await page.evaluate(() => document.cookie)).includes("dz_google_link")
      && (await page.evaluate(() => getComputedStyle(document.body).direction)) === "rtl" && (await noOverflow(page)));
    ok(`${vp.name} 1 the email path says up front that the link works only in this browser (not the installed-app notice)`,
      (await page.getByTestId("google-link-email-note").innerText()).includes("בדפדפן הזה") && (await page.getByTestId("google-link-pwa-note").count()) === 0);
    await shot(page, `${vp.name}-1-link-screen`);

    await page.locator("#link-password").fill("not-the-password");
    await page.getByTestId("google-link-password-submit").click();
    await page.getByTestId("google-link-password-error").waitFor({ state: "visible", timeout: 30_000 });
    ok(`${vp.name} 2 a wrong password → a clear message; still nothing linked`, (await page.getByTestId("google-link-password-error").innerText()).includes("הסיסמה שגויה") && (await identities(a)) === 0);
    if (vp.name === "desktop") await shot(page, `${vp.name}-2-wrong-password`);

    await page.locator("#link-password").fill(PASSWORD);
    await page.getByTestId("google-link-password-submit").click();
    await page.waitForURL(/\/(app|setup)/, { timeout: 30_000 });
    ok(`${vp.name} 3 the right password → into the app with a stored session; ONE identity`, !!(await page.evaluate(() => localStorage.getItem("token"))) && (await identities(a)) === 1);
    await ctx.close();
  }

  console.log("\n— the emailed link —");
  const e = await existingAccount("email");
  const ctxE = await newContext(browser);
  const pageE = await toLinkScreen(ctxE, e);
  await pageE.getByTestId("google-link-email-send").click();
  await pageE.getByTestId("google-link-email-sent").waitFor({ state: "visible", timeout: 30_000 });
  ok("4 'email me a link' → the sent notice", (await pageE.getByTestId("google-link-email-sent").innerText()).includes("שלחנו קישור"));
  await shot(pageE, "desktop-4-email-sent");
  const link = await emailedLink(e);
  await pageE.goto(link);
  await pageE.getByTestId("google-link-confirm").waitFor({ state: "visible", timeout: 30_000 });
  ok("4 the emailed link in THIS browser → the confirmation screen, nothing linked yet", (await identities(e)) === 0);
  ok("4 …the token is gone from the address bar", !pageE.url().includes("#t="));
  await shot(pageE, "desktop-4-confirm");
  await pageE.getByTestId("google-link-confirm-submit").click();
  await pageE.waitForURL(/\/(app|setup)/, { timeout: 30_000 });
  ok("4 the explicit confirm → into the app; ONE identity", !!(await pageE.evaluate(() => localStorage.getItem("token"))) && (await identities(e)) === 1);
  await ctxE.close();

  const s = await existingAccount("scanner");
  const ctxS = await newContext(browser);
  const pageS = await toLinkScreen(ctxS, s);
  await pageS.getByTestId("google-link-email-send").click();
  await pageS.getByTestId("google-link-email-sent").waitFor({ state: "visible", timeout: 30_000 });
  const linkS = await emailedLink(s);
  const scanner = await newContext(browser, 390, 844);
  const pageX = await scanner.newPage();
  await pageX.goto(linkS);
  await pageX.getByTestId("google-link-confirm-blocked").waitFor({ state: "visible", timeout: 30_000 });
  ok("5 the link opened in ANOTHER browser (a scanner) → 'open it where you started'", (await pageX.getByTestId("google-link-confirm-blocked").getAttribute("data-status")) === "OTHER_BROWSER");
  ok("5 …nothing changed: no identity, the ticket still open, the link unused", (await identities(s)) === 0 && (await openLinkTickets(s)) === 1
    && (await owner.authEmailToken.count({ where: { userId: s.userId, consumedAt: { not: null } } })) === 0);
  ok("5 …no horizontal overflow on the phone", await noOverflow(pageX));
  ok("5 …it explains the iPhone installed-app case and the password alternative, and restarts in THIS browser",
    (await pageX.getByTestId("google-link-confirm-more").allInnerTexts()).join(" ").includes("Safari")
    && (await pageX.getByTestId("google-link-confirm-more").allInnerTexts()).join(" ").includes("סיסמה")
    && (await pageX.getByTestId("google-link-restart").innerText()).includes("בדפדפן הזה")
    && (await pageX.getByTestId("google-link-restart").getAttribute("href")) === "/api/auth/google/start?from=login");
  ok("5 …the quoted button name stays whole in the right-to-left line (gershayim, no ASCII quotes)",
    (await pageX.locator("p").first().innerText()).includes("״המשך עם Google״"));
  await shot(pageX, "phone-5-other-browser");
  await scanner.close();

  // The installed app (PWA) on an iPhone: its cookies are apart from Safari's, and a link from Mail opens in Safari.
  // Simulated here by reporting display-mode: standalone; the link screen then recommends the password up front.
  const p = await existingAccount("pwa");
  const ctxP = await newContext(browser, 390, 844);
  await ctxP.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("display-mode: standalone") ? ({ ...real(q), matches: true, media: q } as MediaQueryList) : real(q));
  });
  const pageP = await toLinkScreen(ctxP, p);
  await pageP.getByTestId("google-link-pwa-note").waitFor({ state: "visible", timeout: 30_000 });
  ok("5b in the installed app: the email path warns that the link opens in Safari and recommends the password",
    (await pageP.getByTestId("google-link-pwa-note").innerText()).includes("Safari") && (await pageP.getByTestId("google-link-pwa-note").innerText()).includes("סיסמה"));
  ok("5b …no horizontal overflow", await noOverflow(pageP));
  await shot(pageP, "phone-5b-installed-app");
  await ctxP.close();

  await pageS.getByTestId("google-link-cancel").click();
  await pageS.waitForURL(/\/login\?google=cancelled$/, { timeout: 30_000 });
  ok("6 cancel on the link screen → /login 'cancelled'; the ticket ended on the server", (await openLinkTickets(s)) === 0 && (await identities(s)) === 0);
  await ctxS.close();

  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    const u = await existingAccount(`settings-${vp.name}`);
    const ctx = await newContext(browser, vp.width, vp.height);
    const page = await toLinkScreen(ctx, u);
    await page.locator("#link-password").fill(PASSWORD);
    await page.getByTestId("google-link-password-submit").click();
    await page.waitForURL(/\/(app|setup)/, { timeout: 30_000 });
    await page.goto(`${BASE}/settings/security`);
    await page.getByTestId("google-connection-state").waitFor({ state: "visible", timeout: 30_000 });
    ok(`${vp.name} 7 Settings → Security: "connected to Google"`, (await page.getByTestId("google-connection-state").innerText()).includes("מחובר ל־Google"));
    await shot(page, `${vp.name}-7-settings-connected`);
    await page.getByTestId("google-unlink-open").click();
    await page.locator("#google-unlink-password").fill(PASSWORD);
    await page.getByTestId("google-unlink-submit").click();
    await page.getByTestId("google-connection-message").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="google-connection-state"]')?.textContent?.includes("לא מחובר"), null, { timeout: 30_000 });
    ok(`${vp.name} 7 disconnect with the password → "not connected"; the identity gone; a GOOGLE_UNLINKED notice`, (await identities(u)) === 0
      && (await owner.transactionalEmail.count({ where: { userId: u.userId, kind: "GOOGLE_UNLINKED" } })) === 1);
    ok(`${vp.name} 7 no horizontal overflow`, await noOverflow(page));
    await shot(page, `${vp.name}-7-settings-disconnected`);
    await ctx.close();
  }
}

async function offMode(browser: Browser) {
  const ctx = await newContext(browser, 390, 844);
  const page = await ctx.newPage();
  for (const p of ["/link/google", "/link/google/confirm"]) {
    ok(`OFF: ${p} → 404`, (await page.request.get(`${BASE}${p}`)).status() === 404);
  }
  ok("OFF: GET /api/auth/google/link → 404", (await page.request.get(`${BASE}/api/auth/google/link`)).status() === 404);
  for (const p of ["/api/auth/google/link/password", "/api/auth/google/link/email", "/api/auth/google/link/email/check", "/api/auth/google/link/email/complete", "/api/security/google"]) {
    ok(`OFF: POST ${p} → 404`, (await page.request.post(`${BASE}${p}`, { headers: { origin: BASE }, data: {} })).status() === 404);
  }
  ok("OFF: DELETE /api/auth/google/link → 404", (await page.request.delete(`${BASE}/api/auth/google/link`, { headers: { origin: BASE } })).status() === 404);
  ok("OFF: GET /api/security/google → 404", (await page.request.get(`${BASE}/api/security/google`)).status() === 404);
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
  console.log(`\n[oauth-identity-browser-m3-${MODE}] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
