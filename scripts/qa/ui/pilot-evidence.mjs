/**
 * Pilot evidence harness (Foundation+Pilot gate): measures the five pilot
 * screens on a LOCAL build at the full owner-required viewport matrix
 * (320/390/768/1024/1280/1440/1920), asserts the mobile no-overflow invariant
 * and the expected desktop container behavior, and captures screenshots.
 *
 *   AUDIT_BASE_URL=http://localhost:3111 node scripts/qa/ui/pilot-evidence.mjs
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3111";
const OUT =
  process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".pilot-evidence");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

const ROUTES = [
  ["documents-inbox", "/documents/inbox", "data"],
  ["inventory-hub", "/inventory", "dashboard"],
  ["payments", "/payments", "workspace"],
  ["suppliers", "/suppliers", "workspace"],
  ["settings-whatsapp", "/settings/whatsapp", "focused"],
];

const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = TOKEN_FILE
    ? JSON.parse(await readFile(TOKEN_FILE, "utf8")).token
    : null;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  if (token) {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => localStorage.setItem("token", t), token);
  }

  const rows = [];
  for (const [name, route] of ROUTES) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      // "load" + settle delay (not networkidle): screens with polling/long
      // fetches never reach networkidle and would time the harness out.
      await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(1500);
      if (name === "documents-inbox") {
        // Wait past the loading skeleton: the post-load band / table / empty
        // state — otherwise desktop measurements catch the skeleton frame.
        await page
          .waitForSelector("section[aria-live], table, [class*=empty]", {
            timeout: 20000,
          })
          .catch(() => {});
        await page.waitForTimeout(400);
      }
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const main = document.querySelector("main, [data-page-intent], .inv-hm-frame");
        const intentEl = document.querySelector("[data-page-intent]");
        const table = document.querySelector("table");
        // Workspace screens: measure the primitive's regions directly.
        const vis = (el) => el && getComputedStyle(el).display !== "none";
        const wslStart = document.querySelector("[data-wsl] > .wsl-start");
        const wslEnd = document.querySelector("[data-wsl] > .wsl-end");
        return {
          iw: window.innerWidth,
          sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
          mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
          intent: intentEl?.getAttribute("data-page-intent") ?? null,
          tableW: table ? Math.round(table.getBoundingClientRect().width) : null,
          wsl: wslStart
            ? {
                startVisible: vis(wslStart),
                endVisible: vis(wslEnd),
                startW: Math.round(wslStart.getBoundingClientRect().width),
                endW: wslEnd ? Math.round(wslEnd.getBoundingClientRect().width) : 0,
              }
            : null,
          url: location.pathname,
        };
      });
      rows.push({ name, w, ...m });
      await page.screenshot({
        path: path.join(OUT, "shots", `${name}__${w}.png`),
        fullPage: false,
      });
      console.log(
        `${name}@${w}: main=${m.mainW} table=${m.tableW ?? "-"} intent=${m.intent ?? "-"} wsl=${m.wsl ? `${m.wsl.startVisible ? m.wsl.startW : "·"}|${m.wsl.endVisible ? m.wsl.endW : "·"}` : "-"} overflow=${m.sw > m.iw + 1}`
      );
    }
  }

  // ── Assertions ─────────────────────────────────────────────────────────
  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("no horizontal overflow at ANY viewport (mobile invariant)", of.length === 0,
    of.map((r) => `${r.name}@${r.w}`).join(", "));

  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);

  const inbox1920 = by("documents-inbox", 1920);
  check("inbox @1920 uses the data container (~1280, was 760)",
    inbox1920?.mainW >= 1180 && inbox1920?.mainW <= 1290, `main=${inbox1920?.mainW}`);
  check("inbox @1920 renders the desktop table at data width",
    (inbox1920?.tableW ?? 0) >= 1100, `table=${inbox1920?.tableW}`);
  check("inbox declares data intent", inbox1920?.intent === "data");
  const inbox390 = by("documents-inbox", 390);
  check("inbox @390 unchanged mobile column", inbox390?.mainW <= 390);

  const inv1920 = by("inventory-hub", 1920);
  check("inventory hub @1920 recomposed to content width (~960, was 520)",
    inv1920?.mainW >= 900 && inv1920?.mainW <= 970, `main=${inv1920?.mainW}`);
  const inv390 = by("inventory-hub", 390);
  check("inventory hub @390 unchanged mobile column", inv390?.mainW <= 390);

  const wa1920 = by("settings-whatsapp", 1920);
  check("whatsapp settings @1920 stays FOCUSED (560) — narrow is a decision",
    wa1920?.mainW >= 520 && wa1920?.mainW <= 570, `main=${wa1920?.mainW}`);
  check("whatsapp declares focused intent", wa1920?.intent === "focused");

  const pay1280 = by("payments", 1280);
  check(
    "payments @1280: two-pane parallel (400 master + flexible detail)",
    pay1280?.wsl?.startVisible && pay1280?.wsl?.endVisible &&
      pay1280.wsl.startW >= 390 && pay1280.wsl.endW >= 500,
    JSON.stringify(pay1280?.wsl)
  );
  const pay390 = by("payments", 390);
  check(
    "payments @390: switch mode shows exactly the list",
    pay390?.wsl?.startVisible === true && pay390?.wsl?.endVisible === false,
    JSON.stringify(pay390?.wsl)
  );

  const sup1920 = by("suppliers", 1920);
  const sup1024 = by("suppliers", 1024);
  check(
    "suppliers @1920: two-pane at the canonical workspace tier",
    sup1920?.wsl?.startVisible && sup1920?.wsl?.endVisible && sup1920.wsl.startW >= 370,
    JSON.stringify(sup1920?.wsl)
  );
  check(
    "suppliers @1024: below wide tier — single region (list)",
    sup1024?.wsl?.startVisible === true && sup1024?.wsl?.endVisible === false,
    JSON.stringify(sup1024?.wsl)
  );

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
