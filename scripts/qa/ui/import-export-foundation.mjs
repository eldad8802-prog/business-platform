/**
 * הגדרות → ייבוא וייצוא (I-2) — layout / RTL / accessibility evidence harness.
 *
 * READ-ONLY: navigates two GET routes, measures layout, drives the keyboard,
 * screenshots. Never clicks a destructive control, never submits, never mutates.
 *
 * The hub is RELEASE-GATED (`IMPORT_EXPORT_RELEASED = false`), so on the
 * committed tree the route correctly 404s. To capture visual evidence, flip the
 * flag locally, run this, and flip it back — the run prints which mode it saw
 * so a screenshot can never be mistaken for proof that the feature is live.
 *
 *   npx next dev            # in another shell
 *   node scripts/qa/ui/import-export-foundation.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
// Mirrors the `.tmp-mist/` convention: a dedicated, git-ignored scratch dir, so
// a QA run never leaves screenshots in the working tree.
const OUT = process.env.QA_OUT_DIR || path.join(process.cwd(), ".tmp-import-export");
const ROUTE = "/settings/import-export";

mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  ["m390-mobile", 390, 844],
  ["m360-mobile-small", 360, 740],
  ["t768-tablet", 768, 1024],
  ["t1024-tablet-wide", 1024, 768],
  ["d1440-desktop", 1440, 900],
];

const results = [];
const consoleErrors = [];

function check(name, condition, detail = "") {
  const pass = Boolean(condition);
  results.push({ name, pass, detail });
  console.log(`${pass ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ locale: "he-IL" });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

/* ------------------------------------------------ gate mode detection ---- */

const response = await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
const status = response?.status() ?? 0;
const bodyText = await page.locator("body").innerText().catch(() => "");
const looksLikeNotFound =
  status === 404 || /404|not found|לא נמצא/i.test(bodyText.slice(0, 400));

console.log(`\n=== ROUTE ${ROUTE} → HTTP ${status} ===`);

if (looksLikeNotFound) {
  console.log(
    "MODE: GATED — the route is closed (IMPORT_EXPORT_RELEASED = false).\n" +
      "This is the CORRECT committed state: no dead navigation is exposed.\n" +
      "Flip the flag locally to capture layout evidence."
  );
  check("gated build: the unreleased hub is unreachable by URL", looksLikeNotFound, `HTTP ${status}`);
  await page.screenshot({ path: path.join(OUT, "gated-404.png"), fullPage: true });
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (gated mode).`);
  process.exit(failed.length === 0 ? 0 : 1);
}

console.log("MODE: OPEN — the flag is flipped locally; capturing layout evidence.\n");

/* ------------------------------------------------------- per viewport ---- */

for (const [label, width, height] of VIEWPORTS) {
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const nav = document.querySelector('nav[aria-label="ייבוא וייצוא"]');
    // Count ROWS, not links: an action that is planned but not yet usable
    // renders as a non-interactive row (see ImportExportPendingRow), so a
    // link count would under-report the hub from I-3 onward.
    const rows = nav ? Array.from(nav.children) : [];
    const dirOf = (el) => (el ? getComputedStyle(el).direction : null);
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      navFound: Boolean(nav),
      rowCount: rows.length,
      rowTexts: rows.map((a) => a.innerText.replace(/\s+/g, " ").trim()),
      rowHrefs: rows.map((el) =>
        el.tagName === "A" ? el.getAttribute("href") : "(not a link)"
      ),
      rowBoxes: rows.map((a) => {
        const r = a.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
      htmlDir: doc.getAttribute("dir"),
      rtlContainerDir: dirOf(document.querySelector("[dir='rtl']")),
      navDir: dirOf(nav),
      headingText: document.querySelector("h1")?.innerText?.trim() ?? null,
    };
  });

  const overflow = metrics.scrollWidth - metrics.clientWidth;

  check(`[${label}] the hub renders with both actions`, metrics.navFound && metrics.rowCount === 2, `rows=${metrics.rowCount}`);
  check(`[${label}] no horizontal overflow`, overflow <= 0, `scrollW-clientW=${overflow}px`);
  check(`[${label}] direction is RTL`, metrics.navDir === "rtl", `nav dir=${metrics.navDir}`);
  check(
    `[${label}] every action row meets the 44px touch target`,
    metrics.rowBoxes.every((b) => b.h >= 44),
    metrics.rowBoxes.map((b) => `${b.w}x${b.h}`).join(", ")
  );

  if (label === "m390-mobile") {
    check("hub heading is the Hebrew feature name", metrics.headingText === "ייבוא וייצוא", String(metrics.headingText));
    check(
      "action copy is the approved owner-facing wording",
      metrics.rowTexts.some((t) => t.includes("העבר מידע ממערכת אחרת לדוביז")) &&
        metrics.rowTexts.some((t) => t.includes("הורד עותק של הנתונים והמסמכים שלך")),
      metrics.rowTexts.join(" | ")
    );
    check(
      "only the two direction actions are on the hub (no six-domain grid)",
      metrics.rowCount === 2,
      metrics.rowHrefs.join(", ")
    );
  }

  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true });
}

/* ------------------------------------------------------- accessibility -- */

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });

// Tab until focus lands inside the hub nav, then measure whether the focus ring
// is actually PAINTED — a focusable control with no visible indicator fails
// WCAG 2.4.7 just as hard as one that cannot be reached at all.
let focusInfo = null;
for (let i = 0; i < 15; i++) {
  await page.keyboard.press("Tab");
  focusInfo = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const nav = el.closest('nav[aria-label="ייבוא וייצוא"]');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      inHub: Boolean(nav),
      tag: el.tagName,
      href: el.getAttribute("href"),
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      visible: r.width > 0 && r.height > 0,
    };
  });
  if (focusInfo?.inHub) break;
}

check("hub actions are reachable by keyboard (Tab)", Boolean(focusInfo?.inHub), focusInfo ? `${focusInfo.tag} ${focusInfo.href}` : "never focused");

const ringPainted =
  focusInfo &&
  ((focusInfo.outlineStyle !== "none" && parseFloat(focusInfo.outlineWidth) > 0) ||
    (focusInfo.boxShadow && focusInfo.boxShadow !== "none"));
check(
  "the focused action has a VISIBLE focus indicator",
  Boolean(ringPainted),
  focusInfo ? `outline=${focusInfo.outlineStyle} ${focusInfo.outlineWidth}, shadow=${focusInfo.boxShadow}` : "n/a"
);

await page.screenshot({ path: path.join(OUT, "focus-visible.png"), fullPage: false });

// Enter must activate the focused row (it is a real link, not a div handler).
const activatable = await page.evaluate(() => {
  const el = document.activeElement;
  return el?.tagName === "A" && Boolean(el.getAttribute("href"));
});
check("the focused action is a real link (Enter-activatable)", activatable);

check("no console errors on the hub", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\nScreenshots: ${OUT}`);
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
