/**
 * Runtime QA — the Home screen, every state, every phone width.
 *
 * The screen is driven entirely by five reads, so the states are produced by
 * answering those reads: BUSY, CALM, QUIET (a young business), LOADING (never
 * answered) and PARTIAL (the money read fails while the rest succeed). Nothing
 * is mocked inside the app — the real client code runs against real HTTP
 * responses, which is what makes "a failed source never renders as ₪0" a
 * provable claim rather than a hope.
 *
 * Usage: node scripts/qa/ui/home-final-states.mjs <baseUrl> <outDir>
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const [BASE = "http://127.0.0.1:3061", OUT = "./qa-home"] = process.argv.slice(2);

const todayKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const dayKey = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
};

const hours = (pairs) => {
  const out = new Array(24).fill("0.00");
  for (const [h, v] of pairs) out[h] = v.toFixed(2);
  return out;
};
const sum = (pairs) => pairs.reduce((a, [, v]) => a + v, 0).toFixed(2);

const DAYS = {
  [dayKey(0)]: [[9, 620]],
  [dayKey(-1)]: [[11, 480], [14, 1180], [18, 300]],
  [dayKey(-2)]: [[10, 820]],
};

const iso = (days, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const obligation = (id, name, amount, dueAt) => ({
  id,
  obligeeName: name,
  amount,
  currency: "ILS",
  dueAt,
  state: "OPEN",
  source: "MANUAL",
  recurrence: "NONE",
  recurrenceSeriesId: null,
  note: null,
  followUpAt: null,
  settlementAssertedBy: null,
  metAt: null,
  releasedAt: null,
  createdAt: iso(-40),
  updatedAt: iso(-40),
});

const statusItem = (id, domain, severity, title, summary, href, score) => ({
  itemId: id,
  domain,
  semanticCategory: "ACTION_REQUIRED",
  title,
  summary,
  severity,
  priorityScore: score,
  entityRef: { type: domain, id: 1 },
  state: "open",
  createdAt: iso(-1),
  primaryAction: { kind: "navigate", label: "פתח", href },
  sourceEngine: "qa-fixture",
});

const BUSY = {
  briefing: {
    state: "BUSY",
    oriented: true,
    attention: [
      { obligation: obligation(31, "חברת החשמל", "1250.00", iso(1)), reason: "DUE_SOON" },
      { obligation: obligation(32, "שכר דירה — הסטודיו", "6400.00", iso(1, 9)), reason: "DUE_SOON" },
    ],
    watching: [],
    counts: { open: 2, attention: 2, breakToday: 0, watching: 0 },
    generatedAt: iso(0),
  },
  status: [
    statusItem("l1", "leads", "HIGH", "ליד ממתין לתשובה", "שירן גולן · פנתה אתמול", "/leads/91", 90),
    statusItem("d1", "documents", "MEDIUM", "חשבונית ספק ממתינה לאישור", "חומרי בניין הגליל · ₪412", "/documents/inbox", 70),
    statusItem("i1", "inventory", "MEDIUM", "מוצר עומד להיגמר", "פיתות · 12 יחידות", "/inventory/items/4", 50),
  ],
  awaiting: { totalOutstanding: "9340.00", customerCount: 3 },
  activity: { invoicesIssued: 2, newLeads: 1 },
  month: { amount: "8100.00", count: 9, previousAmount: "5200.00", previousCount: 7, changePct: 56 },
};

const CALM = {
  briefing: {
    state: "CALM",
    oriented: true,
    attention: [],
    watching: [obligation(21, "ביטוח לאומי", "980.00", iso(18))],
    counts: { open: 1, attention: 0, breakToday: 0, watching: 1 },
    generatedAt: iso(0),
  },
  status: [],
  awaiting: { totalOutstanding: "2100.00", customerCount: 1 },
  activity: { invoicesIssued: 1, newLeads: 0 },
  month: { amount: "8100.00", count: 9, previousAmount: "5200.00", previousCount: 7, changePct: 56 },
};

const QUIET = {
  briefing: CALM.briefing,
  status: [],
  awaiting: { totalOutstanding: "0.00", customerCount: 0 },
  activity: { invoicesIssued: 0, newLeads: 0 },
  // A young business: no previous month at all, so NO comparison may be shown.
  month: { amount: "1250.00", count: 2, previousAmount: "0.00", previousCount: 0, changePct: null },
  emptyDays: true,
};

const FIXTURES = { busy: BUSY, calm: CALM, quiet: QUIET };

async function install(page, state) {
  const fx = FIXTURES[state] ?? BUSY;
  const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/home", (r) =>
    r.fulfill(
      json({
        heroAction: null,
        quickActions: [],
        businessSnapshot: { businessName: "פלאפל הדר", greeting: "", ownerName: "אלדד" },
        leadsAttention: { count: 0, href: "/leads" },
      })
    )
  );

  await page.route("**/api/home/day**", (route) => {
    if (state === "loading") return; // never answered
    if (state === "partial") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    const url = new URL(route.request().url());
    const date = url.searchParams.get("date") ?? todayKey();
    const pairs = fx.emptyDays ? [] : DAYS[date] ?? [];
    const scope = url.searchParams.get("scope");
    return route.fulfill(
      json({
        timezone: "Asia/Jerusalem",
        date,
        isToday: date === todayKey(),
        day: { hours: hours(pairs), total: sum(pairs), count: pairs.length, complete: true },
        month: scope === "day" ? null : fx.month,
        activity: scope === "day" ? null : fx.activity,
      })
    );
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

