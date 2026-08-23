/**
 * FULL BUSINESS JOURNEY — firsthand browser E2E, run as QA (not as author).
 *
 * One continuous story in a real browser, in order:
 *   Publish → Management → Disable → Enable → Redemption → Return to owner
 *   → cross-screen consistency → double-redemption failure injection
 *
 * Console, page errors and every non-2xx response are captured for the WHOLE
 * journey and reported at the end, per surface.
 *
 *   TEST_DATABASE_URL=… node scripts/qa/coupons/business-journey.mjs
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

execFileSync("npx", ["tsx", "scripts/qa/coupons/coupon-smoke-seed.ts"], { stdio: "inherit", shell: true });

const BASE = "http://localhost:3000";
const OWNER = "qa-coupon-smoke-issuer@dubiz.test";
const CUSTOMER = "qa-coupon-smoke-redeemer@dubiz.test";
const PASSWORD = "SmokeTest!2026";
const LONG = 60_000;

const results = [];
const consoleMsgs = [];
const netFails = [];
const requestLog = [];

function step(phase, name, pass, detail = "") {
  results.push({ phase, name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${phase}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ who, type: m.type(), text: m.text() });
  });
  page.on("pageerror", (e) => consoleMsgs.push({ who, type: "pageerror", text: e.message.split("\n")[0] }));
  page.on("requestfailed", (r) => netFails.push({ who, kind: "requestfailed", url: r.url(), err: r.failure()?.errorText }));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/")) requestLog.push({ who, status: r.status(), method: r.request().method(), url: u.replace(BASE, "") });
    if (r.status() >= 400) netFails.push({ who, kind: "http", status: r.status(), method: r.request().method(), url: u.replace(BASE, "") });
  });
}

async function login(page, email) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: PASSWORD } });
  if (!res.ok()) throw new Error(`login ${email}: ${res.status()}`);
  const token = (await res.json()).token;
  await page.goto(`${BASE}/login`);
  await page.evaluate((t) => localStorage.setItem("token", t), token);
  return token;
}

const txt = async (page) => (await page.locator("body").innerText());
function isoDate(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

const browser = await chromium.launch();
const ownerCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL", permissions: ["clipboard-read", "clipboard-write"] });
const owner = await ownerCtx.newPage();
watch(owner, "owner");
const ownerToken = await login(owner, OWNER);

const custCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
const customer = await custCtx.newPage();
watch(customer, "customer");
const custToken = await login(customer, CUSTOMER);

/* ═══════════════════ PHASE 1 — PUBLISH ═══════════════════ */
// Values chosen so they are distinctive and easy to trace end-to-end.
const INPUT = { pct: "35", scope: "קפה הפוך", days: 21, minPurchase: "80" };
const EXPECTED_BENEFIT = `${INPUT.pct}% הנחה על ${INPUT.scope}`;
const EXPECTED_END = isoDate(INPUT.days);

await owner.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
step("1 Publish", "owner lands on 'הקופונים שלי'", (await txt(owner)).includes("הקופונים שלי"));

await owner.locator("text=צור קופון חדש").first().click();
await owner.waitForURL(/view=create/, { timeout: LONG });
await owner.locator("text=לקדם מוצר או שירות שלא נמכר מספיק").first().click();
await owner.locator("text=הנחה").first().click();

// benefit value
const valueBox = owner.locator('input[inputmode="decimal"]').first();
await valueBox.fill(INPUT.pct);
await valueBox.blur();
// scope: typed product name
await owner.locator("text=מוצר או שירות מסוים").first().click();
const scopeBox = owner.locator("input").filter({ hasNot: owner.locator('[inputmode="decimal"]') }).nth(1);
await owner.locator('input[placeholder*="קפה הפוך"]').first().fill(INPUT.scope);
await owner.waitForTimeout(300);

const previewBeforeNext = await txt(owner);
step("1 Publish", "live preview shows the composed sentence", previewBeforeNext.includes(EXPECTED_BENEFIT), EXPECTED_BENEFIT);

// F-1: the identity strip must never be a silent blank. At any instant it is
// either a skeleton (still loading), the real name, or an explicit error with a
// retry — and never a fabricated name.
const skeletonUp = await owner.locator('[aria-label="טוען את פרטי העסק"]').first().isVisible().catch(() => false);
const nameUp = previewBeforeNext.includes("מאפיית הבוקר");
const errUp = previewBeforeNext.includes("לא הצלחנו לטעון את פרטי העסק");
step("1 Publish", "identity strip is never a silent blank", skeletonUp || nameUp || errUp,
  skeletonUp ? "skeleton" : nameUp ? "real name" : "explicit error");
