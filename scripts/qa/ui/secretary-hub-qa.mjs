/**
 * Secretary main screen QA — management stations (owner-approved mockup, 24.10.2026), in the REAL Next.js app.
 *
 * Every /api/** request is answered from main-screens-fixtures.mjs, plus a hub layer: an agenda with the
 * owner's tasks, a lead source row and a lead-linked task (which must never show), closed commitments (one
 * paid, one handled without a payment) and a forecast date. The main screen must write nothing; the task
 * centre's own sync (once /tasks opens) is listed apart. Any non-GET is recorded and answered 404.
 *
 *   BASE_URL=http://localhost:3105 node scripts/qa/ui/secretary-hub-qa.mjs
 *
 * Requires `npx next dev -p 3105` in the checkout under test. Evidence: qa-evidence/secretary-hub/
 * (<scenario>-<width>-<step>.png + results.json). The browser clock is frozen at 2026-10-21T09:00+03:00.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FROZEN_NOW, resolveApi } from "./main-screens-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(ROOT, "qa-evidence", "secretary-hub");
const BASE = process.env.BASE_URL || "http://localhost:3105";
mkdirSync(OUT, { recursive: true });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;
const json = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const norm = (t) => (t || "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/ /g, " ").replace(/\s+/g, " ");

/* ───────────── hub layer over the prod fixtures ───────────── */

const GEN = "2026-10-21T06:00:00.000Z";
const task = (id, title, dueOn, link = null) => ({ id, title, note: null, dueOn, pinned: false, version: 2, seriesId: null, sequence: null, cadence: null, link, createdAt: GEN });
const TASKS = {
  t1: task(1, "להתקשר לרואה החשבון", "2026-10-19"),
  t2: task(2, "להזמין נייר למדפסת", "2026-10-21", { kind: "supplier", id: 4, label: "דפוס אור" }),
  lead: task(3, "לחזור לליד דנה כהן", "2026-10-21", { kind: "lead", id: 7, label: "דנה כהן" }),
  t4: task(4, "לחדש ביטוח רכב", "2026-10-26"),
  t5: task(5, "לסדר את המחסן", null),
};
const LEAD_SOURCE = {
  type: "SOURCE", key: "lead:77", bucket: "TODAY", pinned: false, dimmed: false, tags: [],
  item: { sourceKind: "LEAD", dedupeKey: "lead:77", title: "ליד חדש מהאתר: יוסי לוי", fact: "השאיר פרטים", action: { label: "לחזור", href: "/leads/77" }, dueOn: "2026-10-21", details: {} },
};
const row = (t, bucket) => ({ type: "TASK", key: `task:${t.id}`, bucket, pinned: false, task: t, tags: [] });
function agenda(completed) {
  const keep = (r) => !(r.type === "TASK" && completed.has(r.task.id));
  const buckets = [
    { bucket: "OVERDUE", rows: [row(TASKS.t1, "OVERDUE")].filter(keep) },
    { bucket: "TODAY", rows: [row(TASKS.t2, "TODAY"), row(TASKS.lead, "TODAY"), LEAD_SOURCE].filter(keep) },
    { bucket: "NO_DATE", rows: [row(TASKS.t5, "NO_DATE")].filter(keep) },
    { bucket: "UPCOMING", rows: [row(TASKS.t4, "UPCOMING")].filter(keep) },
  ].map((b) => ({ ...b, title: b.bucket, shown: b.rows.length, total: b.rows.length, items: b.rows.length }));
  return { dayKey: "2026-10-21", buckets, count: 4, countPartial: false, doneToday: completed.size, sources: [], integrity: ["COMPLETE"], emptyAllowed: false, generatedAt: GEN, lastSyncAt: null, lastSyncFailedAt: null, syncVersion: 1, series: [], disabledSources: [] };
}
const closed = (id, name, amount, dueAt, paid, remaining) => ({
  id, obligeeName: name, amount, currency: "ILS", dueAt, state: "MET", source: "MANUAL", recurrence: "MONTHLY", recurrenceSeriesId: `series-${id}`, note: null,
  followUpAt: null, settlementAssertedBy: "OWNER", metAt: dueAt, releasedAt: null, createdAt: GEN, updatedAt: GEN,
  ledger: { commitmentId: 90 + id, installmentId: 100 + id, paid, remaining },
});
const CLOSED = [closed(21, "חשמל", "420.00", "2026-10-05T06:00:00.000Z", "420.00", "0.00"), closed(22, "מים", "130.00", "2026-10-08T06:00:00.000Z", "0.00", "130.00")];
const PROJECTED = { title: "שכירות משרד", dueDate: "2026-10-28", amount: "4200.00", basis: "PROJECTED" };

