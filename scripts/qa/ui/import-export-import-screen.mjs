/**
 * הגדרות → ייבוא וייצוא → ייבוא (I-5) — layout / RTL / accessibility evidence.
 *
 * READ-ONLY with respect to business data, and that is not just a claim about
 * this script: there is no endpoint behind the screen that writes. The upload
 * is exercised only in its UNAUTHENTICATED state (no token in localStorage), so
 * nothing reaches the database at all.
 *
 *   npx next dev            # in another shell
 *   node scripts/qa/ui/import-export-import-screen.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE_URL || "http://localhost:3000";
const OUT =
  process.env.QA_OUT_DIR || path.join(process.cwd(), ".tmp-import-export");
const HUB = "/settings/import-export";
const ROUTE = "/settings/import-export/import";

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

/* --------------------------------------------------------------- hub ---- */

await page.goto(`${BASE}${HUB}`, { waitUntil: "networkidle", timeout: 90_000 });
const hub = await page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="ייבוא וייצוא"]');
  const rows = nav ? Array.from(nav.children) : [];
  return {
    rowCount: rows.length,
    hrefs: rows.map((el) => (el.tagName === "A" ? el.getAttribute("href") : null)),
    text: (nav?.innerText || "").replace(/\s+/g, " "),
  };
});
check("the hub still offers three rows", hub.rowCount === 3, hub.hrefs.join(" | "));
check("Import is now a real link", hub.hrefs[0] === ROUTE, String(hub.hrefs[0]));
check(
  "Import no longer says 'בקרוב' — it describes a CHECK, not a transfer",
  !hub.text.includes("בקרוב") && hub.text.includes("בדקו קובץ"),
  hub.text.slice(0, 80)
);

/* ------------------------------------------------------- per viewport --- */

for (const [labelName, width, height] of VIEWPORTS) {
  await page.setViewportSize({ width, height });
  const response = await page.goto(`${BASE}${ROUTE}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForTimeout(150);

  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      dir: getComputedStyle(document.querySelector("[dir='rtl']") || doc).direction,
      heading: document.querySelector("h1")?.innerText?.trim() ?? null,
      radios: document.querySelectorAll('input[type="radio"]').length,
      radioHeights: Array.from(document.querySelectorAll("label")).map((l) =>
        Math.round(l.getBoundingClientRect().height)
      ),
      bodyText: document.body.innerText.replace(/\s+/g, " "),
      liveRegions: document.querySelectorAll("[aria-live]").length,
      fileInputs: document.querySelectorAll('input[type="file"]').length,
    };
  });

  const overflow = m.scrollWidth - m.clientWidth;
  check(`[${labelName}] import screen renders`, response?.status() === 200, `HTTP ${response?.status()}`);
  check(`[${labelName}] no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(`[${labelName}] direction is RTL`, m.dir === "rtl", m.dir);
  check(`[${labelName}] one choice per tabular area`, m.radios === 4, `${m.radios} radios`);
  check(`[${labelName}] every area row meets 44px`, m.radioHeights.every((h) => h >= 44), m.radioHeights.join(","));

  if (labelName === "m390-mobile") {
    check("heading names the action", m.heading === "ייבוא", String(m.heading));
    check(
      "THE PROMISE is on the page before anything else",
      m.bodyText.includes("שום מידע לא יישמר בדוביז"),
      "no-write promise"
    );
    check(
      "the four areas are the approved tabular domains",
      ["לקוחות", "ספקים", "לידים", "מלאי"].every((t) => m.bodyText.includes(t)),
      "domains"
    );
    check("the file picker is present but hidden until an area is chosen", m.fileInputs === 0, `${m.fileInputs}`);
    check("there is a live region for errors", m.liveRegions >= 1, String(m.liveRegions));
  }

  await page.screenshot({ path: path.join(OUT, `import-${labelName}.png`), fullPage: true });
}

/* ------------------------------------------------- progressive flow ----- */

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });

const beforeChoice = await page.evaluate(() =>
  document.body.innerText.includes("העלו את הקובץ")
);
check("the upload step is hidden until an area is chosen", beforeChoice === false);

await page.getByRole("radio").first().check();
await page.waitForTimeout(200);
const afterChoice = await page.evaluate(() => ({
  uploadVisible: document.body.innerText.includes("העלו את הקובץ"),
  limitsStated: document.body.innerText.includes("10MB") &&
    document.body.innerText.includes("10,000"),
  fileInputs: document.querySelectorAll('input[type="file"]').length,
  accept: document.querySelector('input[type="file"]')?.getAttribute("accept"),
}));
check("choosing an area reveals the upload step", afterChoice.uploadVisible);
check("the limits are stated to the owner up front", afterChoice.limitsStated);
check("the picker accepts only xlsx and csv", afterChoice.accept === ".xlsx,.csv", String(afterChoice.accept));
await page.screenshot({ path: path.join(OUT, "import-step-upload.png"), fullPage: true });

/* --------------------------------------------------- unauthenticated ---- */

// Uploading without a session must produce a readable error and never reach data.
const template = path.join(OUT, "qa-customers.csv");
const fs = await import("node:fs");
fs.writeFileSync(
  template,
  "﻿שם,טלפון,אימייל\nאבי כהן,050-123-4567,avi@example.co.il\n",
  "utf8"
);
await page.setInputFiles('input[type="file"]', template);
await page.waitForTimeout(1200);
const errorState = await page.evaluate(() => {
  const live = document.querySelector("[aria-live]");
  return live ? live.innerText.replace(/\s+/g, " ").trim() : "";
});
check(
  "an unauthenticated analyze reports a readable error, not a crash",
  errorState.length > 0,
  errorState
);
await page.screenshot({ path: path.join(OUT, "import-error-state.png"), fullPage: true });

/* --------------------------------------------------------- keyboard ---- */

await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle", timeout: 90_000 });

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
  if (focus?.type === "radio") break;
}
check("the area choices are keyboard reachable", focus?.type === "radio", JSON.stringify(focus));
check(
  "the focused control has a visible focus indicator",
  Boolean(
    focus &&
      ((focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) > 0) ||
        (focus.boxShadow && focus.boxShadow !== "none"))
  ),
  focus ? `outline=${focus.outlineStyle} ${focus.outlineWidth}` : "n/a"
);
await page.screenshot({ path: path.join(OUT, "import-focus-visible.png"), fullPage: false });

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
