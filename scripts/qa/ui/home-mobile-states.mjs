/**
 * Runtime QA — the mobile Home, every state, every phone width.
 *
 * The screen is driven by five reads, so the states are produced by answering
 * those reads. Nothing is mocked inside the app: the real client code runs
 * against real HTTP responses, which is what makes "a failed source never
 * renders as ₪0" a provable claim rather than a hope.
 *
 * Usage: node scripts/qa/ui/home-mobile-states.mjs <baseUrl> <outDir>
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const [BASE = "http://127.0.0.1:3062", OUT = "./qa-home-mobile"] = process.argv.slice(2);

const iso = (days, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const obligation = (id, name, amount, dueAt) => ({
  id, obligeeName: name, amount, currency: "ILS", dueAt, state: "OPEN", source: "MANUAL",
  recurrence: "NONE", recurrenceSeriesId: null, note: null, followUpAt: null,
  settlementAssertedBy: null, metAt: null, releasedAt: null, createdAt: iso(-40), updatedAt: iso(-40),
});

const statusItem = (id, domain, severity, title, summary, href, score) => ({
  itemId: id, domain, semanticCategory: "ACTION_REQUIRED", title, summary, severity,
  priorityScore: score, entityRef: { type: domain, id: 1 }, state: "open", createdAt: iso(-1),
  primaryAction: { kind: "navigate", label: "פתח", href }, sourceEngine: "qa-fixture",
});

/** A cumulative series from hourly amounts. */
const cumulative = (pairs, length) => {
  const per = new Array(length).fill(0);
  for (const [i, v] of pairs) per[i] += v;
  let run = 0;
  return per.map((v) => (run += v).toFixed(2));
};

const dayPeriod = (currentPairs, previousPairs, elapsed, cutoff) => ({
  timezone: "Asia/Jerusalem",
  granularity: "hour",
  current: {
    points: cumulative(currentPairs, 24),
    elapsedPoints: elapsed,
    total: currentPairs.reduce((a, [, v]) => a + v, 0).toFixed(2),
    count: currentPairs.length,
  },
  previous: {
    points: cumulative(previousPairs, 24),
    elapsedPoints: 24,
    total: previousPairs.reduce((a, [, v]) => a + v, 0).toFixed(2),
    count: previousPairs.length,
  },
  cutoffLabel: cutoff,
  window: { from: "2026-09-23", to: "2026-09-23" },
  previousWindow: { from: "2026-09-22", to: "2026-09-22" },
});

const TODAY_PAIRS = [[7, 140], [9, 180], [11, 120], [14, 180]];
const YESTERDAY_PAIRS = [[8, 120], [10, 140], [13, 160], [16, 220], [19, 280], [21, 260]];
const BEFORE_PAIRS = [[9, 200], [12, 300], [15, 260], [18, 180]];
const WEEK_PAIRS = [[0, 900], [1, 1200], [2, 650], [3, 1400], [4, 1100], [5, 1180], [6, 620]];
const PREV_WEEK_PAIRS = [[0, 700], [1, 900], [2, 800], [3, 1000], [4, 950], [5, 700], [6, 550]];

function periodPayload(period, fx) {
  if (fx.emptyCollection) {
    const base = dayPeriod([], [], 16, "15:25");
    return { ...base, period, previousAtSamePoint: "0.00", changePct: null, month: fx.month };
  }
  if (period === "yesterday") {
    const base = dayPeriod(YESTERDAY_PAIRS, BEFORE_PAIRS, 24, null);
    return { ...base, period, previousAtSamePoint: "940.00", changePct: 26, month: fx.month };
  }
  if (period === "week") {
    return {
      timezone: "Asia/Jerusalem",
      period,
      granularity: "day",
      current: { points: cumulative(WEEK_PAIRS, 7), elapsedPoints: 7, total: "7050.00", count: 22 },
      previous: { points: cumulative(PREV_WEEK_PAIRS, 7), elapsedPoints: 7, total: "5600.00", count: 18 },
      previousAtSamePoint: "5210.00",
      changePct: 35,
      cutoffLabel: "15:25",
      window: { from: "2026-09-17", to: "2026-09-23" },
      previousWindow: { from: "2026-09-10", to: "2026-09-16" },
      month: fx.month,
    };
  }
  const base = dayPeriod(TODAY_PAIRS, YESTERDAY_PAIRS, 16, "15:25");
  return { ...base, period, previousAtSamePoint: "484.00", changePct: 28, month: fx.month };
}

const MONTH = { key: "2026-09", amount: "8100.00", count: 9, previousAmount: "5200.00", changePct: 56 };

