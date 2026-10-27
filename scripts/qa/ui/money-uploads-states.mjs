/**
 * העלאת דוחות וקבצים (/money/uploads, S1-B M3) — state and layout evidence.
 *
 * Renders the REAL screen (real component, real CSS, real router, inside ShellChrome) against a STUBBED
 * GET /api/money/uploads, so every state can be captured without touching any business's data:
 *   legacy   bank_file_import OFF, history (runs + old-path uploads) and attention (action + info)
 *   b1       bank_file_import ON
 *   unknown  the server could not resolve the flag (200, mode "unknown")
 *   error    the read failed (500)
 *   empty    no upload yet
 * plus /tools/money, which must list the new row.
 *
 * Every other /api/* call is answered 404 by a catch-all stub, so the run needs no database.
 * Asserts per state and width: RTL, no horizontal overflow, no dead hrefs, where the bank card leads, that
 * the "בקרוב" cards are not links, and that every history entry says the source file is not stored.
 *
 *   AUDIT_BASE_URL=http://localhost:3013 AUDIT_OUT_DIR=<dir> node scripts/qa/ui/money-uploads-states.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3013";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".money-uploads");
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const HISTORY = [
  {
    id: "run-41",
    source: "import_run",
    domain: "customers",
    typeLabel: "ייבוא לקוחות",
    status: "PARTIAL",
    statusLabel: "הושלם חלקית",
    at: ago(25),
    completedAt: ago(24),
    counts: { total: 120, created: 114, skipped: 2, failed: 4 },
    period: null,
    account: null,
    legacyPath: false,
    sourceFileStored: false,
  },
  {
    id: "upl-mh3k2a1",
    source: "legacy_bank_upload",
    domain: "bank_statement",
    typeLabel: "דף חשבון בנק",
    status: "RECORDED",
    statusLabel: "נקלט",
    at: ago(60 * 26),
    completedAt: null,
    counts: { total: null, created: 87, skipped: null, failed: null },
    period: { from: "2026-09-01", to: "2026-09-30" },
    account: { label: "חשבון עסקי", last4: "4821" },
    legacyPath: true,
    sourceFileStored: false,
  },
  {
    id: "run-38",
    source: "import_run",
    domain: "historical-documents",
    typeLabel: "היסטוריה ממערכת קודמת",
    status: "COMPLETED",
    statusLabel: "הושלם",
    at: ago(60 * 24 * 4),
    completedAt: ago(60 * 24 * 4 - 2),
    counts: { total: 36, created: 36, skipped: 0, failed: 0 },
    period: null,
    account: null,
    legacyPath: false,
    sourceFileStored: false,
  },
];

const ATTENTION = [
  {
    id: "run-41-failed",
    kind: "action",
    title: "ייבוא לקוחות: 4 שורות לא נקלטו",
    detail: "אפשר לתקן בקובץ את מה שלא נקלט ולהעלות קובץ מתוקן. לפני הקליטה תוצג בדיקה של הקובץ.",
    action: { label: "לייבוא נתונים", href: "/settings/import-export/import" },
  },
  {
    id: "run-40-stuck",
    kind: "info",
    title: "ייבוא מלאי: הקליטה לא הסתיימה",
    detail: "הקליטה התחילה לפני יותר משעה ועדיין לא הסתיימה. מה שכבר נקלט נשמר.",
  },
];

const STATES = {
  legacy: { status: 200, body: { bank: { mode: "legacy" }, historyAvailable: true, history: HISTORY, attention: ATTENTION }, bankHref: "/payables/bank" },
  b1: {
    status: 200,
    body: {
      bank: { mode: "b1" },
      historyAvailable: true,
      history: [
        {
          ...HISTORY[0],
          id: "run-52",
          domain: "bank_statement",
          typeLabel: "דף חשבון בנק",
          status: "COMPLETED",
          statusLabel: "הושלם",
          counts: { total: 64, created: 61, skipped: 3, failed: 0 },
        },
        HISTORY[1],
      ],
      attention: [],
    },
    bankHref: "/payables/bank/import",
  },
  unknown: { status: 200, body: { bank: { mode: "unknown" }, historyAvailable: true, history: HISTORY.slice(1), attention: [] }, bankHref: null },
  error: { status: 500, body: { error: "INTERNAL" }, bankHref: null },
  empty: { status: 200, body: { bank: { mode: "legacy" }, historyAvailable: true, history: [], attention: [] }, bankHref: "/payables/bank" },
  // The history read failed (e.g. a table the environment lacks) — the bank card still follows the flag.
  partial: { status: 200, body: { bank: { mode: "legacy" }, historyAvailable: false, history: [], attention: [] }, bankHref: "/payables/bank" },
};

/* --------------------------------------------------------------- stubs -- */

async function installStubs(page, state) {
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  // Registered first, so the specific stub below (registered later) wins for its URL.
  await page.route("**/api/**", (route) => json(route, { error: "Not found" }, 404));
  if (state) await page.route("**/api/money/uploads", (route) => json(route, state.body, state.status));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("token", "qa-stub-token");
    } catch {
      /* ignore */
    }
  });
}