function answer(scenario, state, pathname, searchParams) {
  const base = scenario === "summaryFail" ? "summaryFail" : "prod";
  // No fixed costs recorded yet: the summary of the "empty" fixture, the rest of prod.
  if (scenario === "emptyCost" && pathname === "/api/business-cost/summary") return resolveApi("empty", "GET", pathname, searchParams);
  if (pathname === "/api/business/capabilities") return { features: { daily_tasks: { allowed: scenario !== "off" } } };
  if (pathname === "/api/tasks/agenda") return scenario === "off" ? { __status: 404, error: "Not found" } : agenda(state.completed);
  if (pathname === "/api/obligations" && searchParams.get("includeClosed") === "1") {
    const body = resolveApi(base, "GET", pathname, searchParams);
    return { obligations: [...body.obligations, ...CLOSED] };
  }
  const body = resolveApi(base, "GET", pathname, searchParams);
  if (pathname === "/api/business-cost/summary" && body && !body.__status) {
    const s = structuredClone(body);
    s.upcoming.next30Days.items = [...s.upcoming.next30Days.items, PROJECTED];
    return s;
  }
  return body;
}

/* ───────────── harness ───────────── */

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "768", width: 768, height: 1024, isMobile: false, hasTouch: true },
  { name: "820", width: 820, height: 1180, isMobile: false, hasTouch: true },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];
const results = { base: BASE, frozenNow: FROZEN_NOW, startedAt: new Date().toISOString(), runs: [] };

async function open(browser, vp, scenario) {
  const state = { completed: new Set(), api: [], writes: [], unmocked: [], errors: [] };
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
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
    const method = req.method();
    state.api.push(`${method} ${url.pathname}${url.search}`);
    if (method !== "GET") {
      const m = url.pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
      state.writes.push({ method, path: url.pathname, body: req.postData(), idempotencyKey: req.headers()["idempotency-key"] ?? null });
      if (m && method === "POST") {
        state.completed.add(Number(m[1]));
        return route.fulfill(json({ ok: true }));
      }
      return route.fulfill(json({ error: "QA harness: writes are not mocked" }, 404));
    }
    if (scenario === "slow" && url.pathname === "/api/business-cost/summary") await new Promise((r) => setTimeout(r, 5000));
    const body = answer(scenario, state, url.pathname, url.searchParams);
    if (body === undefined) {
      state.unmocked.push(url.pathname);
      return route.fulfill(json({ error: "QA harness: not mocked" }, 404));
    }
    if (body && body.__status) return route.fulfill(json({ error: body.error }, body.__status));
    return route.fulfill(json(body));
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => state.errors.push(`pageerror: ${e.message}`.slice(0, 240)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404|500/.test(m.text())) state.errors.push(`console: ${m.text()}`.slice(0, 240));
  });
  return { ctx, page, state };
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
}
const shot = (page, scenario, vp, step, full = true) => page.screenshot({ path: path.join(OUT, `${scenario}-${vp.name}-${step}.png`), fullPage: full });
const mainText = async (page) => norm(await page.locator("main").first().innerText().catch(() => ""));

async function layout(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    const main = document.querySelector("main");
    const english = (main?.innerText.match(/\b[A-Za-z]{3,}\b/g) ?? []).filter((w) => !/^(ILS|USD|EUR)$/.test(w));
    const controls = [...(main?.querySelectorAll("a,button") ?? [])].filter((el) => el.getClientRects().length > 0);
    const unnamed = controls.filter((el) => !(el.getAttribute("aria-label") || el.innerText.trim())).length;
    // Tap targets under 44px (the drawer is a dialog outside <main>).
    const small = window.innerWidth < 720 ? controls.map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width < 44 || r.height < 44).map(({ el, r }) => `${(el.getAttribute("aria-label") || el.innerText).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`) : [];
    return { noHorizontalScroll: root.scrollWidth <= root.clientWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, english, unnamed, small };
  });
}

const box = (loc) => loc.first().boundingBox().catch(() => null);
const style = (loc, prop) => loc.first().evaluate((el, p) => getComputedStyle(el)[p], prop).catch(() => null);