const BUSY = {
  month: MONTH,
  briefing: {
    state: "BUSY", oriented: true,
    attention: [
      { obligation: obligation(31, "גולן טלקום", "35.00", iso(-3)), reason: "OVERDUE" },
      { obligation: obligation(32, "דירה", "3500.00", iso(0, 9)), reason: "DUE_TODAY" },
    ],
    watching: [], counts: { open: 2, attention: 2, breakToday: 0, watching: 0 }, generatedAt: iso(0),
  },
  status: [
    statusItem("d1", "documents", "MEDIUM", "חשבונית מספק", "חומרי בניין הגליל · ₪480", "/documents/inbox", 80),
    statusItem("l1", "leads", "HIGH", "ליד ממתין לתשובה", "שירן גולן · פנתה אתמול", "/leads/91", 70),
    statusItem("i1", "inventory", "MEDIUM", "מוצר עומד להיגמר", "פיתות · 12 יחידות", "/inventory/items/4", 50),
  ],
  awaiting: { totalOutstanding: "9340.00", customerCount: 3 },
};

const QUIET = {
  month: { key: "2026-09", amount: "1250.00", count: 2, previousAmount: "0.00", changePct: null },
  emptyCollection: true,
  briefing: {
    state: "CALM", oriented: true, attention: [], watching: [],
    counts: { open: 0, attention: 0, breakToday: 0, watching: 0 }, generatedAt: iso(0),
  },
  status: [],
  awaiting: { totalOutstanding: "0.00", customerCount: 0 },
};

const FIXTURES = { busy: BUSY, quiet: QUIET };

async function install(page, state) {
  const fx = FIXTURES[state] ?? BUSY;
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", (r) => r.abort());

  await page.route("**/api/home", (r) =>
    r.fulfill(json({
      heroAction: null, quickActions: [],
      businessSnapshot: { businessName: "העסק שלי", greeting: "", ownerName: "אלדד" },
      leadsAttention: { count: 0, href: "/leads" },
    }))
  );
  await page.route("**/api/home/collection**", (route) => {
    if (state === "loading") return;
    if (state === "partial") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    const period = new URL(route.request().url()).searchParams.get("period") ?? "today";
    return route.fulfill(json(periodPayload(period, fx)));
  });
  await page.route("**/api/obligations/briefing", (route) => {
    if (state === "loading") return;
    return route.fulfill(json(fx.briefing));
  });
  await page.route("**/api/business-status", (route) => {
    if (state === "loading") return;
    return route.fulfill(json({ items: fx.status }));
  });
  await page.route("**/api/billing/collection/awaiting", (route) => {
    if (state === "loading") return;
    if (state === "partial") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    return route.fulfill(json(fx.awaiting));
  });
  await page.route("**/api/billing/invoice-profile", (r) => r.fulfill(json({ profile: { billingLogoDataUrl: null } })));
  await page.route("**/api/notifications/unread-count", (r) => r.fulfill(json({ unreadCount: 3 })));
}

const rows = [];

