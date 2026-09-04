/**
 * הגדרות → ייבוא וייצוא → ייצוא (I-3) — layout / RTL / accessibility evidence.
 *
 * READ-ONLY with respect to business data: it navigates GET routes, measures
 * layout, drives the keyboard, and exercises the DOWNLOAD button only in its
 * unauthenticated state (no token in localStorage), which returns an error
 * without touching the database. It never logs in, never exports real data.
 *
 *   npx next dev            # in another shell
 *   node scripts/qa/ui/import-export-export-screen.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const OUT =
  process.env.QA_OUT_DIR || path.join(process.cwd(), ".tmp-import-export");
const HUB = "/settings/import-export";
const EXPORT_ROUTE = "/settings/import-export/export";

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

/* --------------------------------------------------- the hub, released --- */

const hubResponse = await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle" });
check("the hub is now REACHABLE (released)", hubResponse?.status() === 200, `HTTP ${hubResponse?.status()}`);

const hub = await page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="ייבוא וייצוא"]');
  const links = nav ? Array.from(nav.querySelectorAll("a")) : [];
  const text = nav ? nav.innerText.replace(/\s+/g, " ") : "";
  return {
    linkCount: links.length,
    linkHrefs: links.map((a) => a.getAttribute("href")),
    hasSoon: text.includes("בקרוב"),
    // The unbuilt Import row must not be pressable in ANY form.
    importIsLink: links.some((a) => (a.getAttribute("href") || "").endsWith("/import")),
    disabledControls: nav ? nav.querySelectorAll("[disabled],[aria-disabled='true']").length : -1,
    buttons: nav ? nav.querySelectorAll("button").length : -1,
  };
});

check("Export is the ONLY navigable action on the hub", hub.linkCount === 1, hub.linkHrefs.join(", "));
check("Export links to the export screen", hub.linkHrefs[0] === EXPORT_ROUTE, String(hub.linkHrefs[0]));
check("Import is NOT a link (cannot reach a 404)", hub.importIsLink === false);
check('Import shows a "בקרוב" status instead', hub.hasSoon);
check("Import is not a disabled control (which would read as a bug)", hub.disabledControls === 0 && hub.buttons === 0, `disabled=${hub.disabledControls} buttons=${hub.buttons}`);

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(OUT, "hub-released-m390.png"), fullPage: true });

/* ------------------------------------------------- export, per viewport -- */

for (const [labelName, width, height] of VIEWPORTS) {
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${EXPORT_ROUTE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);

  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const boxes = Array.from(document.querySelectorAll("label")).map((l) => {
      const r = l.getBoundingClientRect();
      return { h: Math.round(r.height) };
    });
    return {
      status: 200,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dir: getComputedStyle(document.querySelector("[dir='rtl']") || doc).direction,
      heading: document.querySelector("h1")?.innerText?.trim() ?? null,
      checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"]')).length,
      radios: Array.from(document.querySelectorAll('input[type="radio"]')).length,
      domainLabels: Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .map((i) => i.closest("label")?.innerText.replace(/\s+/g, " ").trim() ?? ""),
      formatLabels: Array.from(document.querySelectorAll('input[type="radio"]'))
        .map((i) => ({ value: i.value, checked: i.checked })),
      downloadDisabled: document.querySelector("button:not([type='button' i])")
        ? null
        : Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("הורד"))?.disabled ?? null,
      labelHeights: boxes.map((b) => b.h),
      liveRegions: document.querySelectorAll("[aria-live]").length,
    };
  });

  const overflow = m.scrollWidth - m.clientWidth;
  check(`[${labelName}] export screen renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${labelName}] no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(`[${labelName}] direction is RTL`, m.dir === "rtl", m.dir);
  check(`[${labelName}] four selectable areas`, m.checkboxes === 4, `${m.checkboxes} checkboxes`);
  check(`[${labelName}] two formats offered`, m.radios === 2, `${m.radios} radios`);
  check(`[${labelName}] every option row meets 44px`, m.labelHeights.every((h) => h >= 44), m.labelHeights.join(","));

  if (labelName === "m390-mobile") {
    check("heading is the Hebrew action name", m.heading === "ייצוא", String(m.heading));
    check(
      "the four areas are the approved tabular domains",
      // The label text begins with the domain's icon, so match on inclusion.
      ["לקוחות", "ספקים", "לידים", "מלאי"].every((t) => m.domainLabels.some((l) => l.includes(t))),
      m.domainLabels.join(" | ")
    );
    check("Excel is the DEFAULT format", m.formatLabels.find((f) => f.value === "xlsx")?.checked === true, JSON.stringify(m.formatLabels));
    check("download is blocked until something is selected", m.downloadDisabled === true, String(m.downloadDisabled));
    check("there is a live region for the result", m.liveRegions >= 1, String(m.liveRegions));
  }

  await page.screenshot({ path: path.join(OUT, `export-${labelName}.png`), fullPage: true });
}

/* ------------------------------------------------------ interaction ----- */

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${EXPORT_ROUTE}`, { waitUntil: "networkidle" });

