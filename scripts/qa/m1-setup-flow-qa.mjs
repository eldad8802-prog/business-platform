/**
 * M1 setup flow — browser QA on phone, tablet and desktop.
 *
 *   npx next dev -p 3531   (PUBLIC_SIGNUP_ENABLED=true, a lab database)
 *   node scripts/qa/m1-setup-flow-qa.mjs
 *
 * Drives the real pages: signup (with consent) → /setup step 1 → step 2 →
 * Home with "ההתחלה שלך". Proves Back walks the steps and keeps answers,
 * Back from Home never re-enters a finished setup, a skipped setup gets a
 * sensible default, and a half-finished setup resumes after signing in again
 * in a fresh browser. Screenshots land in qa-evidence/m1-setup/.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3531";
const OUT = "qa-evidence/m1-setup";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "tablet", width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false },
];
const PASSWORD = "qa-synthetic-password";
// One synthetic client address per browser: the 3-per-hour signup limit is real
// and stays on; each "device" simply is a different visitor.
let ipSeq = Math.floor(Math.random() * 200);
const nextIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function signUp(page, email, business) {
  await page.goto(`${BASE}/register?utm_source=qa&utm_campaign=m1`, { waitUntil: "networkidle" });
  await page.fill("#reg-name", "בודקת איכות");
  await page.fill("#reg-business", business);
  await page.fill("#reg-email", email);
  await page.fill("#reg-password", PASSWORD);
  await page.check("#reg-terms");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/setup/, { timeout: 60_000 });
  await page.waitForSelector("#setup-business-title", { timeout: 60_000 });
}

async function checkedText(page, group) {
  return page.$$eval(`[aria-labelledby="${group}"] [role="radio"][aria-checked="true"]`, (els) =>
    els.map((e) => e.textContent?.trim())
  );
}

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  console.log(`\n== ${vp.name} (${vp.width}x${vp.height})`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: "he-IL", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const page = await ctx.newPage();
  const stamp = `${vp.name}-${Date.now()}`;

  // 1. Signup with consent lands on setup step 1.
  await signUp(page, `qa-${stamp}@lab.invalid`, "סטודיו לבדיקות");
  ok(`${vp.name}: signup lands on /setup`, new URL(page.url()).pathname === "/setup");
  ok(`${vp.name}: progress shows step 1 of 2`, (await page.textContent("main, body"))?.includes("שלב 1 מתוך 2") ?? false);
  await page.screenshot({ path: `${OUT}/${vp.name}-1-business-empty.png`, fullPage: true });

  // 2. Answer step 1.
  await page.getByRole("radio", { name: "יופי וטיפוח" }).click();
  await page.getByRole("radio", { name: "ציפורניים" }).click();
  ok(`${vp.name}: the model is pre-selected from the category`, (await checkedText(page, "setup-model")).includes("שירותים"));
  await page.screenshot({ path: `${OUT}/${vp.name}-2-business-answered.png`, fullPage: true });
  if (vp.name === "desktop") {
    ok("desktop: the live preview column is visible", await page.getByLabel("כך Dubiz יראה אצלך").isVisible());
  } else {
    ok(`${vp.name}: no desktop preview column`, !(await page.getByLabel("כך Dubiz יראה אצלך").isVisible()));
  }
  await page.getByRole("button", { name: "המשך" }).click();
  await page.waitForSelector("#setup-start-title");
  ok(`${vp.name}: step 2 is its own history entry`, new URL(page.url()).searchParams.get("step") === "start");

  // 3. Back walks to step 1 with the answers kept; forward again.
  await page.goBack();
  await page.waitForSelector("#setup-business-title");
  ok(`${vp.name}: Back returns to step 1`, new URL(page.url()).searchParams.get("step") === null);
  ok(`${vp.name}: ...with the category kept`, (await checkedText(page, "setup-category")).includes("יופי וטיפוח"));
  ok(`${vp.name}: ...and the sub-category kept`, (await checkedText(page, "setup-sub")).includes("ציפורניים"));
  await page.getByRole("button", { name: "המשך" }).click();
  await page.waitForSelector("#setup-start-title");

  // 4. Choose a goal and finish.
  await page.getByRole("radio", { name: /להוציא מסמכים ולגבות/ }).click();
  await page.screenshot({ path: `${OUT}/${vp.name}-3-start-chosen.png`, fullPage: true });
  await page.getByRole("button", { name: "לבית שלי" }).click();
  await page.waitForURL(/\/app$/, { timeout: 60_000 });
  await page.waitForSelector("#home-setup-title", { timeout: 60_000 });
  const cardText = (await page.textContent('section[aria-labelledby="home-setup-title"]')) ?? "";
  ok(`${vp.name}: Home shows "ההתחלה שלך"`, cardText.includes("ההתחלה שלך"));
  ok(`${vp.name}: ...with the BILLING first action`, cardText.includes("צרו הצעת מחיר ראשונה"));
  ok(`${vp.name}: ...linking to the quote flow`, (await page.getAttribute('section[aria-labelledby="home-setup-title"] a[href^="/billing"]', "href")) === "/billing?create=QUOTE");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${vp.name}-4-home-card.png`, fullPage: false });

  // 5. Back from Home never re-enters the finished setup.
  await page.goBack().catch(() => null);
  await page.waitForTimeout(800);
  ok(`${vp.name}: Back from Home does not reopen setup`, !page.url().includes("/setup"), page.url());
  await ctx.close();
}

// 6. Skip everything → a sensible default, not an empty Home.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: "he-IL", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const page = await ctx.newPage();
  await signUp(page, `qa-skip-${Date.now()}@lab.invalid`, "עסק שדילג");
  await page.getByRole("button", { name: "אמלא אחר כך" }).click();
  await page.waitForSelector("#setup-start-title");
  await page.getByRole("button", { name: "דלג" }).click();
  await page.waitForURL(/\/app$/, { timeout: 60_000 });
  await page.waitForSelector("#home-setup-title", { timeout: 60_000 });
  const text = (await page.textContent('section[aria-labelledby="home-setup-title"]')) ?? "";
  ok("skip: Home shows the default first action (LEADS)", text.includes("חברו את הוואטסאפ של העסק"));
  ok("skip: the unanswered business question is offered again", text.includes("ספרו לנו מה העסק עושה"));
  await page.screenshot({ path: `${OUT}/phone-5-home-after-skip.png` });
  await ctx.close();
}

// 7. Resume on another device: answer step 1, leave, sign in fresh → back in setup with it kept.
{
  const email = `qa-resume-${Date.now()}@lab.invalid`;
  const a = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const pa = await a.newPage();
  await signUp(pa, email, "עסק שחוזר");
  await pa.getByRole("radio", { name: "שירותי בית" }).click();
  await pa.getByRole("radio", { name: "חשמל" }).click();
  await pa.getByRole("button", { name: "המשך" }).click();
  await pa.waitForSelector("#setup-start-title");
  await a.close();

  const b = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: "he-IL", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": nextIp() } });
  const pb = await b.newPage();
  await pb.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await pb.fill("#login-email", email);
  await pb.fill("#login-password", PASSWORD);
  await pb.click('button[type="submit"]');
  await pb.waitForURL(/\/setup/, { timeout: 90_000 });
  await pb.waitForSelector("#setup-business-title");
  ok("resume: a new device lands back in setup", new URL(pb.url()).pathname === "/setup");
  await pb.waitForTimeout(1000);
  ok("resume: ...with the saved category", (await checkedText(pb, "setup-category")).includes("שירותי בית"));
  ok("resume: ...and sub-category", (await checkedText(pb, "setup-sub")).includes("חשמל"));
  await pb.screenshot({ path: `${OUT}/phone-6-resume-other-device.png`, fullPage: true });
  await b.close();
}

await browser.close();
console.log(`\n[m1-setup-flow-qa] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
