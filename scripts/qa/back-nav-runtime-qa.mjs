/**
 * Back navigation runtime QA — real pages, real router, real browser history.
 *
 * Data is injected at the NETWORK layer (same method as the collection /
 * payables harnesses); the real App Router, the real BackButton, the real
 * history trail and the real list screens run. Every assertion is on the URL,
 * `history.length`, restored state or measured geometry — never a screenshot.
 *
 * "Arrived from screen X" uses `window.next.router.push` — the same router
 * instance every <Link> uses — where wiring a real source link would need a
 * heavy data fixture; list → detail uses a real click on the real row link.
 *
 * Proves at desktop (1440), tablet (820) and mobile (390), RTL:
 *   1. one detail screen opened from three sources returns to each source
 *   2. list state (search text, filter) and scroll position come back
 *   3. refresh keeps the verified origin (back still goes to the list)
 *   4. direct link and new tab → honest labelled fallback, opened with
 *      replace (history.length unchanged), never "back" out of the app
 *   5. rapid / repeated activations move exactly one screen
 *   6. browser Back / Forward stay consistent with the in-app back
 *   7. an account switch in the same tab is a trail boundary (fallback)
 *   8. keyboard: Tab focus + Enter activates; accessible name present
 *   9. control geometry: ≥44px round target, RTL arrow points right, one back
 *      control per screen
 *  10. root screens show no back control
 *
 * Run: build, `npx next start -p 3527`, then `node scripts/qa/back-nav-runtime-qa.mjs`.
 */
import { chromium, webkit } from "playwright";
// QA_BROWSER=webkit runs the same suite on WebKit (Safari engine).
const ENGINE = process.env.QA_BROWSER === "webkit" ? webkit : chromium;

const BASE = process.env.QA_BASE ?? "http://localhost:3527";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const b64url = (s) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const tokenFor = (sub) => `v1.${b64url(JSON.stringify({ sub, iat: 1, exp: 4102444800 }))}.qa`;

const CUSTOMERS = Array.from({ length: 80 }, (_, i) => ({
  id: i + 1,
  name: `לקוח ${i + 1}`,
  phone: `05000000${String(i).padStart(2, "0")}`,
  email: null,
  city: "תל אביב",
  isActive: i % 5 !== 0,
}));
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function wire(context, { sub = 9 } = {}) {
  await context.addInitScript((t) => {
    if (!localStorage.getItem("token")) localStorage.setItem("token", t);
  }, tokenFor(sub));
  // Unknown APIs: a quiet 404 (never 401 — that would bounce to /login).
  await context.route("**/api/**", (r) => r.fulfill(json({ error: "qa-not-mocked" }, 404)));
  await context.route("**/api/customers?*", (r) => {
    const u = new URL(r.request().url());
    const q = (u.searchParams.get("q") ?? "").trim();
    const st = u.searchParams.get("status") ?? "active";
    let rows = CUSTOMERS.filter((c) => (st === "all" ? true : st === "active" ? c.isActive : !c.isActive));
    if (q) rows = rows.filter((c) => c.name.includes(q) || (c.phone ?? "").includes(q));
    return r.fulfill(json({ customers: rows }));
  });
}

const settle = (page) => page.waitForLoadState("networkidle").catch(() => {});
async function pushTo(page, url) {
  await page.evaluate((u) => window.next.router.push(u), url);
  await page.waitForURL((u) => u.pathname + u.search === url || u.href.endsWith(url), { timeout: 15000 });
  await settle(page);
}
const path = (page) => {
  const u = new URL(page.url());
  return decodeURIComponent(u.pathname + u.search);
};
/** The visible canonical back control (data-dz-back on BackButton). */
const visibleBack = (page) => page.locator("[data-dz-back]:visible");
async function backMode(page) {
  const b = visibleBack(page).first();
  await b.waitFor({ state: "visible", timeout: 15000 });
  // Resolve past the SSR "pending" form.
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll("[data-dz-back]")].find((e) => e.offsetParent !== null);
    return el && el.getAttribute("data-dz-back") !== "pending";
  });
  return b.getAttribute("data-dz-back");
}
async function clickBack(page) {
  await visibleBack(page).first().click();
}

