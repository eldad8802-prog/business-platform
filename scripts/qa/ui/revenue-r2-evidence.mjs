/**
 * Revenue R2 evidence — READ-ONLY.
 *
 * Issues, redeems, enables and disables nothing. The dev tenant holds no
 * coupons, so the populated collection cannot be rendered; what *can* be proven
 * without inventing data is the shipped stylesheet itself. A probe element
 * carrying the collection class is appended to the live document, its computed
 * `grid-template-columns` is read, and it is removed again — that tests the CSS
 * as delivered rather than a mock of it. The populated grid remains
 * IMPLEMENTED BUT NOT CURRENTLY RUNTIME PROVEN.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".revenue-r2");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];
const ROUTES = [
  ["mine", "/revenue", "MANAGEMENT"],
  ["create", "/revenue?view=create", "MANAGEMENT"],
  ["redeem", "/revenue/redeem", "MANAGEMENT"],
  ["browse", "/revenue?view=browse", "CONSUMER"],
  ["consumer-coupon", "/revenue/coupons/00000000-0000-0000-0000-000000000000", "CONSUMER"],
  ["preview", "/coupon-design", "PREVIEW"],
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const rect = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
    const mg = document.querySelector(".revenue-management");
    const navs = Array.from(document.querySelectorAll("nav"))
      .filter((n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 40);
    const phoneCaps = [
      ...new Set(
        Array.from(document.querySelectorAll("div"))
          .map((d) => getComputedStyle(d).maxWidth)
          .filter((v) => v === "390px" || v === "480px")
      ),
    ];
    // Probe the shipped collection rule without any coupon existing.
    let columns = null;
    const host = document.querySelector(".revenue-management") || document.body;
    if (host) {
      const probe = document.createElement("div");
      probe.className = "rv-coupon-collection";
      host.appendChild(probe);
      columns = getComputedStyle(probe).gridTemplateColumns;
      probe.remove();
    }
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body.scrollWidth),
      mgmtW: rect(mg),
      intent: mg ? mg.getAttribute("data-page-intent") : null,
      collection: !!(mg && mg.classList.contains("revenue-collection")),
      columns,
      navs: navs.length,
      phoneCaps,
      minTap: taps.length ? Math.round(Math.min(...taps.map((r) => r.height))) : null,
      tokenInDom: /qrValue|"token"/.test(de.innerHTML),
      dir: de.getAttribute("dir"),
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
    const k = r.method() + " " + r.url().replace(BASE, "").replace(/[0-9a-f-]{8,}/g, ":id");
    reqs[bucket] = reqs[bucket] || {};
    reqs[bucket][k] = (reqs[bucket][k] || 0) + 1;
  });

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  const rows = [];
  for (const [name, route, cls] of ROUTES) {
    for (const w of VIEWPORTS) {
      bucket = name + "@" + w;
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2400);
      const m = await measure(page);
      rows.push({ name, cls, w, ...m });
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png") });
      console.log(
        name + "@" + w + ": mgmt=" + m.mgmtW + "(" + m.intent + (m.collection ? ",coll" : "") +
        ") cols=" + m.columns + " nav=" + m.navs + " caps=" + JSON.stringify(m.phoneCaps) +
        " minTap=" + m.minTap + " overflow=" + (m.sw > m.iw + 1)
      );
    }
  }

  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  const mgmt = rows.filter((r) => r.cls === "MANAGEMENT");

  // --- universal ---
  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("zero horizontal overflow (" + rows.length + " cells)", of.length === 0,
    of.map((r) => r.name + "@" + r.w).join(", "));
  check("RTL preserved", rows.every((r) => r.dir === "rtl"));
  check("no interactive target under 24px", rows.every((r) => r.minTap === null || r.minTap >= 24),
    rows.filter((r) => r.minTap !== null && r.minTap < 24).map((r) => r.name + "@" + r.w + "=" + r.minTap).join(", "));
  check("secret capability never in the DOM", rows.every((r) => !r.tokenInDom),
    rows.filter((r) => r.tokenInDom).map((r) => r.name + "@" + r.w).join(", "));

  // --- ShellChrome contract ---
  for (const r of mgmt) {
    if (r.w >= 1024) check("chrome: " + r.name + "@" + r.w + " has the shell nav", r.navs === 1, "navs=" + r.navs);
    else check("chrome: " + r.name + "@" + r.w + " keeps the full viewport", r.navs === 0, "navs=" + r.navs);
  }
  check("never two navigation surfaces", rows.every((r) => r.navs <= 1));

  // --- collection composition (the shipped rule, probed) ---
  const cols = (w) => (by("mine", w) || {}).columns || "";
  check("collection: one column below the tablet tier",
    [320, 390].every((w) => cols(w).split(" ").length === 1), [320, 390].map((w) => w + ":" + cols(w)).join(" | "));
  check("collection: two columns from 768 to 1279",
    [768, 1024].every((w) => cols(w).split(" ").length === 2), [768, 1024].map((w) => w + ":" + cols(w)).join(" | "));
  check("collection: three columns from the workspace tier",
    [1280, 1440, 1920].every((w) => cols(w).split(" ").length === 3),
    [1280, 1440, 1920].map((w) => w + ":" + cols(w)).join(" | "));

  // --- management width authority ---
  for (const w of [320, 390, 768, 1024]) {
    const r = by("mine", w);
    check("mine@" + w + " keeps the content measure", r.intent === "content", "intent=" + r.intent);
  }
  for (const w of [1280, 1440, 1920]) {
    const r = by("mine", w);
    // The cap is `data` (1280) but the shell sidebar takes 248, so below ~1528
    // the available width binds first and the container is narrower than the
    // cap. That is the cap working, not failing — assert the intent, and that
    // the container fills what the shell leaves it, up to the cap.
    check("mine@" + w + " takes the data measure", r.intent === "data", "intent=" + r.intent);
    check("mine@" + w + " fills the shell's remaining width up to the cap",
      r.mgmtW > 960 && r.mgmtW <= 1280, "w=" + r.mgmtW);
  }
  for (const w of VIEWPORTS) {
    const r = by("create", w);
    check("create@" + w + " stays focused (a form is not stretched)",
      r.intent === "focused" && r.mgmtW <= 560, "intent=" + r.intent + " w=" + r.mgmtW);
  }

  // --- consumer + preview invariants ---
  for (const w of VIEWPORTS) {
    check("consumer: browse@" + w + " keeps the screen frame and no chrome",
      by("browse", w).navs === 0, "navs=" + by("browse", w).navs);
    check("consumer: coupon page@" + w + " has no management chrome",
      by("consumer-coupon", w).navs === 0, "navs=" + by("consumer-coupon", w).navs);
    check("preview: coupon-design@" + w + " keeps its device mocks",
      by("preview", w).phoneCaps.includes("390px"), JSON.stringify(by("preview", w).phoneCaps));
  }

  // --- request parity ---
  const dupes = Object.entries(reqs).filter(([, v]) => Math.max(...Object.values(v), 0) > 1);
  check("no duplicate request on any load (no remount across tiers)", dupes.length === 0,
    dupes.map(([k, v]) => k + ":" + JSON.stringify(v)).join(" | "));

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify({ rows, reqs, checks: results }, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log("\n=== R2 EVIDENCE " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => f.name + " " + f.detail).join("\n - "));
  console.log("\nNOTE: the dev tenant holds 0 coupons, so the POPULATED collection is");
  console.log("IMPLEMENTED BUT NOT CURRENTLY RUNTIME PROVEN. The column rule above is");
  console.log("measured from the shipped stylesheet, not from rendered cards.");
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