async function measure(page, sel) {
  return page.evaluate((sel) => {
    const de = document.documentElement;
    const root = document.querySelector(sel);
    const links = [...document.querySelectorAll(`${sel} a[href]`)];
    return {
      iw: window.innerWidth,
      scrollW: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
      dir: root ? getComputedStyle(root).direction : null,
      deadHrefs: links.map((a) => a.getAttribute("href")).filter((h) => !h || h === "#" || h.trim() === ""),
      hrefs: links.map((a) => a.getAttribute("href")),
      bankMode: document.querySelector(`${sel} [data-bank-mode]`)?.getAttribute("data-bank-mode") ?? null,
      bankHref: document.querySelector(`${sel} a[data-bank-mode]`)?.getAttribute("href") ?? null,
      soonLinks: [...document.querySelectorAll(`${sel} .ucard-soon`)].filter((el) => el.closest("a")).length,
      soonCount: document.querySelectorAll(`${sel} .ucard-soon`).length,
      historyRows: document.querySelectorAll(`${sel} .uhist-row[data-source]`).length,
      fileNotes: [...document.querySelectorAll(`${sel} .uhist-row[data-source] .uhist-note`)].filter((n) =>
        n.textContent.includes("קובץ המקור לא נשמר")
      ).length,
      attention: document.querySelectorAll(`${sel} .uattn-row`).length,
      emptyText: document.querySelector(`${sel} .uempty`)?.textContent?.trim() ?? null,
      errorBanner: !!document.querySelector(`${sel} .uerr`),
    };
  }, sel);
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const [key, state] of Object.entries(STATES)) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "he-IL", reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await installStubs(page, state);
      await page.goto(`${BASE}/money/uploads`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".dzup .ucards", { timeout: 120000, state: "visible" });
      await page.waitForFunction(() => document.querySelector(".dzup [data-bank-mode]")?.getAttribute("data-bank-mode") !== "loading", null, {
        timeout: 30000,
      });
      await page.waitForTimeout(400);
      const m = await measure(page, ".dzup");
      const tag = `${key} @${vp.width}`;

      check(`${tag}: RTL`, m.dir === "rtl", m.dir);
      check(`${tag}: no horizontal overflow`, m.scrollW <= m.iw + 1, `scrollWidth ${m.scrollW} vs ${m.iw}`);
      check(`${tag}: no dead hrefs`, m.deadHrefs.length === 0, m.deadHrefs.join(", "));
      check(`${tag}: bank card leads where the server said`, m.bankHref === state.bankHref, `${m.bankMode} → ${m.bankHref}`);
      check(`${tag}: "בקרוב" cards (Z, settlement) are not links`, m.soonCount === 2 && m.soonLinks === 0, `${m.soonCount}/${m.soonLinks}`);
      check(`${tag}: no link to a non-existent detail page`, !m.hrefs.some((h) => /\/money\/uploads\//.test(h)), m.hrefs.join(" "));
      if (state.status === 200) {
        const n = state.body.history.length;
        check(`${tag}: ${n} history rows`, m.historyRows === n, String(m.historyRows));
        check(`${tag}: every entry says the source file is not stored`, m.fileNotes === n, `${m.fileNotes}/${n}`);
        check(`${tag}: attention rows`, m.attention === state.body.attention.length, String(m.attention));
      }
      if (key === "partial") {
        check(`${tag}: a history that could not be read says so (banner), not "nothing uploaded"`, m.errorBanner && !(m.emptyText ?? "").includes("עוד לא הועלו דוחות"), m.emptyText);
        check(`${tag}: the bank card is still live and leads to the old path`, m.bankMode === "legacy" && m.bankHref === "/payables/bank");
      }
      if (key === "empty") check(`${tag}: empty history says so`, (m.emptyText ?? "").includes("עוד לא הועלו דוחות"), m.emptyText);
      if (key === "error") {
        check(`${tag}: error banner with retry`, m.errorBanner);
        check(`${tag}: bank card falls back to "unknown" (no link)`, m.bankMode === "unknown" && m.bankHref === null);
      }

      await page.screenshot({ path: path.join(OUT, `uploads-${key}-${vp.width}.png`), fullPage: true });
      await ctx.close();
    }
  }

  // The family screen lists the fifth row.
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "he-IL", reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await installStubs(page, null);
    await page.goto(`${BASE}/tools/money`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dzcat .clist", { timeout: 120000, state: "visible" });
    await page.waitForTimeout(400);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".dzcat .crow")].map((r) => ({ key: r.getAttribute("data-tool"), href: r.getAttribute("href") }))
    );
    check(
      `/tools/money @${vp.width}: five rows, the fifth is uploads → /money/uploads`,
      rows.length === 5 && rows[4].key === "uploads" && rows[4].href === "/money/uploads",
      rows.map((r) => `${r.key}:${r.href}`).join(" | ")
    );
    await page.screenshot({ path: path.join(OUT, `tools-money-${vp.width}.png`), fullPage: true });
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n[money-uploads-states] PASS=${results.length - failed.length} FAIL=${failed.length}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
