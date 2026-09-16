/**
 * Export flow — real browser E2E.
 *
 * Answers two different questions that are easy to confuse:
 *
 *   1. does the download WORK        — click, and does a real file arrive
 *   2. is the action REACHABLE       — at the moment the owner has finished
 *                                      choosing, is the button on screen
 *
 * Export is a read. It creates, updates and deletes nothing, which is why this
 * is safe to point at Production. The only write anywhere in the run is the
 * auth session the login itself mints, exactly as a person signing in makes one.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const BASE = process.env.EXPORT_E2E_BASE;
if (!BASE) throw new Error("EXPORT_E2E_BASE is required and is never defaulted");

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "export-e2e-"));

function credentials() {
  const raw = fs.readFileSync(
    path.join(process.env.USERPROFILE ?? "", ".dubiz-local-secrets", "google-play-reviewer.txt"),
    "utf8"
  );
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { email: out.email, password: out.password };
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const EXPORT_PATH = "/settings/import-export/export";

/**
 * Reachability needs no account.
 *
 * The export page renders from a static domain registry and enforces nothing —
 * authorization lives on the API the button calls. So "is the action on screen"
 * can be asked of any running build, with no credentials and no data, which is
 * what makes it answerable locally and in CI. The download half still needs a
 * real tenant, and says so.
 */
const REACHABILITY_ONLY = process.env.EXPORT_E2E_REACHABILITY_ONLY === "1";

async function tokenFor() {
  if (REACHABILITY_ONLY) return { token: "reachability-only" };
  const { email, password } = credentials();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.token) throw new Error("login returned no token");
  return body;
}

async function openExport(browser, viewport, auth) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  // Any same-origin document will do as a place to seed the token.
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((a) => {
    window.localStorage.setItem("token", a.token);
    if (a.sessionId) window.localStorage.setItem("sessionId", a.sessionId);
    if (a.user) window.localStorage.setItem("user", JSON.stringify(a.user));
  }, auth);
  await page.goto(`${BASE}${EXPORT_PATH}`, { waitUntil: "networkidle" });
  return { context, page };
}

const cta = (page) => page.getByRole("button", { name: /הורד קובץ|מכין את הקובץ/ });

/** Is the element inside the viewport WITHOUT scrolling? */
async function visibleWithoutScrolling(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return { onScreen: false, reason: "no box" };
  const vh = page.viewportSize().height;
  const scrollY = await page.evaluate(() => window.scrollY);
  // boundingBox is page-relative; subtract the current scroll to get viewport-relative.
  const top = box.y - scrollY;
  return { onScreen: top >= 0 && top + box.height <= vh, top: Math.round(top), vh, boxH: Math.round(box.height) };
}

async function reachability(browser, label, viewport, auth) {
  const { context, page } = await openExport(browser, viewport, auth);
  const button = cta(page);
  await button.waitFor({ state: "attached", timeout: 20000 });

  const before = await visibleWithoutScrolling(page, button);
  ok(
    `${label}: the download action is on screen before any choice`,
    before.onScreen,
    `top=${before.top}px viewport=${before.vh}px`
  );

  // The owner's actual first move: tick one domain.
  await page.locator('input[type="checkbox"]').first().check();
  const after = await visibleWithoutScrolling(page, button);
  ok(
    `${label}: and still on screen once a domain is chosen`,
    after.onScreen,
    `top=${after.top}px viewport=${after.vh}px`
  );

  const enabled = await button.isEnabled();
  ok(`${label}: the action is enabled once a domain is chosen`, enabled);

  // A bar taken out of flow can cover the thing the owner was reading. Scroll
  // to the end and check the last format option is still clear of it.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(250);
  const lastOption = page.locator('input[name="export-format"]').last();
  const optionBox = await lastOption.boundingBox();
  const barBox = await button.boundingBox();
  const clear =
    !optionBox || !barBox ? false : optionBox.y + optionBox.height <= barBox.y + 1;
  ok(
    `${label}: the bar does not cover the last choice at the end of the page`,
    clear,
    optionBox && barBox
      ? `option bottom=${Math.round(optionBox.y + optionBox.height)} bar top=${Math.round(barBox.y)}`
      : "no box"
  );

  // The safe-area inset. A headless browser reports 0 for it, so asserting the
  // resolved pixels would prove nothing about a notched phone — what can be
  // checked is that the rule still yields the floor, and that the declaration
  // asking for the inset is the one in force.
  const padding = await page.evaluate(() => {
    const bar = document.querySelector("[data-export-action-bar]");
    if (!bar) return null;
    const cs = getComputedStyle(bar);
    return { position: cs.position, paddingBottom: cs.paddingBottom };
  });
  const floorPx = padding ? parseFloat(padding.paddingBottom) : -1;
  ok(
    `${label}: the bar keeps its bottom padding floor`,
    padding !== null && floorPx >= 12,
    JSON.stringify(padding)
  );
  // The action must be out of flow at EVERY width. The previous version of this
  // check asserted `static` above `sm` — it was pinning the old position rather
  // than asking whether anyone could reach it, which is how a 761px action
  // passed as "desktop is fine".
  ok(
    `${label}: the bar is out of flow`,
    padding !== null && padding.position === "fixed",
    JSON.stringify(padding)
  );

  // Visible is not the same as hittable. The shell has its own fixed bottom
  // navigation at z-index 100 below 768px, and a bar sitting under it would
  // still measure as "on screen".
  const hit = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /הורד קובץ|מכין את הקובץ/.test(b.textContent ?? "")
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const corners = [
      [r.left + r.width / 2, r.top + 2],
      [r.left + r.width / 2, r.bottom - 2],
      [r.left + 4, r.top + r.height / 2],
      [r.right - 4, r.top + r.height / 2],
    ];
    return corners.every((c) => {
      const el = document.elementFromPoint(c[0], c[1]);
      return el === btn || (el ? btn.contains(el) || el.contains(btn) : false);
    });
  });
  ok(`${label}: nothing covers the action, edge to edge`, hit === true, `hit=${hit}`);

  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1
  );
  ok(`${label}: no horizontal overflow`, overflowX === false);

  const ctaCount = await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].filter((b) =>
        /הורד קובץ|מכין את הקובץ/.test(b.textContent ?? "")
      ).length
  );
  ok(`${label}: exactly one download action on the page`, ctaCount === 1, `count=${ctaCount}`);

  await context.close();
  return { before, after };
}

