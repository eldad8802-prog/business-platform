/**
 * Coupon v1 browser smoke — drives a REAL browser through the whole business
 * flow against the running dev server:
 *
 *   login → My Coupons (empty) → create wizard → validation blocks bad input
 *         → publish → success screen → coupon appears in My Coupons
 *         → disable → gone from marketplace → re-enable
 *         → other business redeems it → state becomes "מומש"
 *
 * Also captures every console message and every failed network response, so
 * the audit's "console noise" and false-success findings can be checked
 * firsthand rather than inferred.
 *
 *   node scripts/qa/coupons/coupon-smoke.mjs
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

// Screenshot target; may not exist in a fresh clone.
mkdirSync(".tmp", { recursive: true });

// Reseed so every run starts from a known-empty tenant. Without this the
// "empty state" / "exactly one coupon" checks measure the previous run.
execFileSync("npx", ["tsx", "scripts/qa/coupons/coupon-smoke-seed.ts"], { stdio: "inherit", shell: true });

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const ISSUER = "qa-coupon-smoke-issuer@dubiz.test";
const REDEEMER = "qa-coupon-smoke-redeemer@dubiz.test";
const PASSWORD = "SmokeTest!2026";

const results = [];
const consoleErrors = [];
const failedRequests = [];

function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function watch(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[${label}] pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`[${label}] ${res.status()} ${res.request().method()} ${res.url()}`);
  });
}

async function login(page, email) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: PASSWORD } });
  if (!res.ok()) throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  const token = body.token || body.accessToken || body?.data?.token;
  if (!token) throw new Error(`no token in login response: ${JSON.stringify(body)}`);
  await page.goto(`${BASE}/login`);
  await page.evaluate((t) => localStorage.setItem("token", t), token);
  return token;
}

const browser = await chromium.launch();
try {
  // ───────────────────────────── issuer ─────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
  const page = await ctx.newPage();
  watch(page, "issuer");
  const issuerToken = await login(page, ISSUER);

  // ── 1. IA: "קופונים" lands on the owner's own coupons, not the marketplace
  await page.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
  const heading = await page.locator("text=הקופונים שלי").first().textContent().catch(() => null);
  check("IA: /revenue opens 'הקופונים שלי' (not the marketplace)", heading !== null);
  check(
    "IA: the consumer marketplace is NOT the landing screen",
    !(await page.locator("text=הטבות קרוב אליך").first().isVisible().catch(() => false))
  );
  check(
    "empty state: says no coupons yet (not an error)",
    await page.locator("text=עדיין לא יצרת קופון").first().isVisible().catch(() => false)
  );

  // ── 2. coupons/mine must NOT 500 (the audit's blocker)
  const mine = await page.request.get(`${BASE}/api/revenue/coupons/mine`, {
    headers: { Authorization: `Bearer ${issuerToken}` },
  });
  check("API: GET /api/revenue/coupons/mine → 200", mine.status() === 200, `status ${mine.status()}`);

  // ── 3. real business identity, no placeholders
  const bizRes = await page.request.get(`${BASE}/api/revenue/coupons/my-business`, {
    headers: { Authorization: `Bearer ${issuerToken}` },
  });
  const biz = (await bizRes.json()).business;
  check("identity: returns the REAL business name", biz.name.includes("מאפיית הבוקר"), biz.name);
  check("identity: returns the REAL city", biz.city === "חיפה", biz.city);
  check("identity: no 'העסק שלך' placeholder", biz.name !== "העסק שלך");
  check("identity: no 'הכתובת שלך' placeholder", biz.address !== "הכתובת שלך", biz.address);

  // ── 4. server rejects invalid economics (COUPON-07)
  const bad = [
    { label: "0%", body: { benefitType: "pct", value: "0", scope: "כל העסק", validUntilDate: iso(14) } },
    { label: "999%", body: { benefitType: "pct", value: "999", scope: "כל העסק", validUntilDate: iso(14) } },
    { label: "24 digits", body: { benefitType: "pct", value: "123456789012345678901234", scope: "כל העסק", validUntilDate: iso(14) } },
    { label: "empty value", body: { benefitType: "pct", value: "", scope: "כל העסק", validUntilDate: iso(14) } },
    { label: "past end date", body: { benefitType: "pct", value: "20", scope: "כל העסק", validUntilDate: iso(-1) } },
  ];
  for (const b of bad) {
    const res = await page.request.post(`${BASE}/api/revenue/coupons`, {
      headers: { Authorization: `Bearer ${issuerToken}` },
      data: b.body,
    });
    check(`validation: ${b.label} → 400`, res.status() === 400, `status ${res.status()}`);
  }
  const afterBad = await (await page.request.get(`${BASE}/api/revenue/coupons/mine`, {
    headers: { Authorization: `Bearer ${issuerToken}` },
  })).json();
  check("atomicity: rejected publishes created nothing", afterBad.coupons.length === 0, `${afterBad.coupons.length} coupons`);

  // ── 5. the wizard, end to end in the browser
  await page.locator("text=צור קופון חדש").first().click();
  await page.waitForURL(/view=create/, { timeout: 45_000 });
  check("wizard: creation lives in the URL (Back works, refresh survives)", page.url().includes("view=create"));

  await page.locator("text=להביא לקוחות חדשים").first().click();
  await page.locator("text=הנחה").first().click();

  // scope: the fake selectors are gone; a typed scope is the real option
  check(
    "scope: 'קטגוריה' selector removed from v1",
    !(await page.locator("button", { hasText: /^קטגוריה$/ }).first().isVisible().catch(() => false))
  );
  check(
    "scope: typed product/service option is offered",
    await page.locator("text=מוצר או שירות מסוים").first().isVisible().catch(() => false)
  );

  // invalid value blocks progress
  const valueBox = page.locator('input[inputmode="decimal"]').first();
  const nextBtn = page.locator("button", { hasText: /^המשך$/ }).first();

  await valueBox.fill("0");
  await valueBox.blur();
  check(
    "validation: 0% shows an inline message next to the field",
    await page.locator("text=אחוז ההנחה חייב להיות בין 1 ל‑100").first().isVisible().catch(() => false)
  );
  check("validation: 0% disables 'המשך'", await nextBtn.isDisabled());
  check("validation: the field is marked invalid for assistive tech",
    (await valueBox.getAttribute("aria-invalid")) === "true");
  check("validation: 0% keeps the owner on the builder step", page.url().includes("view=create"));

  await valueBox.fill("999");
  await valueBox.blur();
  check("validation: 999% also disables 'המשך'", await nextBtn.isDisabled());

  await valueBox.fill("25");
  await valueBox.blur();
  check("validation: a valid 25% re-enables 'המשך'", await nextBtn.isEnabled());
  await nextBtn.click();

  // terms step: a real end date input exists
  check(
    "validity: a real end-date picker exists (not just presets)",
    await page.locator('input[type="date"]').first().isVisible().catch(() => false)
  );
  check(
    "terms: unenforceable 'פעם אחת ללקוח' removed",
    !(await page.locator("button", { hasText: /^פעם אחת ללקוח$/ }).first().isVisible().catch(() => false))
  );
  check(
    "terms: 'סניף מסוים' removed (no branch model exists)",
    !(await page.locator("button", { hasText: /^סניף מסוים$/ }).first().isVisible().catch(() => false))
  );

  await page.locator("text=צור את הקופון").first().click();
  const published = await page
    .locator("text=הקופון שלך פורסם")
    .first()
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!published) {
    console.log("---- publish did not succeed; screen text ----");
    console.log((await page.locator("body").innerText()).slice(0, 800));
    console.log("---- recent non-2xx ----");
    console.log(failedRequests.slice(-5).join("\n"));
  }
  check("publish: success screen shown after a REAL create", published);

  const previewText = await page.locator("body").innerText();
  check("publish: preview shows the real business name", previewText.includes("מאפיית הבוקר"));
  check("publish: preview shows no 'העסק שלך' placeholder", !previewText.includes("העסק שלך"));
  check("publish: preview shows no 'הכתובת שלך' placeholder", !previewText.includes("הכתובת שלך"));
  check(
    "publish: no invented terms are printed on the coupon",
    !previewText.includes("לא ניתן לכפל עם מבצעים אחרים")
  );

  // ── 6. it really persisted
  const listed = await (await page.request.get(`${BASE}/api/revenue/coupons/mine`, {
    headers: { Authorization: `Bearer ${issuerToken}` },
  })).json();
  check("persistence: exactly one coupon exists", listed.coupons.length === 1, `${listed.coupons.length}`);
  const coupon = listed.coupons[0];
  check("persistence: benefit sentence is canonical", coupon.benefit === "25% הנחה על כל העסק", coupon.benefit);
  check("persistence: state is ACTIVE", coupon.state === "ACTIVE", coupon.state);

  const codeRes = await page.request.get(`${BASE}/api/revenue/coupons/${coupon.publicId}/code`, {
    headers: { Authorization: `Bearer ${issuerToken}` },
  });
  const code = await codeRes.json();
  check("code: issuer can read the coupon token", Boolean(code.token));

  // ── 7. it is discoverable while active
  const activeBefore = await (await page.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
  check(
    "marketplace: an active coupon is listed",
    activeBefore.coupons.some((c) => c.publicId === coupon.publicId)
  );

  // ── 8. management: the list, then the kill switch
  await page.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
  const listText = await page.locator("body").innerText();
  check("management: the coupon is visible in 'הקופונים שלי'", listText.includes("25% הנחה על כל העסק"));
  check("management: its state is shown", listText.includes("פעיל"));
  check("management: an end date is shown", /בתוקף עד/.test(listText));
  check("management: a disable action is offered", listText.includes("השבת קופון"));

  await page.locator("text=השבת קופון").first().click();
  await page.locator("text=הפעל מחדש").first().waitFor({ timeout: 45_000 });
  check("disable: the UI flips to 'מושבת' / 'הפעל מחדש'", true);

  const activeAfter = await (await page.request.get(`${BASE}/api/revenue/coupons/active?limit=24`)).json();
  check(
    "disable: the coupon leaves the marketplace immediately",
    !activeAfter.coupons.some((c) => c.publicId === coupon.publicId)
  );

  // ── 9. cross-tenant: the redeemer must not be able to manage it
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "he-IL" });
  const page2 = await ctx2.newPage();
  watch(page2, "redeemer");
  const redeemerToken = await login(page2, REDEEMER);

  const foreignDisable = await page2.request.post(`${BASE}/api/revenue/coupons/${coupon.publicId}/disable`, {
    headers: { Authorization: `Bearer ${redeemerToken}` },
  });
  check("tenant: another business cannot disable it → 403", foreignDisable.status() === 403, `status ${foreignDisable.status()}`);
  const foreignCode = await page2.request.get(`${BASE}/api/revenue/coupons/${coupon.publicId}/code`, {
    headers: { Authorization: `Bearer ${redeemerToken}` },
  });
  check("tenant: another business cannot read the token → 403", foreignCode.status() === 403, `status ${foreignCode.status()}`);
  const foreignList = await (await page2.request.get(`${BASE}/api/revenue/coupons/mine`, {
    headers: { Authorization: `Bearer ${redeemerToken}` },
  })).json();
  check("tenant: another business's list does not contain it", !foreignList.coupons.some((c) => c.publicId === coupon.publicId));

  const anonCode = await page2.request.get(`${BASE}/api/revenue/coupons/${coupon.publicId}/code`);
  check("tenant: anonymous cannot read the token", anonCode.status() >= 400, `status ${anonCode.status()}`);
  const anonMine = await page2.request.get(`${BASE}/api/revenue/coupons/mine`);
  check("tenant: anonymous cannot list coupons → 401", anonMine.status() === 401, `status ${anonMine.status()}`);

  // ── 10. redemption is blocked while disabled, then works once re-enabled
  const blocked = await page2.request.post(`${BASE}/api/coupons/${code.token}/redeem`, {
    headers: { Authorization: `Bearer ${redeemerToken}` },
  });
  check("redeem: a disabled coupon cannot be redeemed", blocked.status() >= 400, `status ${blocked.status()}`);

  await page.locator("text=הפעל מחדש").first().click();
  await page.locator("text=השבת קופון").first().waitFor({ timeout: 45_000 });
  check("enable: the coupon comes back to life", true);

  await page2.goto(`${BASE}/revenue/redeem?token=${code.token}`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(3000);
  const redeemText = await page2.locator("body").innerText();
  check("redeem: the redeem screen reports success", /מומש|הצלח/.test(redeemText), redeemText.slice(0, 120).replace(/\s+/g, " "));

  const second = await page2.request.post(`${BASE}/api/coupons/${code.token}/redeem`, {
    headers: { Authorization: `Bearer ${redeemerToken}` },
  });
  check("redeem: the same coupon cannot be redeemed twice", second.status() >= 400, `status ${second.status()}`);

  await page.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
  const finalText = await page.locator("body").innerText();
  check("lifecycle: the owner's list now shows 'מומש'", finalText.includes("מומש"));

  // ── 11. desktop viewport renders without a horizontal scrollbar
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
  const dpage = await desktop.newPage();
  watch(dpage, "desktop");
  await dpage.goto(`${BASE}/login`);
  await dpage.evaluate((t) => localStorage.setItem("token", t), issuerToken);
  await dpage.goto(`${BASE}/revenue`, { waitUntil: "networkidle" });
  const overflow = await dpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("desktop: no horizontal overflow at 1440px", overflow <= 1, `overflow ${overflow}px`);
  await dpage.screenshot({ path: ".tmp/coupon-smoke-desktop.png", fullPage: true });
  await page.screenshot({ path: ".tmp/coupon-smoke-mobile.png", fullPage: true });

  // ── 12. console / network hygiene
  // Known pre-existing app-shell noise, NOT coupon code: the Dubiz intro splash
  // (app/(shell)/layout.tsx + components/brand/dubiz-intro-overlay.tsx) renders
  // a preboot <script> and hydrates differently from the server HTML. Reported
  // separately rather than silently swallowed.
  const SHELL_NOISE = /Hydration failed|hydrat|Encountered a script tag while rendering/i;
  const shellNoise = consoleErrors.filter((e) => SHELL_NOISE.test(e));
  const couponErrors = consoleErrors.filter((e) => !SHELL_NOISE.test(e));
  check("console: no page errors from the coupon feature", couponErrors.length === 0, couponErrors.slice(0, 3).join(" | "));
  if (shellNoise.length) {
    console.log(`\nNOTE: ${shellNoise.length} pre-existing app-shell hydration warning(s) (not coupon code).`);
  }
  const unexpected = failedRequests.filter((r) => !/\b(400|401|403)\b/.test(r));
  check("network: no unexpected 5xx/404 responses", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

function iso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const failedChecks = results.filter((r) => !r.pass);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
if (consoleErrors.length) console.log("\nconsole errors:\n" + consoleErrors.join("\n"));
if (failedRequests.length) console.log("\nnon-2xx responses:\n" + failedRequests.join("\n"));
if (failedChecks.length) {
  console.log("\nFAILED:\n" + failedChecks.map((r) => ` - ${r.name}${r.detail ? ` (${r.detail})` : ""}`).join("\n"));
  process.exit(1);
}