async function run(browser, { state, width, file, mode = "full", back = 0 }) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 },
    locale: "he-IL",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("token", "qa-token");
      localStorage.setItem("dubiz.home.identity.v1", "dubiz");
    } catch {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m) => {
    const text = m.text();
    // The PARTIAL fixture answers 500 on purpose; the browser logging that is
    // the injection working, not the app failing.
    if (m.type() === "error" && !text.includes("Failed to load resource")) errs.push(`console: ${text.slice(0, 160)}`);
  });
  await install(page, state);

  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dzhome", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1100);

  for (let i = 0; i < back; i += 1) {
    await page.click(".daynav .dn:not([disabled]):first-child");
    await page.waitForTimeout(400);
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
        return { t: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 18), w: Math.round(r.width), h: Math.round(r.height) };
      })
      .filter((x) => x.w > 0 && x.h > 0);
    const slips = [...document.querySelectorAll(".dzhome .slip")].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const fab = document.querySelector('[aria-label="פתח תפריט נגישות"]')?.getBoundingClientRect();
    const leaves = [...document.querySelectorAll(".dzhome b, .dzhome p, .dzhome h2, .dzhome span, .dzhome svg")].filter(
      (el) => el.tagName !== "A" && (el.children.length === 0 || el.tagName === "svg") && ((el.textContent || "").trim().length > 0 || el.tagName === "svg")
    );
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
    const fabHitNames = hitEls.map((el) => el.tagName + String.fromCharCode(171) + (el.textContent || "").trim().slice(0, 20) + String.fromCharCode(187) + "@" + (el.className || ""));
    const navLabels = [...document.querySelectorAll('[data-component="shell-bottom-bar"] a')].map((a) => a.textContent.trim());
    return {
      sw: de.scrollWidth,
      iw: innerWidth,
      h: de.scrollHeight,
      fold: Math.round(fold),
      dayLabel: document.querySelector(".dn-t")?.textContent?.trim() ?? null,
      dayAmount: document.querySelector(".day-amt")?.textContent?.trim() ?? document.querySelector(".day-off")?.textContent?.trim() ?? null,
      monthText: document.querySelector(".fc-g .fc-n")?.textContent?.trim() ?? null,
      activity: [...document.querySelectorAll(".act-o")].map((a) => a.textContent.trim()),
      families: [...document.querySelectorAll(".fam")].map((f) => ({
        title: f.querySelector(".fam-t")?.textContent?.trim(),
        line: f.querySelector(".fam-l")?.textContent?.trim(),
        icons: f.querySelectorAll(".fam-i").length,
        href: f.getAttribute("href"),
      })),
      primaryHref: document.querySelector(".obj")?.getAttribute("href") ?? null,
      supportHrefs: [...document.querySelectorAll(".slip")].map((s) => s.getAttribute("href")),
      slips,
      minTap: taps.length ? Math.min(...taps.map((x) => Math.min(x.w, x.h))) : null,
      smallTaps: taps.filter((x) => Math.min(x.w, x.h) < 44),
      fabHits,
      fabHitNames,
      bars: document.querySelectorAll(".hg-b").length,
      barsOn: document.querySelectorAll(".hg-b.on").length,
      hasBell: Boolean(document.querySelector(".dzhome .top a[href='/notifications']")),
      gearHref: document.querySelector(".dzhome .gear")?.getAttribute("href") ?? null,
      navLabels,
      layers: {
        header: where(".top"),
        bizname: where(".bizname"),
        daynav: where(".daynav"),
        amount: where(".day-amt, .day-off"),
        graph: where(".hg"),
        context: where(".fc"),
        activity: where(".act"),
        secretary: where(".sec-head"),
        object: where(".stage"),
        families: where(".dz h2"),
      },
    };
  });

  rows.push({ state, width, back, overflow: m.sw > m.iw + 1, errs, ...m });

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
await run(browser, { state: "calm", width: 390, file: "C-calm-390-full.png" });
await run(browser, { state: "calm", width: 390, file: "D-calm-390-fold.png", mode: "fold" });
await run(browser, { state: "busy", width: 390, file: "E-yesterday-390.png", mode: "fold", back: 1 });
await run(browser, { state: "busy", width: 390, file: "F-older-390.png", mode: "fold", back: 2 });
await run(browser, { state: "quiet", width: 390, file: "G-quiet-390-full.png" });
await run(browser, { state: "loading", width: 390, file: "H-loading-390.png", mode: "fold" });
await run(browser, { state: "partial", width: 390, file: "I-partial-390.png", mode: "fold" });
for (const width of [360, 430]) {
  for (const state of ["busy", "calm", "quiet", "loading", "partial"]) {
    await run(browser, {
      state,
      width,
      file: state === "busy" || state === "calm" ? `J-${state}-${width}-fold.png` : null,
      mode: "fold",
    });
  }
}
await browser.close();

for (const r of rows) console.log(JSON.stringify(r));
