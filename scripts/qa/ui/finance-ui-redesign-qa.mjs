/**
 * Finance UI redesign QA — Secretary (/secretary) + Payables (/payables).
 *
 * Drives the REAL Next.js app in Chromium with EVERY /api/** request answered
 * from fixtures (scripts/qa/ui/finance-ui-fixtures.mjs). Nothing reaches a
 * database or a third-party service: un-mocked /api calls are logged and get a
 * 404 JSON, and every non-GET request is recorded (the run expects none).
 *
 *   BASE_URL=http://localhost:3105 node scripts/qa/ui/finance-ui-redesign-qa.mjs [--only=secretary|payables]
 *
 * Requires `npx next dev -p 3105` running in this checkout. Evidence goes to
 * qa-evidence/finance-ui-redesign/ (<page>-<scenario>-<viewport>.png + results.json).
 *
 * Auth is client-side: a fake JWT-shaped token (exp 2030) is written to
 * localStorage "token" before any page script runs. The browser clock is frozen
 * at 2026-10-21T09:00:00+03:00.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FROZEN_NOW, resolveApi } from "./finance-ui-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(ROOT, "qa-evidence", "finance-ui-redesign");
mkdirSync(OUT, { recursive: true });

const BASE = (process.env.BASE_URL || "http://localhost:3105").replace(/\/$/, "");
if (/promaxgroup|vercel\.app/i.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local dev server only.`);
  process.exit(2);
}
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length) || null;

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "tablet", width: 820, height: 1180, isMobile: false, hasTouch: true },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const PAGES = [
  { slug: "secretary", path: "/secretary", scenarios: ["prod", "empty", "calm"], group: "secretary" },
  { slug: "secretary-today", path: "/secretary?today=1", scenarios: ["prod"], group: "secretary" },
  { slug: "secretary-detail-11", path: "/secretary?screen=detail&id=11", scenarios: ["prod"], group: "secretary" },
  { slug: "secretary-capture", path: "/secretary?screen=capture", scenarios: ["prod"], group: "secretary" },
  { slug: "secretary-remind-13", path: "/secretary?screen=remind&id=13", scenarios: ["prod"], group: "secretary" },
  { slug: "secretary-all", path: "/secretary?screen=all", scenarios: ["prod"], group: "secretary" },
  { slug: "payables", path: "/payables", scenarios: ["prod"], group: "payables" },
  { slug: "payables-7", path: "/payables/7", scenarios: ["prod"], group: "payables" },
  { slug: "payables-5", path: "/payables/5", scenarios: ["prod"], group: "payables" },
  { slug: "payables-new", path: "/payables?new=1", scenarios: ["prod"], group: "payables" },
].filter((p) => !ONLY || p.group === ONLY);

// A JWT-shaped token; only `exp` is read client-side (lib/auth/refresh-client.ts).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;

const unmocked = new Map(); // "METHOD /path" -> count
const nonGet = []; // every non-GET request the page made
const results = { base: BASE, frozenNow: FROZEN_NOW, startedAt: new Date().toISOString(), only: ONLY, runs: [], checks: {}, unmockedApi: [], nonGetRequests: [] };

const json = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });

async function newContext(browser, vp, scenario) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
  });
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  await ctx.addInitScript((token) => {
    try {
      window.localStorage.setItem("token", token);
      window.localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה" }));
    } catch {
      /* ignore */
    }
  }, FAKE_TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = req.method();
    if (method !== "GET") {
      nonGet.push({ method, path: url.pathname + url.search, scenario, viewport: vp.name });
      const k = `${method} ${url.pathname}`;
      unmocked.set(k, (unmocked.get(k) || 0) + 1);
      return route.fulfill(json({ error: "QA harness: writes are not mocked" }, 404));
    }
    const body = resolveApi(scenario, method, url.pathname, url.searchParams);
    if (body === undefined) {
      const k = `${method} ${url.pathname}`;
      unmocked.set(k, (unmocked.get(k) || 0) + 1);
      return route.fulfill(json({ error: "QA harness: not mocked" }, 404));
    }
    if (body && body.__status) return route.fulfill(json({ error: body.error }, body.__status));
    return route.fulfill(json(body));
  });
  // Any non-GET outside /api too (server actions etc.) — recorded, never expected.
  ctx.on("request", (req) => {
    const u = new URL(req.url());
    if (req.method() !== "GET" && !u.pathname.startsWith("/api/") && u.origin === BASE) {
      nonGet.push({ method: req.method(), path: u.pathname + u.search, scenario, viewport: vp.name, outsideApi: true, devTooling: u.pathname.startsWith("/__nextjs") });
    }
  });
  return ctx;
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .waitForFunction(() => !document.querySelector('main[aria-busy="true"], [aria-busy="true"] main'), null, { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
}

async function devOverlay(page) {
  return page.evaluate(() => {
    const portal = document.querySelector("nextjs-portal");
    const root = portal && portal.shadowRoot;
    if (!root) return null;
    const dialog = root.querySelector("[data-nextjs-dialog], [data-nextjs-dialog-overlay], .nextjs-container-errors-header");
    const text = ((dialog || root).textContent || "").replace(/\s+/g, " ").trim();
    const issues = text.match(/(\d+)\s*Issues?/i);
    return { dialogOpen: Boolean(dialog), issues: issues ? Number(issues[1]) : 0, text: dialog ? text.slice(0, 1500) : null };
  }).catch(() => null);
}

/* ─────────────── in-page probes ─────────────── */

const PROBE = () => {
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return { tag: el.tagName.toLowerCase(), name, href: el.getAttribute("href"), w: Math.round(r.width), h: Math.round(r.height), html: el.outerHTML.slice(0, 160) };
  };
  const mains = [...document.querySelectorAll("main")];
  const scope = mains.length ? mains : [document.body];

  // 1. horizontal scroll
  const de = document.documentElement;
  const hscroll = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, ok: de.scrollWidth <= de.clientWidth + 1 };

  // 2. visible Latin words (3+ letters) in main, outside <svg>
  const IGNORE = new Set(["dubiz", "qa", "ils", "usd", "eur", "nis"]);
  const english = [];
  for (const m of scope) {
    const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest("svg, script, style, noscript") || !vis(p)) continue;
      const words = n.textContent.match(/[A-Za-z]{3,}/g);
      if (!words) continue;
      for (const word of words) if (!IGNORE.has(word.toLowerCase())) english.push({ word, context: n.textContent.trim().slice(0, 100) });
    }
  }

  // 5. accessible names (heuristic per element)
  const interactiveSel = 'a[href], button, [role="button"], [role="link"], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  const nameOf = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel && wrapLabel.textContent.trim()) return wrapLabel.textContent.trim();
    const t = (el.innerText || el.textContent || "").trim();
    if (t) return t;
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    if (el.getAttribute("title")) return el.getAttribute("title").trim();
    if (el.getAttribute("placeholder")) return el.getAttribute("placeholder").trim();
    if (el.tagName === "INPUT" && ["submit", "button"].includes(el.type) && el.value) return el.value;
    return "";
  };
  const unnamed = [];
  const small = [];
  for (const m of scope) {
    for (const el of m.querySelectorAll(interactiveSel)) {
      if (!vis(el)) continue;
      if (["a", "button"].includes(el.tagName.toLowerCase()) || ["button", "link"].includes(el.getAttribute("role"))) {
        if (!nameOf(el)) unnamed.push(describe(el));
      }
      let r = el.getBoundingClientRect();
      // A "stretched link" (::after absolutely positioned, inset 0) hits over its positioned ancestor.
      const after = getComputedStyle(el, "::after");
      if (after.content && after.content !== "none" && after.position === "absolute" && el.offsetParent) {
        const pr = el.offsetParent.getBoundingClientRect();
        if (pr.width > r.width || pr.height > r.height) r = pr;
      }
      // WCAG 2.5.8 "inline" exception: a link inside a sentence of running text
      // (a <p> with text of its own around the link) is sized by the line.
      const inlineInText =
        el.tagName.toLowerCase() === "a" &&
        el.parentElement?.tagName.toLowerCase() === "p" &&
        (el.parentElement.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 10;
      if (!inlineInText && (r.width < 32 || r.height < 32)) small.push({ ...describe(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  const text = document.body.innerText;
  return { hscroll, english, unnamed, small, text, url: location.href, mainCount: mains.length };
};

/* ─────────────── run ─────────────── */

const browser = await chromium.launch();
const t0 = Date.now();

async function capture(p, scenario, vp) {
  const ctx = await newContext(browser, vp, scenario);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500)));

  const run = { page: p.slug, path: p.path, scenario, viewport: vp.name, screenshot: null, status: null, error: null };
  try {
    const resp = await page.goto(BASE + p.path, { waitUntil: "load", timeout: 600_000 });
    run.status = resp ? resp.status() : null;
    await settle(page);
    if (p.slug === "secretary-all") {
      await page.waitForURL(/\/payables/, { timeout: 15_000 }).catch(() => {});
      await settle(page);
    }
    const shot = path.join(OUT, `${p.slug}-${scenario}-${vp.name}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    run.screenshot = path.relative(ROOT, shot).replace(/\\/g, "/");
    const probe = await page.evaluate(PROBE);
    run.finalUrl = probe.url.replace(BASE, "");
    run.mainCount = probe.mainCount;
    run.overlay = await devOverlay(page);
    if (run.status && run.status >= 500) run.error = `HTTP ${run.status}`;
    if (run.overlay?.dialogOpen) run.error = (run.error ? run.error + " | " : "") + "Next dev error overlay: " + (run.overlay.text || "").slice(0, 600);
    run.checks = {
      noHorizontalScroll: probe.hscroll,
      englishWords: probe.english,
      unnamedControls: probe.unnamed,
      ...(vp.name === "mobile" ? { smallTapTargets: probe.small } : {}),
    };

    if (p.slug === "secretary" && scenario === "prod") {
      const t = probe.text;
      const rowOk = await page.evaluate(() => {
        const els = [...document.querySelectorAll("main *")].filter((e) => e.innerText && e.innerText.includes("גולן טלקום") && e.innerText.includes("נותר"));
        const leaves = els.filter((e) => ![...e.children].some((c) => els.includes(c)));
        return leaves.map((e) => ({ text: e.innerText.replace(/\s+/g, " ").slice(0, 200), ok: /נותר[^0-9]{0,30}15(?![0-9])|(?<![0-9.,])15(?:\.00)?[^0-9]{0,30}נותר/.test(e.innerText) }));
      });
      run.checks.content = {
        has3Overdue: t.includes("3 תשלומים עברו את המועד"),
        noOneThing: !t.includes("יש דבר אחד"),
        golanRemaining15: rowOk.some((r) => r.ok),
        golanRows: rowOk,
        no3615: !t.includes("3,615"),
      };
    }
    if (p.slug === "secretary-all") run.checks.redirectToPayables = { finalUrl: run.finalUrl, ok: /^\/payables(\?|$)/.test(run.finalUrl) };

    if (p.slug === "secretary" && scenario === "prod" && vp.name === "desktop") {
      run.checks.menu = await checkMenu(page);
      run.checks.keyboard = await checkKeyboard(page);
    }
    if (p.slug === "secretary" && scenario === "prod" && (vp.name === "desktop" || vp.name === "mobile")) {
      run.checks.paidDialog = await checkPaidDialog(page, vp);
    }
  } catch (e) {
    run.error = (run.error ? run.error + " | " : "") + String(e && e.message ? e.message : e).slice(0, 800);
    try {
      const shot = path.join(OUT, `${p.slug}-${scenario}-${vp.name}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      run.screenshot = path.relative(ROOT, shot).replace(/\\/g, "/");
      run.overlay = await devOverlay(page);
    } catch {
      /* ignore */
    }
  }
  run.consoleErrors = consoleErrors;
  run.pageErrors = pageErrors;
  await ctx.close();
  return run;
}

async function checkMenu(page) {
  const out = { ok: false };
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    const trigger = page.locator('main [aria-haspopup="menu"]').first();
    await trigger.scrollIntoViewIfNeeded();
    out.triggerName = await trigger.getAttribute("aria-label");
    await trigger.click();
    const menu = page.getByRole("menu").first();
    await menu.waitFor({ state: "visible", timeout: 5000 });
    const vp = page.viewportSize();
    const box = await menu.boundingBox();
    out.box = box;
    out.viewport = vp;
    out.insideViewport = Boolean(box) && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5;
    out.centerHit = await menu.evaluate((m) => {
      const r = m.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && m.contains(hit));
    });
    out.items = await menu.getByRole("menuitem").allInnerTexts().catch(() => []);
    await page.screenshot({ path: path.join(OUT, "secretary-prod-desktop-menu-open.png") });
    out.screenshot = "qa-evidence/finance-ui-redesign/secretary-prod-desktop-menu-open.png";
    out.ok = out.insideViewport && out.centerHit;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  } catch (e) {
    out.error = String(e.message || e).slice(0, 400);
  }
  return out;
}