async function downloadCase(browser, auth, { label, domains, format, viewport }) {
  const { context, page } = await openExport(browser, viewport, auth);
  const boxes = page.locator('input[type="checkbox"]');
  const total = await boxes.count();
  for (let i = 0; i < total; i++) {
    if (domains === "all" || domains.includes(i)) await boxes.nth(i).check();
  }
  await page.locator(`input[name="export-format"][value="${format}"]`).check();

  const button = cta(page);
  await button.scrollIntoViewIfNeeded();
  const waitDownload = page.waitForEvent("download", { timeout: 90000 });
  await button.click();

  // The busy state, and the guard that matters more: while it is busy the
  // button must be DISABLED, so a second click cannot start a second export.
  // "It said it was working" and "it refused the second press" are different
  // claims, and only the second one prevents two files.
  let busy = false;
  let lockedWhileBusy = false;
  try {
    const busyButton = page.getByRole("button", { name: /מכין את הקובץ/ });
    await busyButton.waitFor({ timeout: 4000 });
    busy = true;
    lockedWhileBusy = !(await busyButton.isEnabled());
  } catch {
    busy = false;
  }

  const download = await waitDownload;
  const suggested = download.suggestedFilename();
  const file = path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, "-")}-${suggested}`);
  await download.saveAs(file);
  const size = fs.statSync(file).size;
  const head = fs.readFileSync(file).subarray(0, 4);

  const isXlsx = head[0] === 0x50 && head[1] === 0x4b; // PK zip header
  const text = format === "csv" ? fs.readFileSync(file, "utf8") : "";
  const hasBom = format === "csv" && text.charCodeAt(0) === 0xfeff;
  const hasHebrew = format === "csv" ? /[֐-׿]/.test(text) : false;

  console.log(
    `    ${label}: file=${suggested} bytes=${size} busyShown=${busy}` +
      (format === "csv" ? ` bom=${hasBom} hebrew=${hasHebrew}` : ` zip=${isXlsx}`)
  );

  await context.close();
  return { suggested, size, isXlsx, hasBom, hasHebrew, busy, lockedWhileBusy, text };
}

async function main() {
  console.log(`export E2E against ${BASE}\n`);
  const auth = await tokenFor();
  const browser = await chromium.launch();

  const MOBILE = { width: 390, height: 844 };
  const DESKTOP = { width: 1440, height: 900 };

  console.log("reachability of the primary action");
  // Several REAL viewports, not one convenient one. A phone's usable height is
  // what is left after the browser's own chrome, which is 120-190px on the
  // common devices — so the nominal 844 of a modern iPhone is nearer 660 in use,
  // and measuring only the nominal number is how a page that does not fit
  // passes a test about whether it fits.
  const VIEWPORTS = [
    { label: "phone small (360x640)", size: { width: 360, height: 640 } },
    { label: "phone in use (390x664)", size: { width: 390, height: 664 } },
    { label: "phone nominal (390x844)", size: MOBILE },
    { label: "tablet (768x1024)", size: { width: 768, height: 1024 } },
    { label: "tablet landscape (1024x768)", size: { width: 1024, height: 768 } },
    // A LAPTOP, measured as a window rather than as a screen. A 1366x768 panel
    // gives roughly 590-650px of viewport once the browser's own chrome is on
    // it, and 1440x900 gives roughly 720-780. Testing the panel size instead of
    // the window is what let a 761px action pass as "desktop is fine".
    { label: "laptop 1366x768 (viewport 600)", size: { width: 1366, height: 600 } },
    { label: "laptop 1440x900 (viewport 740)", size: { width: 1440, height: 740 } },
    { label: "desktop tall (1440x900)", size: DESKTOP },
  ];
  const reach = [];
  for (const v of VIEWPORTS) {
    reach.push({ label: v.label, ...(await reachability(browser, v.label, v.size, auth)) });
  }

  if (REACHABILITY_ONLY) {
    await browser.close();
    console.log(`\n[EXPORT E2E — reachability only] PASS=${pass} FAIL=${fail}`);
    if (failures.length) console.log("  failed: " + failures.join(", "));
    console.log("\nreachability summary (distance from the top of the viewport):");
    for (const r of reach) {
      console.log(
        `  ${r.label.padEnd(24)} button top=${String(r.after.top).padStart(5)}px  viewport=${r.after.vh}px  ` +
          `${r.after.onScreen ? "ON SCREEN" : "OFF SCREEN"}`
      );
    }
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log("\nempty state");
  {
    const { context, page } = await openExport(browser, DESKTOP, auth);
    const button = cta(page);
    await button.waitFor({ state: "attached" });
    ok("nothing selected: the action is disabled", !(await button.isEnabled()));
    await page.getByText("בחרו לפחות תחום אחד כדי להוריד.").waitFor({ timeout: 5000 });
    ok("nothing selected: the screen says what is missing", true);
    await context.close();
  }

  console.log("\ndownloads");
  const one = await downloadCase(browser, auth, { label: "one domain xlsx", domains: [0], format: "xlsx", viewport: DESKTOP });
  ok("one domain -> a file arrives", one.size > 0);
  ok("one domain -> it is a real xlsx (zip header)", one.isXlsx, JSON.stringify(one.suggested));
  ok("one domain -> the button showed a busy state", one.busy);
  ok("one domain -> and refused a second press while busy", one.lockedWhileBusy);

  const many = await downloadCase(browser, auth, { label: "two domains xlsx", domains: [0, 1], format: "xlsx", viewport: DESKTOP });
  ok("multiple domains -> a file arrives", many.size > 0 && many.isXlsx);

  const all = await downloadCase(browser, auth, { label: "all domains xlsx", domains: "all", format: "xlsx", viewport: DESKTOP });
  ok("all domains -> a file arrives", all.size > 0 && all.isXlsx);

  // CSV, one domain: a single file, so its own bytes can be read directly.
  const csvOne = await downloadCase(browser, auth, { label: "one domain csv", domains: [0], format: "csv", viewport: DESKTOP });
  ok("csv, one domain -> a file arrives", csvOne.size > 0);
  ok("csv, one domain -> the name ends in .csv", /\.csv$/i.test(csvOne.suggested), csvOne.suggested);
  ok("csv, one domain -> Hebrew survived", csvOne.hasHebrew, csvOne.text.slice(0, 80));

  // CSV, several domains: one CSV per domain cannot be a single file, so the
  // server sends a zip. Asserted as a zip rather than mis-read as a CSV.
  const csvAll = await downloadCase(browser, auth, { label: "all domains csv", domains: "all", format: "csv", viewport: DESKTOP });
  ok("csv, all domains -> a file arrives", csvAll.size > 0);
  ok("csv, all domains -> it is a zip, one CSV per domain", csvAll.isXlsx && /\.zip$/i.test(csvAll.suggested), csvAll.suggested);

  const mobileDl = await downloadCase(browser, auth, { label: "mobile one domain xlsx", domains: [0], format: "xlsx", viewport: MOBILE });
  ok("mobile -> a file arrives", mobileDl.size > 0 && mobileDl.isXlsx);

  await browser.close();

  console.log(`\n[EXPORT E2E] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("  failed: " + failures.join(", "));
  console.log(`  files kept in ${OUT}`);
  console.log("\nreachability summary (distance from the top of the viewport):");
  for (const r of reach) {
    console.log(
      `  ${r.label.padEnd(24)} button top=${String(r.after.top).padStart(5)}px  viewport=${r.after.vh}px  ` +
        `${r.after.onScreen ? "ON SCREEN" : "OFF SCREEN"}`
    );
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E failed:", err.message);
  process.exit(1);
});
