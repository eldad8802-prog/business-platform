/**
 * F-1 regression — three states of the identity fetch:
 *   1. SLOW   → skeleton visible, then the real name replaces it
 *   2. FAILED → explicit message + working retry, publishing still allowed
 *   3. RETRY  → recovering the network makes "נסה שוב" actually load the name
 */
import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const results = [];
const check = (n, c, d = "") => { results.push({ n, c }); console.log(`${c ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const b = await chromium.launch();
async function session() {
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
  const p = await ctx.newPage();
  const r = await p.request.post(`${BASE}/api/auth/login`, { data: { email: "qa-coupon-smoke-issuer@dubiz.test", password: "SmokeTest!2026" } });
  if (!r.ok()) { console.error("LOGIN FAILED", r.status()); process.exit(2); }
  const t = (await r.json()).token;
  await p.goto(`${BASE}/login`);
  await p.evaluate((x) => localStorage.setItem("token", x), t);
  return { ctx, p, t };
}
const skeleton = (p) => p.locator('[aria-label="טוען את פרטי העסק"]').first().isVisible().catch(() => false);
async function toBuilder(p) {
  await p.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
  await p.locator("text=צור קופון חדש").first().click();
  await p.waitForURL(/view=create/, { timeout: 60000 });
  await p.locator("text=להביא לקוחות חדשים").first().click();
  await p.locator("text=הנחה").first().click();
}

/* ── 1. SLOW identity ── */
{
  const { ctx, p } = await session();
  await p.route("**/api/revenue/coupons/my-business", async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue();
  });
  await toBuilder(p);
  await p.waitForTimeout(1200);
  check("slow: skeleton is shown while loading", await skeleton(p));
  const during = await p.locator("body").innerText();
  check("slow: no fabricated name during loading", !during.includes("העסק שלך"));
  check("slow: no premature error while merely slow", !during.includes("לא הצלחנו לטעון את פרטי העסק"));

  let appeared = false;
  for (let i = 0; i < 40; i++) {
    if ((await p.locator("body").innerText()).includes("מאפיית הבוקר")) { appeared = true; break; }
    await p.waitForTimeout(500);
  }
  check("slow: the real name replaces the skeleton", appeared);
  check("slow: skeleton is gone once loaded", !(await skeleton(p)));
  await ctx.close();
}

/* ── 2. FAILED identity ── */
{
  const { ctx, p, t } = await session();
  await p.route("**/api/revenue/coupons/my-business", (route) => route.abort("failed"));
  await toBuilder(p);
  await p.waitForTimeout(3000);

  const body = await p.locator("body").innerText();
  check("failed: explicit message shown", body.includes("לא הצלחנו לטעון את פרטי העסק"));
  check("failed: retry action offered", await p.locator("button", { hasText: /^נסה שוב$/ }).first().isVisible().catch(() => false));
  check("failed: skeleton stops spinning forever", !(await skeleton(p)));
  check("failed: still no fabricated name", !body.includes("העסק שלך"));
  check("failed: owner is told publishing is still fine", body.includes("אפשר להמשיך"));

  // Publishing must still work and still produce a correct customer-facing coupon.
  const val = p.locator('input[inputmode="decimal"]').first();
  await val.fill("29");
  await val.blur();
  await p.locator("button", { hasText: /^המשך$/ }).first().click();
  await p.waitForTimeout(700);
  await p.locator("text=צור את הקופון").first().click();
  const ok = await p.locator("text=הקופון שלך פורסם").first().waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
  check("failed: publishing still succeeds", ok);
  if (ok) {
    const mine = await (await p.request.get(`${BASE}/api/revenue/coupons/mine`, { headers: { Authorization: `Bearer ${t}` } })).json();
    const newest = mine.coupons.find((c) => c.benefit.includes("29%"));
    const active = await (await p.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
    const card = active.coupons.find((c) => c.publicId === newest?.publicId);
    check("failed: the published coupon still carries the real business name",
      Boolean(card?.business?.name?.includes("מאפיית הבוקר")), card?.business?.name ?? "(n/a)");
  }
  await ctx.close();
}

/* ── 3. RETRY recovers ── */
{
  const { ctx, p } = await session();
  let fail = true;
  await p.route("**/api/revenue/coupons/my-business", (route) => (fail ? route.abort("failed") : route.continue()));
  await toBuilder(p);
  await p.waitForTimeout(3000);
  check("retry: starts in the error state", (await p.locator("body").innerText()).includes("לא הצלחנו לטעון"));

  fail = false; // "network came back"
  await p.locator("button", { hasText: /^נסה שוב$/ }).first().click();
  let recovered = false;
  for (let i = 0; i < 40; i++) {
    if ((await p.locator("body").innerText()).includes("מאפיית הבוקר")) { recovered = true; break; }
    await p.waitForTimeout(500);
  }
  check("retry: 'נסה שוב' actually loads the identity", recovered);
  check("retry: the error notice disappears after success", !(await p.locator("body").innerText()).includes("לא הצלחנו לטעון"));
  await ctx.close();
}

await b.close();
const failed = results.filter((r) => !r.c);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:\n" + failed.map((f) => " - " + f.n).join("\n")); process.exit(1); }
