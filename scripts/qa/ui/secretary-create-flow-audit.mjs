/**
 * Flow audit — "ניהול העסק" → המזכירה → "הוסף התחייבות" → categories → save → result → back / add more →
 * the "התחייבויות" station (owner, 25.10.2026). Runs in the REAL Next.js app at 390 and 1440.
 *
 * Every /api request is answered locally from main-screens-fixtures.mjs. POST /api/obligations is kept in this
 * run's memory and echoed back by the lists the screens read (/api/obligations, /api/payables/commitments), so
 * the audit can see a save land where the owner will look for it. Nothing reaches a database. Any other write is
 * recorded and answered 404.
 *
 *   BASE_URL=http://localhost:3105 node scripts/qa/ui/secretary-create-flow-audit.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { FROZEN_NOW, resolveApi } from "./main-screens-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(HERE, "../../..", "qa-evidence", "create-flow-audit");
const BASE = (process.env.BASE_URL || "http://localhost:3105").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local dev server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;
const json = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const path0 = (u) => { const x = new URL(u); return x.pathname + x.search; };

async function open(browser, vp) {
  const state = { created: [], bodies: [], writes: [], errors: [] };
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  await ctx.addInitScript((t) => { localStorage.setItem("token", t); localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה" })); }, TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() !== "GET") {
      state.writes.push(`${req.method()} ${u.pathname}`);
      if (req.method() === "POST" && u.pathname === "/api/obligations") {
        const b = JSON.parse(req.postData() || "{}");
        const id = 7000 + state.created.length;
        const o = { id, obligeeName: b.obligeeName, amount: Number(b.amount).toFixed(2), currency: "ILS", dueAt: b.dueAt, state: "OPEN", source: "MANUAL", recurrence: b.recurrence ?? "NONE", recurrenceSeriesId: null, note: b.note ?? null, followUpAt: null, settlementAssertedBy: null, metAt: null, releasedAt: null, createdAt: FROZEN_NOW, updatedAt: FROZEN_NOW, ledger: { commitmentId: id, installmentId: id, paid: "0.00", remaining: Number(b.amount).toFixed(2) } };
        state.created.push(o);
        state.bodies.push(b);
        return route.fulfill(json(o, 201));
      }
      if (u.pathname === "/api/tasks/sync") return route.fulfill(json({ ok: true, syncVersion: 1 }));
      return route.fulfill(json({ error: "QA: write not mocked" }, 404));
    }
    if (u.pathname === "/api/home") return route.fulfill(json({ heroAction: { actionKey: "none", title: "", description: "", ctaLabel: "", ctaHref: "/app" }, quickActions: [], businessSnapshot: { businessName: "עסק לדוגמה" }, leadsAttention: { count: 0, href: "/leads" } }));
    if (u.pathname === "/api/business-status") return route.fulfill(json({ items: [] }));
    // Existing payees of the business (the picker's search).
    if (u.pathname === "/api/payables/payees") {
      const q = u.searchParams.get("q") ?? "";
      const all = [{ id: 41, displayName: "מחשבי הדר", kind: "SUPPLIER" }, { id: 42, displayName: "חברת החשמל", kind: "SUPPLIER" }];
      return route.fulfill(json({ payees: all.filter((x) => x.displayName.includes(q)) }));
    }
    const body = resolveApi("todayShared", "GET", u.pathname, u.searchParams);
    if (body === undefined) return route.fulfill(json({ error: "QA: not mocked" }, 404));
    // Echo this run's saves where the screens read them.
    if (u.pathname === "/api/obligations") return route.fulfill(json({ obligations: [...state.created, ...body.obligations] }));
    if (u.pathname === "/api/payables/commitments") {
      const extra = state.created.map((o) => ({ id: o.id, title: o.obligeeName, scheduleKind: "ONE_OFF", total: o.amount, paid: "0.00", remaining: o.amount, next: { id: o.id, sequence: 1, dueAt: o.dueAt, scheduled: o.amount, remaining: o.amount, state: "SCHEDULED" }, attention: "SCHEDULED", isLegacy: false, payeeId: null, payeeNameSnapshot: o.obligeeName, currency: "ILS", status: "ACTIVE", installmentCount: 1 }));
      return route.fulfill(json({ commitments: [...extra, ...body.commitments] }));
    }
    if (body && body.__status) return route.fulfill(json({ error: body.error }, body.__status));
    return route.fulfill(json(body));
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => state.errors.push(e.message.slice(0, 200)));
  return { ctx, page, state };
}

const settle = async (p) => { await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(700); };
const main = (p) => p.locator("main").first();
const text = async (p) => (await main(p).innerText().catch(() => "")).replace(/\s+/g, " ");

const results = { base: BASE, runs: [] };
const browser = await chromium.launch();
for (const vp of [{ n: "390", w: 390, h: 844, m: true }, { n: "1440", w: 1440, h: 900 }]) {
  const { ctx, page: p, state } = await open(browser, vp);
  const s = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      s.push({ step: name, ok: r.ok !== false, ...r, at: path0(p.url()) });
    } catch (e) {
      s.push({ step: name, ok: false, error: String(e.message || e).slice(0, 200), at: path0(p.url()) });
    }
    await p.screenshot({ path: path.join(OUT, `${vp.n}-${String(s.length).padStart(2, "0")}.png`) }).catch(() => {});
  };

  await step("1 ניהול העסק: only המזכירה / מלאי / ספקים under \"הכלים בתחום\"", async () => {
    await p.goto(`${BASE}/tools/operations`); await settle(p);
    await main(p).getByRole("link", { name: /המזכירה שלי/ }).first().waitFor({ timeout: 15000 });
    const hrefs = await main(p).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const t = await text(p);
    const listed = ["המזכירה שלי", "מלאי", "ספקים"].every((x) => t.includes(x));
    // The tools themselves: no entry to /tasks or /payables here (the Secretary's stations lead there).
    const gone = !hrefs.includes("/tasks") && !hrefs.includes("/payables");
    // The Secretary's line (owner, 25.10.2026).
    const line = t.includes("ניהול משימות והתחייבויות העסק") && !t.includes("תזכורות לתשלומים שהעסק צריך לשלם");
    return { ok: listed && gone && line, hrefs: hrefs.filter(Boolean).slice(0, 8) };
  });
  await step("2 open המזכירה שלי", async () => {
    await main(p).getByRole("link", { name: /המזכירה שלי/ }).first().click();
    await p.waitForURL(/\/secretary$/, { timeout: 15000 }); await settle(p);
    const ok = await main(p).getByRole("heading", { name: "תחנות ניהול" }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    return { ok };
  });
  await step("3–4 \"הוסף התחייבות\" → נגדיר את ההתחייבויות", async () => {
    await main(p).getByRole("link", { name: "הוסף התחייבות", exact: true }).click();
    await p.waitForURL(/screen=bank$/, { timeout: 15000 }); await settle(p);
    const t = await text(p);
    return {
      ok: t.includes("נגדיר את ההתחייבויות") && !t.includes("כבר אני זוכרת") && !t.includes("סיימתי, חזרה ליום שלי") && !t.includes("התחייבות אחרת") && t.includes("משהו שלא ברשימה") && t.includes("צור התחייבות") && t.includes("שכירות") && t.includes("ביטוח לאומי"),
    };
  });
  await step("\"לראות את כל ההתחייבויות\" keeps its own height", async () => {
    const box = await main(p).getByRole("link", { name: "לראות את כל ההתחייבויות" }).boundingBox();
    return { ok: !!box && box.height < 80, height: box?.height };
  });
  await step("back from the categories → the Secretary", async () => {
    await main(p).getByRole("button", { name: "חזרה" }).first().click();
    await p.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }); await settle(p);
    await main(p).getByRole("link", { name: "הוסף התחייבות", exact: true }).click();
    await p.waitForURL(/screen=bank$/, { timeout: 15000 }); await settle(p);
    return { ok: true };
  });
  await step("5 \"צור התחייבות\" opens the empty capture form", async () => {
    await main(p).getByRole("link", { name: "צור התחייבות" }).click();
    await p.waitForURL(/screen=capture$/, { timeout: 15000 }); await settle(p);
    const name = await p.locator("form input").first().inputValue().catch(() => "x");
    return { ok: name === "" };
  });
  await step("back from the form → the categories", async () => {
    await p.goBack(); await p.waitForURL(/screen=bank$/, { timeout: 15000 }); await settle(p);
    return { ok: true };
  });
  await step("5–6 a category (שכירות): fill and save", async () => {
    await main(p).locator("a", { hasText: "שכירות" }).first().click();
    await p.waitForURL(/screen=capture/, { timeout: 15000 }); await settle(p);
    const f = p.locator("form").first();
    await f.locator("input[inputmode=decimal]").first().fill("6500");
    await f.locator("input[type=date]").first().fill("2026-11-01");
    await f.locator("button[type=submit]").click();
    await p.waitForTimeout(1500);
    const t = await text(p);
    return { ok: state.created.length === 1 && state.created[0].obligeeName.includes("שכירות") && t.includes("שמרתי"), saved: state.created.map((o) => `${o.obligeeName} ${o.amount} ${o.dueAt.slice(0, 10)}`) };
  });
  await step("7–8 \"הוסף עוד\" → an empty form, no restart through the categories", async () => {
    await main(p).getByRole("button", { name: "הוסף עוד" }).click(); await p.waitForTimeout(900);
    const name = await p.locator("form input").first().inputValue().catch(() => "x");
    return { ok: name === "" && /screen=capture/.test(p.url()) };
  });
  await step("save a second one from the general form", async () => {
    const f = p.locator("form").first();
    await f.locator("input").first().fill("ועד בית");
    await f.locator("input[inputmode=decimal]").first().fill("250");
    await f.locator("input[type=date]").first().fill("2026-11-05");
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    return { ok: state.created.length === 2 };
  });
  await step("8 \"סיימתי\" → the Secretary", async () => {
    await main(p).getByRole("button", { name: "סיימתי" }).click();
    await p.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }); await settle(p);
    return { ok: (await text(p)).includes("תחנות ניהול") };
  });
  // Owner, 25.10.2026: after "סיימתי", browser back must leave the finished creation as a whole — never an empty
  // form, never the categories again.
  const leftFlow = (url) => !/screen=(capture|bank)/.test(url);
  await step("browser back after \"סיימתי\" leaves the finished creation", async () => {
    await p.goBack(); await p.waitForTimeout(1500);
    const landed = path0(p.url());
    const ok = leftFlow(landed) && !/שגיאה|נכשל/.test(await text(p));
    await p.goto(`${BASE}/secretary`); await settle(p);
    return { ok, landed };
  });
  await step("from Home: shortcut / \"+\" → save → \"סיימתי\" returns Home → back leaves the flow", async () => {
    await p.goto(`${BASE}/app`); await settle(p);
    if (vp.w >= 1200) await p.getByRole("link", { name: /התחייבות חדשה/ }).first().click();
    else {
      await p.getByRole("button", { name: "פעולה חדשה" }).locator("visible=true").first().click();
      await p.getByRole("dialog", { name: "פעולות מהירות" }).getByRole("button", { name: "התחייבות חדשה" }).click();
    }
    await p.waitForURL(/screen=bank$/, { timeout: 15000 }); await settle(p);
    await main(p).locator("a", { hasText: "חשמל" }).first().click();
    await p.waitForURL(/screen=capture/, { timeout: 15000 }); await settle(p);
    const f = p.locator("form").first();
    await f.locator("input[inputmode=decimal]").first().fill("420");
    await f.locator("input[type=date]").first().fill("2026-11-10");
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    await main(p).getByRole("button", { name: "סיימתי" }).click();
    // Owner, 25.10.2026: "סיימתי" returns to the entry point — Home here.
    const home = await p.waitForURL((u) => u.pathname === "/app", { timeout: 15000 }).then(() => true).catch(() => false);
    await settle(p);
    await p.goBack(); await p.waitForTimeout(1500);
    const landed = path0(p.url());
    return { ok: state.created.length === 3 && home && leftFlow(landed), landed };
  });
  await step("direct entry to the form → save → \"סיימתי\" → back leaves the flow", async () => {
    await p.goto(`${BASE}/secretary`); await settle(p);
    await p.goto(`${BASE}/secretary?screen=capture`); await settle(p);
    const f = p.locator("form").first();
    await f.locator("input").first().fill("גז");
    await f.locator("input[inputmode=decimal]").first().fill("90");
    await f.locator("input[type=date]").first().fill("2026-11-12");
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    await main(p).getByRole("button", { name: "סיימתי" }).click();
    await p.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }); await settle(p);
    await p.goBack(); await p.waitForTimeout(1500);
    const landed = path0(p.url());
    await p.goto(`${BASE}/secretary`); await settle(p);
    return { ok: state.created.length === 4 && leftFlow(landed), landed };
  });
  await step("from the commitments screen: \"התחייבות חדשה\" → P3 → save → \"סיימתי\" returns there → back leaves the flow", async () => {
    await p.goto(`${BASE}/payables`); await settle(p);
    await main(p).getByRole("link", { name: "התחייבות חדשה" }).first().click();
    await p.waitForURL(/screen=bank$/, { timeout: 15000 }); await settle(p);
    await main(p).getByRole("link", { name: "צור התחייבות" }).first().click();
    await p.waitForURL(/screen=capture/, { timeout: 15000 }); await settle(p);
    const f = p.locator("form").first();
    await f.locator("input").first().fill("אינטרנט");
    await f.locator("input[inputmode=decimal]").first().fill("310");
    await f.locator("input[type=date]").first().fill("2026-11-14");
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    await main(p).getByRole("button", { name: "סיימתי" }).click();
    const back = await p.waitForURL((u) => u.pathname === "/payables", { timeout: 15000 }).then(() => true).catch(() => false);
    await settle(p);
    await p.goBack(); await p.waitForTimeout(1500);
    const landed = path0(p.url());
    await p.goto(`${BASE}/secretary`); await settle(p);
    return { ok: state.created.length === 5 && back && leftFlow(landed), landed };
  });
  // One creation path (owner, 25.10.2026): the two capabilities P3 took over from the old form.
  await step("payee: pick an existing payee → only its id is sent", async () => {
    await p.goto(`${BASE}/secretary?screen=capture`); await settle(p);
    const f = p.locator("form").first();
    await f.locator("input").first().fill("מחשב נייד");
    const picker = f.getByRole("combobox");
    await picker.fill("מחשבי");
    await p.getByRole("option", { name: /מחשבי הדר/ }).first().click();
    await f.locator("input[inputmode=decimal]").first().fill("500");
    await f.locator("input[type=date]").first().fill("2026-11-20");
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    const b = state.bodies[state.bodies.length - 1] ?? {};
    await p.goto(`${BASE}/secretary`); await settle(p);
    return { ok: b.payeeId === 41 && b.obligeeName === "מחשב נייד" && !("installmentPlan" in b), body: JSON.stringify(b) };
  });
  await step("plan: preview = the server split; saved as ONE request with the plan", async () => {
    await p.goto(`${BASE}/secretary?screen=capture`); await settle(p);
    await p.locator('[aria-label="סוג התחייבות"] button', { hasText: "פריסת תשלומים" }).first().click(); await p.waitForTimeout(300);
    const f = p.locator("form").first();
    await f.locator("input").first().fill("ריהוט");
    await f.locator("input[inputmode=decimal]").first().fill("1000");
    await f.locator("input[inputmode=numeric]").first().fill("3");
    await f.locator("input[type=date]").first().fill("2026-11-10");
    await f.getByRole("radio", { name: /רבעון/ }).click(); await p.waitForTimeout(300);
    const preview = (await f.locator("section").filter({ hasText: /1\/3/ }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
    const split = (preview.match(/333\.33/g) ?? []).length === 2 && preview.includes("333.34");
    const quarterly = preview.includes("10 בנובמבר") && preview.includes("10 בפברואר") && preview.includes("10 במאי");
    const before = state.bodies.length;
    await f.locator("button[type=submit]").click(); await p.waitForTimeout(1500);
    const added = state.bodies.slice(before);
    const b = added[0] ?? {};
    await p.goto(`${BASE}/secretary`); await settle(p);
    return { ok: split && quarterly && added.length === 1 && b.amount === "1000" && b.installmentPlan?.count === 3 && b.installmentPlan?.cadence === "QUARTERLY" && b.recurrence === "NONE", preview: preview.slice(0, 160), body: JSON.stringify(b) };
  });
  await step("9 the \"התחייבויות\" station shows both saves", async () => {
    await main(p).locator("section[aria-labelledby='sec-stations-title'] a").first().click();
    await p.waitForURL(/\/payables$/, { timeout: 15000 }); await settle(p);
    // Planned and closed fold on arrival (redesign 25.10.2026): open every folded group first.
    for (const head of await main(p).locator("section[aria-labelledby^='pay-group-'] h2 button[aria-expanded='false']").all()) await head.click();
    await p.waitForTimeout(300);
    const t = (await p.locator("body").innerText()).replace(/\s+/g, " ");
    const ok = t.includes("שכירות") && t.includes("ועד בית");
    await p.goBack(); await p.waitForURL((u) => u.pathname === "/secretary", { timeout: 15000 }).catch(() => {});
    return { ok, back: path0(p.url()) };
  });
  await step("the full list (\"לראות את כל ההתחייבויות\") shows both saves", async () => {
    await p.goto(`${BASE}/secretary?screen=bank`); await settle(p);
    await main(p).getByRole("link", { name: "לראות את כל ההתחייבויות" }).click();
    await p.waitForURL(/screen=all$/, { timeout: 15000 }); await settle(p);
    const t = await text(p);
    return { ok: t.includes("שכירות") && t.includes("ועד בית") };
  });
  await step("direct entry to the categories: \"חזרה\" falls back to the Secretary", async () => {
    const fresh = await ctx.newPage();
    await fresh.goto(`${BASE}/secretary?screen=bank`); await settle(fresh);
    await fresh.locator("main").getByRole("button", { name: "חזרה" }).first().click();
    await fresh.waitForURL((u) => u.pathname === "/secretary" && !u.search, { timeout: 15000 }).catch(() => {});
    const ok = new URL(fresh.url()).pathname === "/secretary" && !new URL(fresh.url()).search;
    await fresh.close();
    return { ok };
  });

  const writesOther = state.writes.filter((w) => w !== "POST /api/obligations" && w !== "POST /api/tasks/sync");
  results.runs.push({ viewport: vp.n, steps: s, writes: state.writes, writesOther, errors: state.errors, ok: s.every((x) => x.ok) && writesOther.length === 0 && state.errors.length === 0 });
  await ctx.close();
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
for (const r of results.runs) {
  console.log(`== ${r.viewport} ${r.ok ? "PASS" : "FAIL"}`);
  for (const x of r.steps) console.log(`  ${x.ok ? "✓" : "✗"} ${x.step} → ${x.at}${x.landed ? ` (landed ${x.landed})` : ""}${x.error ? ` — ${x.error}` : ""}${x.saved ? ` ${JSON.stringify(x.saved)}` : ""}${x.height ? ` h=${Math.round(x.height)}` : ""}`);
  console.log(`  writes: ${r.writes.join(", ") || "none"} · other writes: ${r.writesOther.length} · page errors: ${r.errors.length}`);
}
process.exit(results.runs.every((r) => r.ok) ? 0 : 1);
