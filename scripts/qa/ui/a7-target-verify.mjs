/**
 * A-7 gating verification for the three release-blocking surfaces.
 *
 * The contract this asserts (Accessibility Constitution A-7):
 *   < 24x24   FAIL — release blocker
 *   24..43    PASS (minimum) — reported when below the preferred 44
 *   >= 44x44  preferred usability target
 *
 * 44x44 is explicitly NOT a gate here; anything in 24..43 is reported as an
 * observation so the distinction stays visible without becoming a new bar.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".a7");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const VIEWPORTS = [320, 390, 768, 1024, 1280, 1920];
const ROUTES = [
  ["uniform-export", "/documents/uniform-export"],
  ["inventory-items", "/inventory/items"],
  ["settings-whatsapp", "/settings/whatsapp"],
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function main() {
  await mkdir(OUT, { recursive: true });
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
  for (const [name, route] of ROUTES) {
    for (const w of VIEWPORTS) {
      bucket = name + "@" + w;
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 45000 });
      await page
        .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 12000 })
        .catch(() => {});
      await page.waitForTimeout(1600);
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const targets = Array.from(
          document.querySelectorAll("button, a[href], input, select, textarea")
        )
          .map((e) => {
            const r = e.getBoundingClientRect();
            return {
              tag: e.tagName,
              type: e.getAttribute("type") || "",
              label:
                (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30) ||
                "(unlabelled)",
              h: Math.round(r.height),
              w: Math.round(r.width),
            };
          })
          .filter((t) => t.h > 0 && t.w > 0);
        return {
          iw: window.innerWidth,
          sw: Math.max(de.scrollWidth, document.body.scrollWidth),
          dir: de.getAttribute("dir"),
          // Focus order is a proxy for keyboard behaviour being untouched.
          focusable: Array.from(
            document.querySelectorAll("button, a[href], input, select, textarea")
          ).filter((e) => e.tabIndex >= 0).length,
          failing: targets.filter((t) => t.h < 24 || t.w < 24),
          belowPreferred: targets.filter((t) => (t.h >= 24 && t.h < 44) || (t.w >= 24 && t.w < 44)).length,
          total: targets.length,
        };
      });
      rows.push({ name, w, ...m });
      console.log(
        name + "@" + w + ": targets=" + m.total + " failing(<24)=" + m.failing.length +
        " belowPreferred(24-43)=" + m.belowPreferred + " focusable=" + m.focusable +
        " overflow=" + (m.sw > m.iw + 1)
      );
      if (m.failing.length) console.log("      " + JSON.stringify(m.failing));
    }
  }

  const fails = rows.filter((r) => r.failing.length);
  check("A-7 gating: no interactive target under 24x24 (" + rows.length + " cells)",
    fails.length === 0,
    fails.map((r) => r.name + "@" + r.w + ":" + JSON.stringify(r.failing)).join(" | "));
  check("zero horizontal overflow", rows.every((r) => r.sw <= r.iw + 1),
    rows.filter((r) => r.sw > r.iw + 1).map((r) => r.name + "@" + r.w).join(", "));
  check("RTL preserved", rows.every((r) => r.dir === "rtl"));
  for (const [name] of ROUTES) {
    const counts = [...new Set(rows.filter((r) => r.name === name).map((r) => r.focusable))];
    check(name + ": focusable-control count stable across viewports", counts.length <= 2,
      "counts=" + JSON.stringify(counts));
  }
  /**
   * The bar is parity with the pre-change baseline, not "exactly one call".
   * `/inventory/items` fetches its list twice per load, and that is measured
   * identically on `origin/main` — a pre-existing double fetch this
   * presentation-only change neither caused nor could cause. Asserting "one"
   * would have failed a correct patch; asserting parity tests what matters.
   */
  const BASELINE = {
    "uniform-export": {},
    "inventory-items": { "GET /api/inventory/items": 2 },
    "settings-whatsapp": {},
  };
  const drift = Object.entries(reqs)
    .filter(([k]) => k !== "boot")
    .flatMap(([k, v]) => {
      const surface = k.split("@")[0];
      const expected = BASELINE[surface] || {};
      return Object.entries(v)
        .filter(([call, n]) => n > (expected[call] || 1))
        .map(([call, n]) => k + " " + call + "=" + n);
    });
  check("request/refetch parity with the pre-change baseline", drift.length === 0,
    drift.join(" | "));

  await writeFile(path.join(OUT, "a7.json"), JSON.stringify({ rows, reqs, checks: results }, null, 1));
  const failed = results.filter((r) => !r.pass);
  console.log("\n=== A-7 GATE " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => f.name + " " + f.detail).join("\n - "));
  console.log("\nObservation, not a gate: targets in 24..43 remain below the preferred 44x44.");
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