async function checkPaidDialog(page, vp) {
  const out = { ok: false };
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    const btn = page.locator("main").getByRole("button", { name: "שילמתי", exact: true }).first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const dlg = page.getByRole("dialog").first();
    await dlg.waitFor({ state: "visible", timeout: 5000 });
    out.dialogName = (await dlg.getAttribute("aria-label")) || (await dlg.evaluate((d) => {
      const id = d.getAttribute("aria-labelledby");
      return id ? document.getElementById(id)?.textContent?.trim() : null;
    }));
    out.titled = await page.getByRole("dialog", { name: "פרטי התשלום" }).isVisible().catch(() => false);
    const shot = `secretary-prod-${vp.name}-paid-dialog.png`;
    await page.screenshot({ path: path.join(OUT, shot) });
    out.screenshot = `qa-evidence/finance-ui-redesign/${shot}`;
    await page.keyboard.press("Escape");
    out.closedOnEscape = await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false);
    out.ok = out.titled && out.closedOnEscape;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 400);
  }
  return out;
}

async function checkKeyboard(page) {
  const out = { ok: false };
  try {
    // Fresh load: the sequential-focus starting point is the top of the document (body).
    await page.reload({ waitUntil: "load" });
    await settle(page);
    const stops = [];
    const inMain = [];
    for (let i = 0; i < 120 && inMain.length < 15; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 50);
        return { tag: el.tagName.toLowerCase(), name, href: el.getAttribute("href"), inMain: Boolean(el.closest("main")) };
      });
      if (!d) continue;
      stops.push(d);
      if (d.inMain) inMain.push(d);
    }
    out.totalTabsBeforeMain = stops.findIndex((s) => s.inMain);
    out.mainTabOrder = inMain;
    const rowIdx = inMain.findIndex((s) => s.tag === "a" && /screen=detail/.test(s.href || ""));
    const nextRowIdx = rowIdx >= 0 ? inMain.findIndex((s, i) => i > rowIdx && s.tag === "a" && /screen=detail/.test(s.href || "")) : -1;
    const paidIdx = rowIdx >= 0 ? inMain.findIndex((s, i) => i > rowIdx && s.name === "שילמתי") : -1;
    out.firstRowLinkIndex = rowIdx;
    out.paidButtonIndex = paidIdx;
    out.ok = rowIdx >= 0 && paidIdx > rowIdx && (nextRowIdx < 0 || paidIdx < nextRowIdx);
  } catch (e) {
    out.error = String(e.message || e).slice(0, 400);
  }
  return out;
}

