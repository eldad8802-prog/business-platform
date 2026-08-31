/**
 * Revenue adaptive production closure smoke — READ-ONLY, MUTATION-SAFE.
 *
 * Covers the merged #298 (coupon public-id / auth contract) and #299 (R2
 * management composition) against the deployment that actually serves the
 * domain. It issues, redeems, enables and disables nothing; the API probes use
 * ids that cannot exist, so a missing gate shows as a status code rather than
 * as a change to real data.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".revenue-prod");
const PROFILE =
  process.env.AUDIT_PROFILE_DIR ||
  "C:/Users/84D7~1/AppData/Local/Temp/claude/c--dev-business-platform/ff50b31f-2d66-4c99-bf1c-dd70619a0b0f/scratchpad/closure-smoke/pw-profile";

const VIEWPORTS = [390, 768, 1024, 1280, 1440, 1920];
const ROUTES = [
  ["mine", "/revenue", "MANAGEMENT"],
  ["create", "/revenue?view=create", "MANAGEMENT"],
  ["redeem", "/revenue/redeem", "MANAGEMENT"],
  ["browse", "/revenue?view=browse", "CONSUMER"],
  ["public-coupon", "/revenue/coupons/00000000-0000-0000-0000-000000000000", "CONSUMER"],
  ["preview", "/coupon-design", "PREVIEW"],
];

const IMPOSSIBLE_NUM = "999999999";
const IMPOSSIBLE_UUID = "00000000-0000-0000-0000-000000000000";

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const mg = document.querySelector(".revenue-management");
    const navs = Array.from(document.querySelectorAll("nav")).filter(
      (n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 40
    );
    const phoneCaps = [
      ...new Set(
        Array.from(document.querySelectorAll("div"))
          .map((d) => getComputedStyle(d).maxWidth)
          .filter((v) => v === "390px" || v === "480px")
      ),
    ];
    // Probe the shipped collection rule; no coupon is required and none is made.
    let columns = null;
    let capFromInlineStyle = null;
    if (mg) {
      const probe = document.createElement("div");
      probe.className = "rv-coupon-collection";
      mg.appendChild(probe);
      columns = getComputedStyle(probe).gridTemplateColumns;
      probe.remove();
      // The cap must come from PageContainer's own inline style (its intent),
      // not from a stylesheet override bolted on top of it.
      capFromInlineStyle = mg.style.maxWidth || null;
    }
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body.scrollWidth),
      mgmtW: mg ? Math.round(mg.getBoundingClientRect().width) : null,
      intent: mg ? mg.getAttribute("data-page-intent") : null,
      capFromInlineStyle,
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
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let bucket = "boot";
  const reqs = {};
  page.on("request", (r) => {
    if (!r.url().includes("/api/")) return;
    const k = r.method() + " " + r.url().replace(BASE, "").replace(/[0-9a-f-]{8,}/g, ":id");
    reqs[bucket] = reqs[bucket] || {};
    reqs[bucket][k] = (reqs[bucket][k] || 0) + 1;
  });

  await page.goto(BASE + "/revenue", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  if (!(await page.evaluate(() => localStorage.getItem("token")))) {
    console.error("FAIL: no authenticated production session in profile");
    await ctx.close();
    process.exit(2);
  }

  // Probe traffic is bucketed separately: attributing it to whichever page was
  // last loaded made the request tally look like a duplicate fetch when it was
  // the harness talking, not the app.
  bucket = "probe:inventory";
  // How many coupons exist decides what can honestly be claimed below.
  const inventory = await page.evaluate(async () => {
    const h = { authorization: "Bearer " + localStorage.getItem("token") };
    const mine = await (await fetch("/api/revenue/coupons/mine", { headers: h })).json().catch(() => ({}));
    const active = await (await fetch("/api/revenue/coupons/active")).json().catch(() => ({}));
    return { mine: (mine.coupons || []).length, active: (active.coupons || []).length };
  });
  console.log("production coupons: mine=" + inventory.mine + " active=" + inventory.active);

  const rows = [];
  for (const [name, route, cls] of ROUTES) {
    for (const w of VIEWPORTS) {
      bucket = name + "@" + w;
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2600);
      const m = await measure(page);
      rows.push({ name, cls, w, ...m });
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png") });
      console.log(
        name + "@" + w + ": mgmt=" + m.mgmtW + "(" + m.intent + ") inlineCap=" + m.capFromInlineStyle +
        " cols=" + m.columns + " nav=" + m.navs + " caps=" + JSON.stringify(m.phoneCaps) +
        " minTap=" + m.minTap + " overflow=" + (m.sw > m.iw + 1)
      );
    }
  }

  // ---------- #298 contract, against production ----------
  bucket = "probe:api";
  console.log("\n=== #298 CONTRACT ===");
  const api = await page.evaluate(
    async ([num, uuid]) => {
      const out = {};
      const hit = async (label, url, opts) => {
        const r = await fetch(url, opts);
        out[label] = r.status;
      };
      const auth = { headers: { authorization: "Bearer " + localStorage.getItem("token") } };
      await hit("public malformed", "/api/revenue/coupons/" + num);
      await hit("public malformed alpha", "/api/revenue/coupons/abc");
      await hit("public missing", "/api/revenue/coupons/" + uuid);
      await hit("code anon", "/api/revenue/coupons/" + num + "/code");
      await hit("code auth malformed", "/api/revenue/coupons/" + num + "/code", auth);
      await hit("code auth missing", "/api/revenue/coupons/" + uuid + "/code", auth);
      await hit("redeem anon", "/api/coupons/" + uuid + "/redeem", { method: "POST" });
      await hit("mine anon", "/api/revenue/coupons/mine");
      await hit("disable anon", "/api/revenue/coupons/" + num + "/disable", { method: "POST" });
      return out;
    },
    [IMPOSSIBLE_NUM, IMPOSSIBLE_UUID]
  );
  for (const [k, v] of Object.entries(api)) console.log("  " + v + "  " + k);

  check("public lookup: malformed id → 404, not 500", api["public malformed"] === 404, api["public malformed"]);
  check("public lookup: alpha id → 404, not 500", api["public malformed alpha"] === 404, api["public malformed alpha"]);
  check("public lookup: missing id → 404 (indistinguishable from malformed)",
    api["public missing"] === 404 && api["public missing"] === api["public malformed"],
    api["public missing"] + " vs " + api["public malformed"]);
  check("secret /code: anonymous → 401 (auth before identifier)", api["code anon"] === 401, api["code anon"]);
  check("secret /code: authenticated malformed → 404, not 500", api["code auth malformed"] === 404, api["code auth malformed"]);
  check("secret /code: malformed and missing are indistinguishable",
    api["code auth malformed"] === api["code auth missing"],
    api["code auth malformed"] + " vs " + api["code auth missing"]);
  check("redemption: unauthenticated → 401", api["redeem anon"] === 401, api["redeem anon"]);
  // Anonymous management APIs must still be protected. The persistent profile
  // carries a session, so these are re-probed from a clean context below.

  // ---------- anonymous control group ----------
  const anonBrowser = await chromium.launch({ headless: true });
  const anonPage = await (await anonBrowser.newContext()).newPage();
  await anonPage.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await anonPage.evaluate(() => localStorage.clear());
  const anonApi = await anonPage.evaluate(
    async ([num]) => {
      const out = {};
      for (const [label, url, opts] of [
        ["mine", "/api/revenue/coupons/mine", undefined],
        ["my-business", "/api/revenue/coupons/my-business", undefined],
        ["offers", "/api/offers", undefined],
        ["disable", "/api/revenue/coupons/" + num + "/disable", { method: "POST" }],
        ["enable", "/api/revenue/coupons/" + num + "/enable", { method: "POST" }],
      ]) {
        out[label] = (await fetch(url, opts)).status;
      }
      return out;
    },
    [IMPOSSIBLE_NUM]
  );
  console.log("\n=== ANONYMOUS MANAGEMENT APIS ===");
  for (const [k, v] of Object.entries(anonApi)) console.log("  " + v + "  " + k);
  check("anonymous management APIs all refused",
    Object.values(anonApi).every((s) => s === 401 || s === 403),
    JSON.stringify(anonApi));
  await anonBrowser.close();

  // ---------- #299 composition ----------
  console.log("\n=== #299 COMPOSITION ===");
  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  const mgmt = rows.filter((r) => r.cls === "MANAGEMENT");

  check("zero horizontal overflow (" + rows.length + " cells)",
    rows.every((r) => r.sw <= r.iw + 1),
    rows.filter((r) => r.sw > r.iw + 1).map((r) => r.name + "@" + r.w).join(", "));
  check("RTL preserved", rows.every((r) => r.dir === "rtl"));
  check("no interactive target under 24px", rows.every((r) => r.minTap === null || r.minTap >= 24),
    rows.filter((r) => r.minTap !== null && r.minTap < 24).map((r) => r.name + "@" + r.w + "=" + r.minTap).join(", "));

  for (const r of mgmt) {
    if (r.w >= 1024) check("chrome: " + r.name + "@" + r.w + " exactly one shell nav", r.navs === 1, "navs=" + r.navs);
    else check("chrome: " + r.name + "@" + r.w + " full viewport", r.navs === 0, "navs=" + r.navs);
  }
  check("never two navigation surfaces", rows.every((r) => r.navs <= 1));

  const cols = (w) => (by("mine", w) || {}).columns || "";
  check("mine: one column at 390", cols(390).split(" ").length === 1, cols(390));
  check("mine: two columns at 768 and 1024",
    [768, 1024].every((w) => cols(w).split(" ").length === 2), [768, 1024].map((w) => w + ":" + cols(w)).join(" | "));
  check("mine: three columns from 1280",
    [1280, 1440, 1920].every((w) => cols(w).split(" ").length === 3),
    [1280, 1440, 1920].map((w) => w + ":" + cols(w)).join(" | "));
  for (const w of [390, 768, 1024]) {
    check("mine@" + w + " content intent", by("mine", w).intent === "content", by("mine", w).intent);
  }
  for (const w of [1280, 1440, 1920]) {
    const r = by("mine", w);
    check("mine@" + w + " data intent", r.intent === "data", r.intent);
    check("mine@" + w + " cap comes from PageContainer's inline style, not a CSS override",
      r.capFromInlineStyle === "1280px", "inline=" + r.capFromInlineStyle);
  }
  for (const w of VIEWPORTS) {
    const r = by("create", w);
    check("create@" + w + " focused, not stretched", r.intent === "focused" && r.mgmtW <= 560,
      r.intent + " w=" + r.mgmtW);
  }

  // ---------- consumer + preview ----------
  console.log("\n=== CONSUMER / PREVIEW REGRESSION ===");
  for (const w of VIEWPORTS) {
    check("consumer browse@" + w + ": 480 cap kept, no management chrome",
      by("browse", w).phoneCaps.includes("480px") && by("browse", w).navs === 0,
      JSON.stringify(by("browse", w).phoneCaps) + " navs=" + by("browse", w).navs);
    check("consumer coupon page@" + w + ": no management chrome", by("public-coupon", w).navs === 0,
      "navs=" + by("public-coupon", w).navs);
    check("preview@" + w + ": device mocks kept", by("preview", w).phoneCaps.includes("390px"),
      JSON.stringify(by("preview", w).phoneCaps));
  }
  check("secret capability never in the DOM", rows.every((r) => !r.tokenInDom),
    rows.filter((r) => r.tokenInDom).map((r) => r.name + "@" + r.w).join(", "));

  // ---------- request parity ----------
  const dupes = Object.entries(reqs)
    .filter(([k]) => !k.startsWith("probe:") && k !== "boot")
    .filter(([, v]) => Math.max(...Object.values(v), 0) > 1);
  check("one request per surface per load (no remount across tiers)", dupes.length === 0,
    dupes.map(([k, v]) => k + ":" + JSON.stringify(v)).join(" | "));

  await writeFile(path.join(OUT, "matrix.json"),
    JSON.stringify({ inventory, rows, api, anonApi, reqs, checks: results }, null, 1));

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== REVENUE PRODUCTION CLOSURE " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => f.name + " " + f.detail).join("\n - "));
  if (inventory.mine === 0) {
    console.log("\nCOVERAGE: production holds 0 coupons for this business, so the populated");
    console.log("collection, the kill switch and redeemed/expired states are NOT CURRENTLY");
    console.log("RUNTIME PROVEN. No coupon was issued to close that gap.");
  }
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
