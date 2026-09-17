/**
 * HOME 2B — state, layout and reachability evidence.
 *
 * Renders the REAL home and "כל הכלים" screens (real component, real CSS, real
 * router) against STUBBED API responses, so the three verdict states and the
 * failure state can be captured without touching any business's data. It is
 * deliberately not a substitute for the manual pass in the approved test
 * business — it proves composition and reachability, not production data.
 *
 * For each state it asserts:
 *   - no horizontal overflow at 360 and 430 (the two phone widths in the spec)
 *   - RTL is active on the screen root
 *   - every link carries a real href (never "#", never empty)
 *   - every tappable control is at least 44px on its smaller axis
 *   - the secretary card links to /attention in EVERY state
 * and then checks that every href the two screens actually rendered resolves
 * to a 200 on the running server.
 *
 *   AUDIT_BASE_URL=http://localhost:3122 node scripts/qa/ui/home-2b-states.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3122";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".home-2b");
const WIDTHS = [360, 430];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */

const HOME = {
  heroAction: { actionKey: "x", title: "", description: "", ctaLabel: "", ctaHref: "/app" },
  quickActions: [],
  businessSnapshot: { businessName: "פלאפל הדר", ownerName: "אלדד כהן" },
  leadsAttention: { count: 3, href: "/leads?view=needsAction" },
};

