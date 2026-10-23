/**
 * P3 creation-flow QA — every create entry point, every kind, at 390 / 768 / 820 / 1440.
 *
 * Drives the REAL Next.js app in Chromium with every /api/** request answered from
 * main-screens-fixtures.mjs. The two create endpoints are answered locally and their
 * request bodies recorded, so the saved payloads can be compared between branches.
 * Nothing reaches a database or a third-party service.
 *
 *   BASE_URL=http://localhost:3105 node scripts/qa/ui/p3-create-qa.mjs --label=branch [--entries=p3|main]
 *   node scripts/qa/ui/p3-create-qa.mjs --compare=main,branch     # saved payloads must be identical
 *   --fresh  starts every kind from a new panel (needed on main, whose "הוסף עוד" stays on the result)
 *
 * Evidence: qa-evidence/p3-create/<label>/ (or $QA_EVIDENCE_DIR/<label>/): screenshots + results.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const EVIDENCE = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(ROOT, "qa-evidence", "p3-create");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3) || null;

const COMPARE = arg("compare");
if (COMPARE) {
  const [a, b] = COMPARE.split(",");
  const load = (l) => JSON.parse(readFileSync(path.join(EVIDENCE, l, "results.json"), "utf8")).payloads;
  const A = load(a);
  const B = load(b);
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])];
  let same = 0;
  for (const k of keys) {
    const ok = JSON.stringify(A[k]) === JSON.stringify(B[k]);
    if (ok) same++;
    else console.log(`  DIFF ${k}\n    ${a}: ${JSON.stringify(A[k])}\n    ${b}: ${JSON.stringify(B[k])}`);
  }
  console.log(`saved payloads ${a} vs ${b}: ${same}/${keys.length} identical`);
  process.exit(same === keys.length ? 0 : 1);
}

const { chromium } = await import("playwright");
const { FROZEN_NOW, resolveApi } = await import("./main-screens-fixtures.mjs");
const LABEL = arg("label") || "local";
const OUT = path.join(EVIDENCE, LABEL);
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE_URL || "http://localhost:3105").replace(/\/$/, "");
if (/promaxgroup|vercel\.app|dubiz/i.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local dev server only.`);
  process.exit(2);
}
const P3_START = /\/secretary\?screen=bank$/;
const VIEWPORTS = [
  { n: "390", w: 390, h: 844, m: true },
  { n: "768", w: 768, h: 1024 },
  { n: "820", w: 820, h: 1180 },
  { n: "1440", w: 1440, h: 900 },
];
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;
const results = { label: LABEL, base: BASE, checks: [], payloads: {}, writes: [] };
const check = (vp, name, ok, detail = "") => results.checks.push({ vp, name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });

let nextId = 2000;
async function newPage(browser, vp, scenario, record) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה" })); } catch {} }, TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
    if (m !== "GET") results.writes.push(`${vp.n} ${m} ${url.pathname}`);
    if (m === "POST" && url.pathname === "/api/obligations") {
      const body = JSON.parse(req.postData() || "{}");
      record(body);
      const id = nextId++;
      return json({ id, obligeeName: body.obligeeName, amount: Number(body.amount).toFixed(2), currency: "ILS", dueAt: body.dueAt, state: "OPEN", source: "MANUAL", recurrence: body.recurrence ?? "NONE", recurrenceSeriesId: null, note: body.note ?? null, followUpAt: null, settlementAssertedBy: null, metAt: null, releasedAt: null, createdAt: FROZEN_NOW, updatedAt: FROZEN_NOW, ledger: { commitmentId: id, installmentId: id, paid: "0.00", remaining: Number(body.amount).toFixed(2) } }, 201);
    }
    if (m !== "GET") return json({ error: "QA: write not mocked" }, 404);
    if (url.pathname === "/api/home") return json({ heroAction: { actionKey: "none", title: "", description: "", ctaLabel: "", ctaHref: "/app" }, quickActions: [], businessSnapshot: { businessName: "עסק לדוגמה" }, leadsAttention: { count: 0, href: "/leads" } });
    const body = resolveApi(scenario, "GET", url.pathname, url.searchParams);
    if (body === undefined) return json({ error: "QA: not mocked" }, 404);
    if (body && body.__status) return json({ error: body.error }, body.__status);
    return json(body);
  });
  const page = await ctx.newPage();
  return { ctx, page };
}
const settle = async (p) => { await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(600); };
const route = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const shot = (p, vp, name) => p.screenshot({ path: path.join(OUT, `${vp.n}-${name}.png`), fullPage: true }).catch(() => {});
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  // ── Entry points (flag ON, as for the owner's business)
  {
    const { ctx, page: p } = await newPage(browser, vp, "todayShared", () => {});
    // "+" (from Payables, so back must return there)
    await p.goto(`${BASE}/payables`); await settle(p);
    await p.getByRole("button", { name: "פעולה חדשה" }).locator("visible=true").first().click().catch((e) => check(vp.n, "+ opens", false, e.message));
    // Inside the quick-actions sheet only (Payables has its own "התחייבות חדשה" button).
    const sheet = p.getByRole("dialog", { name: "פעולות מהירות" });
    await sheet.getByRole("button", { name: "התחייבות חדשה" }).or(sheet.getByRole("link", { name: "התחייבות חדשה" })).first().click().catch((e) => check(vp.n, "+ item", false, e.message));
    await p.waitForURL(P3_START, { timeout: 15000 }).catch(() => {});
    check(vp.n, '"+" → התחייבות חדשה opens P3', P3_START.test(route(p)), route(p));
    await settle(p); await shot(p, vp, "entry-plus-bank");
    const back = p.getByRole("button", { name: "חזרה", exact: true });
    check(vp.n, "P3 back control shows 'חזרה'", (await back.innerText().catch(() => "")).includes("חזרה"));
    await back.click().catch(() => {});
    await p.waitForURL(/\/payables$/, { timeout: 15000 }).catch(() => {});
    check(vp.n, "back returns to the exact entry (/payables)", /\/payables$/.test(route(p)), route(p));
    // Secretary header "הוספה למעקב"
    await p.goto(`${BASE}/secretary`); await settle(p);
    await p.getByRole("link", { name: /הוספה למעקב/ }).first().click().catch(() => {});
    await p.waitForURL(P3_START, { timeout: 15000 }).catch(() => {});
    check(vp.n, "Secretary 'הוספה למעקב' opens P3", P3_START.test(route(p)), route(p));
    // Home shortcut (desktop Home shows the shortcut row)
    if (vp.w >= 1200) {
      await p.goto(`${BASE}/app`); await settle(p);
      await p.getByRole("link", { name: /התחייבות חדשה/ }).first().click().catch((e) => check(vp.n, "home shortcut click", false, e.message));
      await p.waitForURL(P3_START, { timeout: 15000 }).catch(() => {});
      check(vp.n, "Home shortcut 'התחייבות חדשה' opens P3", P3_START.test(route(p)), route(p));
    }
    // Task form's commitment link
    await p.goto(`${BASE}/tasks?new=1`); await settle(p);
    // The new-task form (not the quick-add row above it).
    const taskForm = p.locator("form", { hasText: "מה צריך לעשות" }).first();
    await taskForm.locator("input").first().fill("לשלם 500 לספק").catch(() => {});
    await p.waitForTimeout(300);
    const link = taskForm.locator('a[href="/secretary?screen=bank"]');
    check(vp.n, "task form's commitment link points to P3", (await link.count()) > 0);
    // Direct link still works
    await p.goto(`${BASE}/payables?new=1`); await settle(p);
    check(vp.n, "/payables?new=1 still opens the payables form", await p.locator("main form, form").first().isVisible().catch(() => false));
    await ctx.close();
  }
  // ── The flow
  {
    const bodies = [];
    const { ctx, page: p } = await newPage(browser, vp, "todayShared", (b) => bodies.push(b));
    await p.goto(`${BASE}/secretary?screen=bank`); await settle(p);
    await shot(p, vp, "1-bank");
    check(vp.n, "bank: no horizontal scroll", await noHScroll(p));
    const grid = await p.evaluate(() => {
      const g = document.querySelector('[class*="bankGrid"]');
      if (!g) return null;
      const items = [...g.children].map((c) => Math.round(c.getBoundingClientRect().top));
      return { width: Math.round(g.getBoundingClientRect().width), perRow: items.filter((t) => t === items[0]).length };
    });
    if (vp.w >= 1200) check(vp.n, "desktop: P3 column (≤ 720px, two per row)", grid && grid.width <= 720 && grid.perRow === 2, JSON.stringify(grid));
    const insurance = await p.locator("main a", { hasText: "ביטוחים" }).first().getAttribute("href").catch(() => null);
    check(vp.n, "ביטוחים not marked saved by ביטוח לאומי", insurance !== null && /screen=capture/.test(insurance), insurance);
    await p.locator("main a", { hasText: "שכירות" }).first().click();
    await p.waitForURL(/screen=capture/, { timeout: 15000 }).catch(() => {});
    await settle(p); await shot(p, vp, "2-capture");
    const kinds = (await p.locator('[aria-label="סוג התחייבות"] button').allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
    check(vp.n, "kinds: payment kinds first, משימה last", kinds.length === 5 && /תשלום רגיל/.test(kinds[0]) && /משימה/.test(kinds[4]), kinds.join(" | "));
    check(vp.n, "cheque description has no reminder promise", kinds.some((k) => /צ'ק דחוי מספר צ'ק ותאריך פירעון/.test(k)), kinds.join(" | "));
    check(vp.n, "name prefilled from category", (await p.locator("form input").first().inputValue().catch(() => "")) === "שכירות");
    const pick = async (title) => { await p.locator('[aria-label="סוג התחייבות"] button', { hasText: title }).first().click(); await p.waitForTimeout(250); };
    const form = () => p.locator("form").first();
    const submit = async () => { await form().locator("button[type=submit]").first().click(); await p.waitForTimeout(900); };
    const result = async (key, expectedPosts) => {
      const before = bodies.length;
      await submit();
      const txt = (await p.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      const added = bodies.slice(before);
      results.payloads[`${vp.n}:${key}`] = added;
      check(vp.n, `${key}: saved once per expected payment (${expectedPosts})`, added.length === expectedPosts, added.length);
      check(vp.n, `${key}: result shows the due date, no reminder promise`, /מצוין, אני זוכרת/.test(txt) && /לתשלום/.test(txt) && !/אזכיר לך/.test(txt), txt.slice(0, 200));
      return txt;
    };
    // --fresh: start each kind from a new panel (main's "הוסף עוד" does not open one), for payload comparison across branches.
    const FRESH = process.argv.includes("--fresh");
    const again = async () => {
      if (FRESH) { await p.goto(`${BASE}/secretary?screen=capture`); await settle(p); return; }
      await p.getByRole("link", { name: "הוסף עוד" }).or(p.getByRole("button", { name: "הוסף עוד" })).first().click();
      await p.waitForTimeout(700);
      check(vp.n, "'הוסף עוד' opens a new, empty panel", (await form().locator("input").first().inputValue().catch(() => "x")) === "");
    };
    const fillMoney = (v) => form().locator("input[inputmode=decimal]").first().fill(v);
    const fillDate = (v) => form().locator("input[type=date]").first().fill(v);

    // Validation (empty amount) per kind, then a real save.
    for (const [title, msg] of [["תשלום רגיל", "למי, כמה ומתי"], ["פריסת תשלומים", "מספר תשלומים"], ["צ'ק דחוי", "מספר צ'ק"], ["שוטף+", "תאריך חשבונית"]]) {
      await pick(title);
      await submit();
      const err = await p.locator('[class*="formError"]').first().innerText().catch(() => "");
      check(vp.n, `${title}: validation message`, err.includes(msg), err);
    }
    await pick("תשלום רגיל");
    await fillMoney("6500"); await fillDate("2026-11-01");
    await result("regular-once", 1);
    if (vp.n === "1440" || vp.n === "390") await shot(p, vp, "3-saved");
    await again();
    await form().locator("input").first().fill("ארנונה");
    await fillMoney("812.40"); await fillDate("2026-11-15");
    await p.getByRole("radio", { name: "כל חודש", exact: true }).click();
    await result("regular-monthly", 1);
    await again();
    await pick("פריסת תשלומים");
    await form().locator("input").first().fill("מחשב נייד");
    await fillMoney("3600"); await form().locator("input[inputmode=numeric]").first().fill("3"); await fillDate("2026-11-10");
    const planNote = await p.locator('[class*="captureCalmNote"]').first().innerText().catch(() => "");
    check(vp.n, "plan: says it is saved as separate payments", /3 תשלומים נפרדים/.test(planNote), planNote);
    await result("installments-3", 3);
    await again();
    await pick("צ'ק דחוי");
    await form().locator("input").first().fill("ספק ציוד");
    await fillMoney("1250"); await form().locator('input[placeholder="000000"]').fill("123456"); await fillDate("2026-12-01");
    const chequeNote = await p.locator('[class*="captureCalmNote"]').first().innerText().catch(() => "");
    check(vp.n, "cheque: says it is not in the cheque register", /לא נרשם בפנקס הצ'קים/.test(chequeNote), chequeNote);
    await result("postdated-check", 1);
    await again();
    await pick("שוטף+");
    await form().locator("input").first().fill("ספק שירותים");
    await fillMoney("990"); await fillDate("2026-10-14");
    await p.getByRole("radio", { name: "שוטף+60", exact: true }).click();
    const netNote = await p.locator('[class*="captureCalmNote"]').first().innerText().catch(() => "");
    check(vp.n, "net terms: computed date, no reminder promise", /חישבתי: שוטף\+60/.test(netNote) && !/אזכיר/.test(netNote), netNote);
    await result("net-terms-60", 1);
    await p.getByRole("link", { name: "סיימתי" }).or(p.getByRole("button", { name: "סיימתי" })).first().click().catch(() => {});
    await p.waitForURL(/\/secretary$/, { timeout: 15000 }).catch(() => {});
    check(vp.n, "'סיימתי' → the Secretary", /\/secretary$/.test(route(p)), route(p));
    // "×" closes back to "נגדיר את ההתחייבויות"
    await p.goto(`${BASE}/secretary?screen=capture`); await settle(p);
    check(vp.n, "capture: no horizontal scroll", await noHScroll(p));
    await p.getByRole("link", { name: "סגירת החלונית" }).click().catch(() => {});
    await p.waitForURL(P3_START, { timeout: 15000 }).catch(() => {});
    check(vp.n, "'×' → נגדיר את ההתחייבויות", P3_START.test(route(p)), route(p));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL ${c.vp} ${c.name} — ${c.detail}`);
console.log(`[${LABEL}] ${results.checks.length - failed.length}/${results.checks.length} checks passed · create requests: ${Object.values(results.payloads).flat().length} · other writes: ${results.writes.filter((w) => !/\/api\/obligations$/.test(w)).length}`);
process.exit(failed.length ? 1 : 0);
