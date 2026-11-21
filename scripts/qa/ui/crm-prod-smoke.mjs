/**
 * CRM-tail production smoke (post-merge, Spec v1 W5).
 *
 * Re-proves the cluster's adaptive contract against the deployed site rather
 * than a local build: overflow, RTL, intent, workspace pane geometry and the
 * mobile switch. Uses the persistent profile that holds the owner's manual
 * production login — no credentials pass through this script.
 *
 *   AUDIT_CUSTOMER_ID=.. AUDIT_SUPPLIER_ID=.. node scripts/qa/ui/crm-prod-smoke.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".crm-prod");
const PROFILE =
  process.env.AUDIT_PROFILE_DIR ||
  "C:/Users/84D7~1/AppData/Local/Temp/claude/c--dev-business-platform/ff50b31f-2d66-4c99-bf1c-dd70619a0b0f/scratchpad/closure-smoke/pw-profile";

const VIEWPORTS = [390, 1280, 1920];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vis = (el) => !!el && getComputedStyle(el).display !== "none";
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width) };
    };
    const s = document.querySelector("[data-wsl] > .wsl-start");
    const e = document.querySelector("[data-wsl] > .wsl-end");
    const reading = document.querySelector(".crm-reading");
    const host = document.querySelector("[data-page-intent]");
    const inner = reading || document.querySelector(".crm-page");
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
      intent: host ? host.getAttribute("data-page-intent") : null,
      intentW: host ? Math.round(host.getBoundingClientRect().width) : null,
      innerW: inner ? Math.round(inner.getBoundingClientRect().width) : null,
      hasReading: !!reading,
      wsl: s ? { sv: vis(s), ev: vis(e), s: box(s), e: box(e) } : null,
      dir: de.getAttribute("dir"),
    };
  });
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(BASE + "/customers", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (!(await page.evaluate(() => localStorage.getItem("token")))) {
    console.error("FAIL: no authenticated production session in profile");
    await ctx.close();
    process.exit(2);
  }

  // Discover real production ids from the live list rather than assuming any.
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/customers/"]'))
      .map((a) => a.getAttribute("href").split("/")[2])
      .filter((v) => /^\d+$/.test(v))
  );
  await page.goto(BASE + "/suppliers", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const sids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="/suppliers/"]'))
      .map((a) => a.getAttribute("href").split("/")[2])
      .filter((v) => /^\d+$/.test(v))
  );
  const CUSTOMER = process.env.AUDIT_CUSTOMER_ID || ids[0] || "";
  const SUPPLIER = process.env.AUDIT_SUPPLIER_ID || sids[0] || "";
  console.log("prod ids: customer=" + (CUSTOMER || "none") + " supplier=" + (SUPPLIER || "none"));

  const ROUTES = [
    ["customers", "/customers", "workspace"],
    ["suppliers", "/suppliers", "workspace"],
    ["opportunities", "/opportunities", "data"],
    ["attention", "/attention", "data"],
  ];
  if (CUSTOMER) ROUTES.push(["customer-detail", "/customers/" + CUSTOMER, "workspace"]);
  if (SUPPLIER) ROUTES.push(["supplier-detail", "/suppliers/" + SUPPLIER, "workspace"]);

  const rows = [];
  for (const [name, route, intent] of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      await page.waitForSelector(".crm-page, [data-page-intent]", { timeout: 25000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector(".crm-skel"), null, { timeout: 25000 })
        .catch(() => {});
      await page.waitForTimeout(1400);
      const m = await measure(page);
      rows.push(Object.assign({ name, w, expect: intent }, m));
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png") });
      console.log(
        name + "@" + w + ": intent=" + m.intent + "(" + m.intentW + ") inner=" + m.innerW +
        " panes=" + (m.wsl ? (m.wsl.sv ? m.wsl.s.w : "-") + "|" + (m.wsl.ev ? m.wsl.e.w : "-") : "-") +
        " overflow=" + (m.sw > m.iw + 1)
      );
    }
  }

  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("PROD: zero horizontal overflow (" + rows.length + " cells)", of.length === 0,
    of.map((r) => r.name + "@" + r.w).join(", "));
  check("PROD: RTL preserved everywhere", rows.every((r) => r.dir === "rtl"));
  for (const [name, , intent] of ROUTES) {
    const r = by(name, 1920);
    check("PROD: " + name + " intent=" + intent, r && r.intent === intent, "got=" + (r && r.intent));
  }
  for (const name of ["customers", "suppliers"]) {
    const wide = by(name, 1920);
    const mob = by(name, 390);
    check("PROD: " + name + "@1920 two-pane", !!(wide.wsl && wide.wsl.sv && wide.wsl.ev),
      wide.wsl ? wide.wsl.s.w + "|" + wide.wsl.e.w : "no wsl");
    check("PROD: " + name + "@1920 master=380", wide.wsl && wide.wsl.s.w === 380,
      "master=" + (wide.wsl && wide.wsl.s.w));
    check("PROD: " + name + "@1920 RTL pane order (master inline-start)",
      wide.wsl && wide.wsl.s.x > wide.wsl.e.x,
      wide.wsl ? "s.x=" + wide.wsl.s.x + " e.x=" + wide.wsl.e.x : "");
    check("PROD: " + name + "@390 mobile switch shows the list region only",
      mob.wsl && mob.wsl.sv === true && mob.wsl.ev === false,
      mob.wsl ? "sv=" + mob.wsl.sv + " ev=" + mob.wsl.ev : "no wsl");
  }
  for (const name of ["customer-detail", "supplier-detail"]) {
    const wide = by(name, 1920);
    if (!wide) { check("PROD: " + name + " reachable", false, "no such entity in production"); continue; }
    const mob = by(name, 390);
    check("PROD: " + name + "@1920 reading column 840", wide.hasReading && wide.innerW === 840,
      "inner=" + wide.innerW);
    check("PROD: " + name + "@390 mobile switch shows the card region only",
      mob.wsl && mob.wsl.sv === false && mob.wsl.ev === true,
      mob.wsl ? "sv=" + mob.wsl.sv + " ev=" + mob.wsl.ev : "no wsl");
  }
  for (const name of ["opportunities", "attention"]) {
    check("PROD: " + name + "@1920 reaches 1280", by(name, 1920).intentW === 1280,
      "w=" + by(name, 1920).intentW);
  }

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify({ rows, checks: results }, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log("=== PROD SMOKE " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.name + " " + f.detail).join(" | "));
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
