/**
 * "Continue with Google" — the PILOT in a real browser (Chromium, phone width 390×844): this build under
 * `next start` with AUTH_GOOGLE_LOGIN_ENABLED=true, NO mode (→ pilot) and AUTH_GOOGLE_LOGIN_PILOT_EMAILS naming
 * two lab addresses; Google is the local stand-in (.agl/mock-google.ts).
 *
 *   1  The button: hidden on /login and /register; shown only on ?google=pilot.
 *   2  An unlisted Google account → back on the page with the generic "unavailable" notice; no ticket, no account,
 *      no Google or session cookie in the browser.
 *   3  A listed existing account → the link screen → its password → signed in; Settings → Security shows the
 *      connection.
 *   4  A listed new person → the completion form (details + terms) → the account exists only after submit;
 *      verified at once; no verification email recorded.
 *
 * env: BASE, MOCK, OWNER_URL, SHOTS, LISTED_EXISTING, LISTED_NEW (the two listed addresses). Synthetic only.
 */
import fs from "node:fs";
import bcrypt from "bcrypt";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3613";
const MOCK = process.env.MOCK ?? "http://localhost:3902";
const SHOTS = process.env.SHOTS ?? "";
const LISTED_EXISTING = process.env.LISTED_EXISTING!;
const LISTED_NEW = process.env.LISTED_NEW!;
const PASSWORD = "Correct-Horse-Battery-9";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const stamp = Date.now();
const shot = async (page: import("playwright").Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const nextIs = (who: { sub: string; email: string; name: string }) =>
  fetch(`${MOCK}/__next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(who) });
const ticketsFor = async (sub: string) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "OAuthSignupTicket" WHERE "providerSubject" = $1`, sub)) as { c: number }[])[0].c);
let addressSeq = 40;
const phone = (browser: Browser): Promise<BrowserContext> =>
  browser.newContext({ locale: "he-IL", viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${++addressSeq}` } });
const googleCookies = async (ctx: BrowserContext) => (await ctx.cookies()).filter((c) => ["dz_google_signup", "dz_google_link", "dubiz_rt"].includes(c.name) && c.value);

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  try {
    // 1 — the button
    const ctx1 = await phone(browser);
    const p1 = await ctx1.newPage();
    for (const [path, shown] of [["/login", false], ["/register", false], ["/login?google=existing", false], ["/login?google=pilot", true], ["/register?google=pilot", true]] as const) {
      await p1.goto(`${BASE}${path}`);
      await p1.locator("form").first().waitFor({ state: "visible", timeout: 30_000 });
      ok(`1 ${path}: the Google button ${shown ? "shown" : "hidden"}`, ((await p1.getByTestId("google-button").count()) > 0) === shown);
    }
    await shot(p1, "pilot-phone-register-button");
    await ctx1.close();

    // 2 — an unlisted Google account
    const stranger = { sub: `pilot-stranger-${stamp}`, email: `agl-pilot-stranger-${stamp}@lab.invalid`, name: "זר" };
    const ctx2 = await phone(browser);
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/register?google=pilot`);
    await nextIs(stranger);
    await p2.getByTestId("google-button").click();
    await p2.waitForURL(/\/register\?google=unavailable$/, { timeout: 30_000 });
    await p2.getByTestId("google-notice").waitFor({ state: "visible", timeout: 30_000 });
    ok("2 an unlisted account → back on /register with the 'unavailable' notice", (await p2.getByTestId("google-notice").getAttribute("data-notice")) === "unavailable");
    ok("2 …no ticket row and no account", (await ticketsFor(stranger.sub)) === 0 && (await owner.user.count({ where: { email: stranger.email } })) === 0);
    ok("2 …no Google or session cookie in the browser", (await googleCookies(ctx2)).length === 0);
    ok("2 …and the button is hidden again (the notice page has no ?google=pilot)", (await p2.getByTestId("google-button").count()) === 0);
    await shot(p2, "pilot-phone-unavailable");
    await ctx2.close();

    // 3 — a listed existing account links with its password
    const biz = await owner.business.create({ data: { name: `pilot-existing-${stamp}` }, select: { id: true } });
    const existing = await owner.user.create({ data: { email: LISTED_EXISTING, password: await bcrypt.hash(PASSWORD, 10), name: "דנה כהן", businessId: biz.id }, select: { id: true } });
    const ctx3 = await phone(browser);
    const p3 = await ctx3.newPage();
    await p3.goto(`${BASE}/login?google=pilot`);
    await nextIs({ sub: `pilot-existing-${stamp}`, email: LISTED_EXISTING, name: "דנה כהן" });
    await p3.getByTestId("google-button").click();
    await p3.waitForURL(/\/link\/google$/, { timeout: 30_000 });
    await p3.getByTestId("google-link-screen").waitFor({ state: "visible" });
    await p3.locator("#link-password").fill(PASSWORD);
    await p3.locator("#link-password").press("Enter");
    await p3.waitForURL(/\/(app|setup)/, { timeout: 30_000 });
    ok("3 a listed existing account → link screen → password → signed in, one identity", (await owner.userIdentity.count({ where: { userId: existing.id } })) === 1);
    await p3.goto(`${BASE}/settings/security`);
    await p3.getByTestId("google-connection-state").waitFor({ state: "visible", timeout: 30_000 });
    ok("3 Settings → Security shows 'connected to Google' for the connected pilot account", (await p3.getByTestId("google-connection-state").innerText()).includes("מחובר ל־Google"));
    await shot(p3, "pilot-phone-settings");
    await ctx3.close();

    // 4 — a listed new person completes signup
    const fresh = { sub: `pilot-new-${stamp}`, email: LISTED_NEW, name: "נועה לוי" };
    const ctx4 = await phone(browser);
    const p4 = await ctx4.newPage();
    await p4.goto(`${BASE}/register?google=pilot`);
    await nextIs(fresh);
    await p4.getByTestId("google-button").click();
    await p4.waitForURL(/\/register\/google$/, { timeout: 30_000 });
    await p4.getByTestId("google-signup-form").waitFor({ state: "visible" });
    ok("4 a listed new person → the completion form; no account yet", (await owner.user.count({ where: { email: LISTED_NEW } })) === 0);
    await p4.locator("#g-business").fill(`עסק פיילוט ${stamp}`);
    await p4.locator("#g-terms").check();
    await shot(p4, "pilot-phone-form");
    await p4.getByTestId("google-signup-submit").click();
    await p4.waitForURL(/\/setup/, { timeout: 30_000 });
    const made = await owner.user.findUnique({ where: { email: LISTED_NEW }, select: { id: true, emailVerifiedAt: true } });
    ok("4 …after submit: one account, verified at once", !!made && !!made.emailVerifiedAt);
    ok("4 …no verification email recorded; one WELCOME", !!made
      && (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'EMAIL_VERIFY'`, made.id) as { c: number }[])[0].c === 0
      && (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "TransactionalEmail" WHERE "userId" = $1 AND kind = 'WELCOME'`, made.id) as { c: number }[])[0].c === 1);
    await ctx4.close();
  } finally {
    await browser.close();
  }
  console.log(`\n[oauth-identity-browser-pilot] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); });
