/**
 * Closed-beta signup, end to end in a real browser (Chromium) against a running build whose
 * environment has PUBLIC_SIGNUP_ENABLED off and SIGNUP_ALLOWED_EMAILS = LISTED.
 *
 *   BASE=http://localhost:3551 LISTED=… OWNER_URL=… MODE=list|nolist npx tsx .te/beta-browser.ts
 *
 * MODE=list    1 the public /register is the closed notice (no form);
 *              2 /register?access=beta shows the form;
 *              3 an unlisted address submitted there gets the closed message, and nothing is written;
 *              4 the listed address signs up through the real UI → /setup → /app, with its WELCOME row;
 * MODE=nolist  5 the same entry with no list is the closed notice again (rollback = today).
 * Synthetic data only.
 */
import { chromium, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3551";
const MODE = process.env.MODE ?? "list";
const LISTED = process.env.LISTED ?? "";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

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
const hasForm = (page: Page) => page.locator('input[type="password"]').first().isVisible().catch(() => false);
const closedNotice = (page: Page) => page.getByText("ההרשמה סגורה כרגע").first().isVisible().catch(() => false);

async function fill(page: Page, email: string) {
  const inputs = page.locator("form input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const type = (await el.getAttribute("type")) ?? "text";
    const name = `${(await el.getAttribute("name")) ?? ""} ${(await el.getAttribute("autocomplete")) ?? ""} ${(await el.getAttribute("placeholder")) ?? ""}`.toLowerCase();
    if (type === "checkbox") await el.check();
    else if (type === "email" || /email|מייל/.test(name)) await el.fill(email);
    else if (type === "password") await el.fill("beta-browser-pw-1");
    else if (/business|organization|עסק/.test(name)) await el.fill("בדיקת בטא");
    else await el.fill("דנה בטא");
  }
  await page.locator('form button[type="submit"]').first().click();
}

async function main() {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: "he-IL" })).newPage();

  if (MODE === "nolist") {
    await page.goto(`${BASE}/register?access=beta`);
    await page.waitForLoadState("networkidle");
    ok("5 · no list: /register?access=beta is the closed notice again (no form)", (await closedNotice(page)) && !(await hasForm(page)));
    await page.goto(`${BASE}/register`);
    await page.waitForLoadState("networkidle");
    ok("5 · no list: /register is the closed notice (today)", (await closedNotice(page)) && !(await hasForm(page)));
  } else {
    await page.goto(`${BASE}/register`);
    await page.waitForLoadState("networkidle");
    ok("1 · the public /register stays the closed notice — no form", (await closedNotice(page)) && !(await hasForm(page)));

    await page.goto(`${BASE}/register?access=beta`);
    await page.waitForLoadState("networkidle");
    ok("2 · /register?access=beta shows the registration form", await hasForm(page));

    const outsider = `outsider-${Date.now().toString(36)}@battery.test`;
    await fill(page, outsider);
    await page.waitForTimeout(2500);
    ok("3 · an unlisted address gets the closed message on the form", (await page.getByText("ההרשמה למערכת סגורה זמנית").first().isVisible().catch(() => false)));
    ok("3 · …stays on /register, and nothing was written", new URL(page.url()).pathname === "/register" &&
      (await owner.user.count({ where: { email: outsider } })) === 0);

    await page.goto(`${BASE}/register?access=beta`);
    await page.waitForLoadState("networkidle");
    await fill(page, LISTED);
    await page.waitForURL(/\/setup$/, { timeout: 30_000 }).catch(() => undefined);
    ok("4 · the listed address signs up through the real UI → /setup", new URL(page.url()).pathname === "/setup", page.url());
    const user = await owner.user.findUnique({ where: { email: LISTED }, select: { id: true, businessId: true } });
    const rows = user ? await owner.transactionalEmail.findMany({ where: { userId: user.id } }) : [];
    ok("4 · Business + User created, one WELCOME row PENDING (flag OFF: not sent)",
      user !== null && rows.length === 1 && rows[0].kind === "WELCOME" && rows[0].status === "PENDING" && rows[0].attempts === 0);
    await page.goto(`${BASE}/app`);
    await page.waitForTimeout(3000);
    ok("4 · the new owner is inside Dubiz (/app, or Home's own hand-off to /setup)", ["/app", "/setup"].includes(new URL(page.url()).pathname), page.url());
  }

  await browser.close();
  await owner.$disconnect();
  console.log(`\n[beta browser ${MODE}] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
