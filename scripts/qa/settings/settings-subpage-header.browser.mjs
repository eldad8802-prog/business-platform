#!/usr/bin/env node
/**
 * The shared settings page header (components/settings/SettingsSubPageHeader.tsx), in a REAL browser: this build
 * under `next start`, every /api/** request answered here (no database; nothing is sent anywhere).
 *
 *   BASE=http://localhost:3631 OUT=./shots node scripts/qa/settings/settings-subpage-header.browser.mjs
 *
 * /settings/inbound-email exists only with INBOUND_EMAIL_ENABLED=true on the server: start the local test server with
 * it (that server only).
 *
 * Owner 2026-11-15: a title such as "סוגי התראות" is shown in full on a 320 px phone — it may wrap to two lines.
 * For EVERY settings screen that uses the header, at 320 / 390 / 430 px (Android WebView UA, Hebrew, RTL):
 *   - the title is not cut (sideways or by the two-line clamp) and takes at most two lines;
 *   - the back control is visible, ≥ 44×44 px and has an accessible name;
 *   - the title's text never overlaps the back control or the balancing slot on the other side;
 *   - RTL: the document is rtl and the back control sits on the start (right) side of the title;
 *   - the header stays inside the screen (no horizontal scroll caused by it).
 * Screenshots of each header + results.json in OUT. Local server only.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE || "http://localhost:3631").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "settings-header-shots");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa", exp: 1893456000 })}.sig`;
const WV_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const WIDTHS = [320, 390, 430];

const results = [];
const check = (where, name, cond, detail = "") => {
  results.push({ where, name, pass: !!cond, detail: cond ? "" : String(detail) });
  console.log(`${cond ? "  ok " : "FAIL "} [${where}] ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};

// Every page under app/settings that renders <SettingsSubPageHeader>, found in the source (run from the repository
// root), so a new settings screen is checked without editing this list. A dynamic segment gets the id 1.
const ROUTES = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name === "page.tsx" && readFileSync(f, "utf8").includes("SettingsSubPageHeader")) {
      ROUTES.push("/" + path.relative("app", path.dirname(f)).split(path.sep).join("/").replace(/\[[^\]]+\]/g, "1"));
    }
  }
})(path.join("app", "settings"));
ROUTES.sort();
check("routes", `the settings pages that use the shared header were found (${ROUTES.length})`, ROUTES.length >= 10, JSON.stringify(ROUTES));

async function ctxFor(browser, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, userAgent: WV_UA, locale: "he-IL" });
  await ctx.addInitScript((t) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים", businessName: "עסק" }));
  }, TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const j = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/business/capabilities") return j({ features: { notifications_engine: { allowed: true } } });
    if (u.pathname === "/api/auth/me") return j({ user: { id: 9, name: "בעלים", businessName: "עסק", email: "qa@example.invalid" } });
    if (u.pathname === "/api/notifications/settings") {
      return j({
        settings: { pushEnabled: true, quietHoursEnabled: false, quietStartMinute: 1320, quietEndMinute: 420, digestEnabled: false, digestMinute: 480, lockScreenDetails: false },
        storedSettings: null, timeZone: "Asia/Jerusalem", categories: [], overrides: [],
      });
    }
    if (u.pathname === "/api/push/subscriptions") return j({ configured: false, publicKey: null });
    return j({ error: "not mocked" }, 404);
  });
  return ctx;
}

const browser = await chromium.launch();
const titles = {};
for (const width of WIDTHS) {
  const ctx = await ctxFor(browser, width);
  const p = await ctx.newPage();
  for (const route of ROUTES) {
    const where = `${width} ${route}`;
    await p.goto(BASE + route, { waitUntil: "domcontentloaded" });
    const h1 = p.locator('[data-testid="settings-subpage-title"]').first();
    const found = await h1.waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
    check(where, "the shared header is on the screen", found, `url=${p.url()}`);
    if (!found) continue;
    await p.waitForTimeout(300);
    const r = await h1.evaluate((el) => {
      const header = el.closest("header");
      const row = header.firstElementChild;
      const back = row.querySelector("button, a[href]");
      const slot = row.lastElementChild;
      const range = document.createRange();
      range.selectNodeContents(el);
      const textRects = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const rect = (b) => b && { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height };
      const bb = back?.getBoundingClientRect();
      const hb = header.getBoundingClientRect();
      return {
        title: el.textContent.trim(),
        cutX: el.scrollWidth > el.clientWidth + 1,
        cutY: el.scrollHeight > el.clientHeight + 1,
        lines: Math.round(el.getBoundingClientRect().height / lh),
        text: textRects.map(rect),
        back: rect(bb),
        backName: back ? (back.getAttribute("aria-label") || back.textContent || "").trim() : "",
        backVisible: !!back && bb.width > 0 && bb.height > 0 && getComputedStyle(back).visibility !== "hidden",
        slot: rect(slot.getBoundingClientRect()),
        row: rect(row.getBoundingClientRect()),
        dir: document.documentElement.dir || getComputedStyle(document.body).direction,
        headerInside: hb.left >= -1 && hb.right <= window.innerWidth + 1,
      };
    });
    const ownRow = r.text.length > 0 && r.text.every((t) => t.t >= r.back.b - 0.5);
    titles[r.title] = { ...(titles[r.title] || {}), [width]: `${r.lines}${ownRow ? " (own row)" : ""}` };
    const overlaps = (a, b) => a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
    check(where, `title shown in full ("${r.title}")`, !r.cutX && !r.cutY, `cutX=${r.cutX} cutY=${r.cutY}`);
    check(where, "title takes at most two lines", r.lines <= 2, `lines=${r.lines}`);
    check(where, "back control visible, ≥ 44×44 px, with an accessible name", r.backVisible && r.back.w >= 44 && r.back.h >= 44 && r.backName.length > 0, JSON.stringify({ back: r.back, name: r.backName }));
    check(where, "title text overlaps neither the back control nor the balancing slot", r.text.every((t) => !overlaps(t, r.back) && !overlaps(t, r.slot)), JSON.stringify({ text: r.text, back: r.back, slot: r.slot }));
    // Beside the title (start = right side in RTL), or — when a long back label leaves the title too little room —
    // on the row above it, at the start edge.
    check(where, "RTL: document rtl, back control at the start (right) — beside the title or on the row above it",
      r.dir === "rtl" && r.back.r >= r.row.r - 1 && r.text.every((t) => r.back.l >= t.r - 0.5 || t.t >= r.back.b - 0.5), JSON.stringify({ dir: r.dir, back: r.back, row: r.row, text: r.text }));
    check(where, "header inside the screen", r.headerInside);
    await p.locator("header").first().screenshot({ path: path.join(OUT, `${width}-${route.replace(/\W+/g, "_")}.png`) }).catch(() => {});
  }
  await ctx.close();
}
await browser.close();

console.log("\nTitle lines per width:");
for (const [t, w] of Object.entries(titles)) console.log(`  ${t}: ${WIDTHS.map((x) => `${x}px=${w[x] ?? "-"}`).join(" ")}`);
const failed = results.filter((x) => !x.pass);
writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ base: BASE, titles, results }, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