// Select-all, then confirm the button becomes usable.
await page.getByRole("button", { name: "בחר הכול" }).click();
const afterAll = await page.evaluate(() => ({
  checked: Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((i) => i.checked).length,
  downloadDisabled: Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("הורד"))?.disabled,
  toggleLabel: Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("בחר") || b.innerText.includes("נקה"))?.innerText.trim(),
}));
check('"בחר הכול" selects all four', afterAll.checked === 4, String(afterAll.checked));
check("download becomes available once something is selected", afterAll.downloadDisabled === false);
check("the toggle flips to clear", afterAll.toggleLabel === "נקה בחירה", String(afterAll.toggleLabel));
await page.screenshot({ path: path.join(OUT, "export-all-selected.png"), fullPage: true });

// The primary action must not sit UNDER the fixed bottom bar on mobile. A
// full-page screenshot cannot answer this (fixed elements render at their
// viewport position), so ask the browser what is actually painted at the
// button's centre.
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(250);
const occlusion = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    b.innerText.includes("הורד קובץ")
  );
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { hitIsButton: hit === btn || btn.contains(hit), height: Math.round(r.height) };
});
check(
  "the download button is not covered by the bottom bar",
  occlusion?.hitIsButton === true,
  JSON.stringify(occlusion)
);
check("the download button meets the 44px target", (occlusion?.height ?? 0) >= 44, String(occlusion?.height));

// Error state: no auth token in localStorage, so the request never reaches data.
await page.getByRole("button", { name: "הורד קובץ" }).click();
await page.waitForTimeout(600);
const errorState = await page.evaluate(() => {
  const live = document.querySelector("[aria-live]");
  return live ? live.innerText.replace(/\s+/g, " ").trim() : "";
});
check("an unauthenticated download reports a readable error, not a crash", errorState.length > 0, errorState);
await page.screenshot({ path: path.join(OUT, "export-error-state.png"), fullPage: true });

/* --------------------------------------------------------- keyboard ----- */

await page.goto(`${BASE}${EXPORT_ROUTE}`, { waitUntil: "networkidle" });
await page.setViewportSize({ width: 1440, height: 900 });

let focus = null;
for (let i = 0; i < 20; i++) {
  await page.keyboard.press("Tab");
  focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      type: el.getAttribute("type"),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      boxShadow: cs.boxShadow,
    };
  });
  if (focus?.type === "checkbox") break;
}
check("the area checkboxes are keyboard reachable", focus?.type === "checkbox", JSON.stringify(focus));
check(
  "the focused control has a visible focus indicator",
  Boolean(focus && ((focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) > 0) || (focus.boxShadow && focus.boxShadow !== "none"))),
  focus ? `outline=${focus.outlineStyle} ${focus.outlineWidth}` : "n/a"
);

// Space must toggle the focused checkbox — proof it is a real input.
const before = await page.evaluate(() => document.activeElement.checked);
await page.keyboard.press("Space");
const after = await page.evaluate(() => document.activeElement.checked);
check("Space toggles the focused area", before !== after, `${before} -> ${after}`);
await page.screenshot({ path: path.join(OUT, "export-focus-visible.png"), fullPage: false });

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
