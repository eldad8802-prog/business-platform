/**
 * Post-deploy pilot smoke — PRODUCTION, read-only navigation + measurement.
 * Uses the operator-authenticated persistent profile (no credentials here).
 *
 *   node scripts/qa/ui/pilot-prod-smoke.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".pilot-prod");
const PROFILE =
  process.env.AUDIT_PROFILE_DIR ||
  "C:/Users/84D7~1/AppData/Local/Temp/claude/c--dev-business-platform/ff50b31f-2d66-4c99-bf1c-dd70619a0b0f/scratchpad/closure-smoke/pw-profile";

const ROUTES = [
  ["documents-inbox", "/documents/inbox"],
  ["inventory-hub", "/inventory"],
  ["payments", "/payments"],
  ["suppliers", "/suppliers"],
  ["settings-whatsapp", "/settings/whatsapp"],
];
const VIEWPORTS = [390, 768, 1280, 1920];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  const token = await page.evaluate(() => localStorage.getItem("token"));
  if (!token) {
    console.error("FAIL: no authenticated session in profile — re-login needed");
    await ctx.close();
    process.exit(2);
  }

  const rows = [];
  for (const [name, route] of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(1800);
      if (name === "documents-inbox") {
        await page
          .waitForSelector("section[aria-live], table, [class*=empty]", { timeout: 20000 })
          .catch(() => {});
        await page.waitForTimeout(400);
      }
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const main = document.querySelector("main, [data-page-intent], .inv-hm-frame");
        const table = document.querySelector("table");
        const vis = (el) => el && getComputedStyle(el).display !== "none";
        const s = document.querySelector("[data-wsl] > .wsl-start");
        const e = document.querySelector("[data-wsl] > .wsl-end");
        return {
          iw: window.innerWidth,
          sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
          mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
          intent: document.querySelector("[data-page-intent]")?.getAttribute("data-page-intent") ?? null,
          tableW: table ? Math.round(table.getBoundingClientRect().width) : null,
          wsl: s
            ? { sv: vis(s), ev: vis(e), swd: Math.round(s.getBoundingClientRect().width), ewd: e ? Math.round(e.getBoundingClientRect().width) : 0 }
            : null,
          url: location.pathname,
        };
      });
      rows.push({ name, w, ...m });
      await page.screenshot({ path: path.join(OUT, "shots", `${name}__${w}.png`) });
      console.log(`${name}@${w}: main=${m.mainW} table=${m.tableW ?? "-"} wsl=${m.wsl ? `${m.wsl.sv ? m.wsl.swd : "·"}|${m.wsl.ev ? m.wsl.ewd : "·"}` : "-"} overflow=${m.sw > m.iw + 1}`);
    }
  }

  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("PROD: zero horizontal overflow (all pilots × all viewports)", of.length === 0,
    of.map((r) => `${r.name}@${r.w}`).join(", "));
  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);
  check("PROD inbox @1920 data container", by("documents-inbox", 1920)?.mainW === 1280, `main=${by("documents-inbox", 1920)?.mainW}`);
  check("PROD inbox @1920 desktop table wide", (by("documents-inbox", 1920)?.tableW ?? 0) >= 1100, `table=${by("documents-inbox", 1920)?.tableW}`);
  check("PROD inbox @390 mobile intact", by("documents-inbox", 390)?.mainW <= 390);
  check("PROD inventory hub @1920 = 960", by("inventory-hub", 1920)?.mainW === 960, `main=${by("inventory-hub", 1920)?.mainW}`);
  check("PROD inventory hub @390 intact", by("inventory-hub", 390)?.mainW <= 390);
  check("PROD whatsapp @1920 focused 560", by("settings-whatsapp", 1920)?.mainW === 560, `main=${by("settings-whatsapp", 1920)?.mainW}`);
  const p1280 = by("payments", 1280);
  check("PROD payments @1280 two-pane", p1280?.wsl?.sv && p1280?.wsl?.ev && p1280.wsl.swd >= 390, JSON.stringify(p1280?.wsl));
  const s1920 = by("suppliers", 1920);
  check("PROD suppliers @1920 two-pane", s1920?.wsl?.sv && s1920?.wsl?.ev && s1920.wsl.swd >= 370, JSON.stringify(s1920?.wsl));
  const s768 = by("suppliers", 768);
  check("PROD suppliers @768 single region", s768?.wsl?.sv === true && s768?.wsl?.ev === false, JSON.stringify(s768?.wsl));

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
