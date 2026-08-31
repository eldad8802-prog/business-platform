/**
 * `/business/bot` ShellChrome contract verification — READ-ONLY.
 *
 * The page hid the shell unconditionally, so on desktop the owner lost
 * navigation for a conflict that only exists on mobile (a fixed bottom bar over
 * a full-screen sheet). The hiding is now tied to a sheet actually being open.
 *
 * This opens a sheet by clicking a category card and closes it again — a purely
 * local UI state change. No bot setting is saved, no message is sent, no
 * conversation is touched.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".bot-chrome");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const VIEWPORTS = [390, 768, 1024, 1280, 1440, 1920];
const DESKTOP_TIER = 1024;

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function shellState(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const navs = Array.from(document.querySelectorAll("nav")).filter(
      (n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 40
    );
    const dialog = document.querySelector('[role="dialog"]');
    const scroller = document.scrollingElement || de;
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body.scrollWidth),
      navs: navs.map((n) => ({ label: n.getAttribute("aria-label"), w: Math.round(n.getBoundingClientRect().width) })),
      chrome: document.querySelector("[data-shell-root]")?.getAttribute("data-chrome") ?? null,
      sheetOpen: !!dialog,
      dir: de.getAttribute("dir"),
      scrollTop: Math.round(scroller.scrollTop),
      focusable: Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
        .filter((e) => e.tabIndex >= 0).length,
    };
  });
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  let bucket = "boot";
  const reqs = {};
  page.on("request", (r) => {
    if (!r.url().includes("/api/")) return;
    const k = r.method() + " " + r.url().replace(BASE, "").replace(/\d+/g, ":id");
    reqs[bucket] = reqs[bucket] || {};
    reqs[bucket][k] = (reqs[bucket][k] || 0) + 1;
  });

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  const rows = [];
  for (const w of VIEWPORTS) {
    bucket = "bot@" + w;
    await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
    await page.goto(BASE + "/business/bot", { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(2600);

    const closed = await shellState(page);
    await page.screenshot({ path: path.join(OUT, "shots", "closed__" + w + ".png") });

    // Open a sheet: click the first category card. Local UI state only.
    let opened = null;
    const card = page.locator("button", { hasText: /זהות|שיחה|גבולות|עתיד/ }).first();
    if (await card.count()) {
      await card.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      opened = await shellState(page);
      await page.screenshot({ path: path.join(OUT, "shots", "sheet__" + w + ".png") });
      // Close it again, so the run leaves no state behind.
      await page.keyboard.press("Escape").catch(() => {});
      const closeBtn = page.locator('button[aria-label="סגור"]').first();
      if (await closeBtn.count()) await closeBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    const reclosed = await shellState(page);

    rows.push({ w, closed, opened, reclosed });
    console.log(
      "bot@" + w + ": closed nav=" + closed.navs.length + " chrome=" + closed.chrome +
      " | sheet " + (opened ? "open=" + opened.sheetOpen + " nav=" + opened.navs.length : "not reachable") +
      " | reclosed nav=" + reclosed.navs.length +
      " overflow=" + (closed.sw > closed.iw + 1)
    );
  }

  const by = (w) => rows.find((r) => r.w === w);

  check("zero horizontal overflow", rows.every((r) => r.closed.sw <= r.closed.iw + 1),
    rows.filter((r) => r.closed.sw > r.closed.iw + 1).map((r) => r.w).join(", "));
  check("RTL preserved", rows.every((r) => r.closed.dir === "rtl"));

  for (const w of VIEWPORTS) {
    const r = by(w);
    if (w >= DESKTOP_TIER) {
      check("bot@" + w + ": exactly one ShellChrome with no sheet open",
        r.closed.navs.length === 1, JSON.stringify(r.closed.navs));
    } else {
      check("bot@" + w + ": no shell below the desktop tier (unchanged)",
        r.closed.navs.length === 0, JSON.stringify(r.closed.navs));
    }
  }
  check("never two navigation surfaces", rows.every((r) =>
    r.closed.navs.length <= 1 && (!r.opened || r.opened.navs.length <= 1) && r.reclosed.navs.length <= 1));

  const opened = rows.filter((r) => r.opened && r.opened.sheetOpen);
  check("a sheet was actually opened (otherwise the modal claim is untested)",
    opened.length > 0, opened.length + " of " + rows.length + " viewports");
  check("while a sheet is open the shell yields, so the modal stays modal",
    opened.every((r) => r.opened.navs.length === 0),
    opened.map((r) => r.w + ":" + r.opened.navs.length).join(", "));
  check("the shell returns after the sheet closes",
    rows.filter((r) => r.w >= DESKTOP_TIER).every((r) => r.reclosed.navs.length === 1),
    rows.filter((r) => r.w >= DESKTOP_TIER).map((r) => r.w + ":" + r.reclosed.navs.length).join(", "));

  check("focusable-control count stable across the tier (keyboard order unchanged)",
    [...new Set(rows.map((r) => r.closed.focusable))].length <= 2,
    JSON.stringify(rows.map((r) => r.w + ":" + r.closed.focusable)));

  const dupes = Object.entries(reqs)
    .filter(([k]) => k !== "boot")
    .filter(([, v]) => Math.max(...Object.values(v), 0) > 1);
  check("no request/refetch increase across viewports (no remount)", dupes.length === 0,
    dupes.map(([k, v]) => k + ":" + JSON.stringify(v)).join(" | "));

  await writeFile(path.join(OUT, "bot-chrome.json"), JSON.stringify({ rows, reqs, checks: results }, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log("\n=== BOT CHROME " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => f.name + " " + f.detail).join("\n - "));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
