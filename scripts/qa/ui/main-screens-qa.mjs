/**
 * Main screens QA — "המזכירה שלי" (/secretary) and "התחייבויות" (/payables),
 * alternative B, plus a text regression of every inner screen.
 *
 * Drives the REAL Next.js app in Chromium with EVERY /api/** request answered
 * from fixtures (scripts/qa/ui/main-screens-fixtures.mjs). Nothing reaches a
 * database or a third-party service: un-mocked /api calls are logged and get a
 * 404 JSON, and every non-GET request is recorded and answered with a 404 —
 * the run expects none outside the "legacy" action-error scenario.
 *
 *   BASE_URL=http://localhost:3105 node scripts/qa/ui/main-screens-qa.mjs --label=pr-s [--only=secretary|payables|inner]
 *   node scripts/qa/ui/main-screens-qa.mjs --compare=main,pr-s   # inner-screen text: main vs a branch
 *
 * Requires `npx next dev -p 3105` running in the checkout under test. Evidence
 * goes to qa-evidence/main-screens/<label>/ (or $QA_EVIDENCE_DIR/<label>/) (<page>-<scenario>-<width>.png +
 * results.json). Auth is client-side: a fake JWT-shaped token (exp 2030) in
 * localStorage "token". The browser clock is frozen at 2026-10-21T09:00+03:00.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const EVIDENCE = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(ROOT, "qa-evidence", "main-screens");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3) || null;

/* ─────────────── compare mode ─────────────── */

const COMPARE = arg("compare");
if (COMPARE) {
  const [a, b] = COMPARE.split(",");
  const load = (l) => JSON.parse(readFileSync(path.join(EVIDENCE, l, "results.json"), "utf8"));
  const A = load(a);
  const B = load(b);
  const rows = [];
  for (const [key, textA] of Object.entries(A.innerTexts)) {
    const textB = B.innerTexts[key];
    rows.push({ key, same: textA === textB, missing: textB === undefined, lenA: textA.length, lenB: textB?.length ?? 0 });
  }
  const diff = rows.filter((r) => !r.same);
  console.log(`inner-screen text ${a} vs ${b}: ${rows.length - diff.length}/${rows.length} identical`);
  for (const r of diff) {
    console.log(`  DIFF ${r.key}${r.missing ? " (missing)" : ` (${r.lenA} vs ${r.lenB} chars)`}`);
    if (!r.missing) {
      const la = A.innerTexts[r.key].split("\n");
      const lb = B.innerTexts[r.key].split("\n");
      for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) console.log(`    line ${i + 1}: «${(la[i] ?? "").slice(0, 120)}» → «${(lb[i] ?? "").slice(0, 120)}»`);
    }
  }
  writeFileSync(path.join(EVIDENCE, `compare-${a}-${b}.json`), JSON.stringify({ a, b, rows }, null, 2));
  process.exit(diff.length ? 1 : 0);
}

const { chromium } = await import("playwright");
const { FROZEN_NOW, SLOW_PATHS, resolveApi } = await import("./main-screens-fixtures.mjs");

