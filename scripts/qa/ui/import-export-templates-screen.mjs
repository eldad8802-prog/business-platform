/**
 * הגדרות → ייבוא וייצוא → תבניות (I-4) — layout / RTL / accessibility evidence.
 *
 * READ-ONLY with respect to business data. It navigates GET routes, measures
 * layout, drives the keyboard, and clicks a download only in its
 * UNAUTHENTICATED state (no token in localStorage), which returns an error
 * without reaching any data. Template generation itself never touches tenant
 * data, authenticated or not.
 *
 *   npx next dev            # in another shell
 *   node scripts/qa/ui/import-export-templates-screen.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const OUT =
  process.env.QA_OUT_DIR || path.join(process.cwd(), ".tmp-import-export");
const HUB = "/settings/import-export";
const ROUTE = "/settings/import-export/templates";

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
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

/* ------------------------------------------------------- hub structure -- */

await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle" });
const hub = await page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="ייבוא וייצוא"]');
  const rows = nav ? Array.from(nav.children) : [];
  return {
    rowCount: rows.length,
    order: rows.map((el) =>
      (el.querySelector("span")?.parentElement?.innerText || el.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24)
    ),
    hrefs: rows.map((el) => (el.tagName === "A" ? el.getAttribute("href") : null)),
    hasSoon: (nav?.innerText || "").includes("בקרוב"),
  };
});

check("the hub now offers three rows", hub.rowCount === 3, hub.order.join(" | "));
check("Import is still NOT a link", hub.hrefs[0] === null, String(hub.hrefs[0]));
check('Import still shows "בקרוב"', hub.hasSoon);
check(
  "Templates sits with Import and IS a link",
  hub.hrefs[1] === ROUTE,
  String(hub.hrefs[1])
);
check(
  "Export is still a link",
  hub.hrefs[2] === "/settings/import-export/export",
  String(hub.hrefs[2])
);

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(OUT, "hub-with-templates-m390.png"), fullPage: true });

/* ------------------------------------------------------- per viewport --- */

for (const [labelName, width, height] of VIEWPORTS) {
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);

  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    // Scope to the download list: the page also carries the back button, the
    // FAB and the bottom bar, which are not this screen's controls.
    const buttons = Array.from(document.querySelectorAll("li > button"));
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dir: getComputedStyle(document.querySelector("[dir='rtl']") || doc).direction,
      heading: document.querySelector("h1")?.innerText?.trim() ?? null,
      buttonCount: buttons.length,
      buttonLabels: buttons.map((b) => b.innerText.replace(/\s+/g, " ").trim()),
      buttonHeights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
      bodyText: document.body.innerText.replace(/\s+/g, " "),
      liveRegions: document.querySelectorAll("[aria-live]").length,
    };
  });

  const overflow = m.scrollWidth - m.clientWidth;
  check(`[${labelName}] templates screen renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${labelName}] no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(`[${labelName}] direction is RTL`, m.dir === "rtl", m.dir);
  check(`[${labelName}] one download per tabular domain`, m.buttonCount === 4, `${m.buttonCount} buttons`);
  check(`[${labelName}] every download row meets 44px`, m.buttonHeights.every((h) => h >= 44), m.buttonHeights.join(","));

  if (labelName === "m390-mobile") {
    check("heading names the artifact", m.heading === "תבניות לייבוא", String(m.heading));
    check(
      "the four areas are the approved tabular domains",
      ["לקוחות", "ספקים", "לידים", "מלאי"].every((t) =>
        m.buttonLabels.some((l) => l.includes(t))
      ),
      m.buttonLabels.join(" | ")
    );
    check(
      "the screen states that importing is NOT live yet",
      m.bodyText.includes("אפשרות הייבוא עצמה תתווסף בהמשך") &&
        m.bodyText.includes("אי אפשר עדיין להעלות"),
      "explicit not-yet copy"
    );
    check("there is a live region for the result", m.liveRegions >= 1, String(m.liveRegions));
  }

  await page.screenshot({ path: path.join(OUT, `templates-${labelName}.png`), fullPage: true });
}

/* ---------------------------------------------------------- keyboard ---- */

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });

let focus = null;
for (let i = 0; i < 20; i++) {
  await page.keyboard.press("Tab");
  focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      boxShadow: cs.boxShadow,
    };
  });
  if (focus?.tag === "BUTTON") break;
}
check("download rows are keyboard reachable", focus?.tag === "BUTTON", JSON.stringify(focus));
check(
  "the focused row has a visible focus indicator",
  Boolean(
    focus &&
      ((focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) > 0) ||
        (focus.boxShadow && focus.boxShadow !== "none"))
  ),
  focus ? `outline=${focus.outlineStyle} ${focus.outlineWidth}` : "n/a"
);
await page.screenshot({ path: path.join(OUT, "templates-focus-visible.png"), fullPage: false });

/* ------------------------------------------------------- error state ---- */

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /לקוחות/ }).click();
await page.waitForTimeout(600);
const errorState = await page.evaluate(() => {
  const live = document.querySelector("[aria-live]");
  return live ? live.innerText.replace(/\s+/g, " ").trim() : "";
});
check("an unauthenticated download reports a readable error", errorState.length > 0, errorState);
await page.screenshot({ path: path.join(OUT, "templates-error-state.png"), fullPage: true });

check("no console errors across the flow", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\nScreenshots: ${OUT}`);
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}
process.exit(failed.length === 0 ? 0 : 1);