async function run(browser, { state, width, file, mode = "full", period = null }) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 },
    locale: "he-IL",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  const bad = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !t.includes("Failed to load resource")) errs.push(t.slice(0, 160));
  });
  page.on("response", (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url().slice(0, 70)}`); });
  await install(page, state);

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("token", "qa-token"));
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dzhome", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  if (period) {
    await page.click(`.seg-b:nth-child(${period === "today" ? 1 : period === "yesterday" ? 2 : 3})`);
    await page.waitForTimeout(900);
  }

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const nav = document.querySelector('[data-component="shell-bottom-bar"]')?.getBoundingClientRect();
    const fold = nav ? nav.top : innerHeight;
    const where = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return "—";
      const r = el.getBoundingClientRect();
      if (r.bottom <= fold) return `in (${Math.round(r.top)}–${Math.round(r.bottom)})`;
      return r.top < fold ? `partly (${Math.round(r.top)})` : `below (${Math.round(r.top)})`;
    };
    const taps = [...document.querySelectorAll(".dzhome a[href], .dzhome button")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { t: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 16), w: Math.round(r.width), h: Math.round(r.height) };
      })
      .filter((x) => x.w > 0 && x.h > 0);
    const fab = document.querySelector('[aria-label="פתח תפריט נגישות"]')?.getBoundingClientRect();
    const leaves = [...document.querySelectorAll(".dzhome b, .dzhome p, .dzhome h1, .dzhome h2, .dzhome span, .dzhome svg")]
      .filter((el) => el.tagName !== "A" && (el.children.length === 0 || el.tagName === "svg") && ((el.textContent || "").trim().length > 0 || el.tagName === "svg"));
    const inkRects = (el) => {
      if (el.tagName === "svg") return [el.getBoundingClientRect()];
      const rg = document.createRange();
      rg.selectNodeContents(el);
      return [...rg.getClientRects()];
    };
    const hitEls = fab
      ? leaves.filter((el) => inkRects(el).some((r) => r.width > 0 && r.left < fab.right && r.right > fab.left && r.top < fab.bottom && r.bottom > fab.top))
      : [];
    const fabHits = hitEls.length;
    const fabHitNames = hitEls.map((el) => el.tagName + String.fromCharCode(171) + (el.textContent || "").trim().slice(0, 22) + String.fromCharCode(187) + "@" + String(el.className || ""));
    const rail = document.querySelector(".rc-rail");
    const items = [...document.querySelectorAll(".rc-item")].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
    });
    const clipped = [...document.querySelectorAll(".dzhome .rc-cta, .dzhome .fam-t, .dzhome .col-amt, .dzhome .rc-amt")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.className + "«" + el.textContent.trim().slice(0, 18) + "»");
    return {
      sw: de.scrollWidth, iw: innerWidth, h: de.scrollHeight, fold: Math.round(fold),
      amount: document.querySelector(".col-amt")?.textContent?.trim() ?? document.querySelector(".col-off")?.textContent?.trim() ?? null,
      delta: document.querySelector(".col-head .delta")?.textContent?.trim() ?? null,
      comparison: document.querySelector(".col-cmp")?.textContent?.trim() ?? null,
      chartNone: document.querySelector(".chart-none")?.textContent?.trim() ?? null,
      segOn: document.querySelector(".seg-b.on")?.textContent?.trim() ?? null,
      figures: [...document.querySelectorAll(".fig")].map((f) => f.textContent.trim().slice(0, 40)),
      receipts: [...document.querySelectorAll(".rc-item")].map((r) => ({
        title: r.querySelector(".rc-title")?.textContent?.trim(),
        kind: r.querySelector(".rc-kind")?.textContent?.trim(),
        chip: r.querySelector(".rc-chip")?.textContent?.trim() ?? null,
        cta: r.querySelector(".rc-cta")?.textContent?.trim(),
        href: r.querySelector(".rc-paper")?.getAttribute("href"),
      })),
      railScrollable: rail ? rail.scrollWidth > rail.clientWidth + 2 : false,
      items,
      dots: document.querySelectorAll(".rc-dots span").length,
      families: [...document.querySelectorAll(".fam")].map((f) => ({
        title: f.querySelector(".fam-t")?.textContent?.trim(),
        line: f.querySelector(".fam-l")?.textContent?.trim(),
        icons: f.querySelector(".fam-ic")?.querySelectorAll("svg").length ?? 0,
        href: f.getAttribute("href"),
      })),
      hasSecretaryStrip: /המזכירה שלך|אני כאן בשבילך|דברים לטיפול/.test(document.body.innerText),
      hasCount: /\d+\s*כלים/.test(document.body.innerText),
      minTap: taps.length ? Math.min(...taps.map((x) => Math.min(x.w, x.h))) : null,
      smallTaps: taps.filter((x) => Math.min(x.w, x.h) < 44),
      fabHits,
      fabHitNames,
      contentH: Math.round(document.querySelector(".dzhome .w")?.getBoundingClientRect().height ?? 0),
      clipped,
      layers: {
        header: where(".top"), collection: where(".col"), chart: where(".chart-svg, .chart-none"),
        figures: where(".figs"), receipts: where(".rc, .rc-calm"), families: where(".dz h2"),
      },
    };
  });

  rows.push({ state, width, period: period ?? "today", overflow: m.sw > m.iw + 1, errs, bad, ...m });

  if (file) {
    if (mode === "full") {
      await page.setViewportSize({ width, height: Math.max(844, m.h) });
      await page.waitForTimeout(350);
    }
    await page.screenshot({ path: `${OUT}/${file}` });
  }
  await ctx.close();
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

await run(browser, { state: "busy", width: 390, file: "A-busy-390-full.png" });
await run(browser, { state: "busy", width: 390, file: "B-busy-390-fold.png", mode: "fold" });
await run(browser, { state: "quiet", width: 390, file: "C-quiet-390-full.png" });
await run(browser, { state: "busy", width: 390, file: "D-today-390.png", mode: "fold", period: "today" });
await run(browser, { state: "busy", width: 390, file: "E-yesterday-390.png", mode: "fold", period: "yesterday" });
await run(browser, { state: "busy", width: 390, file: "F-week-390.png", mode: "fold", period: "week" });
await run(browser, { state: "busy", width: 360, file: "G-busy-360-full.png" });
await run(browser, { state: "busy", width: 430, file: "H-busy-430-full.png" });
await run(browser, { state: "loading", width: 390, file: "I-loading-390.png", mode: "fold" });
await run(browser, { state: "partial", width: 390, file: "J-partial-390.png", mode: "fold" });
await run(browser, { state: "quiet", width: 360, file: null, mode: "fold" });
await run(browser, { state: "quiet", width: 430, file: null, mode: "fold" });

await browser.close();
for (const r of rows) console.log(JSON.stringify(r));