const LABEL = arg("label") || "local";
const OUT = path.join(EVIDENCE, LABEL);
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE_URL || "http://localhost:3105").replace(/\/$/, "");
if (/promaxgroup|vercel\.app|dubiz/i.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local dev server only.`);
  process.exit(2);
}
const ONLY = arg("only");

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "768", width: 768, height: 1024, isMobile: false, hasTouch: true },
  { name: "820", width: 820, height: 1180, isMobile: false, hasTouch: true },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const PAGES = [
  { slug: "secretary", path: "/secretary", scenarios: ["prod", "empty", "calm", "loading", "error", "legacy"], group: "secretary" },
  { slug: "payables", path: "/payables", scenarios: ["prod", "empty", "calm", "loading", "error", "summaryFail"], group: "payables" },
  // Inner screens: text must equal main's, screen by screen.
  ...[
    ["secretary-today", "/secretary?today=1"],
    ["secretary-detail-11", "/secretary?screen=detail&id=11"],
    ["secretary-update-11", "/secretary?screen=update&id=11"],
    ["secretary-capture", "/secretary?screen=capture"],
    ["secretary-remind-13", "/secretary?screen=remind&id=13"],
    ["secretary-all", "/secretary?screen=all"],
    ["secretary-watching", "/secretary?screen=watching"],
    ["secretary-bank", "/secretary?screen=bank"],
    ["secretary-loops", "/secretary?screen=loops"],
    ["payables-7", "/payables/7"],
    ["payables-5", "/payables/5"],
    ["payables-cheques", "/payables/cheques"],
    ["payables-bank", "/payables/bank"],
    ["payables-new-form", "/payables?new=1", "form"],
    ["tasks", "/tasks"],
  ].map(([slug, p, textSel]) => ({ slug, path: p, scenarios: ["prod"], group: "inner", textSel })),
].filter((p) => !ONLY || p.group === ONLY);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;

const unmocked = new Map();
const nonGet = [];
const results = { label: LABEL, base: BASE, frozenNow: FROZEN_NOW, startedAt: new Date().toISOString(), only: ONLY, runs: [], innerTexts: {}, unmockedApi: [], nonGetRequests: [] };
const json = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const norm = (t) => (t || "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/ /g, " ");

async function newContext(browser, vp, scenario, apiLog, slug) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
  });
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  await ctx.addInitScript((token) => {
    try {
      window.localStorage.setItem("token", token);
      window.localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה" }));
    } catch {
      /* ignore */
    }
  }, FAKE_TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = req.method();
    apiLog.push(`${method} ${url.pathname}${url.search}`);
    if (method !== "GET") {
      nonGet.push({ method, path: url.pathname + url.search, page: slug, scenario, viewport: vp.name });
      return route.fulfill(json({ error: "QA harness: writes are not mocked" }, 404));
    }
    if (scenario === "loading" && SLOW_PATHS.has(url.pathname)) await new Promise((r) => setTimeout(r, 6000));
    const body = resolveApi(scenario, method, url.pathname, url.searchParams);
    if (body === undefined) {
      const k = `${method} ${url.pathname}`;
      unmocked.set(k, (unmocked.get(k) || 0) + 1);
      return route.fulfill(json({ error: "QA harness: not mocked" }, 404));
    }
    if (body && body.__status) return route.fulfill(json({ error: body.error }, body.__status));
    return route.fulfill(json(body));
  });
  ctx.on("request", (req) => {
    const u = new URL(req.url());
    if (req.method() !== "GET" && !u.pathname.startsWith("/api/") && u.origin === BASE) {
      nonGet.push({ method: req.method(), path: u.pathname + u.search, scenario, viewport: vp.name, outsideApi: true, devTooling: u.pathname.startsWith("/__nextjs") });
    }
  });
  return ctx;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function devOverlay(page) {
  return page
    .evaluate(() => {
      const portal = document.querySelector("nextjs-portal");
      const root = portal && portal.shadowRoot;
      if (!root) return null;
      const dialog = root.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay], .nextjs-container-errors-header");
      const text = ((dialog || root).textContent || "").replace(/\s+/g, " ").trim();
      return { dialogOpen: Boolean(dialog), text: dialog ? text.slice(0, 1500) : null };
    })
    .catch(() => null);
}

/* ─────────────── in-page probe ─────────────── */

const PROBE = () => {
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el, r) => ({
    tag: el.tagName.toLowerCase(),
    name: (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 50),
    w: Math.round(r.width),
    h: Math.round(r.height),
    inSideCard: Boolean(el.closest('aside[aria-label="תמונת מצב"]')),
  });
  const de = document.documentElement;
  const hscroll = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, ok: de.scrollWidth <= de.clientWidth + 1 };
  const mains = [...document.querySelectorAll("main")];
  const scope = mains.length ? mains : [document.body];
  const IGNORE = new Set(["dubiz", "qa", "ils", "usd", "eur", "nis"]);
  const english = [];
  for (const m of scope) {
    const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest("svg, script, style, noscript") || !vis(p)) continue;
      for (const word of n.textContent.match(/[A-Za-z]{3,}/g) || []) if (!IGNORE.has(word.toLowerCase())) english.push(word);
    }
  }
  const sel = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary';
  const unnamed = [];
  const small = [];
  for (const m of scope) {
    for (const el of m.querySelectorAll(sel)) {
      if (!vis(el)) continue;
      const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
      if (!name && ["a", "button"].includes(el.tagName.toLowerCase())) unnamed.push(el.outerHTML.slice(0, 140));
      let r = el.getBoundingClientRect();
      const after = getComputedStyle(el, "::after");
      if (after.content && after.content !== "none" && after.position === "absolute" && el.offsetParent) {
        const pr = el.offsetParent.getBoundingClientRect();
        if (pr.width > r.width || pr.height > r.height) r = pr;
      }
      // A link inside a sentence of running text is sized by the line (WCAG 2.5.8 inline exception).
      const inline = el.tagName === "A" && el.parentElement?.tagName === "P" && (el.parentElement.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 10;
      if (!inline && (r.height < 44 || r.width < 44)) small.push(describe(el, r));
    }
  }
  return { hscroll, english: [...new Set(english)], unnamed, small, text: document.body.innerText, url: location.href, mainCount: mains.length };
};

/* ─────────────── scenario checks ─────────────── */

async function secretaryChecks(page, vp, scenario, run) {
  const t = norm(await page.locator("main").first().innerText().catch(() => ""));
  const c = {};
  if (scenario === "prod") {
    c.headline = t.includes("3 תשלומים עברו את המועד.");
    c.no3615 = !t.includes("3,615");
    c.noReminderPromise = !/אזכיר לך|אני אזכיר/.test(t);
    // Every amount on a row is a fixture field: ledger.remaining 15 / 3500 / 30, watching 50.
    c.amounts = ["₪15", "₪3,500", "₪30", "₪50"].every((a) => t.includes(a));
    c.hrefs = await page.evaluate(() => {
      const href = (txt) => [...document.querySelectorAll("main a")].find((a) => a.innerText.trim() === txt)?.getAttribute("href") ?? null;
      return { today: href("היום שלי"), all: href("כל ההתחייבויות"), add: href("הוספה למעקב") };
    });
    c.hrefsOk = c.hrefs.today === "/secretary?today=1" && c.hrefs.all === "/secretary?screen=all" && c.hrefs.add === "/secretary?screen=bank";
    c.paidQuestion = await checkPaidQuestion(page, vp);
    if (vp.name === "1440" || vp.name === "390") c.menu = await checkMenu(page, vp);
    if (vp.name === "1440") c.keyboard = await checkKeyboard(page);
    c.allNav = await checkNav(page, "כל ההתחייבויות", /\/secretary\?screen=all$/, vp);
    c.ok = c.headline && c.no3615 && c.noReminderPromise && c.amounts && c.hrefsOk && c.paidQuestion.ok && (!c.menu || c.menu.ok) && (!c.keyboard || c.keyboard.ok) && c.allNav.ok;
  } else if (scenario === "empty") {
    c.ok = t.includes("שלום, אני המזכירה שלך.");
  } else if (scenario === "calm") {
    c.ok = t.includes("הכול רגוע השבוע.");
  } else if (scenario === "error") {
    c.hebrewError = /לא הצלחתי|נכשל|שגיאה/.test(t) && !/Internal server error/i.test(t);
    c.retry = await page.locator("main").getByRole("button", { name: /נסה שוב|לנסות שוב/ }).count();
    c.ok = c.hebrewError && c.retry > 0;
  } else if (scenario === "legacy") {
    // No ledger link → "סמן שטופל" closes directly (as before); the write fails → a Hebrew error, no dialog.
    const before = nonGet.length;
    await page.locator("main").getByRole("button", { name: "סמן שטופל" }).first().click();
    await page.waitForTimeout(1200);
    c.writesAttempted = nonGet.slice(before).map((n) => `${n.method} ${n.path}`);
    c.noDialog = (await page.getByRole("dialog").count()) === 0;
    const alert = norm(await page.locator('main [role="alert"]').first().innerText().catch(() => ""));
    c.alert = alert;
    c.ok = c.noDialog && /[֐-׿]/.test(alert) && !/QA harness|not mocked/i.test(alert);
    await page.screenshot({ path: path.join(OUT, `secretary-legacy-${vp.name}-action-error.png`), fullPage: false });
  } else if (scenario === "loading") {
    c.ok = run.loadingSeen;
  }
  return c;
}

async function checkPaidQuestion(page, vp) {
  const out = { ok: false };
  try {
    const before = nonGet.length;
    const btn = page.locator("main").getByRole("button", { name: "סמן שטופל" }).first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const dlg = page.getByRole("dialog", { name: "שילמת לגולן טלקום?" });
    await dlg.waitFor({ state: "visible", timeout: 5000 });
    out.askStep = await dlg.getByRole("button", { name: "כן, שילמתי" }).isVisible();
    out.handledOnly = await dlg.getByRole("button", { name: "לא, רק לסמן שטופל" }).isVisible();
    await page.screenshot({ path: path.join(OUT, `secretary-prod-${vp.name}-paid-question.png`) });
    await dlg.getByRole("button", { name: "ביטול" }).click();
    out.closed = await dlg.waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false);
    out.writes = nonGet.length - before;
    out.ok = out.askStep && out.handledOnly && out.closed && out.writes === 0;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

async function checkMenu(page, vp) {
  const out = { ok: false };
  try {
    const trigger = page.locator('main [aria-haspopup="menu"]').first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const menu = page.getByRole("menu").first();
    await menu.waitFor({ state: "visible", timeout: 5000 });
    const box = await menu.boundingBox();
    const v = page.viewportSize();
    out.items = (await menu.getByRole("menuitem").allInnerTexts()).map((s) => s.trim());
    out.inside = Boolean(box) && box.x >= 0 && box.x + box.width <= v.width + 0.5;
    await page.screenshot({ path: path.join(OUT, `secretary-prod-${vp.name}-menu.png`) });
    await page.keyboard.press("Escape");
    out.closed = await menu.waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false);
    // "כבר לא רלוונטי…" opens the existing ReleaseControl under the row: its own button, then the same confirm. No write.
    const before = nonGet.length;
    await trigger.click();
    await page.getByRole("menu").first().getByRole("menuitem", { name: /^כבר לא רלוונטי/ }).click();
    const row = page.locator("main li").filter({ has: page.getByRole("button", { name: "סגירה" }) }).first();
    await row.getByRole("button", { name: "כבר לא רלוונטי", exact: true }).click();
    const confirm = row.getByRole("group", { name: "אישור הסרה" });
    out.releaseConfirm = (await confirm.innerText()).includes("להסיר את ההתחייבות הזאת?") && (await confirm.getByRole("button", { name: "כן, להסיר" }).isVisible());
    await page.screenshot({ path: path.join(OUT, `secretary-prod-${vp.name}-release.png`) });
    await confirm.getByRole("button", { name: "לא, להשאיר" }).click();
    await row.getByRole("button", { name: "סגירה" }).click();
    out.releaseWrites = nonGet.length - before;
    out.ok = out.inside && out.closed && out.items.includes("פרטים") && out.items.some((s) => s.startsWith("כבר לא רלוונטי")) && out.releaseConfirm && out.releaseWrites === 0;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

async function checkKeyboard(page) {
  const out = { ok: false };
  try {
    await page.reload({ waitUntil: "load" });
    await settle(page);
    const inMain = [];
    for (let i = 0; i < 150 && inMain.length < 20; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || !el.closest("main")) return null;
        return { tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40), href: el.getAttribute("href"), menu: el.getAttribute("aria-haspopup") === "menu" };
      });
      if (d) inMain.push(d);
    }
    const row = inMain.findIndex((s) => s.tag === "a" && /screen=detail/.test(s.href || ""));
    out.order = inMain.slice(Math.max(0, row), row + 3).map((s) => (s.menu ? "⋯" : s.name));
    out.ok = row >= 0 && inMain[row + 1]?.name === "סמן שטופל" && inMain[row + 2]?.menu === true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

async function checkNav(page, linkText, expect, vp) {
  const out = { ok: false };
  try {
    const start = page.url();
    await page.locator("main").getByRole("link", { name: linkText, exact: true }).first().click();
    await page.waitForURL(expect, { timeout: 15_000 });
    out.landed = page.url().replace(BASE, "");
    await settle(page);
    await page.goBack();
    await page.waitForURL((u) => u.href === start, { timeout: 15_000 });
    out.back = page.url().replace(BASE, "");
    out.ok = !/\/payables/.test(out.landed);
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300) + ` (at ${page.url()}, ${vp.name})`;
  }
  return out;
}

const FIXTURE_ROW_AMOUNTS = ["₪15", "₪3,500", "₪30", "₪50"];
const groupHeads = (page) => page.evaluate(() => [...document.querySelectorAll("main section h2[id^='pay-group-']")].map((h) => h.innerText.replace(/[()]/g, " ").replace(/\s+/g, " ").trim()));
const boxText = (page, id) => page.evaluate((i) => (document.getElementById(i)?.closest("section")?.innerText ?? null), id);

async function payablesChecks(page, vp, scenario, run, apiLog) {
  const main = page.locator("main").first();
  const t = norm(await main.innerText().catch(() => ""));
  const c = {};
  if (scenario === "prod") {
    // Two separate boxes; every figure is a fixture field of /api/business-cost/summary:
    // upcoming.overdue.total 3545 (3 items) · next7Days.recorded 0 · next30Days.recorded 0 · next30Days.projected · baseline.monthly 65.
    const rec = norm(await boxText(page, "pay-sum-recorded"));
    const fc = norm(await boxText(page, "pay-sum-forecast"));
    c.recordedBox = rec.includes("מועדים רשומים שלא שולמו") && rec.includes("מועדים חודשיים שעוד לא נוצרו לא נכללים") && rec.includes("₪3,545") && rec.includes("3 מועדים");
    c.forecastNotDebt = fc.includes("תחזית · לא חוב") && fc.includes("₪65") && !fc.includes("₪3,545");
    c.forecastDashed = await page.evaluate(() => getComputedStyle(document.getElementById("pay-sum-forecast").closest("section")).borderStyle.includes("dashed"));
    c.noAllDebts = !t.includes("כל החובות");
    c.rowAmounts = FIXTURE_ROW_AMOUNTS.every((a) => t.includes(a));
    c.groups = await groupHeads(page);
    c.groupsOk = JSON.stringify(c.groups) === JSON.stringify(["המועד עבר 3", "מתוכנן 1"]);
    c.layout = vp.width >= 720 ? "table" : "cards";
    c.layoutOk = vp.width >= 720 ? (await main.locator("table").count()) === 2 : (await main.locator("table").count()) === 0 && (await countRows(page, vp)) === 4;
    if (vp.width >= 720) {
      c.table = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("main table tbody tr")];
        const minRow = Math.min(...rows.map((r) => r.getBoundingClientRect().height));
        const clipped = [...document.querySelectorAll("main table tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1 && /\d/.test(td.innerText)).map((td) => td.innerText);
        return { minRowHeight: Math.round(minRow), clippedNumbers: clipped };
      });
      c.tableOk = c.table.minRowHeight >= 44 && c.table.clippedNumbers.length === 0;
    }
    // Search + chips + "כולל שנסגרו" (the old "הצג הכול": scope=all).
    const search = main.getByRole("searchbox", { name: "חיפוש לפי שם התחייבות או מקבל תשלום" });
    await search.fill("דירה");
    await page.waitForTimeout(250);
    c.searchRows = await countRows(page, vp);
    await search.fill("אין כזה");
    await page.waitForTimeout(250);
    c.noResults = norm(await main.innerText()).includes("לא נמצאו התחייבויות שמתאימות לחיפוש.");
    await main.getByRole("button", { name: "נקה חיפוש וסינון" }).click();
    await main.getByRole("group", { name: "סינון מהיר" }).getByRole("button", { name: /^מתחדשות/ }).click();
    await page.waitForTimeout(250);
    c.recurringRows = await countRows(page, vp);
    await main.getByRole("group", { name: "סינון מהיר" }).getByRole("button", { name: /^הכול/ }).click();
    const before = apiLog.length;
    await main.getByRole("button", { name: /כולל שנסגרו/ }).click();
    await page.waitForTimeout(800);
    c.scopeAllRequested = apiLog.slice(before).some((l) => l.includes("/api/payables/commitments?scope=all"));
    await main.getByRole("button", { name: /כולל שנסגרו/ }).click();
    await page.waitForTimeout(500);
    c.searchOk = c.searchRows === 1 && c.noResults && c.recurringRows === 2 && c.scopeAllRequested;
    // Row open: desktop selects into the existing panel; tablet/mobile open the payment flow.
    if (vp.width >= 1200) {
      await main.locator("table").first().locator("tbody tr", { hasText: "דירה" }).first().click();
      const panel = page.locator('aside[aria-label="ההתחייבות שנבחרה"]');
      const pt = norm(await panel.innerText());
      c.panel = { title: pt.includes("דירה"), amount: pt.includes("₪3,500"), href: await panel.getByRole("link", { name: "פתח את מהלך התשלום" }).getAttribute("href"), legacyNote: pt.includes("נמסרה דרך המזכירה") };
      c.panelOk = c.panel.title && c.panel.amount && c.panel.href === "/payables/6" && c.panel.legacyNote;
      await page.screenshot({ path: path.join(OUT, `payables-prod-${vp.name}-selected.png`) });
    } else {
      if (vp.width >= 720) await main.locator("table").first().locator("tbody tr", { hasText: "דירה" }).first().click();
      else await main.locator("section[aria-labelledby^='pay-group-'] button", { hasText: "דירה" }).first().click();
      c.openFlow = await page.waitForURL(/\/payables\/6$/, { timeout: 15_000 }).then(() => true).catch(() => false);
      await page.goBack();
      await page.waitForURL(/\/payables$/, { timeout: 15_000 }).catch(() => {});
      await settle(page);
      c.panelOk = c.openFlow;
    }
    // Toolbar + the unchanged inline form.
    await main.getByRole("button", { name: "התחייבות חדשה" }).click();
    c.formOpens = await main.locator("form").first().isVisible().catch(() => false);
    await main.getByRole("button", { name: "סגור" }).click();
    c.toolbar = await checkToolbar(page, vp);
    c.ok = c.recordedBox && c.forecastNotDebt && c.forecastDashed && c.noAllDebts && c.rowAmounts && c.groupsOk && c.layoutOk && (c.tableOk ?? true) && c.searchOk && c.panelOk && c.formOpens && c.toolbar.ok;
  } else if (scenario === "empty") {
    c.noBoxes = (await page.locator("#pay-sum-recorded").count()) === 0;
    c.ok = t.includes("אין עדיין התחייבויות") && c.noBoxes && !t.includes("כל החובות");
  } else if (scenario === "calm") {
    c.groups = await groupHeads(page);
    c.ok = JSON.stringify(c.groups) === JSON.stringify(["מתוכנן 1"]) && t.includes("₪0") && t.includes("₪50");
  } else if (scenario === "error") {
    c.ok = t.includes("טעינת ההתחייבויות נכשלה.") && !/Internal server error/i.test(t) && (await main.getByRole("button", { name: "נסה שוב" }).count()) > 0;
  } else if (scenario === "summaryFail") {
    c.ok = t.includes("לא הצלחנו לטעון את תמונת המצב הכספית") && FIXTURE_ROW_AMOUNTS.every((a) => t.includes(a));
  } else if (scenario === "loading") {
    c.ok = run.loadingSeen;
  }
  return c;
}

async function countRows(page, vp) {
  return page.evaluate((wide) => (wide ? document.querySelectorAll("main table tbody tr").length : document.querySelectorAll("main section[aria-labelledby^='pay-group-'] button").length), vp.width >= 720);
}

async function checkToolbar(page, vp) {
  const out = { ok: false };
  try {
    for (const [name, re] of [["צ׳קים וחשבונות בנק", /\/payables\/cheques$/], ["תנועות בנק", /\/payables\/bank$/]]) {
      if (vp.width < 720) {
        // Phone: the two secondary tools sit in the "עוד" menu.
        await page.locator("main").getByRole("button", { name: "עוד" }).click();
        await page.getByRole("menu", { name: "פעולות נוספות" }).getByRole("menuitem", { name }).click();
      } else {
        await page.locator("main").getByRole("button", { name }).click();
      }
      await page.waitForURL(re, { timeout: 15_000 });
      await page.goBack();
      await page.waitForURL(/\/payables$/, { timeout: 15_000 });
      await settle(page);
    }
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

/* ─────────────── run ─────────────── */

const browser = await chromium.launch();
const t0 = Date.now();

async function capture(p, scenario, vp) {
  const apiLog = [];
  const ctx = await newContext(browser, vp, scenario, apiLog, p.slug);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
  const run = { page: p.slug, path: p.path, scenario, viewport: vp.name, screenshot: null, error: null };
  const shot = path.join(OUT, `${p.slug}-${scenario}-${vp.name}.png`);
  try {
    const resp = await page.goto(BASE + p.path, { waitUntil: scenario === "loading" ? "domcontentloaded" : "load", timeout: 600_000 });
    run.status = resp ? resp.status() : null;
    if (scenario === "loading") {
      await page.waitForTimeout(2500);
      const lt = norm(await page.locator("body").innerText());
      run.loadingSeen = (await page.locator('[aria-busy="true"]').count()) > 0 || lt.includes("טוען");
      await page.screenshot({ path: shot, fullPage: true });
      run.screenshot = path.relative(ROOT, shot).replace(/\\/g, "/");
    }
    await settle(page);
    if (scenario !== "loading") {
      await page.screenshot({ path: shot, fullPage: true });
      run.screenshot = path.relative(ROOT, shot).replace(/\\/g, "/");
    }
    const probe = await page.evaluate(PROBE);
    run.finalUrl = probe.url.replace(BASE, "");
    run.mainCount = probe.mainCount;
    const overlay = await devOverlay(page);
    if (overlay?.dialogOpen) run.error = "Next dev error overlay: " + (overlay.text || "").slice(0, 400);
    run.layout = { noHorizontalScroll: probe.hscroll, englishWords: probe.english, unnamedControls: probe.unnamed, smallTapTargets: vp.name === "390" ? probe.small : undefined };
    if (p.group === "inner") {
      // Inner payables screens have no <main>; the same selector is used on every branch.
      const sel = p.textSel ?? ((await page.locator("main").count()) > 0 ? "main" : "body");
      const text = await page.locator(sel).first().innerText({ timeout: 10_000 }).catch(() => "");
      results.innerTexts[`${p.slug}@${vp.name}`] = norm(text).replace(/[ \t]+/g, " ").trim();
    } else if (p.group === "secretary") {
      run.checks = await secretaryChecks(page, vp, scenario, run);
    } else if (p.group === "payables") {
      run.checks = await payablesChecks(page, vp, scenario, run, apiLog);
    }
  } catch (e) {
    run.error = (run.error ? run.error + " | " : "") + String(e?.message ?? e).slice(0, 600);
    try {
      await page.screenshot({ path: shot, fullPage: true });
      run.screenshot = path.relative(ROOT, shot).replace(/\\/g, "/");
    } catch {
      /* ignore */
    }
  }
  run.consoleErrors = consoleErrors.filter((m) => !/Failed to load resource: the server responded with a status of (404|500)/.test(m));
  run.pageErrors = pageErrors;
  await ctx.close();
  return run;
}

for (const p of PAGES) {
  for (const scenario of p.scenarios) {
    for (const vp of VIEWPORTS) {
      const r = await capture(p, scenario, vp);
      results.runs.push(r);
      const verdict = r.error ? "ERROR" : r.checks ? (r.checks.ok ? "PASS" : "FAIL") : "ok";
      console.log(`${verdict.padEnd(5)} ${p.slug}-${scenario}-${vp.name}${r.error ? "  " + r.error.slice(0, 200) : ""}`);
    }
  }
}
await browser.close();

/* ─────────────── aggregate ─────────────── */

const runs = results.runs;
const summary = [];
const add = (id, check, pass, detail) => summary.push({ id, check, result: pass === null ? "N/A" : pass ? "PASS" : "FAIL", detail });
const mainRuns = runs.filter((r) => r.page === "secretary" || r.page === "payables");
add(1, "Rendered without compile/runtime error", runs.every((r) => !r.error), runs.filter((r) => r.error).map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.error}`));
add(2, "Main-screen scenario checks", mainRuns.length ? mainRuns.every((r) => r.checks?.ok) : null, mainRuns.filter((r) => !r.checks?.ok).map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${String(JSON.stringify(r.checks ?? { error: r.error })).slice(0, 700)}`));
const hs = runs.filter((r) => r.layout && !r.layout.noHorizontalScroll.ok);
add(3, "No horizontal scroll (all screens, all widths)", hs.length === 0, hs.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.layout.noHorizontalScroll.scrollWidth}>${r.layout.noHorizontalScroll.clientWidth}`));
const en = mainRuns.filter((r) => r.layout?.englishWords.length);
add(4, "No visible English on the main screens", en.length === 0, en.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.layout.englishWords.join(", ")}`));
const un = mainRuns.filter((r) => r.layout?.unnamedControls.length);
add(5, "Every control on the main screens has a name", un.length === 0, un.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.layout.unnamedControls.join(" | ").slice(0, 300)}`));
const st = mainRuns.filter((r) => r.viewport === "390" && r.layout?.smallTapTargets?.some((s) => !s.inSideCard));
add(6, "Mobile tap targets >= 44px on the main screens (embedded side cards reported separately)", st.length === 0, st.map((r) => `${r.page}-${r.scenario}: ${r.layout.smallTapTargets.filter((s) => !s.inSideCard).map((s) => `${s.tag}"${s.name}"${s.w}x${s.h}`).join("; ").slice(0, 400)}`));
const sideSmall = mainRuns.filter((r) => r.viewport === "390" && r.layout?.smallTapTargets?.some((s) => s.inSideCard));
add("6b", "Info: small targets inside the embedded cost/leads cards (pre-existing, T5)", null, sideSmall.map((r) => `${r.page}-${r.scenario}: ${r.layout.smallTapTargets.filter((s) => s.inSideCard).map((s) => `${s.tag}"${s.name}"${s.w}x${s.h}`).join("; ").slice(0, 300)}`));
// Reproduced on main 07a3d025 too: browser back from /payables/cheques to /payables logs this React dev warning.
// Pre-existing and outside the two main screens' scope — listed as 7b, never hidden.
const KNOWN_PREEXISTING = /useInsertionEffect must not schedule updates/;
const ce = runs.filter((r) => r.pageErrors.length || r.consoleErrors.some((m) => !KNOWN_PREEXISTING.test(m)));
add(7, "No console/page errors (404/500 resource lines from the mocked failures excluded)", ce.length === 0, ce.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${[...r.pageErrors, ...r.consoleErrors].slice(0, 3).join(" || ").slice(0, 300)}`));
const known = runs.filter((r) => r.consoleErrors.some((m) => KNOWN_PREEXISTING.test(m)));
add("7b", "Info: pre-existing dev warning on back from /payables/cheques (same on main)", null, known.map((r) => `${r.page}-${r.scenario}-${r.viewport}`));
// /tasks syncs its agenda on open (its own existing behaviour); the harness answers 404 — nothing reaches a server.
const expectedWrite = (n) => n.devTooling || n.scenario === "legacy" || (n.page === "tasks" && n.path === "/api/tasks/sync");
const writes = nonGet.filter((n) => !expectedWrite(n));
add(8, "Zero writes from the main screens (legacy action-error + /tasks own sync listed, intercepted)", writes.length === 0, [...new Set(nonGet.map((n) => `${n.method} ${n.path} (${n.page ?? "-"}/${n.scenario})${n.devTooling ? " [dev tooling]" : expectedWrite(n) ? " [expected, intercepted]" : ""}`))]);
const mc = runs.filter((r) => r.mainCount > 1);
add(9, "One <main> per page", mc.length === 0, mc.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.mainCount}`));

results.finishedAt = new Date().toISOString();
results.durationSec = Math.round((Date.now() - t0) / 1000);
results.summary = summary;
results.unmockedApi = [...unmocked.entries()].map(([k, n]) => ({ request: k, count: n }));
results.nonGetRequests = nonGet;
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));

console.log(`\n[${LABEL}]  #   | result | check`);
for (const s of summary) {
  console.log(`${String(s.id).padEnd(4)} | ${s.result.padEnd(6)} | ${s.check}`);
  for (const d of s.detail.slice(0, 14)) console.log(`      - ${d}`);
}
console.log(`\nUn-mocked /api calls: ${results.unmockedApi.length ? results.unmockedApi.map((u) => `${u.request} x${u.count}`).join(", ") : "none"}`);
console.log(`Results: ${path.relative(ROOT, path.join(OUT, "results.json"))} (${results.durationSec}s)`);
if (!existsSync(OUT)) process.exit(1);