/** The stations layout (owner-approved mockup, 24.10.2026), flag ON. */
async function hubOn(browser, vp) {
  const { ctx, page, state } = await open(browser, vp, "on");
  const c = {};
  try {
    await page.goto(`${BASE}/secretary`);
    await settle(page);
    await shot(page, "on", vp, "1-main");
    const main = page.locator("main");
    const t = await mainText(page);

    // Order: title · actions · day cost · stations · week.
    const tops = [];
    for (const loc of [main.locator("h1"), main.getByRole("navigation", { name: "פעולות ראשיות" }), main.locator("section[aria-labelledby='sec-cost-title']"), main.locator("section[aria-labelledby='sec-stations-title']"), main.locator("section[aria-labelledby='hub-week-title']")]) tops.push((await box(loc))?.y ?? -1);
    c.order = tops.every((y, i) => y >= 0 && (i === 0 || y > tops[i - 1]));
    c.texts = ["המזכירה שלי", "ניהול המשימות וההתחייבויות של העסק", "עלות יומית של העסק", "תחנות ניהול", "לוח השבוע"].every((x) => t.includes(x));
    c.removed = !["מה מחכה לך היום", "משימות פתוחות", "התחייבויות פתוחות", "תשלומים קרובים", "התחייבויות קרובות", "היסטוריה ומידע נוסף", "סמן שטופל"].some((x) => t.includes(x));

    // The two actions: hrefs, colours, same height.
    const add = main.getByRole("link", { name: "הוסף התחייבות", exact: true });
    const task = main.getByRole("link", { name: "הוסף משימה", exact: true });
    c.addCommitment = (await add.getAttribute("href")) === "/secretary?screen=bank";
    c.addTask = (await task.getAttribute("href")) === "/tasks?new=1";
    const [bAdd, bTask] = [await box(add), await box(task)];
    c.sameRow = !!bAdd && !!bTask && Math.abs(bAdd.y - bTask.y) < 1 && Math.abs(bAdd.height - bTask.height) < 1;
    c.commitmentFirstInRtl = !!bAdd && !!bTask && bAdd.x > bTask.x;
    c.colors = { task: [await style(task, "backgroundColor"), await style(task, "backgroundImage"), await style(task, "color")], add: [await style(add, "backgroundColor"), await style(add, "color")] };
    const rgb = (s) => (s?.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const [tr, tg, tb] = rgb(c.colors.task[2]);
    const [gr, gg, gb] = rgb(c.colors.task[0]);
    // White text and icon on Dubiz green (a green-dominant fill, or the primary gradient).
    c.taskGreenWhite = tr > 240 && tg > 240 && tb > 240 && ((gg > gr && gg >= gb - 10 && gr + gg + gb < 450) || /gradient/.test(c.colors.task[1] ?? ""));
    c.sandDarkText = (await style(add, "color")) !== "rgb(255, 255, 255)";

    // Day cost: server figure, calculated-not-paid, "לפירוט" opens the existing breakdown.
    c.cost = t.includes("2.10 ₪") && t.includes("עלות תפעול מחושבת, לא תשלום בפועל") && t.includes("65 ₪") && t.includes("31");
    const details = main.getByRole("button", { name: "לפירוט" });
    await details.click();
    const dlg = page.getByRole("dialog", { name: "מה מרכיב את העלות היומית" });
    await dlg.waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(800);
    const d = norm(await dlg.innerText());
    c.drawer = { notPaid: d.includes("זו עלות תפעול מחושבת, לא כסף ששולם."), breakdown: d.includes("גולן טלקום") };
    await shot(page, "on", vp, "2-cost-drawer", false);
    await page.keyboard.press("Escape");
    c.drawer.closed = await dlg.waitFor({ state: "hidden", timeout: 4000 }).then(() => true).catch(() => false);
    c.drawer.focusBack = await page.evaluate(() => (document.activeElement?.innerText ?? "").includes("לפירוט"));

    // Stations: three, one row on every width, the existing screens.
    const stations = main.locator("section[aria-labelledby='sec-stations-title'] a");
    c.stationHrefs = (await stations.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).join(" ") === "/payables /tasks /secretary?screen=calendar";
    const sb = await stations.evaluateAll((as) => as.map((a) => a.parentElement.getBoundingClientRect().top)); // the slots: notes are tilted on purpose
    c.stationsOneRow = sb.length === 3 && sb.every((y) => Math.abs(y - sb[0]) < 1);

    // Week: seven days, today marked, marks from real reads only, no lead.
    const days = main.locator("section[aria-labelledby='hub-week-title'] ol a");
    c.week = { count: await days.count(), today: (await main.locator("section[aria-labelledby='hub-week-title'] [aria-current='date']").getAttribute("href")) === "/secretary?screen=calendar&day=2026-10-21" };
    const labels = await days.evaluateAll((as) => as.map((a) => a.getAttribute("aria-label")));
    c.week.taskOn19 = /משימה 1/.test(labels[1] ?? "");
    c.week.noLead = !labels.join(" ").includes("דנה");
    c.week.emptyDaySays = labels.some((l) => l.includes("אין משימה או מועד תשלום"));
    c.noLeads = !t.includes("יוסי לוי") && !t.includes("דנה כהן") && !state.api.some((a) => a.includes("/api/leads"));
    c.agendaReadOnly = !state.api.some((a) => a.startsWith("POST "));
    c.layout = await layout(page);

    // Full calendar from a week day: paid / handled / forecast keep their words; back returns to the main screen.
    await days.nth(3).click();
    await page.waitForURL(/screen=calendar&day=2026-10-21/, { timeout: 15000 });
    await settle(page);
    await shot(page, "on", vp, "3-calendar", false);
    const cal = page.locator("main section", { has: page.getByRole("heading", { name: "משימות ומועדי תשלום" }) });
    const pick = async (day) => {
      await cal.locator(`[data-day="${day}"]`).click();
      await page.waitForTimeout(250);
      return norm(await cal.locator("h3").locator("xpath=..").innerText());
    };
    const paid = await pick("2026-10-05");
    const handled = await pick("2026-10-08");
    const forecast = await pick("2026-10-28");
    c.calendar = {
      opensOnDay: true,
      paid: paid.includes("חשמל") && paid.includes("שולם"),
      handled: handled.includes("מים") && handled.includes("טופל, לא נרשם תשלום"),
      forecast: forecast.includes("שכירות משרד") && forecast.includes("תחזית"),
    };
    c.calendar.layout = (await layout(page)).noHorizontalScroll;
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }).catch(() => {});
    c.calendar.back = new URL(page.url()).pathname === "/secretary" && !new URL(page.url()).search;
    await settle(page);

    // "לוח שנה מלא", each station, and the two actions — each with back.
    const go = async (name, opts, expect) => {
      await page.locator("main").getByRole("link", { name, ...opts }).first().click();
      await page.waitForURL(expect, { timeout: 15000 }).catch(() => {});
      const landed = expect.test(page.url());
      await settle(page);
      await page.goBack();
      await page.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }).catch(() => {});
      const back = new URL(page.url()).pathname === "/secretary" && !new URL(page.url()).search;
      await settle(page);
      return landed && back;
    };
    c.nav = {
      fullCalendar: await go("לוח שנה מלא", {}, /\/secretary\?screen=calendar$/),
      payables: await go(/^התחייבויות/, {}, /\/payables$/),
      tasks: await go(/^משימות/, {}, /\/tasks$/),
      p3: await go("הוסף התחייבות", { exact: true }, /\/secretary\?screen=bank$/),
      taskForm: await go("הוסף משימה", { exact: true }, /\/tasks/),
      profile: await go("הפרופיל שלי", {}, /\/profile/),
    };

    c.writes = state.writes.filter((x) => !/\/api\/tasks\/sync$/.test(x.path)).map((x) => `${x.method} ${x.path}`);
    // Known and pre-existing (listed apart, as main-screens-qa does): React dev warning on browser back.
    c.knownDevWarnings = state.errors.filter((e) => /useInsertionEffect must not schedule updates/.test(e)).length;
    c.errors = state.errors.filter((e) => !/useInsertionEffect must not schedule updates/.test(e));
    c.ok =
      c.order && c.texts && c.removed && c.addCommitment && c.addTask && c.sameRow && c.commitmentFirstInRtl && c.taskGreenWhite && c.sandDarkText && c.cost &&
      c.drawer.notPaid && c.drawer.breakdown && c.drawer.closed && c.drawer.focusBack && c.stationHrefs && c.stationsOneRow &&
      c.week.count === 7 && c.week.today && c.week.taskOn19 && c.week.noLead && c.week.emptyDaySays && c.noLeads && c.agendaReadOnly &&
      Object.values(c.calendar).every(Boolean) && Object.values(c.nav).every(Boolean) &&
      c.layout.noHorizontalScroll && c.layout.english.length === 0 && c.layout.unnamed === 0 && c.layout.small.length === 0 && c.writes.length === 0 && c.errors.length === 0;
  } catch (e) {
    c.error = String(e.message || e).slice(0, 400);
    c.ok = false;
    await shot(page, "on", vp, "error", false).catch(() => {});
  }
  await ctx.close();
  return c;
}

