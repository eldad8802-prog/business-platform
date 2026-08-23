/**
 * Consumer-half honesty check.
 *
 * A non-issuer must NEVER be handed a coupon they cannot redeem. Previously
 * "קבל קופון" showed "הקופון מוכן 🎉" with a placeholder QR and the hardcoded
 * backup code "8F2K · 9QX4" to anyone, because /code is issuer-only and the
 * screen advanced regardless.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
execFileSync("npx", ["tsx", "scripts/qa/coupons/coupon-smoke-seed.ts"], { stdio: "inherit", shell: true });

const BASE = "http://localhost:3000";
const PASSWORD = "SmokeTest!2026";
const results = [];
const check = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "OK  " : "FAIL"}: ${n}${d ? ` — ${d}` : ""}`); };

function iso(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

const browser = await chromium.launch();

// Issuer publishes a coupon so the marketplace has something real in it.
const issuerCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
const issuer = await issuerCtx.newPage();
const iTok = (await (await issuer.request.post(`${BASE}/api/auth/login`, { data: { email: "qa-coupon-smoke-issuer@dubiz.test", password: PASSWORD } })).json()).token;
const pubRes = await issuer.request.post(`${BASE}/api/revenue/coupons`, {
  headers: { Authorization: `Bearer ${iTok}`, "Content-Type": "application/json" },
  data: { benefitType: "pct", value: "18", scope: "כל העסק", validUntilDate: iso(10) },
});
const coupon = (await pubRes.json()).coupon;
check("setup: coupon published", Boolean(coupon?.publicId));

// ── A DIFFERENT business browses the marketplace and tries to claim it ──────
const otherCtx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL", permissions: ["clipboard-read", "clipboard-write"] });
const other = await otherCtx.newPage();
const errs = [];
other.on("pageerror", (e) => errs.push(e.message.split("\n")[0]));
const oTok = (await (await other.request.post(`${BASE}/api/auth/login`, { data: { email: "qa-coupon-smoke-redeemer@dubiz.test", password: PASSWORD } })).json()).token;
await other.goto(`${BASE}/login`);
await other.evaluate((t) => localStorage.setItem("token", t), oTok);

await other.goto(`${BASE}/revenue?view=browse`, { waitUntil: "networkidle" });
await other.locator(`text=18% הנחה על כל העסק`).first().click();
await other.locator("text=קבל קופון").first().waitFor({ timeout: 15000 });
await other.waitForTimeout(1200);
await other.locator("text=קבל קופון").first().click();
await other.locator("text=לתצוגה בלבד, text=הקופון מוכן").first().waitFor({ timeout: 45000 }).catch(() => {});
await other.waitForTimeout(500);

const text = await other.locator("body").innerText();
check("consumer: NOT told the coupon is ready", !text.includes("הקופון מוכן"));
check("consumer: no fabricated backup code shown", !text.includes("8F2K"));
check("consumer: no 'קוד לגיבוי' section at all", !text.includes("קוד לגיבוי"));
check("consumer: not told to present it at the business", !text.includes("הצג אותו בבית העסק"));
check("consumer: given an honest explanation instead", text.includes("לתצוגה בלבד"), text.split("\n").find((l) => l.includes("לתצוגה")) || "");
check("consumer: no invented 'קופון אחד ללקוח' term", !text.includes("קופון אחד ללקוח"));

// The share/copy buttons used to be inert.
const copyBtn = other.locator("button", { hasText: /^העתק קישור$/ }).first();
await copyBtn.click().catch(() => {});
await other.waitForTimeout(600);
check("consumer: 'העתק קישור' actually does something", await other.locator("text=הועתק ✓").first().isVisible().catch(() => false));

// ── The ISSUER viewing their own coupon still gets a real one ───────────────
await issuer.goto(`${BASE}/login`);
await issuer.evaluate((t) => localStorage.setItem("token", t), iTok);
await issuer.goto(`${BASE}/revenue?view=browse`, { waitUntil: "networkidle" });
await issuer.locator(`text=18% הנחה על כל העסק`).first().click();
await issuer.waitForTimeout(1200);
await issuer.locator("text=קבל קופון").first().click();
await issuer.locator("text=הקופון מוכן, text=לתצוגה בלבד").first().waitFor({ timeout: 45000 }).catch(() => {});
await issuer.waitForTimeout(500);
const itext = await issuer.locator("body").innerText();
check("issuer: still gets the real personal coupon", itext.includes("הקופון מוכן"));
const hasCanvas = await issuer.locator("canvas").first().isVisible().catch(() => false);
check("issuer: a REAL rendered QR canvas is present", hasCanvas);
check("issuer: backup code derives from the real token", itext.includes(coupon.token.slice(0, 4).toUpperCase()));

check("console: no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

await browser.close();
const failed = results.filter((r) => !r.c);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:\n" + failed.map((f) => " - " + f.n).join("\n")); process.exit(1); }