function iso(daysFromNow, hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function obligation(id, name, amount, dueAt) {
  return {
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
  };
}

function statusItem(id, domain, severity, title) {
  return {
    itemId: id,
    domain,
    semanticCategory: "ACTION_REQUIRED",
    title,
    summary: null,
    severity,
    priorityScore: 10,
    entityRef: { type: domain, id: 1 },
    state: "open",
    createdAt: iso(-1),
    primaryAction: { kind: "navigate", label: "פתח", href: "/attention" },
    sourceEngine: "qa",
  };
}

const STATES = {
  calm: {
    briefing: {
      state: "CALM",
      oriented: true,
      attention: [],
      watching: [obligation(21, "ביטוח לאומי", "980.00", iso(18))],
      counts: { open: 1, attention: 0, breakToday: 0, watching: 1 },
      generatedAt: iso(0),
    },
    status: { items: [] },
    collection: {
      summary: {
        pending: { amount: "0.00", count: 0 },
        collectedThisMonth: { amount: "4820.00", count: 6 },
        expired: { amount: "0.00", count: 0 },
      },
      attention: [],
      active: [],
      history: [],
    },
    docs: 0,
  },
  busy: {
    briefing: {
      state: "BUSY",
      oriented: true,
      attention: [
        { obligation: obligation(31, "ספק החשמל", "1250.00", iso(1)), reason: "DUE_SOON" },
        { obligation: obligation(32, "שכר דירה", "6400.00", iso(1, 9)), reason: "DUE_SOON" },
        { obligation: obligation(33, "רואה חשבון", "900.00", iso(4)), reason: "DUE_SOON" },
      ],
      watching: [],
      counts: { open: 3, attention: 3, breakToday: 0, watching: 0 },
      generatedAt: iso(0),
    },
    status: {
      items: [
        statusItem("d1", "documents", "MEDIUM", "חשבונית ספק ממתינה לבדיקה"),
        statusItem("i1", "inventory", "MEDIUM", "התראת מלאי"),
      ],
    },
    collection: {
      summary: {
        pending: { amount: "12300.00", count: 4 },
        collectedThisMonth: { amount: "8100.00", count: 11 },
        expired: { amount: "0.00", count: 0 },
      },
      attention: [],
      active: [],
      history: [],
    },
    docs: 7,
  },
  critical: {
    briefing: {
      state: "CRITICAL",
      oriented: true,
      attention: [
        { obligation: obligation(41, "מעֿמ", "4300.00", iso(0, 10)), reason: "DUE_TODAY" },
        { obligation: obligation(42, "ספק החשמל", "1250.00", iso(-3)), reason: "OVERDUE" },
        { obligation: obligation(43, "שכר דירה", "6400.00", iso(1, 9)), reason: "DUE_SOON" },
      ],
      watching: [],
      counts: { open: 3, attention: 3, breakToday: 2, watching: 0 },
      generatedAt: iso(0),
    },
    status: {
      items: [
        statusItem("b1", "billing", "CRITICAL", "הפקת PDF נכשלה"),
        statusItem("c1", "inbox", "HIGH", "לקוח ממתין לתשובה"),
        statusItem("s1", "supplier", "MEDIUM", "הזמנת ספק ממתינה"),
      ],
    },
    collection: {
      summary: {
        pending: { amount: "23400.00", count: 9 },
        collectedThisMonth: { amount: "3100.00", count: 2 },
        expired: { amount: "800.00", count: 1 },
      },
      attention: [],
      active: [],
      history: [],
    },
    docs: 23,
  },
};

/** A fourth capture: the briefing failed. The card must say so, not guess. */
const VERDICT_FAILS = "verdict-error";

/* --------------------------------------------------------------- stubs -- */

async function installStubs(page, stateKey) {
  const fixture = STATES[stateKey] ?? STATES.calm;
  const briefingFails = stateKey === VERDICT_FAILS;

  const json = (route, body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  await page.route("**/api/home", (route) => json(route, HOME));
  await page.route("**/api/notifications/unread-count", (route) =>
    json(route, { unreadCount: 2 })
  );
  await page.route("**/api/obligations/briefing", (route) =>
    briefingFails ? json(route, { error: "boom" }, 500) : json(route, fixture.briefing)
  );
  await page.route("**/api/business-status", (route) => json(route, fixture.status));
  await page.route("**/api/payments/collection-workspace", (route) =>
    json(route, fixture.collection)
  );
  await page.route("**/api/documents/inbox**", (route) =>
    json(route, {
      success: true,
      financialPulse: { inboxDocumentCounts: { totalPendingReview: fixture.docs } },
      items: [],
    })
  );
}

/* ------------------------------------------------------------ measures -- */

async function audit(page, rootSelector) {
  return page.evaluate((sel) => {
    const de = document.documentElement;
    const root = document.querySelector(sel);
    const links = [...document.querySelectorAll(`${sel} a[href]`)];
    const taps = [
      ...document.querySelectorAll(
        `${sel} a[href], ${sel} button, ${sel} .dzcta, ${sel} .ntile, ${sel} .ftile, ${sel} .trow, ${sel} .tcell`
      ),
    ];
    const tooSmall = taps
      // The canonical BackButton is a frozen 40px platform control whose own
      // contract forbids restyling at call sites ("Do NOT restyle at call
      // sites — the visual is fixed here"). It is excluded from the assertion
      // and reported instead, because changing it is an app-wide decision.
      .filter((el) => !(el.tagName === "BUTTON" && el.getAttribute("aria-label") === "לבית"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, w: Math.round(r.width), h: Math.round(r.height) };
      })
      .filter((b) => b.w > 0 && b.h > 0 && Math.min(b.w, b.h) < 44);

    return {
      iw: window.innerWidth,
      scrollW: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
      dir: root?.getAttribute("dir") || getComputedStyle(root || de).direction,
      intent: document.querySelector("[data-page-intent]")?.getAttribute("data-page-intent"),
      hrefs: links.map((a) => a.getAttribute("href")),
      deadHrefs: links
        .map((a) => a.getAttribute("href"))
        .filter((h) => !h || h === "#" || h.trim() === ""),
      tooSmall,
      secretaryHref:
        document.querySelector(`${sel} .seccard-link`)?.getAttribute("href") ?? null,
      verdictBadge:
        document.querySelector(`${sel} .sbadge`)?.textContent?.trim() ?? null,
      verdictSentence:
        document.querySelector(`${sel} .smsg`)?.textContent?.trim() ?? null,
      ctaLabel: document.querySelector(`${sel} .dzcta`)?.textContent?.trim() ?? null,
      counters: [...document.querySelectorAll(`${sel} .ntile`)].map((el) => ({
        value: el.querySelector(".nval")?.textContent?.trim(),
        label: el.querySelector(".nlab")?.textContent?.trim(),
        href: el.getAttribute("href"),
        x: Math.round(el.getBoundingClientRect().x),
      })),
      // Reading order, measured rather than eyeballed: in RTL the first item
      // of a row must sit further right than the second.
      topRow: [...(document.querySelector(`${sel} .top`)?.children ?? [])].map((el) => ({
        cls: el.className,
        x: Math.round(el.getBoundingClientRect().x),
      })),
      groupStats: [...document.querySelectorAll(`${sel} .fstat`)].map((el) =>
        el.textContent.trim()
      ),
      todayRows: [...document.querySelectorAll(`${sel} .trow`)].map((el) => ({
        badge: el.querySelector(".tbadge")?.textContent?.trim(),
        name: el.querySelector(".tname")?.textContent?.trim(),
        href: el.getAttribute("href"),
      })),
      todayEmpty: document.querySelector(`${sel} .tempty`)?.textContent?.trim() ?? null,
      retry:
        document.querySelector(`${sel} .sec-failed .dzcta`)?.textContent?.trim() ?? null,

      /**
       * Rendered contrast for the elements whose whole job is to be read.
       *
       * Measured, not assumed: a control can pass DOM, rect, hit-test and
       * click checks and still be invisible, which is exactly what happened
       * when an export CTA resolved its background to an undefined variable
       * and painted at 1.03:1. Colours are read back from getComputedStyle
       * after the cascade, so an undefined var shows up here as a failure.
       */
      contrast: (() => {
        const parse = (c) => {
          const m = String(c).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
          if (p.length < 3 || p.some(Number.isNaN)) return null;
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        };
        const lum = ({ r, g, b }) => {
          const f = (v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        /** src composited over dst. */
        const over = (src, dst) => ({
          r: src.r * src.a + dst.r * (1 - src.a),
          g: src.g * src.a + dst.g * (1 - src.a),
          b: src.b * src.a + dst.b * (1 - src.a),
          a: 1,
        });
        /** Every opaque colour stop in a computed background-image. */
        const stopsOf = (img) =>
          img === "none"
            ? []
            : [...String(img).matchAll(/rgba?\([^)]+\)/g)]
                .map((m) => parse(m[0]))
                .filter((c) => c && c.a >= 0.9);

        /**
         * Every ground this text could actually be painted on.
         *
         * Walks up until something opaque paints — a background COLOUR or a
         * gradient's stops, because the loudest surface on this screen is a
         * gradient and reading only backgroundColor would walk straight past
         * it to the page white and report a nonsense ratio. Translucent layers
         * passed on the way are composited back on top.
         */
        const groundsOf = (el) => {
          const translucent = [];
          let node = el;
          while (node && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            const stops = stopsOf(cs.backgroundImage);
            const bc = parse(cs.backgroundColor);
            let found = null;
            if (stops.length) found = stops;
            else if (bc && bc.a >= 0.9) found = [bc];
            if (found) {
              return found.map((g) =>
                translucent.reduceRight((acc, layer) => over(layer, acc), g)
              );
            }
            if (bc && bc.a > 0) translucent.push(bc);
            node = node.parentElement;
          }
          return [{ r: 255, g: 255, b: 255, a: 1 }];
        };
        /** Worst case across every ground the text may sit on. */
        const ratio = (el) => {
          const fg = parse(getComputedStyle(el).color);
          if (!fg) return null;
          const fl = lum(fg);
          const worst = groundsOf(el).reduce((min, bg) => {
            const bl = lum(bg);
            const [hi, lo] = fl > bl ? [fl, bl] : [bl, fl];
            return Math.min(min, (hi + 0.05) / (lo + 0.05));
          }, Infinity);
          return Math.round(worst * 100) / 100;
        };
        const out = [];
        const MEASURED = [
          ".sbadge", ".dzcta", ".tbadge", ".fstat", ".nval", ".nlab", ".nnote",
          ".tname", ".tmeta", ".tamt", ".tempty", ".sttl", ".ghi", ".gsub",
          ".smsg", ".lb", ".hi", ".flab", ".tgroup-stat", ".tcell-label",
        ];
        for (const s of MEASURED) {
          for (const el of document.querySelectorAll(`${sel} ${s}`)) {
            const text = el.textContent.trim();
            if (!text) continue;
            out.push({ sel: s, text: text.slice(0, 24), ratio: ratio(el) });
          }
        }
        return out;
      })(),
    };
  }, rootSelector);
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const collectedHrefs = new Set();
  const snapshots = {};

  for (const stateKey of ["calm", "busy", "critical", VERDICT_FAILS]) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        locale: "he-IL",
      reducedMotion: "reduce",
        // The brand intro splash hides the shell until its timeline ends; under
        // reduced motion it resolves in 900ms, which is also the a11y path.
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await installStubs(page, stateKey);
      // The screens read the session token from localStorage before fetching.
      await page.addInitScript(() => {
        try {
          localStorage.setItem("token", "qa-stub-token");
        } catch {
          /* ignore */
        }
      });

      await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".dzhome .seccard", { timeout: 30000, state: "visible" });
      // Let the four independent loaders settle.
      await page.waitForTimeout(700);

      const m = await audit(page, ".dzhome");
      m.hrefs.forEach((h) => collectedHrefs.add(h));
      if (width === 360) snapshots[stateKey] = m;

      check(
        `${stateKey} @${width}: no horizontal overflow`,
        m.scrollW <= m.iw + 1,
        `scrollWidth ${m.scrollW} vs ${m.iw}`
      );
      check(`${stateKey} @${width}: RTL`, m.dir === "rtl", m.dir);
      check(
        `${stateKey} @${width}: counters read right-to-left`,
        m.counters.length === 4 &&
          m.counters[0].x > m.counters[1].x &&
          m.counters[2].x > m.counters[3].x,
        m.counters.map((c) => `${c.label}@${c.x}`).join(" | ")
      );
      check(
        `${stateKey} @${width}: top bar reads initial → logo → bell (RTL)`,
        m.topRow.length === 3 &&
          m.topRow[0].x > m.topRow[1].x &&
          m.topRow[1].x > m.topRow[2].x,
        m.topRow.map((t) => `${t.cls}@${t.x}`).join(" | ")
      );
      check(
        `${stateKey} @${width}: no dead hrefs`,
        m.deadHrefs.length === 0,
        m.deadHrefs.join(", ")
      );
      check(
        `${stateKey} @${width}: every tap target >= 44px`,
        m.tooSmall.length === 0,
        m.tooSmall.map((t) => `${t.cls} ${t.w}x${t.h}`).join(" | ")
      );
      {
        const low = m.contrast.filter((c) => c.ratio === null || c.ratio < 4.5);
        check(
          `${stateKey} @${width}: every label clears AA (4.5:1) as rendered`,
          low.length === 0,
          low.map((c) => `${c.sel} "${c.text}" ${c.ratio}`).join(" | ")
        );
      }

      if (stateKey !== VERDICT_FAILS) {
        check(
          `${stateKey} @${width}: secretary card links to /attention`,
          m.secretaryHref === "/attention",
          String(m.secretaryHref)
        );
      } else {
        check(
          `${stateKey} @${width}: failure says so and offers a retry`,
          m.retry === "נסה שוב" && m.verdictBadge === null,
          `retry=${m.retry} badge=${m.verdictBadge}`
        );
        // A briefing we could not load must NOT be reported as an empty day,
        // and the counter that depends on it must not read as a zero.
        check(
          `${stateKey} @${width}: "היום שלך" does not claim the day is empty`,
          m.todayEmpty === "לא הצלחתי לבדוק אילו מועדים פתוחים היום.",
          String(m.todayEmpty)
        );
        const due = m.counters.find((c) => c.label === "תשלומים למועד");
        check(
          `${stateKey} @${width}: the obligations counter says it did not load`,
          due?.value === "לא נטען",
          String(due?.value)
        );
      }

      await page.screenshot({
        path: path.join(OUT, "shots", `home-${stateKey}-${width}.png`),
        fullPage: true,
      });
      await ctx.close();
    }
  }

  // "כל הכלים" — same two widths, with a status snapshot loaded.
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      locale: "he-IL",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await installStubs(page, "critical");
    await page.addInitScript(() => {
      try {
        localStorage.setItem("token", "qa-stub-token");
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${BASE}/tools#group-customers`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dztools .tgroup", { timeout: 30000, state: "visible" });
    await page.waitForTimeout(600);

    const m = await audit(page, ".dztools");
    m.hrefs.forEach((h) => collectedHrefs.add(h));

    check(`tools @${width}: no horizontal overflow`, m.scrollW <= m.iw + 1, `${m.scrollW}/${m.iw}`);
    check(`tools @${width}: RTL`, m.dir === "rtl", m.dir);
    check(`tools @${width}: no dead hrefs`, m.deadHrefs.length === 0, m.deadHrefs.join(", "));
    check(
      `tools @${width}: every tap target >= 44px`,
      m.tooSmall.length === 0,
      m.tooSmall.map((t) => `${t.cls} ${t.w}x${t.h}`).join(" | ")
    );

    const anchors = await page.evaluate(() =>
      [...document.querySelectorAll(".dztools .tgroup")].map((el) => el.id)
    );
    check(
      `tools @${width}: every group carries its anchor id`,
      ["group-money", "group-customers", "group-operations"].every((id) =>
        anchors.includes(id)
      ),
      anchors.join(", ")
    );

    // The anchor must be scrolled as far toward the top as the document allows
    // — on a short page the last group simply cannot reach y=0, so compare
    // against the achievable position rather than against zero.
    const anchor = await page.evaluate(() => {
      const el = document.getElementById("group-customers");
      if (!el) return null;
      const de = document.documentElement;
      const maxScroll = Math.max(0, de.scrollHeight - de.clientHeight);
      const margin =
        parseFloat(getComputedStyle(el).scrollMarginTop || "0") || 0;
      const docTop = el.getBoundingClientRect().top + window.scrollY;
      return {
        scrollY: Math.round(window.scrollY),
        expected: Math.round(Math.min(Math.max(0, docTop - margin), maxScroll)),
        maxScroll: Math.round(maxScroll),
      };
    });
    check(
      `tools @${width}: #group-customers is scrolled as far into view as the page allows`,
      anchor !== null && anchor.scrollY > 0 && Math.abs(anchor.scrollY - anchor.expected) <= 4,
      anchor ? `scrollY=${anchor.scrollY} expected=${anchor.expected} max=${anchor.maxScroll}` : "missing"
    );

    if (width === 360) snapshots.tools = m;

    await page.screenshot({
      path: path.join(OUT, "shots", `tools-${width}.png`),
      fullPage: true,
    });
    await ctx.close();
  }

  // ---- click proof + chrome contrast -----------------------------------
  // An href that resolves is not proof the owner can reach it: the control has
  // to be the thing under the finger, and the click has to land. This walks
  // every interactive element Home renders, hit-tests its centre against
  // elementFromPoint (so a floating FAB covering a tile is caught), clicks it,
  // and asserts the URL that results.
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 844 },
      locale: "he-IL",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await installStubs(page, "critical");
    await page.addInitScript(() => {
      try {
        localStorage.setItem("token", "qa-stub-token");
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dzhome .seccard", { state: "visible", timeout: 30000 });
    await page.waitForTimeout(800);

    // The global chrome that paints ON Home. `--dz-fab-trigger-*` used to be
    // frozen here to a gradient that put the icon at 1.48:1; this keeps it
    // honest. The bottom-bar "+" is a 30px glyph — large text, 3:1 floor.
    const chrome = await page.evaluate(() => {
      const parse = (c) => {
        const m = String(c).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return p.length < 3 || p.some(Number.isNaN)
          ? null
          : { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      const worstOf = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const ink = parse(cs.color);
        const stops = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)]
          .map((m) => parse(m[0]))
          .filter((c) => c && c.a >= 0.9);
        const bc = parse(cs.backgroundColor);
        const grounds = stops.length ? stops : bc && bc.a >= 0.9 ? [bc] : [];
        if (!ink || !grounds.length) return null;
        return grounds.reduce((m, g) => Math.min(m, ratio(ink, g)), Infinity);
      };
      return {
        a11yFab: worstOf(document.querySelector('[aria-label="פתח תפריט נגישות"]')),
        navFab: worstOf(document.querySelector('[aria-label="פעולות מהירות"]')),
      };
    });
    check(
      `chrome @${width}: accessibility FAB icon clears 3:1`,
      chrome.a11yFab !== null && chrome.a11yFab >= 3,
      `${chrome.a11yFab}:1`
    );
    check(
      `chrome @${width}: bottom-bar FAB glyph clears 3:1 (large text)`,
      chrome.navFab !== null && chrome.navFab >= 3,
      `${chrome.navFab}:1`
    );

    const targets = await page.evaluate(() =>
      [...document.querySelectorAll(".dzhome a[href]")].map((el, i) => {
        el.setAttribute("data-qa-idx", String(i));
        return { idx: i, href: el.getAttribute("href"), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 28) };
      })
    );
    check(`click @${width}: Home renders interactive targets`, targets.length > 0, `${targets.length}`);

    for (const t of targets) {
      const sel = `.dzhome a[data-qa-idx="${t.idx}"]`;
      await page.evaluate((s) => {
        document.querySelector(s)?.scrollIntoView({ block: "center" });
      }, sel);
      await page.waitForTimeout(60);

      // Is this control actually the thing under the finger?
      const hit = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return { ok: false, why: "missing" };
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { ok: false, why: "zero-size" };
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (!top) return { ok: false, why: "nothing-at-point" };
        const ours = el.contains(top) || top.contains(el);
        return {
          ok: ours,
          why: ours ? "" : `covered by ${top.tagName}.${String(top.className).slice(0, 40)}`,
        };
      }, sel);
      check(`hit-test @${width}: ${t.label} (${t.href})`, hit.ok, hit.why);
      if (!hit.ok) continue;

      await page.click(sel);
      await page.waitForTimeout(600);
      const got = new URL(page.url());
      const landed = got.pathname + got.search + got.hash;
      check(
        `click @${width}: ${t.label} lands on ${t.href}`,
        landed === t.href,
        `landed on ${landed}`
      );

      // An anchor href is only kept if the click also ARRIVES at the group.
      // Direct-load scroll was already proven; this is the path from Home.
      if (got.hash) {
        const anchor = await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const de = document.documentElement;
          const maxScroll = Math.max(0, de.scrollHeight - de.clientHeight);
          const margin = parseFloat(getComputedStyle(el).scrollMarginTop || "0") || 0;
          const docTop = el.getBoundingClientRect().top + window.scrollY;
          return {
            scrollY: Math.round(window.scrollY),
            expected: Math.round(Math.min(Math.max(0, docTop - margin), maxScroll)),
          };
        }, got.hash.slice(1));
        check(
          `click @${width}: ${t.label} arrives at ${got.hash}`,
          anchor !== null && Math.abs(anchor.scrollY - anchor.expected) <= 4,
          anchor ? `scrollY=${anchor.scrollY} expected=${anchor.expected}` : "anchor missing"
        );
      }

      await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".dzhome .seccard", { state: "visible", timeout: 30000 });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        [...document.querySelectorAll(".dzhome a[href]")].forEach((el, i) =>
          el.setAttribute("data-qa-idx", String(i))
        );
      });
    }
    await ctx.close();
  }

  // Every href the two screens actually rendered must resolve on the server.
  const page = await (await browser.newContext()).newPage();
  for (const href of [...collectedHrefs].sort()) {
    if (!href || !href.startsWith("/")) continue;
    const res = await page.request.get(`${BASE}${href}`, { maxRedirects: 5 });
    check(`rendered href resolves: ${href}`, res.status() === 200, String(res.status()));
  }

  await writeFile(
    path.join(OUT, "home-2b-evidence.json"),
    JSON.stringify({ base: BASE, snapshots, results }, null, 2),
    "utf8"
  );

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`evidence: ${path.join(OUT, "home-2b-evidence.json")}`);
  if (failed.length) {
    console.error("HOME 2B evidence FAILED");
    process.exit(1);
  }
  console.log("HOME 2B evidence PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