async function hubOff(browser, vp) {
  const { ctx, page, state } = await open(browser, vp, "off");
  const c = {};
  try {
    await page.goto(`${BASE}/secretary`);
    await settle(page);
    await shot(page, "off", vp, "1-main");
    const main = page.locator("main");
    c.noAddTask = (await main.getByRole("link", { name: "הוסף משימה" }).count()) === 0;
    c.addCommitmentFull = (await main.getByRole("link", { name: "הוסף התחייבות", exact: true }).getAttribute("href")) === "/secretary?screen=bank";
    const hrefs = await main.locator("section[aria-labelledby='sec-stations-title'] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    c.twoStations = hrefs.join(" ") === "/payables /secretary?screen=calendar";
    // The screen reads no agenda with the flag OFF (the shell's own /api/tasks/reminders/pending is not this screen).
    c.noAgendaRead = !state.api.some((a) => a.includes("/api/tasks/agenda"));
    c.layout = await layout(page);
    c.ok = c.noAddTask && c.addCommitmentFull && c.twoStations && c.noAgendaRead && c.layout.noHorizontalScroll && c.layout.small.length === 0 && state.writes.length === 0 && state.errors.length === 0;
    c.errors = state.errors;
  } catch (e) {
    c.error = String(e.message || e).slice(0, 400);
    c.ok = false;
  }
  await ctx.close();
  return c;
}

/** summaryFail: the cost says it failed, no "לפירוט"; emptyCost: no fixed costs yet; slow: the cost loads late. */
async function costState(browser, vp, scenario) {
  const { ctx, page, state } = await open(browser, vp, scenario);
  const c = {};
  try {
    await page.goto(`${BASE}/secretary`);
    if (scenario === "slow") {
      await page.waitForTimeout(1500);
      c.busyWhileLoading = (await page.locator("section[aria-labelledby='sec-cost-title'][aria-busy='true']").count()) === 1;
      await shot(page, scenario, vp, "0-loading", false);
    }
    await settle(page);
    await shot(page, scenario, vp, "1-main", false);
    const t = await mainText(page);
    const details = await page.locator("main").getByRole("button", { name: "לפירוט" }).count();
    if (scenario === "summaryFail") c.ok = t.includes("לא הצלחתי לטעון את העלות היומית") && details === 0;
    else if (scenario === "emptyCost") c.ok = t.includes("עוד אין הוצאות קבועות רשומות") && details === 0 && t.includes("תחנות ניהול");
    else c.ok = c.busyWhileLoading && t.includes("2.10 ₪") && details === 1;
    c.ok = c.ok && state.writes.length === 0 && state.errors.length === 0 && (await layout(page)).noHorizontalScroll;
  } catch (e) {
    c.error = String(e.message || e).slice(0, 400);
    c.ok = false;
  }
  await ctx.close();
  return c;
}

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  results.runs.push({ scenario: "on", viewport: vp.name, checks: await hubOn(browser, vp) });
  results.runs.push({ scenario: "off", viewport: vp.name, checks: await hubOff(browser, vp) });
  if (vp.name === "390" || vp.name === "1440") {
    for (const sc of ["summaryFail", "emptyCost", "slow"]) results.runs.push({ scenario: sc, viewport: vp.name, checks: await costState(browser, vp, sc) });
  }
}
await browser.close();
results.finishedAt = new Date().toISOString();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.runs.filter((r) => !r.checks.ok);
for (const r of results.runs) console.log(`${r.checks.ok ? "PASS" : "FAIL"}  ${r.scenario} @${r.viewport}${r.checks.ok ? "" : `  ${JSON.stringify(r.checks).slice(0, 1200)}`}`);
console.log(`secretary-hub-qa: ${results.runs.length - failed.length}/${results.runs.length} runs passed — evidence ${OUT}`);
process.exit(failed.length ? 1 : 0);