step("1 Publish", "no fabricated business identity at any point", !previewBeforeNext.includes("העסק שלך") && !previewBeforeNext.includes("הכתובת שלך"));

// ...and it must actually resolve to the real name.
let nameArrived = nameUp;
for (let i = 0; i < 40 && !nameArrived; i += 1) {
  await owner.waitForTimeout(500);
  nameArrived = (await txt(owner)).includes("מאפיית הבוקר");
}
step("1 Publish", "live preview resolves to the REAL business name", nameArrived);
step("1 Publish", "skeleton is gone once the name is in",
  !(await owner.locator('[aria-label="טוען את פרטי העסק"]').first().isVisible().catch(() => false)));

await owner.locator("button", { hasText: /^המשך$/ }).first().click();

// terms: explicit end date + a minimum-purchase term
await owner.locator('input[type="date"]').first().fill(EXPECTED_END);
await owner.locator("text=מינימום רכישה").first().click();
await owner.locator('input[inputmode="decimal"]').first().fill(INPUT.minPurchase);
await owner.waitForTimeout(300);

await owner.locator("text=צור את הקופון").first().click();
const published = await owner.locator("text=הקופון שלך פורסם").first().waitFor({ timeout: LONG }).then(() => true).catch(() => false);
step("1 Publish", "real success screen shown", published);

const successText = await txt(owner);
step("1 Publish", "success screen shows what was actually saved", successText.includes(EXPECTED_BENEFIT), EXPECTED_BENEFIT);
step("1 Publish", "success screen carries no placeholder identity", !successText.includes("העסק שלך") && !successText.includes("הכתובת שלך"));

