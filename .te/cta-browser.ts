/**
 * The WELCOME CTA, end to end in a real browser (Chromium via Playwright) against a running build.
 *
 *   BASE=http://localhost:3550 OWNER_URL=… AUTH_URL=… npx tsx .te/cta-browser.ts
 *
 * The server must run with the auth plane active against the same lab database (AUTH_PLANE_ENABLED=true,
 * AUTH_DATABASE_URL=AUTH_URL). The CTA is APP_BASE_URL + WELCOME_CTA_PATH; here BASE stands in for it.
 *
 *   A  not signed in          → CTA → /login → sign in → /app (Home)
 *   B  signed in               → CTA → /app directly, /login never shown
 *   C  signed in, token spent  → CTA → /app (refreshed from the cookie), /login never shown
 *   D  contrast: the same state as C, but /login as the target → the login FORM is shown to a signed-in
 *      owner — which is why the CTA is not /login.
 * Synthetic data only.
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3550";
const OWNER_URL = process.env.OWNER_URL!;
const AUTH_URL = process.env.AUTH_URL!;
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = AUTH_URL;
process.env.DATABASE_URL = OWNER_URL;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every main-frame URL path the page visits, in order. */
function trackPaths(page: Page): string[] {
  const seen: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) seen.push(new URL(f.url()).pathname);
  });
  return seen;
}

async function settle(page: Page, ms = 2500) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function main() {
  const { WELCOME_CTA_PATH } = await import("../lib/email/transactional/templates/welcome");
  const CTA = `${BASE}${WELCOME_CTA_PATH}`;
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const bcrypt = (await import("bcrypt")).default;
  const { createAccount } = await import("../lib/auth/signup");

  const email = `cta-${Date.now().toString(36)}@battery.test`;
  const password = "cta-browser-synthetic-pw-1";
  const acct = await createAccount({ email, passwordHash: await bcrypt.hash(password, 4), name: "דנה", businessName: "CTA lab", now: new Date() });
  // A finished onboarding, so Home is the destination (a new account is sent on to /setup by Home itself).
  await owner.businessProfile.upsert({
    where: { businessId: acct.businessId },
    create: { businessId: acct.businessId, onboardingCompletedAt: new Date() },
    update: { onboardingCompletedAt: new Date() },
  });
  console.log(`CTA = ${CTA}`);
  ok("the CTA target is /app", WELCOME_CTA_PATH === "/app");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: "he-IL" });
  const page = await ctx.newPage();

  // A — not signed in.
  const a = trackPaths(page);
  await page.goto(CTA);
  await page.waitForURL(/\/login$/, { timeout: 20_000 }).catch(() => undefined);
  ok("A · not signed in: the CTA lands on /login", new URL(page.url()).pathname === "/login", page.url());
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/app$/, { timeout: 30_000 }).catch(() => undefined);
  await settle(page);
  ok("A · …and after signing in, the owner is in Dubiz (/app)", new URL(page.url()).pathname === "/app", `${page.url()} via ${a.join(" → ")}`);

  // B — signed in, live token.
  const b = trackPaths(page);
  await page.goto(CTA);
  await settle(page);
  ok("B · signed in: the CTA opens Home directly", new URL(page.url()).pathname === "/app", page.url());
  ok("B · …without ever showing /login", !b.includes("/login"), b.join(" → "));

  // C — signed in, access token spent (the refresh cookie is still valid).
  const live = await page.evaluate(() => localStorage.getItem("token"));
  const spend = (t: string) => {
    const [h, p, s] = t.split(".");
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    payload.exp = Math.floor(Date.now() / 1000) - 3600;
    return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
  };
  ok("fixture: a live access token was issued", typeof live === "string" && live.split(".").length === 3);
  const spent = spend(live!);
  await page.evaluate((t) => localStorage.setItem("token", t), spent);
  const c = trackPaths(page);
  await page.goto(CTA);
  await settle(page, 3500);
  const after = await page.evaluate(() => localStorage.getItem("token"));
  ok("C · token spent: the CTA still opens Home", new URL(page.url()).pathname === "/app", page.url());
  ok("C · …without ever showing /login", !c.includes("/login"), c.join(" → "));
  ok("C · …because the shell refreshed the token from the cookie", typeof after === "string" && after !== spent && after !== live);

  // D — contrast: the same spent state, with /login as the target.
  await page.evaluate((t) => localStorage.setItem("token", t), spend(after!));
  await page.goto(`${BASE}/login`);
  await settle(page, 3500);
  const formShown = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  ok("D · contrast: /login as the target shows the LOGIN FORM to a signed-in owner (why the CTA is /app)",
    new URL(page.url()).pathname === "/login" && formShown, page.url());

  await browser.close();
  await owner.$disconnect();
  console.log(`\n[cta browser] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
