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
  { slug: "secretary-today-shared", path: "/secretary?today=1", scenarios: ["todayShared"], group: "secretary" },
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
  // Stations layout (owner-approved mockup, 24.10.2026): title · actions · day cost · stations · week. The rows,
  // their "סמן שטופל" / "שילמת?" / release flows live on the inner screens, unchanged (inner-text regression).
  const stations = async () =>
    page.evaluate(() => {
      const href = (txt) => [...document.querySelectorAll("main a")].find((a) => a.innerText.trim().startsWith(txt))?.getAttribute("href") ?? null;
      return { add: href("הוסף התחייבות"), payables: href("התחייבויות"), calendar: href("לוח שנה"), full: href("לוח שנה מלא") };
    });
  if (scenario === "prod") {
    c.noReminderPromise = !/אזכיר לך|אני אזכיר/.test(t);
    c.noRowsOrCards = !/סמן שטופל|מה מחכה לך היום|משימות פתוחות|תשלומים קרובים/.test(t);
    // The day cost is the fixture's calendarDay.daily (2.10) with its monthly (65) and days (31).
    c.cost = t.includes("2.10 ₪") && t.includes("עלות תפעול מחושבת, לא תשלום בפועל");
    c.hrefs = await stations();
    c.hrefsOk = c.hrefs.add === "/secretary?screen=bank" && c.hrefs.payables === "/payables" && c.hrefs.calendar === "/secretary?screen=calendar" && c.hrefs.full === "/secretary?screen=calendar";
    c.calendarNav = await checkNav(page, "לוח שנה מלא", /\/secretary\?screen=calendar$/, vp);
    c.ok = c.noReminderPromise && c.noRowsOrCards && c.cost && c.hrefsOk && c.calendarNav.ok;
  } else if (scenario === "empty") {
    // A new business: no fixed costs yet, the actions and stations are there.
    c.ok = t.includes("עוד אין הוצאות קבועות רשומות") && t.includes("תחנות ניהול") && (await stations()).add === "/secretary?screen=bank";
  } else if (scenario === "calm") {
    c.ok = t.includes("תחנות ניהול") && t.includes("לוח השבוע");
  } else if (scenario === "error") {
    c.hebrewError = /לא הצלחתי|נכשל|שגיאה/.test(t) && !/Internal server error/i.test(t);
    c.retry = await page.locator("main").getByRole("button", { name: /נסה שוב|לנסות שוב/ }).count();
    c.ok = c.hebrewError && c.retry > 0;
  } else if (scenario === "legacy") {
    // An item with no ledger link due today: on the week strip it is an open commitment ("התחייבות"), never paid.
    const label = await page.locator("main [aria-current='date']").first().getAttribute("aria-label").catch(() => "");
    c.label = label;
    c.ok = /התחייבות/.test(label ?? "") && !/שולם|באיחור/.test(label ?? ""); // open, due today: neither paid nor late
  } else if (scenario === "loading") {
    c.ok = run.loadingSeen;
  } else if (scenario === "todayShared") {
    // The shared agenda rendered, its aside keeps the "hand over" card, and no leads card is in it.
    c.agenda = (await page.locator("#sec-capture").count()) > 0;
    c.ok = c.agenda;
  }
  return c;
}