for (const p of PAGES) {
  for (const scenario of p.scenarios) {
    for (const vp of VIEWPORTS) {
      const r = await capture(p, scenario, vp);
      results.runs.push(r);
      const flag = r.error ? "ERROR" : "ok";
      console.log(`${flag.padEnd(5)} ${p.slug}-${scenario}-${vp.name}  status=${r.status} final=${r.finalUrl ?? "-"}${r.error ? "  " + r.error.slice(0, 160) : ""}`);
    }
  }
}
await browser.close();

/* ─────────────── aggregate ─────────────── */

const runs = results.runs;
const ok = (b) => (b ? "PASS" : "FAIL");
const rendered = runs.filter((r) => !r.error);
const summary = [];
const add = (id, name, pass, detail) => summary.push({ id, check: name, result: pass === null ? "N/A" : ok(pass), detail });

add(0, "Pages rendered without compile/runtime error", runs.every((r) => !r.error), runs.filter((r) => r.error).map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.error.slice(0, 200)}`));
const hs = rendered.filter((r) => !r.checks?.noHorizontalScroll?.ok);
add(1, "No horizontal scroll", hs.length === 0, hs.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.checks.noHorizontalScroll.scrollWidth}>${r.checks.noHorizontalScroll.clientWidth}`));
const en = rendered.filter((r) => r.checks?.englishWords?.length);
add(2, "No visible English words in main", en.length === 0, en.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${[...new Set(r.checks.englishWords.map((w) => w.word))].join(", ")}`));
const ce = runs.filter((r) => r.consoleErrors.length || r.pageErrors.length);
add(3, "No console/page errors", ce.length === 0, ce.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${[...r.pageErrors.map((e) => "pageerror: " + e), ...r.consoleErrors].slice(0, 4).join(" || ").slice(0, 400)}`));
const sp = runs.filter((r) => r.page === "secretary" && r.scenario === "prod" && r.checks?.content);
add(4, "/secretary prod content", sp.length ? sp.every((r) => r.checks.content.has3Overdue && r.checks.content.noOneThing && r.checks.content.golanRemaining15 && r.checks.content.no3615) : null, sp.map((r) => `${r.viewport}: has3Overdue=${r.checks.content.has3Overdue} noOneThing=${r.checks.content.noOneThing} golan15=${r.checks.content.golanRemaining15} no3615=${r.checks.content.no3615}`));
const un = rendered.filter((r) => r.checks?.unnamedControls?.length);
add(5, "Buttons/links in main have accessible names", un.length === 0, un.map((r) => `${r.page}-${r.scenario}-${r.viewport}: ${r.checks.unnamedControls.map((c) => c.html).join(" | ").slice(0, 300)}`));
const st = rendered.filter((r) => r.viewport === "mobile" && r.checks?.smallTapTargets?.length);
add(6, "Mobile tap targets >= 32x32", st.length === 0, st.map((r) => `${r.page}-${r.scenario}: ${r.checks.smallTapTargets.map((c) => `${c.tag}"${c.name}"${c.w}x${c.h}`).join("; ").slice(0, 400)}`));
const ra = runs.filter((r) => r.page === "secretary-all");
add(7, "/secretary?screen=all -> /payables", ra.length ? ra.every((r) => r.checks?.redirectToPayables?.ok) : null, ra.map((r) => `${r.viewport}: ${r.finalUrl}`));
const mn = runs.find((r) => r.page === "secretary" && r.scenario === "prod" && r.viewport === "desktop");
add(8, "Row menu inside viewport, not clipped", mn ? Boolean(mn.checks?.menu?.ok) : null, mn?.checks?.menu ? [JSON.stringify({ box: mn.checks.menu.box, insideViewport: mn.checks.menu.insideViewport, centerHit: mn.checks.menu.centerHit, error: mn.checks.menu.error })] : []);
const pd = runs.filter((r) => r.checks?.paidDialog);
add(9, '"שילמתי" opens "פרטי התשלום" dialog, Escape closes', pd.length ? pd.every((r) => r.checks.paidDialog.ok) : null, pd.map((r) => `${r.viewport}: titled=${r.checks.paidDialog.titled} name="${r.checks.paidDialog.dialogName}" closed=${r.checks.paidDialog.closedOnEscape}${r.checks.paidDialog.error ? " err=" + r.checks.paidDialog.error : ""}`));
add("9b", "Zero non-GET requests during run (Next dev-overlay /__nextjs* calls listed but not counted)", nonGet.filter((n) => !n.devTooling).length === 0, nonGet.map((n) => `${n.method} ${n.path} (${n.scenario}/${n.viewport})${n.devTooling ? " [dev tooling]" : ""}`));
add(10, "Keyboard: row link then its שילמתי", mn ? Boolean(mn.checks?.keyboard?.ok) : null, mn?.checks?.keyboard ? [`tabsBeforeMain=${mn.checks.keyboard.totalTabsBeforeMain} rowIdx=${mn.checks.keyboard.firstRowLinkIndex} paidIdx=${mn.checks.keyboard.paidButtonIndex}${mn.checks.keyboard.error ? " err=" + mn.checks.keyboard.error : ""}`] : []);

results.finishedAt = new Date().toISOString();
results.durationSec = Math.round((Date.now() - t0) / 1000);
results.summary = summary;
results.unmockedApi = [...unmocked.entries()].map(([k, n]) => ({ request: k, count: n }));
results.nonGetRequests = nonGet;
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));

console.log("\n#   | result | check");
for (const s of summary) {
  console.log(`${String(s.id).padEnd(3)} | ${s.result.padEnd(6)} | ${s.check}`);
  for (const d of s.detail.slice(0, 12)) console.log(`    - ${d}`);
}
console.log(`\nUn-mocked /api calls: ${results.unmockedApi.length ? results.unmockedApi.map((u) => `${u.request} x${u.count}`).join(", ") : "none"}`);
console.log(`Results: ${path.relative(ROOT, path.join(OUT, "results.json"))}  (${results.durationSec}s)`);