async function scenario(browser, vp) {
  console.log(`\n=== ${vp.name} ${vp.width}x${vp.height} ===`);
  const context = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
  await wire(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // CRM detail back is intentionally hidden in the ≥1280 two-pane layout (the
  // list stays visible beside the card); there the list→detail→list path is
  // proven with browser Back, and the button paths on a single-pane screen.
  const twoPane = vp.width >= 1280;
  const DETAIL = "/payables/match/41"; // single-pane at every width

  /* ---- 1+2. list → detail → back: origin, list state, scroll ------------ */
  await page.goto(`${BASE}/customers`, { waitUntil: "networkidle" });
  check("root /customers shows no back control", (await visibleBack(page).count()) === 0);
  await page.getByRole("button", { name: "הכול" }).click();
  await page.getByPlaceholder("חיפוש לפי שם או טלפון").fill("לקוח");
  await page.waitForTimeout(600);
  await settle(page);
  const rows = page.locator('a[href^="/customers/"]');
  check("list rendered", (await rows.count()) >= 60, `rows=${await rows.count()}`);
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(300);
  const scrolledTo = await page.evaluate(() => Math.round(window.scrollY));
  const target = rows.nth(Math.min(40, (await rows.count()) - 1));
  const href = await target.getAttribute("href");
  await target.scrollIntoViewIfNeeded();
  const scrollBeforeClick = await page.evaluate(() => Math.round(window.scrollY));
  await target.click();
  await page.waitForURL(`**${href}`);
  await settle(page);
  if (!twoPane) {
    check("detail back resolves to the verified origin", (await backMode(page)) === "history");
    const lenBefore = await page.evaluate(() => history.length);
    await clickBack(page);
  } else {
    check("two-pane: detail back hidden (list visible beside it)", (await visibleBack(page).count()) === 0);
    await page.goBack();
  }
  await page.waitForURL("**/customers");
  await settle(page);
  check("back lands on the list", path(page) === "/customers", path(page));
  check(
    "search text restored",
    (await page.getByPlaceholder("חיפוש לפי שם או טלפון").inputValue()) === "לקוח",
  );
  check(
    "filter restored (הכול)",
    (await page.getByRole("button", { name: "הכול" }).getAttribute("aria-pressed")) === "true",
  );
  await page.waitForTimeout(800);
  const restoredScroll = await page.evaluate(() => Math.round(window.scrollY));
  if (!twoPane) {
    check(
      "scroll restored on return",
      Math.abs(restoredScroll - scrollBeforeClick) <= 4,
      `before=${scrollBeforeClick} (scrolled ${scrolledTo}) after=${restoredScroll}`,
    );
  } else {
    // Two-pane: the list never unmounted; its own scroll is the evidence.
    check("two-pane: list still scrolled", restoredScroll > 0, `after=${restoredScroll}`);
  }

  /* ---- 6. browser Forward / Back consistency ---------------------------- */
  await page.goForward();
  await page.waitForURL(`**${href}`);
  await page.goBack();
  await page.waitForURL("**/customers");
  check("browser Forward/Back returns to the same list", path(page) === "/customers");

  /* ---- 1. multi-source: the same screen from three sources -------------- */
  for (const source of ["/tools", "/settings", "/customers"]) {
    await pushTo(page, source);
    await pushTo(page, DETAIL);
    check(`${DETAIL} from ${source}: back mode = history`, (await backMode(page)) === "history");
    await clickBack(page);
    await page.waitForURL((u) => u.pathname === source);
    check(`${DETAIL} from ${source} → back to ${source}`, new URL(page.url()).pathname === source, path(page));
  }

  /* ---- 3. refresh keeps the origin -------------------------------------- */
  await pushTo(page, "/tools");
  await pushTo(page, DETAIL);
  await page.reload({ waitUntil: "networkidle" });
  check("after refresh: back still knows the origin", (await backMode(page)) === "history");
  await clickBack(page);
  await page.waitForURL((u) => u.pathname === "/tools");
  check("after refresh: back → /tools", new URL(page.url()).pathname === "/tools");

  /* ---- 5. rapid repeated activation moves exactly one screen ----------- */
  await pushTo(page, "/settings");
  await pushTo(page, "/payables/match/41");
  await pushTo(page, "/payables/match/42");
  // match/41 → match/42 are different records of one screen type; back from
  // 42 goes to 41 (a real origin). Fire 4 activations within ~60ms.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-dz-back]")].find((e) => e.offsetParent !== null);
    for (let i = 0; i < 4; i += 1) el.click();
  });
  await page.waitForTimeout(1200);
  check("4 rapid clicks → exactly one screen back", path(page) === "/payables/match/41", path(page));
  // Double-click via the real pointer too.
  await visibleBack(page).first().dblclick();
  await page.waitForTimeout(1200);
  check("double-click → exactly one screen back", path(page) === "/settings", path(page));

  /* ---- 8. keyboard ------------------------------------------------------- */
  await pushTo(page, DETAIL);
  const back = visibleBack(page).first();
  await back.focus();
  const name = await back.getAttribute("aria-label");
  check("accessible name present", !!name && name.length > 1, name ?? "");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname === "/settings");
  check("Enter on focused back navigates back", new URL(page.url()).pathname === "/settings");

  /* ---- 8b. long press ---------------------------------------------------- */
  // Mouse: button held 900ms, then released → exactly one screen back.
  await pushTo(page, "/settings");
  await pushTo(page, "/payables/match/41");
  await pushTo(page, "/payables/match/42");
  {
    const box = await visibleBack(page).first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    check("mouse long-press → exactly one screen back", path(page) === "/payables/match/41", path(page));
  }
  // Touch: a real touch held 900ms through the browser's input pipeline
  // (Chromium CDP). A long press may or may not count as a tap — either way it
  // must never move more than one screen.
  if (ENGINE === chromium) {
    const tctx = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: vp.width < 768 });
    await wire(tctx);
    const tp = await tctx.newPage();
    await tp.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
    await pushTo(tp, "/settings");
    await pushTo(tp, "/payables/match/41");
    await pushTo(tp, "/payables/match/42");
    const tb = await visibleBack(tp).first().boundingBox();
    const cdp = await tctx.newCDPSession(tp);
    const pt = [{ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
    await tp.waitForTimeout(900);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await tp.waitForTimeout(1500);
    const after = path(tp);
    check(
      "touch long-press → at most one screen back (never two)",
      after === "/payables/match/42" || after === "/payables/match/41",
      `landed=${after}`,
    );
    // And a normal tap right after still works (no stuck lock).
    const before2 = path(tp);
    await visibleBack(tp).first().tap();
    await tp.waitForTimeout(1200);
    check("tap after the long-press still moves one screen", path(tp) !== before2, `${before2} → ${path(tp)}`);
    await tctx.close();
  }

  /* ---- 9. geometry / RTL ------------------------------------------------- */
  await pushTo(page, DETAIL);
  const box = await visibleBack(page).first().boundingBox();
  check("tap target ≥ 44×44", box && box.width >= 44 && box.height >= 44, JSON.stringify(box));
  check("round (border-radius ≥ 22px)", (await visibleBack(page).first().evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))) >= 22);
  const arrow = await visibleBack(page).first().evaluate((e) => {
    const svg = e.querySelector("svg");
    const r = svg.querySelector("path").getAttribute("d");
    return { d: r, transform: getComputedStyle(svg).transform };
  });
  check("RTL: arrow drawn pointing right, not mirrored", arrow.d.startsWith("M5 12h14M13 6l6 6") && (arrow.transform === "none" || arrow.transform === "matrix(1, 0, 0, 1, 0, 0)"), JSON.stringify(arrow));
  const startEdge = vp.width - (box.x + box.width);
  const pageMain = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-dz-back]")].find((e) => e.offsetParent !== null);
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, vw: innerWidth };
  });
  check("placed on the start (right) side of its row", pageMain.right > pageMain.vw / 2, JSON.stringify(pageMain) + ` startGap=${Math.round(startEdge)}`);
  check("exactly one back control on the screen", (await visibleBack(page).count()) === 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("no horizontal overflow", overflow <= 1, `overflow=${overflow}`);
  await page.screenshot({ path: `qa-evidence/back-nav/${vp.name}-detail.png` });

  /* ---- 7. account switch is a trail boundary ---------------------------- */
  await pushTo(page, "/tools");
  await pushTo(page, DETAIL);
  await page.evaluate((t) => localStorage.setItem("token", t), tokenFor(10));
  await pushTo(page, "/payables/match/43");
  check("after account switch: no back into the other account's screens", (await backMode(page)) === "fallback");
  await page.evaluate((t) => localStorage.setItem("token", t), tokenFor(9));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();

  /* ---- 4. direct link / new tab: labelled fallback with replace ---------- */
  const ctx2 = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
  await wire(ctx2);
  const fresh = await ctx2.newPage();
  await fresh.goto(`${BASE}/payables/match/41`, { waitUntil: "networkidle" });
  check("direct link: fallback mode", (await backMode(fresh)) === "fallback");
  const label = (await visibleBack(fresh).first().innerText()).trim();
  check("direct link: visible destination label (not 'חזרה')", label === "לכל ההתחייבויות", label);
  await fresh.screenshot({ path: `qa-evidence/back-nav/${vp.name}-fallback.png` });
  const len0 = await fresh.evaluate(() => history.length);
  await clickBack(fresh);
  await fresh.waitForURL((u) => u.pathname === "/payables");
  check("direct link: fallback → /payables", new URL(fresh.url()).pathname === "/payables");
  check("fallback used replace (history.length unchanged)", (await fresh.evaluate(() => history.length)) === len0);
  check("root /payables: no back control", (await visibleBack(fresh).count()) === 0);

  // Suppliers list: back only with a verified origin, never in the desktop
  // two-pane workspace.
  await fresh.goto(`${BASE}/suppliers`, { waitUntil: "networkidle" });
  await fresh.waitForTimeout(400);
  check("suppliers list, direct link: no back control (no verified origin)", (await visibleBack(fresh).count()) === 0);
  await fresh.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
  await fresh.evaluate(() => window.next.router.push("/suppliers"));
  await fresh.waitForURL("**/suppliers");
  await fresh.waitForTimeout(600);
  const supBack = await visibleBack(fresh).count();
  if (vp.width >= 1280) check("suppliers list from Tools at ≥1280 (two-pane): back hidden", supBack === 0, `visible=${supBack}`);
  else check("suppliers list from Tools (phone/tablet): back shown", supBack === 1, `visible=${supBack}`);

  // New tab opened from an in-app page: no inherited history → fallback.
  await fresh.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
  const [tab] = await Promise.all([
    ctx2.waitForEvent("page"),
    fresh.evaluate(() => window.open("/customers/7", "_blank")),
  ]);
  await tab.waitForLoadState("networkidle");
  if (!twoPane) {
    check("new tab: fallback mode (no fake origin)", (await backMode(tab)) === "fallback");
    check("new tab: label names the destination", (await visibleBack(tab).first().innerText()).trim() === "לרשימת הלקוחות");
    await clickBack(tab);
    await tab.waitForURL((u) => u.pathname === "/customers");
    check("new tab: fallback → /customers", new URL(tab.url()).pathname === "/customers");
  }
  // Nested fallback chain never loops: records/[id] → records → historical …
  await fresh.goto(`${BASE}/inventory/supplier-purchases/new/confirm`, { waitUntil: "networkidle" });
  const chain = [];
  for (let i = 0; i < 4; i += 1) {
    if ((await visibleBack(fresh).count()) === 0) break;
    const before = new URL(fresh.url()).pathname;
    await clickBack(fresh);
    await fresh.waitForURL((u) => u.pathname !== before, { timeout: 15000 }).catch(() => {});
    await settle(fresh);
    chain.push(new URL(fresh.url()).pathname);
  }
  check(
    "nested fallback walks up without loops",
    chain.length >= 2 && new Set(chain).size === chain.length && !chain.includes("/inventory/supplier-purchases/new/confirm"),
    chain.join(" → "),
  );
  await ctx2.close();
}

const browser = await ENGINE.launch();
try {
  for (const vp of VIEWPORTS) {
    try {
      await scenario(browser, vp);
    } catch (e) {
      // A timeout / crash in one viewport is a recorded failure, not the end
      // of the run: the remaining viewports still report.
      const first = String(e?.message ?? e).split(/\r?\n/)[0];
      failures.push(`${vp.name}: aborted — ${first}`);
      console.log(`  [FAIL] ${vp.name} aborted — ${first}`);
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILED:\n - " + failures.join("\n - "));
  process.exit(1);
}
