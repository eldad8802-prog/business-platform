/**
 * Home-cluster evidence (Spec v1 §22). Measures the loaded Home plus its
 * skeleton state across the full viewport matrix, asserts mobile preservation
 * and the intentional tablet/desktop compositions, and captures screenshots.
 *
 *   AUDIT_BASE_URL=... AUDIT_TOKEN_FILE=... node scripts/qa/ui/home-cluster-evidence.mjs
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3122";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".home-cluster");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Geometry of the Home composition at the current viewport. */
async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const wrap = document.querySelector(".dzhome .wrap");
    const host = document.querySelector("[data-page-intent]");
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    };
    const feats = document.querySelector(".dzhome .feats");
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
      wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : null,
      display: wrap ? getComputedStyle(wrap).display : null,
      intent: host?.getAttribute("data-page-intent") ?? null,
      dir: de.getAttribute("dir") || document.querySelector(".dzhome")?.getAttribute("dir"),
      seccard: box(".dzhome .seccard"),
      state: box(".dzhome .state"),
      tools: box(".dzhome .feats"),
      insights: box(".dzhome .ins"),
      // the tools strip should stop needing a sideways scroll once it fits
      toolsScrolls: feats ? feats.scrollWidth > feats.clientWidth + 1 : null,
      docHeight: Math.round(de.scrollHeight),
    };
  });
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  const rows = [];
  for (const w of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
    await page.goto(`${BASE}/app`, { waitUntil: "load", timeout: 60000 });

    // Skeleton state first (before .dzhome exists), then the loaded composition.
    const skel = await page
      .waitForSelector(".animate-pulse", { timeout: 2500 })
      .then(() => page.evaluate(() => {
        const el = document.querySelector("[data-page-intent]");
        return el ? { w: Math.round(el.getBoundingClientRect().width), intent: el.getAttribute("data-page-intent") } : null;
      }))
      .catch(() => null);
    if (skel) await page.screenshot({ path: path.join(OUT, "shots", `skeleton__${w}.png`) });

    await page.waitForSelector(".dzhome .wrap", { timeout: 30000 }).catch(() => {});
    // The brand intro overlay (variant V6) covers Home on every FULL document
    // load, so screenshots taken too early capture the animation instead of
    // the composition. Wait for it to retire before measuring/shooting.
    await page
      .waitForFunction(() => !document.querySelector("[data-dubiz-intro-overlay]"), { timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(900);
    const m = await measure(page);
    rows.push({ w, skel, ...m });
    await page.screenshot({ path: path.join(OUT, "shots", `home__${w}.png`), fullPage: false });
    console.log(
      `home@${w}: wrap=${m.wrapW} display=${m.display} intent=${m.intent} toolsScroll=${m.toolsScrolls} sec=${m.seccard?.w}@x${m.seccard?.x} state=${m.state?.w}@x${m.state?.x} overflow=${m.sw > m.iw + 1}`
    );
  }

  const by = (w) => rows.find((r) => r.w === w);

  // ── Universal ────────────────────────────────────────────────────────────
  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("zero horizontal overflow (7 viewports)", of.length === 0, of.map((r) => r.w).join(", "));
  check("declares the canonical content intent", rows.every((r) => r.intent === "content"));
  check("RTL preserved", rows.every((r) => r.dir === "rtl"));

  // ── Mobile preservation: unchanged 480 column, single flow ───────────────
  for (const w of [320, 390]) {
    const r = by(w);
    check(`@${w} mobile column preserved (<=480, not grid)`,
      r.wrapW <= 480 && r.display !== "grid", `wrap=${r.wrapW} display=${r.display}`);
    check(`@${w} sections stacked (state below secretary)`,
      r.seccard && r.state && r.state.y > r.seccard.y, `sec.y=${r.seccard?.y} state.y=${r.state?.y}`);
  }

  // ── Tablet: wider single column, still stacked ───────────────────────────
  const t768 = by(768);
  check("@768 single column widened to 600 (breathing, not 2-col)",
    t768.wrapW === 600 && t768.display !== "grid", `wrap=${t768.wrapW} display=${t768.display}`);
  check("@768 hierarchy unchanged (state still below secretary)",
    t768.state.y > t768.seccard.y);

  // ── Desktop: two-column status band, RTL-correct order ──────────────────
  for (const w of [1024, 1280, 1920]) {
    const r = by(w);
    check(`@${w} recomposed to grid`, r.display === "grid", `display=${r.display}`);
    check(`@${w} status band is side-by-side`,
      r.seccard && r.state && Math.abs(r.seccard.y - r.state.y) < 40,
      `sec.y=${r.seccard?.y} state.y=${r.state?.y}`);
    check(`@${w} RTL order: secretary starts right of day-state`,
      r.seccard.x > r.state.x, `sec.x=${r.seccard.x} state.x=${r.state.x}`);
    check(`@${w} tools + insights stay full width`,
      r.tools.w > r.seccard.w * 1.6 && r.insights.w > r.seccard.w * 1.6,
      `tools=${r.tools.w} insights=${r.insights.w} col=${r.seccard.w}`);
  }
  check("@1920 wrap reaches the content intent (960)", by(1920).wrapW === 960, `wrap=${by(1920).wrapW}`);
  check("tools strip stops needing a sideways scroll on desktop",
    by(1920).toolsScrolls === false, `scrolls=${by(1920).toolsScrolls}`);
  // Compare SCROLL OVERFLOW (doc - viewport), not raw document height: the
  // viewports differ in height, so comparing docHeight across them is
  // meaningless. Desktop must need less scrolling than mobile for the same
  // content.
  const overflowAt = (w, vh) => by(w).docHeight - vh;
  check("desktop needs less vertical scrolling than mobile",
    overflowAt(1920, 950) < overflowAt(390, 844),
    `1920=${overflowAt(1920, 950)}px vs 390=${overflowAt(390, 844)}px of scroll`);

  // ── Skeleton must not jump widths against the loaded composition ─────────
  const skels = rows.filter((r) => r.skel);
  check("loading skeleton declares the same intent", skels.length === 0 || skels.every((r) => r.skel.intent === "content"),
    skels.map((r) => `${r.w}:${r.skel?.intent}`).join(" "));

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify(rows, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => `${f.name} ${f.detail}`).join("\n - "));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
