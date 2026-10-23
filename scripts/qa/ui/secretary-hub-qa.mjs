/**
 * Secretary hub QA — version B (owner-approved 23.10.2026), in the REAL Next.js app.
 *
 * Every /api/** request is answered from main-screens-fixtures.mjs, plus a hub layer: an agenda with the
 * owner's tasks, a lead source row and a lead-linked task (which must never show), closed commitments (one
 * paid, one handled without a payment) and a forecast date. The only write the run allows is the task
 * centre's own "complete" (answered 200 and recorded); any other non-GET is recorded and answered 404.
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
const hrefOf = (page, label) => page.locator("main").getByRole("link", { name: label, exact: true }).first().getAttribute("href").catch(() => null);

async function layout(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    const main = document.querySelector("main");
    const english = (main?.innerText.match(/\b[A-Za-z]{3,}\b/g) ?? []).filter((w) => !/^(ILS|USD|EUR)$/.test(w));
    const unnamed = [...(main?.querySelectorAll("a,button") ?? [])].filter((el) => !(el.getAttribute("aria-label") || el.innerText.trim())).length;
    return { noHorizontalScroll: root.scrollWidth <= root.clientWidth, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, english, unnamed };
  });
}

async function hubOn(browser, vp) {
  const { ctx, page, state } = await open(browser, vp, "on");
  const c = {};
  try {
    await page.goto(`${BASE}/secretary`);
    await settle(page);
    await shot(page, "on", vp, "1-hub");
    const t = await mainText(page);
    c.addCommitment = (await hrefOf(page, "הוסף התחייבות")) === "/secretary?screen=bank";
    c.addTask = (await hrefOf(page, "הוסף משימה")) === "/tasks?new=1";
    c.cards = ["משימות פתוחות", "התחייבויות פתוחות", "תשלומים קרובים", "עלות יומית"].every((l) => t.includes(l));
    c.openTasks = /משימות פתוחות 4\b/.test(t);
    c.openCommitments = /התחייבויות פתוחות 4\b/.test(t);
    c.dayCost = t.includes("2.10 ₪");
    c.zones = ["מה מחכה לך היום", "המשימות שלי", "התחייבויות קרובות", "היסטוריה ומידע נוסף", "לוח שנה"].every((z) => t.includes(z));
    c.todayHasPaymentsAndTasks = t.includes("גולן טלקום") && t.includes("להתקשר לרואה החשבון") && t.includes("להזמין נייר למדפסת");
    c.noLeads = !t.includes("יוסי לוי") && !t.includes("לחזור לליד דנה כהן") && !/\bליד\b/.test(t) && !state.api.some((a) => a.includes("/api/leads"));
    c.agendaReadOnly = !state.api.some((a) => a.startsWith("POST /api/tasks/sync"));

    // Cost drawer: calculated, not paid; the existing breakdown; Escape closes and returns focus.
    const costBtn = page.locator("main").getByRole("button", { name: /עלות יומית/ });
    await costBtn.scrollIntoViewIfNeeded();
    await costBtn.click();
    const dlg = page.getByRole("dialog", { name: "מה מרכיב את העלות היומית" });
    await dlg.waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(800);
    const d = norm(await dlg.innerText());
    c.drawer = { notPaid: d.includes("זו עלות תפעול מחושבת, לא כסף ששולם."), breakdown: d.includes("גולן טלקום"), month: d.includes("31") };
    await shot(page, "on", vp, "2-cost-drawer", false);
    await page.keyboard.press("Escape");
    c.drawer.closed = await dlg.waitFor({ state: "hidden", timeout: 4000 }).then(() => true).catch(() => false);
    c.drawer.focusBack = await page.evaluate(() => /עלות יומית/.test(document.activeElement?.innerText ?? ""));

    // Calendar: today is marked; each kind keeps its own words; forecast stays a forecast.
    const cal = page.locator("main section", { has: page.getByRole("heading", { name: "לוח שנה" }) });
    c.calToday = (await cal.locator('[aria-current="date"]').getAttribute("data-day")) === "2026-10-21";
    const pick = async (day) => {
      await cal.locator(`[data-day="${day}"]`).click();
      await page.waitForTimeout(250);
      return norm(await cal.locator("h3").locator("xpath=..").innerText());
    };
    const paid = await pick("2026-10-05");
    const handled = await pick("2026-10-08");
    const forecast = await pick("2026-10-28");
    const taskDay = await pick("2026-10-26");
    c.calendar = {
      paid: paid.includes("חשמל") && paid.includes("שולם"),
      handled: handled.includes("מים") && handled.includes("טופל, לא נרשם תשלום") && !/\bשולם\b(?!,)/.test(handled.replace("טופל, לא נרשם תשלום", "")),
      forecast: forecast.includes("שכירות משרד") && forecast.includes("תחזית") && !forecast.replace("תחזית", "").includes("שולם"),
      task: taskDay.includes("לחדש ביטוח רכב") && taskDay.includes("משימה"),
      noLeadOnCalendar: !(await pick("2026-10-21")).includes("דנה כהן"),
    };
    await shot(page, "on", vp, "3-calendar", false);
    await cal.getByRole("button", { name: "החודש הבא" }).click();
    c.calendar.nextMonth = norm(await cal.innerText()).includes("נובמבר");
    // Keyboard: arrow moves a day (RTL: ArrowLeft = next day).
    await cal.locator('[data-day="2026-11-01"]').focus().catch(() => {});
    await cal.getByRole("button", { name: "החודש הקודם" }).click();

    // Complete a task with the task centre's own action and version.
    const before = state.writes.length;
    await page.locator("main").getByRole("button", { name: "סמן שבוצע: להתקשר לרואה החשבון" }).first().click();
    await page.waitForTimeout(1500);
    const w = state.writes.slice(before);
    c.complete = { writes: w.map((x) => `${x.method} ${x.path} ${x.body}`), ok: w.length === 1 && w[0].path === "/api/tasks/1/complete" && JSON.parse(w[0].body).expectedVersion === 2 && !!w[0].idempotencyKey };
    c.complete.gone = !(await mainText(page)).includes("להתקשר לרואה החשבון");

    // "הוסף התחייבות" → P3 first step; back returns to the hub.
    await page.locator("main").getByRole("link", { name: "הוסף התחייבות", exact: true }).click();
    await page.waitForURL(/\/secretary\?screen=bank$/, { timeout: 15000 });
    await settle(page);
    c.p3 = (await mainText(page)).length > 0;
    await shot(page, "on", vp, "4-p3-start", false);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 });
    c.p3Back = true;
    await settle(page);

    // Writes made on the hub itself (the task centre runs its own sync once /tasks opens).
    c.writesOther = state.writes.filter((x) => !/\/api\/tasks\/\d+\/complete$/.test(x.path)).map((x) => `${x.method} ${x.path}`);
    // "הוסף משימה" → the task centre's create form; back returns to the hub.
    await page.locator("main").getByRole("link", { name: "הוסף משימה", exact: true }).click();
    await page.waitForURL(/\/tasks/, { timeout: 15000 });
    await settle(page);
    c.taskForm = (await page.locator("form").filter({ hasText: "מה צריך לעשות" }).count()) > 0;
    await shot(page, "on", vp, "5-task-form", false);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/secretary", { timeout: 15000 }).catch(() => {});
    c.taskBack = new URL(page.url()).pathname === "/secretary";

    c.layout = await layout(page);
    c.errors = state.errors;
    c.ok =
      c.addCommitment && c.addTask && c.cards && c.openTasks && c.openCommitments && c.dayCost && c.zones && c.todayHasPaymentsAndTasks && c.noLeads && c.agendaReadOnly &&
      c.drawer.notPaid && c.drawer.breakdown && c.drawer.closed && c.drawer.focusBack && c.calToday && Object.values(c.calendar).every(Boolean) &&
      c.complete.ok && c.complete.gone && c.p3 && c.p3Back && c.taskForm && c.taskBack &&
      c.layout.noHorizontalScroll && c.layout.english.length === 0 && c.layout.unnamed === 0 && c.writesOther.length === 0 && c.errors.length === 0;
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
    await shot(page, "off", vp, "1-hub");
    const t = await mainText(page);
    c.noAddTask = (await page.locator("main").getByRole("link", { name: "הוסף משימה" }).count()) === 0;
    c.addCommitment = (await hrefOf(page, "הוסף התחייבות")) === "/secretary?screen=bank";
    c.noTasksZone = !t.includes("המשימות שלי");
    c.tasksCardOff = t.includes("המשימות עוד לא פעילות בעסק");
    c.noAgendaRead = !state.api.some((a) => a.includes("/api/tasks/"));
    c.layout = await layout(page);
    c.ok = c.noAddTask && c.addCommitment && c.noTasksZone && c.tasksCardOff && c.noAgendaRead && c.layout.noHorizontalScroll && state.writes.length === 0 && state.errors.length === 0;
    c.errors = state.errors;
  } catch (e) {
    c.error = String(e.message || e).slice(0, 400);
    c.ok = false;
  }
  await ctx.close();
  return c;
}

async function summaryFail(browser, vp) {
  const { ctx, page, state } = await open(browser, vp, "summaryFail");
  const c = {};
  try {
    await page.goto(`${BASE}/secretary`);
    await settle(page);
    await shot(page, "summaryFail", vp, "1-hub");
    const t = await mainText(page);
    c.saysUnavailable = /עלות יומית — לא הצלחתי לטעון/.test(t);
    c.notClickable = (await page.locator("main").getByRole("button", { name: /עלות יומית/ }).count()) === 0;
    c.restWorks = t.includes("מה מחכה לך היום") && t.includes("גולן טלקום");
    c.ok = c.saysUnavailable && c.notClickable && c.restWorks && state.writes.length === 0;
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
  if (vp.name === "390" || vp.name === "1440") results.runs.push({ scenario: "summaryFail", viewport: vp.name, checks: await summaryFail(browser, vp) });
}
await browser.close();
results.finishedAt = new Date().toISOString();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.runs.filter((r) => !r.checks.ok);
for (const r of results.runs) console.log(`${r.checks.ok ? "PASS" : "FAIL"}  ${r.scenario} @${r.viewport}${r.checks.ok ? "" : `  ${JSON.stringify(r.checks).slice(0, 900)}`}`);
console.log(`secretary-hub-qa: ${results.runs.length - failed.length}/${results.runs.length} runs passed — evidence ${OUT}`);
process.exit(failed.length ? 1 : 0);
