/**
 * F-2 regression: the network-failure branch must NOT trigger a re-read.
 *
 * The fix re-reads the list when the SERVER refuses (proof of staleness). If it
 * also re-read on a network failure, the reload would fail too and blank the
 * whole screen — replacing a precise per-coupon message with an empty list.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:3000";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
const p = await ctx.newPage();

const login = await p.request.post(`${BASE}/api/auth/login`, { data: { email: "qa-coupon-smoke-issuer@dubiz.test", password: "SmokeTest!2026" } });
if (!login.ok()) { console.error("LOGIN FAILED", login.status()); process.exit(2); }
const tok = (await login.json()).token;
await p.goto(`${BASE}/login`);
await p.evaluate((t) => localStorage.setItem("token", t), tok);

await p.request.post(`${BASE}/api/revenue/coupons`, {
  headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
  data: { benefitType: "pct", value: "66", scope: "כל העסק", validUntilDate: new Date(Date.now() + 6e8).toISOString().slice(0, 10) },
});

await p.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
console.log("before:", JSON.stringify({
  cardVisible: await p.locator("text=66% הנחה על כל העסק").first().isVisible().catch(() => false),
  hasStop: await p.locator("button", { hasText: /^השבת קופון$/ }).first().isVisible().catch(() => false),
}));

// Kill ONLY the disable call — the list endpoint stays healthy so we can prove
// the screen was not reloaded rather than that the reload merely succeeded.
let mineCallsAfter = 0;
await p.route("**/api/revenue/coupons/*/disable", (r) => r.abort("failed"));
p.on("response", (r) => { if (r.url().endsWith("/coupons/mine")) mineCallsAfter += 1; });

await p.locator("button", { hasText: /^השבת קופון$/ }).first().click();
await p.waitForTimeout(6000);

const body = await p.locator("body").innerText();
console.log("after network failure:", JSON.stringify({
  cardStillVisible: await p.locator("text=66% הנחה על כל העסק").first().isVisible().catch(() => false),
  listBlanked: body.includes("עדיין לא יצרת קופון") || body.includes("לא הצלחנו לטעון"),
  messageShown: /אין חיבור לשרת/.test(body),
  refetchTriggered: mineCallsAfter > 0,
}));
console.log(`\n→ list preserved on network failure? ${!body.includes("לא הצלחנו לטעון") && !body.includes("עדיין לא יצרת קופון") ? "YES" : "NO"}`);
console.log(`→ no pointless refetch? ${mineCallsAfter === 0 ? "YES" : `NO (${mineCallsAfter} calls)`}`);

await b.close();
