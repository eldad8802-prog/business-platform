/**
 * Precise staleness measurement. Avoids the word "מומש", which is ALWAYS on the
 * card as a field label ("מומש · טרם"). Uses the status pill and the action
 * button, which are unambiguous.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const P = "SmokeTest!2026";

const b = await chromium.launch();
async function tok(page, email) {
  const r = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: P } });
  if (!r.ok()) { console.error("login failed", r.status()); process.exit(2); }
  const t = (await r.json()).token;
  await page.goto(`${BASE}/login`); await page.evaluate((x) => localStorage.setItem("token", x), t);
  return t;
}
const oCtx = await b.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
const owner = await oCtx.newPage();
const oT = await tok(owner, "qa-coupon-smoke-issuer@dubiz.test");
const cCtx = await b.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
const cust = await cCtx.newPage();
const cT = await tok(cust, "qa-coupon-smoke-redeemer@dubiz.test");

const pub = await owner.request.post(`${BASE}/api/revenue/coupons`, {
  headers: { Authorization: `Bearer ${oT}`, "Content-Type": "application/json" },
  data: { benefitType: "pct", value: "57", scope: "מאפה", validUntilDate: new Date(Date.now() + 6e8).toISOString().slice(0, 10) },
});
const coupon = (await pub.json()).coupon;

// Precise probes: the status pill text and whether a stop button exists.
const state = async () => ({
  pillActive: await owner.locator("text=/^פעיל$/").first().isVisible().catch(() => false),
  pillRedeemed: await owner.locator("text=/^מומש$/").first().isVisible().catch(() => false),
  hasStop: await owner.locator("button", { hasText: /^השבת קופון$/ }).first().isVisible().catch(() => false),
  inFinished: await owner.locator("text=/^הסתיים$/").first().isVisible().catch(() => false),
});

await owner.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
await owner.waitForTimeout(2500);
console.log("BEFORE redemption:      ", JSON.stringify(await state()));

const red = await cust.request.post(`${BASE}/api/coupons/${coupon.token}/redeem`, { headers: { Authorization: `Bearer ${cT}` } });
console.log(`customer redeemed elsewhere: HTTP ${red.status()}`);

await owner.waitForTimeout(7000);
const sitting = await state();
console.log("A) owner SITTING, 7s later:", JSON.stringify(sitting));
console.log(`   → live-updates without interaction? ${sitting.pillRedeemed && !sitting.hasStop ? "YES" : "NO — screen is STALE"}`);

if (sitting.hasStop) {
  await owner.locator("button", { hasText: /^השבת קופון$/ }).first().click();
  await owner.waitForTimeout(7000);
  const afterClick = await state();
  const body = await owner.locator("body").innerText();
  const msg = (body.match(/.*(כבר מומש|לא ניתן להשבית|רענן).*/) || ["(none)"])[0].trim();
  console.log(`   clicking the stale stop button → message: "${msg.slice(0, 80)}"`);
  console.log(`   state AFTER the rejected click:`, JSON.stringify(afterClick));
  console.log(`   → does the card self-correct once the server tells it the truth? ${afterClick.pillRedeemed && !afterClick.hasStop ? "YES" : "NO — still shows פעיל + השבת"}`);
}

await owner.goto(`${BASE}/revenue?view=browse`, { waitUntil: "networkidle" });
await owner.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
await owner.waitForTimeout(2500);
const nav = await state();
console.log("B) after navigate away+back:", JSON.stringify(nav), `→ truthful? ${nav.pillRedeemed && !nav.hasStop ? "YES" : "NO"}`);

await owner.reload({ waitUntil: "networkidle" });
await owner.waitForTimeout(2500);
const rel = await state();
console.log("C) after hard reload:      ", JSON.stringify(rel), `→ truthful? ${rel.pillRedeemed && !rel.hasStop ? "YES" : "NO"}`);

await b.close();