// server truth
const mine1 = await (await owner.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
step("1 Publish", "exactly one coupon persisted", mine1.coupons.length === 1, `${mine1.coupons.length}`);
const C = mine1.coupons[0];
step("1 Publish", "stored benefit == entered values", C.benefit === EXPECTED_BENEFIT, C.benefit);
step("1 Publish", "stored terms == entered minimum purchase", (C.description || "").includes(`מעל ${INPUT.minPurchase}₪`), C.description || "(none)");
step("1 Publish", "stored end date == picked date", C.expiresAt.slice(0, 10) === EXPECTED_END, `${C.expiresAt.slice(0, 10)} vs ${EXPECTED_END}`);
step("1 Publish", "state is ACTIVE", C.state === "ACTIVE", C.state);
step("1 Publish", "not yet redeemed", C.redemptionCount === 0 && C.redeemedAt === null);

const codeRes = await owner.request.get(`${BASE}/api/revenue/coupons/${C.publicId}/code`, { headers: { Authorization: `Bearer ${ownerToken}` } });
const CODE = await codeRes.json();
step("1 Publish", "QR + token are real", Boolean(CODE.token && CODE.qrValue), CODE.qrValue);
step("1 Publish", "QR points at the redeem route with this token", CODE.qrValue.includes("/revenue/redeem?token=") && CODE.qrValue.includes(CODE.token));

// orphan check via the owner's own data
const offersRes = await (await owner.request.get(`${BASE}/api/offers`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
const offerIds = offersRes.offers.map((o) => o.id);
const couponOfferIds = mine1.coupons.map((c) => c.offerId);
const orphans = offerIds.filter((id) => !couponOfferIds.includes(id));
step("1 Publish", "no orphan offers for this business", orphans.length === 0, `orphans: ${JSON.stringify(orphans)}`);

/* ═══════════════════ PHASE 2 — MANAGEMENT ═══════════════════ */
await owner.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
await owner.waitForTimeout(1500);
const m = await txt(owner);
step("2 Management", "coupon appears in 'הקופונים שלי'", m.includes(EXPECTED_BENEFIT));
step("2 Management", "status reads 'פעיל'", m.includes("פעיל"));
step("2 Management", "publish date shown", m.includes("פורסם"));
step("2 Management", "expiry shown", m.includes("בתוקף עד"));
step("2 Management", "usage shown as not-yet-redeemed", m.includes("טרם"));
step("2 Management", "terms visible to the owner", m.includes(`מעל ${INPUT.minPurchase}₪`));
step("2 Management", "no placeholder text anywhere", !m.includes("העסק שלך") && !m.includes("הכתובת שלך") && !m.includes("8F2K"));
step("2 Management", "a stop action is offered", m.includes("השבת קופון"));

/* ═══════════════════ PHASE 3 — DISABLE ═══════════════════ */
await owner.locator("text=השבת קופון").first().click();
await owner.locator("text=הפעל מחדש").first().waitFor({ timeout: LONG });
const d = await txt(owner);
step("3 Disable", "status flips to 'מושבת' in the UI", d.includes("מושבת"));
step("3 Disable", "resume action offered", d.includes("הפעל מחדש"));

const mineD = await (await owner.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
step("3 Disable", "server persisted DISABLED", mineD.coupons[0].state === "DISABLED", mineD.coupons[0].state);

const activeD = await (await customer.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
step("3 Disable", "gone from the marketplace", !activeD.coupons.some((c) => c.publicId === C.publicId));

const redeemBlocked = await customer.request.post(`${BASE}/api/coupons/${CODE.token}/redeem`, { headers: { Authorization: `Bearer ${custToken}` } });
step("3 Disable", "cannot be redeemed while disabled", redeemBlocked.status() >= 400, `status ${redeemBlocked.status()}`);

// sibling check: every coupon under the offer must be stopped
const allForOffer = mineD.coupons.filter((c) => c.offerId === C.offerId);
step("3 Disable", "no sibling coupon left active", allForOffer.every((c) => c.state === "DISABLED"), `${allForOffer.length} coupon(s) on the offer`);

/* ═══════════════════ PHASE 4 — ENABLE ═══════════════════ */
await owner.locator("text=הפעל מחדש").first().click();
await owner.locator("text=השבת קופון").first().waitFor({ timeout: LONG });
const e = await txt(owner);
step("4 Enable", "status returns to 'פעיל'", e.includes("פעיל") && !e.includes("מושבת"));
const mineE = await (await owner.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
step("4 Enable", "server persisted ACTIVE", mineE.coupons[0].state === "ACTIVE", mineE.coupons[0].state);
const activeE = await (await customer.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
step("4 Enable", "back in the marketplace", activeE.coupons.some((c) => c.publicId === C.publicId));
step("4 Enable", "no side effect on usage counters", mineE.coupons[0].redemptionCount === 0 && mineE.coupons[0].redeemedAt === null);
step("4 Enable", "no side effect on the end date", mineE.coupons[0].expiresAt.slice(0, 10) === EXPECTED_END);
step("4 Enable", "token unchanged after stop/resume", (await (await owner.request.get(`${BASE}/api/revenue/coupons/${C.publicId}/code`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()).token === CODE.token);

/* ═══════════════════ PHASE 5 — REDEMPTION ═══════════════════ */
// The customer business scans the QR — navigate to the QR's own URL.
const scanUrl = CODE.qrValue.replace(/^https?:\/\/[^/]+/, BASE);
await customer.goto(scanUrl, { waitUntil: "networkidle" });
await customer.locator("text=/מומש|אושר|הצלח|שגיא|לא ניתן/").first().waitFor({ timeout: LONG }).catch(() => {});
await customer.waitForTimeout(1500);
const r = await txt(customer);
step("5 Redemption", "scanning the QR redeems successfully", /אושר|מומש בהצלחה|המימוש/.test(r), r.split("\n").slice(0, 2).join(" | "));
step("5 Redemption", "redemption screen shows the right benefit", r.includes(EXPECTED_BENEFIT));
step("5 Redemption", "redemption time is shown", /מועד מימוש/.test(r));

/* ═══════════════════ PHASE 6 — RETURN TO OWNER ═══════════════════ */
// Deliberately NAVIGATE (not hard-reload) — this is what an owner actually does.
await owner.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
await owner.waitForTimeout(1800);
const o = await txt(owner);
step("6 Owner", "owner sees the coupon as redeemed WITHOUT a forced refresh", o.includes("מומש"));
step("6 Owner", "it is no longer shown as active/stoppable", !o.includes("השבת קופון"));
step("6 Owner", "it moved to the finished section", o.includes("הסתיים"));

const mineR = await (await owner.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
const CR = mineR.coupons[0];
step("6 Owner", "state == REDEEMED", CR.state === "REDEEMED", CR.state);
step("6 Owner", "redemption count incremented", CR.redemptionCount === 1, `${CR.redemptionCount}`);
step("6 Owner", "redeemedAt recorded", Boolean(CR.redeemedAt), CR.redeemedAt || "(null)");
const redeemedDay = (CR.redeemedAt || "").slice(0, 10);
step("6 Owner", "redemption date is today", redeemedDay === isoDate(0), `${redeemedDay} vs ${isoDate(0)}`);
step("6 Owner", "the displayed date matches the stored one",
  o.includes(new Date(CR.redeemedAt).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" })),
  new Date(CR.redeemedAt).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }));

/* ═══════════ CROSS-SCREEN CONSISTENCY ═══════════ */
// 1) marketplace
const activeR = await (await customer.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
step("7 Consistency", "marketplace no longer lists a spent coupon", !activeR.coupons.some((c) => c.publicId === C.publicId));

// 2) public status API
const pub = await (await customer.request.get(`${BASE}/api/revenue/coupons/${C.publicId}`)).json();
step("7 Consistency", "public API reports REDEEMED", pub.coupon.status === "REDEEMED", pub.coupon.status);
step("7 Consistency", "public API redeemedAt matches owner view", pub.coupon.redeemedAt === CR.redeemedAt);

// 3) the coupon's own detail page, reached the way the owner reaches it
await owner.goto(`${BASE}/revenue/coupons/${C.publicId}`, { waitUntil: "networkidle" });
await owner.waitForTimeout(2000);
const detail = await txt(owner);
step("7 Consistency", "coupon detail page does NOT claim it is active", !/פעיל(?!ות)/.test(detail) || /מומש/.test(detail), detail.replace(/\n+/g, " | ").slice(0, 180));
step("7 Consistency", "coupon detail page reflects redeemed state", /מומש|נוצל|כבר/.test(detail), detail.replace(/\n+/g, " | ").slice(0, 180));

// 4) issuer can no longer pull a live code for a spent coupon
const codeAfter = await owner.request.get(`${BASE}/api/revenue/coupons/${C.publicId}/code`, { headers: { Authorization: `Bearer ${ownerToken}` } });
step("7 Consistency", "code endpoint refuses a spent coupon", codeAfter.status() >= 400, `status ${codeAfter.status()}`);

/* ═══════════ FAILURE INJECTION — DOUBLE REDEMPTION ═══════════ */
const second = await customer.request.post(`${BASE}/api/coupons/${CODE.token}/redeem`, { headers: { Authorization: `Bearer ${custToken}` } });
const secondBody = await second.json().catch(() => ({}));
step("8 DoubleRedeem", "server refuses a second redemption", second.status() >= 400, `status ${second.status()}`);
step("8 DoubleRedeem", "server message is specific, not generic", /מומש|redeem/i.test(secondBody.error || ""), secondBody.error || "(none)");

await customer.goto(scanUrl, { waitUntil: "networkidle" });
await customer.waitForTimeout(2500);
const r2 = await txt(customer);
step("8 DoubleRedeem", "UI shows a clear failure, not a success", !/אושר בהצלחה/.test(r2), r2.replace(/\n+/g, " | ").slice(0, 160));
step("8 DoubleRedeem", "UI explains WHY it failed", /כבר מומש|מומש/.test(r2), r2.replace(/\n+/g, " | ").slice(0, 160));
step("8 DoubleRedeem", "a way to recover is offered", /סרוק שוב|הזנה ידנית|נסה/.test(r2));

const mineFinal = await (await owner.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
step("8 DoubleRedeem", "data unchanged after the failed attempt",
  mineFinal.coupons[0].redemptionCount === 1 && mineFinal.coupons[0].redeemedAt === CR.redeemedAt);

await browser.close();

/* ═══════════ REPORT ═══════════ */
const failed = results.filter((r) => !r.pass);
console.log(`\n================ JOURNEY RESULT: ${results.length - failed.length}/${results.length} ================`);
if (failed.length) console.log("FAILED STEPS:\n" + failed.map((f) => ` ✗ [${f.phase}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`).join("\n"));

const SHELL_NOISE = /Hydration failed|hydrat|Encountered a script tag while rendering|Download the React DevTools/i;
const shell = consoleMsgs.filter((c) => SHELL_NOISE.test(c.text));
const real = consoleMsgs.filter((c) => !SHELL_NOISE.test(c.text));
console.log(`\nCONSOLE: ${real.length} coupon-related, ${shell.length} pre-existing app-shell`);
real.slice(0, 10).forEach((c) => console.log(`  [${c.who}] ${c.type}: ${c.text.slice(0, 160)}`));

const expected4xx = netFails.filter((n) => [400, 401, 403].includes(n.status));
const unexpected = netFails.filter((n) => !expected4xx.includes(n));
console.log(`\nNETWORK: ${unexpected.length} unexpected, ${expected4xx.length} expected 4xx (deliberate negative tests)`);
unexpected.slice(0, 10).forEach((n) => console.log(`  [${n.who}] ${n.kind} ${n.status || n.err} ${n.method || ""} ${n.url || ""}`));

const dupes = {};
requestLog.forEach((r) => { const k = `${r.method} ${r.url.split("?")[0]}`; dupes[k] = (dupes[k] || 0) + 1; });
const chatty = Object.entries(dupes).filter(([, n]) => n > 6).sort((a, b) => b[1] - a[1]);
console.log(`\nAPI CALLS: ${requestLog.length} total${chatty.length ? "; high-frequency: " + chatty.map(([k, n]) => `${k} ×${n}`).join(", ") : "; no retry storms"}`);

process.exit(failed.length ? 1 : 0);