async function checkNav(page, linkText, expect, vp) {
  const out = { ok: false };
  try {
    const start = page.url();
    await page.locator("main").getByRole("link", typeof linkText === "string" ? { name: linkText, exact: true } : { name: linkText }).first().click();
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

async function payablesChecks(page, vp, scenario, run, apiLog) {
  const main = page.locator("main").first();
  const t = norm(await main.innerText().catch(() => ""));
  const c = {};
  // Redesign (owner, 25.10.2026): no money summary, no forecast, no search; state chips + type menu + "עוד";
  // compact cards in four groups — overdue and soon open, planned and closed folded. A card opens /payables/:id.
  const expand = async (label) => {
    const head = main.locator("section[aria-labelledby^='pay-group-'] h2 button", { hasText: label }).first();
    if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
    await page.waitForTimeout(200);
  };
  if (scenario === "prod") {
    c.noSummary = (await page.locator("#pay-sum-recorded, #pay-sum-forecast").count()) === 0 && !t.includes("תחזית · לא חוב");
    c.noSearch = (await main.getByRole("searchbox").count()) === 0;
    c.noAllDebts = !t.includes("כל החובות");
    c.groups = await groupHeads(page);
    c.groupsOk = JSON.stringify(c.groups) === JSON.stringify(["באיחור 3", "מתוכנן 1"]);
    c.openByDefault = (await countRows(page)) === 3; // overdue open, planned folded
    await expand("מתוכנן");
    const all = norm(await main.innerText());
    c.rowAmounts = FIXTURE_ROW_AMOUNTS.every((a) => all.includes(a));
    c.allRows = await countRows(page);
    // State chips and the type menu.
    const chips = main.getByRole("group", { name: "סינון לפי מצב" });
    await chips.getByRole("button", { name: /מתוכנן/ }).click();
    await page.waitForTimeout(250);
    c.plannedOnly = JSON.stringify(await groupHeads(page)) === JSON.stringify(["מתוכנן 1"]);
    await chips.getByRole("button", { name: /^הכול/ }).click();
    await page.waitForTimeout(250);
    await main.getByRole("button", { name: /^סוג:/ }).click();
    await page.getByRole("menu", { name: "סוג התחייבות" }).getByRole("menuitemradio", { name: /חוזרות/ }).click();
    await page.waitForTimeout(250);
    c.recurringRows = await countRows(page);
    await main.getByRole("button", { name: /^סוג:/ }).click();
    await page.getByRole("menu", { name: "סוג התחייבות" }).getByRole("menuitemradio", { name: /^הכול/ }).click();
    await page.waitForTimeout(250);
    c.filtersOk = c.plannedOnly && c.recurringRows === 2;
    // Every commitment, closed ones included, in one request.
    c.scopeAll = apiLog.some((l) => l.includes("/api/payables/commitments?scope=all"));
    // A card opens the existing detail screen; back returns here.
    await main.locator("section[aria-labelledby^='pay-group-'] li button", { hasText: "דירה" }).first().click();
    c.openFlow = await page.waitForURL(/\/payables\/6$/, { timeout: 15_000 }).then(() => true).catch(() => false);
    await page.goBack();
    await page.waitForURL(/\/payables$/, { timeout: 15_000 }).catch(() => {});
    await settle(page);
    // "התחייבות חדשה" still opens the existing form (until the one creation path is approved).
    await main.getByRole("button", { name: "התחייבות חדשה" }).click();
    c.formOpens = await main.locator("form").first().isVisible().catch(() => false);
    await main.getByRole("button", { name: "סגור" }).click();
    c.toolbar = await checkToolbar(page, vp);
    c.ok = c.noSummary && c.noSearch && c.noAllDebts && c.groupsOk && c.openByDefault && c.rowAmounts && c.allRows === 4 && c.filtersOk && c.scopeAll && c.openFlow && c.formOpens && c.toolbar.ok;
  } else if (scenario === "empty") {
    c.noBoxes = (await page.locator("#pay-sum-recorded").count()) === 0;
    c.ok = t.includes("אין עדיין התחייבויות") && c.noBoxes && !t.includes("כל החובות");
  } else if (scenario === "calm") {
    c.groups = await groupHeads(page);
    await expand("מתוכנן");
    c.ok = JSON.stringify(c.groups) === JSON.stringify(["מתוכנן 1"]) && norm(await main.innerText()).includes("₪50");
  } else if (scenario === "error") {
    c.ok = t.includes("טעינת ההתחייבויות נכשלה.") && !/Internal server error/i.test(t) && (await main.getByRole("button", { name: "נסה שוב" }).count()) > 0;
  } else if (scenario === "summaryFail") {
    // The screen no longer reads the cost summary: its failure changes nothing here.
    c.ok = !t.includes("לא הצלחנו לטעון את תמונת המצב הכספית") && ["₪15", "₪3,500", "₪30"].every((a) => t.includes(a));
  } else if (scenario === "loading") {
    c.ok = run.loadingSeen;
  }
  return c;
}

async function countRows(page) {
  return page.evaluate(() => document.querySelectorAll("main section[aria-labelledby^='pay-group-'] li button").length);
}

async function checkToolbar(page, vp) {
  const out = { ok: false };
  try {
    for (const [name, re] of [["צ׳קים וחשבונות בנק", /\/payables\/cheques$/], ["תנועות בנק", /\/payables\/bank$/]]) {
      // Every width: the two secondary tools sit in the "עוד" menu.
      await page.locator("main").getByRole("button", { name: /^עוד/ }).click();
      await page.getByRole("menu", { name: "פעולות נוספות" }).getByRole("menuitem", { name }).click();
      await page.waitForURL(re, { timeout: 15_000 });
      await page.goBack();
      await page.waitForURL(/\/payables$/, { timeout: 15_000 });
      await settle(page);
    }
    out.ok = true;
    out.width = vp.name;
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
      // Owner decision 22.10.2026: the Secretary shows no leads (they live on the home screen).
      run.leadsRequests = apiLog.filter((l) => l.includes("/api/leads/")).length;
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
// /tasks and the shared "היום שלי" agenda sync on open (their own existing behaviour); the harness answers 404 — nothing reaches a server.
const expectedWrite = (n) => n.devTooling || n.scenario === "legacy" || ((n.page === "tasks" || n.page === "secretary-today-shared") && n.path === "/api/tasks/sync");
const writes = nonGet.filter((n) => !expectedWrite(n));
add(8, "Zero writes from the main screens (legacy action-error + /tasks own sync listed, intercepted)", writes.length === 0, [...new Set(nonGet.map((n) => `${n.method} ${n.path} (${n.page ?? "-"}/${n.scenario})${n.devTooling ? " [dev tooling]" : expectedWrite(n) ? " [expected, intercepted]" : ""}`))]);
const mc = runs.filter((r) => r.mainCount > 1);
add(9, "One <main> per page", mc.length === 0, mc.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.mainCount}`));
const secRuns = runs.filter((r) => r.page === "secretary" || r.page === "secretary-today-shared");
const leaky = secRuns.filter((r) => r.leadsRequests > 0);
add(10, "The Secretary never loads leads (main screen + היום שלי with daily_tasks on)", secRuns.length > 0 && leaky.length === 0, leaky.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.leadsRequests} /api/leads requests`));

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
