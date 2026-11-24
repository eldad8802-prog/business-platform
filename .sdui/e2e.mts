/**
 * Service Desk UI 1.3 — the real app in a browser (next dev on the M1 lab), phone and desktop, Hebrew. Synthetic only;
 * no Production, no Preview, no secrets, no network beyond localhost. service_desk is ON only for the lab's business A.
 *
 *   L1 the list shows the cases, "needs attention" first with reasons (phone + desktop screenshots)
 *   W1 c1: confirm the intake → CHECKED_IN          W2 start diagnosis → DIAGNOSING
 *   W3 start the repair (lab: no approval needed when nothing is charged) → IN_REPAIR
 *   W4 finish (QA turned off by the owner) → READY
 *   B1 handover without a charge decision is REFUSED: a Hebrew error, the status stays READY (server-enforced)
 *   W5 after the owner records "no charge": handover with the receiver's name → DELIVERED, one ServiceHandover row
 *   W6 delivered: no owner action is offered any more (closing is the system's step); the history lists every step
 *   Q1 c2: "the customer approved" (by phone) → the quote is APPROVED in the database
 *   X1 an illegal action sent straight to the API (PASS_QA on an OPEN case) → 409, nothing changes
 *   X2 a write with a stale version → refused (VERSION_CONFLICT), nothing changes
 *   W360 / W360b the list, the opening form and every case fit 360 px; a dialog fits, is opaque, both buttons reachable
 *   N1 business B (module OFF): the screen says it is not open; its API answers 404
 *   S1 business C (garage, never set up): the list banner leads to the activation; "garage" is pre-selected from the
 *      category; the owner adds "service" by hand; saved + journaled; the banner is gone
 *   O1 the opening form: a repair for an existing customer → the case exists with its track; the screen goes to intake
 *   QA1 c5 (QA REQUIRED): the checklist is recorded in the panel → qaCompletedAt; "QA passed" → READY
 *   Q2 c6: the customer's billing quote is sent from the case → QUOTE_PENDING, one ServiceQuote row, the document unchanged
 *   P1 c3 (READY): a pickup call "no answer" → one ServicePhoneReminder row, the counter 1, the header summary
 *   LN1 a replacement item lent on c3 → the handover reminder in the header (never a block); returned → returnedAt
 *   TK1 an open task linked to c4 and unlinked (Task.serviceCaseId)      F1 c4: item location + estimated date saved
 *   X3 another business (C) cannot read A's loans / tasks / fields / pickup calls / QA (404)
 *   H1 / H2 (migration 20261222090000 applied in this lab, as in Production once applied): the case history shows the task
 *      link / unlink, the work details and the loan lent / returned — once each, by the owner — and the journal holds who acted
 *
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL, DATABASE_URL, STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3740";
const OUT = process.env.OUT ?? "/tmp/sdui";
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as {
  tokenA: string; tokenB: string; tokenC: string; bizA: number; bizB: number; bizC: number; userA: number;
  c1: number; c2: number; c3: number; c4: number; c5: number; c6: number; quoteC6: number; taskA: number;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 60; i++) { if (await f()) return true; await sleep(250); }
  throw new Error(what);
}
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
mkdirSync(OUT, { recursive: true });

const rows: Array<{ name: string; ok: boolean; detail: string }> = [];
let current: Page | null = null;
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    if (r === false) throw new Error("condition false");
    rows.push({ name, ok: true, detail: "" });
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0].slice(0, 240) : String(e);
    rows.push({ name, ok: false, detail });
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`), fullPage: true }).catch(() => undefined);
    console.log(`  [FAIL] ${name} — ${detail}`);
  }
}

async function own<T = Record<string, unknown>>(b: number, sql: string, ...a: unknown[]): Promise<T[]> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as T[];
  });
}
const statusOf = async (id: number) => String((await own(seed.bizA, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
const versionOf = async (id: number) => Number((await own(seed.bizA, `SELECT version v FROM "ServiceCase" WHERE id = $1`, id))[0].v);

type Size = { width: number; height: number; phone: boolean };
const DESKTOP: Size = { width: 1440, height: 1000, phone: false };
const PHONE: Size = { width: 390, height: 844, phone: true };
async function ctx(browser: Browser, token: string, size: Size): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE, locale: "he-IL", timezoneId: "Asia/Jerusalem", viewport: { width: size.width, height: size.height },
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await c.addCookies([{ name: "dz_locale", value: "he", url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const statusPill = (p: Page, label: string) => p.locator("header[aria-label='כותרת התיק']").getByText(label, { exact: true });

async function openCase(p: Page, id: number) {
  await p.goto(`/service-desk/cases/${id}`);
  await p.locator("section[aria-label='מצב ופעולה הבאה']").waitFor({ timeout: 120_000 });
}
async function clickAction(p: Page, label: string) {
  await p.locator("section[aria-label='מצב ופעולה הבאה']").getByRole("button", { name: label, exact: true }).click();
}
async function confirmDialog(p: Page, button = "לאשר") {
  await p.getByRole("dialog").getByRole("button", { name: button, exact: true }).click();
  await p.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
}
async function waitStatus(id: number, want: string) {
  for (let i = 0; i < 40; i++) { if ((await statusOf(id)) === want) return true; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`status of ${id} is ${await statusOf(id)}, expected ${want}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ── list ──
    for (const [size, tag] of [[DESKTOP, "desktop"], [PHONE, "phone"]] as const) {
      const c = await ctx(browser, seed.tokenA, size);
      const p = await c.newPage();
      current = p;
      await check(`L1-${tag} the list: «ממתינים לך» only for overdue cases (none in a fresh lab), the rest with their next step`, async () => {
        await p.goto("/service-desk");
        await p.getByRole("heading", { name: "תיקונים ושירות" }).waitFor({ timeout: 180_000 });
        // Every lab case entered its state minutes ago: below every threshold, so nothing waits yet (owner rule 2026-11-24).
        const want = async (what: string, l: import("playwright").Locator) => { await l.waitFor({ timeout: 20_000 }).catch(() => { throw new Error(`missing: ${what}`); }); };
        await want("the calm line", p.getByText("אין כרגע תיקים שממתינים לך"));
        await want("the בעבודה group title", p.locator("section[aria-label='שאר התיקים'] h2").filter({ hasText: "בעבודה" }));
        await want("c4 next step", p.getByText("הבא: להחזיר לעבודה").first()); // on hold for parts
        await want("c3 next step", p.getByText("הבא: למסור ללקוח").first()); // READY
        const chips = await p.getByRole("group", { name: "סינון" }).getByRole("button").allInnerTexts();
        if (!["פעילים", "מוכנים", "סגורים"].every((l, i) => (chips[i] ?? "").trim().startsWith(l))) throw new Error(`filters ${JSON.stringify(chips)}`);
        const since = await p.evaluate(async () => {
          const r = await fetch("/api/service-desk/cases", { headers: { Authorization: "Bearer " + localStorage.getItem("token") } });
          const j = await r.json();
          return (j.cases as { statusSince?: string; openedAt: string }[]).map((c) => [c.statusSince ?? "", c.openedAt]);
        });
        if (!since.length || !since.every(([st, op]) => st !== "" && Date.parse(st) >= Date.parse(op) - 1000)) throw new Error(`statusSince ${JSON.stringify(since)}`);
        await shot(p, `real-list-${tag}`);
        if (tag === "phone") {
          const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 1) throw new Error(`side scroll ${overflow}px`);
        }
      });
      await c.close();
    }

    // ── c1 end to end on the phone ──
    const c = await ctx(browser, seed.tokenA, PHONE);
    const p = await c.newPage();
    current = p;
    await openCase(p, seed.c1);
    await shot(p, "real-case-open-phone");
    const checkIns = async (id: number) => Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND action::text = 'CHECK_IN'`, id))[0].n);
    const confirmBtn = () => p.getByRole("button", { name: "לאשר קליטה ולקבל את הפריט", exact: true });
    const failWith500 = (route: { fulfill: (o: { status: number; contentType: string; body: string }) => Promise<void> }) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "lab: forced failure" }) });
    await check("W1 «confirm the intake» leads to the intake screen — the one place it is confirmed; it fits 390 px and 360 px with nothing hidden", async () => {
      await p.locator("section[aria-label='מצב ופעולה הבאה']").getByRole("link", { name: "לאשר את הקליטה", exact: true }).click();
      await p.waitForURL(/\/service-desk\/cases\/\d+\/intake/, { timeout: 60_000 });
      await confirmBtn().waitFor({ timeout: 120_000 });
      await shot(p, "real-intake-phone-390");
      const c360 = await ctx(browser, seed.tokenA, { width: 360, height: 780, phone: true });
      const p360 = await c360.newPage();
      await p360.goto(`/service-desk/cases/${seed.c1}/intake`);
      await p360.getByRole("button", { name: "לאשר קליטה ולקבל את הפריט", exact: true }).waitFor({ timeout: 120_000 });
      for (const [pg, w] of [[p, 390], [p360, 360]] as const) {
        const over = await pg.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
        if (over > 1) throw new Error(`intake scrolls sideways at ${w} px (${over})`);
        const b = pg.getByRole("button", { name: "לאשר קליטה ולקבל את הפריט", exact: true });
        await b.scrollIntoViewIfNeeded();
        const box = await b.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > w + 1) throw new Error(`the confirm button is cut at ${w} px`);
        // nothing (a bottom bar, a floating button) sits on top of the button's centre
        const onTop = await b.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (hit === el || el.contains(hit)); });
        if (!onTop) throw new Error(`the confirm button is covered at ${w} px`);
      }
      await shot(p360, "w360-intake");
      await c360.close();
    });
    await check("IN1 the details' save fails → nothing is confirmed, the screen does not claim a save; the case stays OPEN", async () => {
      const v0 = await versionOf(seed.c1);
      await p.locator("textarea").first().fill("סדק בפינה הימנית העליונה · נבדק בקליטה");
      await p.route("**/api/service-desk/cases/*/intake", (r) => r.request().method() === "PUT" ? failWith500(r) : r.continue());
      await Promise.all([p.waitForResponse((r) => r.url().includes("/intake") && r.request().method() === "PUT"), confirmBtn().click()]);
      await confirmBtn().waitFor();
      await p.unroute("**/api/service-desk/cases/*/intake");
      if (await p.getByText(/הקליטה אושרה|פרטי הקליטה נשמרו/).count()) throw new Error("the screen claims a save or a confirmation");
      if ((await statusOf(seed.c1)) !== "OPEN" || (await checkIns(seed.c1)) !== 0 || (await versionOf(seed.c1)) !== v0) throw new Error("something was written");
    });
    await check("IN2 saved, then the confirmation fails → the screen says the details were saved and the confirmation did not pass; nothing confirmed", async () => {
      const v0 = await versionOf(seed.c1);
      await p.route("**/api/service-desk/cases/*/actions", (r) => failWith500(r));
      await confirmBtn().click();
      await p.getByText(/פרטי הקליטה נשמרו, אבל האישור לא עבר/).waitFor({ timeout: 60_000 });
      await p.unroute("**/api/service-desk/cases/*/actions");
      await shot(p, "real-intake-partial-failure-phone");
      if ((await statusOf(seed.c1)) !== "OPEN" || (await checkIns(seed.c1)) !== 0) throw new Error("confirmed despite the failure");
      if ((await versionOf(seed.c1)) !== v0 + 1) throw new Error("the details were not saved exactly once");
    });
    await check("IN3 a double click confirms once: one CHECK_IN, CHECKED_IN; a replay of the confirmation is refused; back to the case", async () => {
      await confirmBtn().dblclick();
      await waitStatus(seed.c1, "CHECKED_IN");
      await p.getByText("הקליטה אושרה והפריט התקבל לטיפול.").waitFor({ timeout: 60_000 });
      if ((await checkIns(seed.c1)) !== 1) throw new Error(`CHECK_IN events: ${await checkIns(seed.c1)}`);
      const v = await versionOf(seed.c1);
      const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
      const replay = await p.evaluate(async ({ id, ver, key }) => {
        const r = await fetch(`/api/service-desk/cases/${id}/actions`, { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("token")}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ action: { type: "CHECK_IN", intakeConfirmed: true }, expectedVersion: ver }) });
        return r.status;
      }, { id: seed.c1, ver: v, key: uuidV7(new Date()) });
      if (replay < 400) throw new Error(`a second confirmation was accepted (${replay})`);
      if ((await checkIns(seed.c1)) !== 1) throw new Error("a second CHECK_IN was written");
      await openCase(p, seed.c1);
      await statusPill(p, "התקבל").waitFor();
    });
    await check("W2 start diagnosis → DIAGNOSING", async () => {
      await clickAction(p, "להתחיל אבחון");
      await waitStatus(seed.c1, "DIAGNOSING");
      await statusPill(p, "באבחון").waitFor();
    });
    await check("W3 start the repair (nothing charged: no approval needed for a lab) → IN_REPAIR", async () => {
      await clickAction(p, "להתחיל תיקון");
      await waitStatus(seed.c1, "IN_REPAIR");
      await statusPill(p, "בעבודה").waitFor();
    });
    await check("W4 finish (the owner turned QA off) → READY", async () => {
      await clickAction(p, "לסיים את התיקון");
      await waitStatus(seed.c1, "READY");
      await statusPill(p, "מוכן למסירה").waitFor();
      await shot(p, "real-case-ready-phone");
    });
    await check("B1 without a charge decision the main action is «לקבוע חיוב» (no locked handover); its sheet offers amount / no charge; nothing is sent; still READY", async () => {
      const status = p.locator("section[aria-label='מצב ופעולה הבאה']");
      await status.getByRole("button", { name: "לקבוע חיוב", exact: true }).waitFor({ timeout: 30_000 });
      if (await status.getByRole("button", { name: "למסור ללקוח", exact: true }).count()) throw new Error("a handover button is offered before the charge is set");
      await status.getByText("למסור ללקוח", { exact: true }).waitFor(); // as step 2, not as a button
      await p.locator("[data-panel=charge]").waitFor({ timeout: 30_000 });
      await shot(p, "real-case-refused-phone");
      await clickAction(p, "לקבוע חיוב");
      const dlg = p.getByRole("dialog");
      await dlg.getByRole("group", { name: "סוג החיוב" }).waitFor();
      await dlg.getByRole("button", { name: "ביטול", exact: true }).click();
      await dlg.waitFor({ state: "detached", timeout: 10_000 });
      if ((await statusOf(seed.c1)) !== "READY") throw new Error("status changed");
    });
    await check("W5 'no charge' with its reason in the case's charge panel; the dialog is opaque; handover with the receiver's name → DELIVERED, one handover row", async () => {
      await p.locator("[data-panel=charge]").getByRole("button", { name: "ללא חיוב", exact: true }).click();
      const dlg = p.getByRole("dialog");
      await dlg.waitFor();
      const bg = await dlg.evaluate((el) => getComputedStyle(el).backgroundColor);
      if (!/^rgb\(255, 255, 255\)$/.test(bg)) throw new Error(`dialog background ${bg}`);
      await dlg.getByRole("textbox").fill("תיקון באחריות");
      await confirmDialog(p, "לשמור");
      await until(async () => Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceCaseCharge" WHERE "caseId" = $1 AND mode::text = 'NO_CHARGE'`, seed.c1))[0].n) === 1, "no NO_CHARGE record");
      const status = p.locator("section[aria-label='מצב ופעולה הבאה']");
      await until(async () => !(await status.getByRole("button", { name: "למסור ללקוח", exact: true }).isDisabled()), "handover still blocked");
      await clickAction(p, "למסור ללקוח");
      await p.getByRole("dialog").getByRole("textbox").fill("דנה");
      await confirmDialog(p, "לאשר מסירה");
      await waitStatus(seed.c1, "DELIVERED");
      const n = Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "caseId" = $1`, seed.c1))[0].n);
      if (n !== 1) throw new Error(`handover rows ${n}`);
    });
    await check("W6 delivered: no owner action is offered (closing is the system's step); the history lists the steps and the charge", async () => {
      await statusPill(p, "נמסר").waitFor();
      const buttons = await p.locator("section[aria-label='מצב ופעולה הבאה'] button").count();
      if (buttons !== 0) throw new Error(`${buttons} action buttons on a delivered case`);
      await p.getByRole("button", { name: /^כל ההיסטוריה/ }).click();
      for (const step of ["הפריט נקלט", "התחיל אבחון", "העבודה התחילה", "העבודה הסתיימה", "נמסר ללקוח"]) await p.getByText(step, { exact: true }).first().waitFor();
      await p.getByText("החיוב נרשם · ללא חיוב").first().waitFor();
      await shot(p, "real-case-closed-phone");
    });

    // ── c2: the customer's answer to the quote, desktop ──
    const d = await ctx(browser, seed.tokenA, DESKTOP);
    const pd = await d.newPage();
    current = pd;
    await openCase(pd, seed.c2);
    await shot(pd, "real-case-quote-desktop");
    await check("Q1 'the customer approved' by phone → the quote is APPROVED in the database", async () => {
      await clickAction(pd, "הלקוח אישר את ההצעה");
      await pd.getByRole("dialog").getByRole("button", { name: "בטלפון" }).click();
      await confirmDialog(pd);
      for (let i = 0; i < 40; i++) {
        const st = String((await own(seed.bizA, `SELECT state::text s FROM "ServiceQuote" WHERE "caseId" = $1 ORDER BY version DESC LIMIT 1`, seed.c2))[0].s);
        if (st === "APPROVED") return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("quote not APPROVED");
    });

    // ── the API refuses what the screen never offers ──
    await check("X1 PASS_QA sent straight to the API on an OPEN case → refused, nothing changes", async () => {
      const { openCase: open } = await import("@/lib/services/service-desk/service-case.service");
      const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
      const { runWithTenantContext } = await import("@/lib/tenant/context");
      const cust = Number((await own(seed.bizA, `SELECT id FROM "Customer" WHERE "businessId" = $1 ORDER BY id LIMIT 1`, seed.bizA))[0].id);
      const fresh = await runWithTenantContext({ businessId: seed.bizA }, async () =>
        (await open({ businessId: seed.bizA, userId: seed.userA } as never, { customerId: cust, track: "T1", problemDescription: "בדיקת סירוב", subject: { displayName: "מכשיר" } } as never, { idempotencyKey: uuidV7(new Date()) })).case.id);
      const before = await versionOf(fresh);
      const r = await pd.evaluate(async ({ id, v }) => {
        const token = localStorage.getItem("token");
        const res = await fetch(`/api/service-desk/cases/${id}/actions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: { type: "PASS_QA", outcome: "REPAIRED" }, expectedVersion: v }) });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      }, { id: fresh, v: before });
      if (r.status < 400) throw new Error(`answered ${r.status}`);
      if ((await statusOf(fresh)) !== "OPEN" || (await versionOf(fresh)) !== before) throw new Error("the case changed");
    });
    await check("X2 a write with a stale version is refused; nothing changes", async () => {
      const before = await versionOf(seed.c4);
      const r = await pd.evaluate(async ({ id, v }) => {
        const token = localStorage.getItem("token");
        const res = await fetch(`/api/service-desk/cases/${id}/actions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action: { type: "CLEAR_HOLD" }, expectedVersion: v }) });
        return res.status;
      }, { id: seed.c4, v: before - 1 });
      if (r < 400) throw new Error(`answered ${r}`);
      if ((await versionOf(seed.c4)) !== before) throw new Error("the case changed");
    });

    // ── activation (decision 1), business C ──
    for (const [size, tag] of [[PHONE, "phone"], [DESKTOP, "desktop"]] as const) {
      const cc = await ctx(browser, seed.tokenC, size);
      const pc = await cc.newPage();
      current = pc;
      await check(`S1-${tag} activation: banner → garage pre-selected from the category${tag === "desktop" ? " → service added by hand → saved, journaled, banner gone" : ""}`, async () => {
        await pc.goto("/service-desk");
        await pc.locator("[data-setup-banner]").waitFor({ timeout: 180_000 });
        await shot(pc, `real-list-setup-banner-${tag}`);
        await pc.locator("[data-setup-banner]").click();
        const garage = pc.getByRole("radio", { name: /מוסך/ });
        await garage.waitFor({ timeout: 120_000 });
        if ((await garage.getAttribute("aria-checked")) !== "true") throw new Error("garage not pre-selected");
        await pc.getByText("מוצע לפי התחום").first().waitFor();
        await pc.getByRole("button", { name: "המשך", exact: true }).click(); // the first activation is two short steps
        if (!(await pc.getByRole("checkbox", { name: /תיקון רכב/ }).isChecked())) throw new Error("T2 not pre-checked");
        await shot(pc, `real-setup-${tag}`);
        if (tag === "phone") return;
        await pc.getByRole("checkbox", { name: /^שירות/ }).check();
        await pc.getByRole("button", { name: /לשמור ולהתחיל/ }).click();
        await pc.getByRole("heading", { name: "תיקונים ושירות" }).waitFor({ timeout: 60_000 });
        await until(async () => {
          const s = (await own(seed.bizC, `SELECT "serviceProfileKey" k, "profileOverrides" o FROM "ServiceSettings" WHERE "businessId" = $1`, seed.bizC))[0] as { k?: string; o?: { offeredTracks?: string[] } } | undefined;
          return s?.k === "garage" && !!s.o?.offeredTracks?.includes("T5");
        }, "settings not saved");
        const ev = Number((await own(seed.bizC, `SELECT count(*)::int n FROM "ServiceSettingsEvent" WHERE "businessId" = $1`, seed.bizC))[0].n);
        if (ev < 1) throw new Error("not journaled");
        await pc.reload();
        await pc.getByRole("heading", { name: "תיקונים ושירות" }).waitFor();
        await sleep(1500);
        if (await pc.locator("[data-setup-banner]").count()) throw new Error("banner still shown");
      });
      await cc.close();
    }

    // ── QA panel, business C, desktop ──
    {
      const cc = await ctx(browser, seed.tokenC, DESKTOP);
      const pc = await cc.newPage();
      current = pc;
      await check("QA1 c5: before any mark nothing says «failed»; a failed mark leads to «back to work»; the server refuses PASS over a saved failure; every check marked → save + confirm in one action → READY", async () => {
        await openCase(pc, seed.c5);
        const panel = pc.locator("[data-panel=qa]");
        await panel.waitFor({ timeout: 60_000 });
        const status = pc.locator("section[aria-label='מצב ופעולה הבאה']");
        // Owner decision 2026-11-24: before any check is marked, the main action is to mark them — never «failed».
        await status.getByRole("button", { name: "לסמן את הבדיקות", exact: true }).waitFor();
        if (await status.getByRole("button", { name: /לא עבר/ }).count()) throw new Error("a «failed» action is offered before any mark");
        // the heading says what is left (owner 2026-11-24: heading and button never disagree)
        await status.getByText(/^(נותרו \d+ בדיקות לסמן|נותרה בדיקה אחת לסמן)$/).waitFor();
        const pass = panel.getByRole("button", { name: "✓ עבר", exact: true });
        const n = await pass.count();
        if (n < 3) throw new Error(`only ${n} checks`);
        await panel.getByText(/0 מתוך \d+ בדיקות הושלמו/).first().waitFor();
        // A — one check marked FAILED: the main action is «save and back to work», and confirming is not offered.
        for (let i = 0; i < n; i++) await pass.nth(i).click();
        await panel.getByRole("button", { name: "✕ לא עבר", exact: true }).first().click();
        await status.getByRole("button", { name: "לשמור ולהחזיר לעבודה", exact: true }).waitFor();
        if (await status.getByRole("button", { name: "לאשר שהבדיקות עברו", exact: true }).count()) throw new Error("confirm offered over a failed mark");
        await status.getByText(/^הבדיקה «.+» לא עברה — להחזיר לעבודה$/).waitFor(); // the failed check is named, with the action
        await shot(pc, "real-case-qa-failed-desktop");
        // The server rule is unchanged: a SAVED failure refuses PASS_QA.
        const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
        const refused = await pc.evaluate(async ({ id, k1, k2 }) => {
          // plain objects, no named helper: tsx wraps named functions in __name(), which does not exist in the page
          const auth = `Bearer ${localStorage.getItem("token")}`;
          const h1 = { Authorization: auth, "Content-Type": "application/json", "Idempotency-Key": k1 };
          const h2 = { Authorization: auth, "Content-Type": "application/json", "Idempotency-Key": k2 };
          const qa = await (await fetch(`/api/service-desk/cases/${id}/qa`, { headers: h1 })).json();
          const keys: string[] = (qa.qa?.template?.items ?? qa.template?.items ?? []).map((i: { key: string }) => i.key);
          const results: Record<string, string> = {};
          keys.forEach((key, idx) => { results[key] = idx === 0 ? "FAIL" : "PASS"; });
          const c0 = await (await fetch(`/api/service-desk/cases/${id}`, { headers: h1 })).json();
          await fetch(`/api/service-desk/cases/${id}/qa`, { method: "PUT", headers: h1, body: JSON.stringify({ results, expectedVersion: c0.version }) });
          const c = await (await fetch(`/api/service-desk/cases/${id}`, { headers: h2 })).json();
          const r = await fetch(`/api/service-desk/cases/${id}/actions`, { method: "POST", headers: h2, body: JSON.stringify({ action: { type: "PASS_QA", outcome: "REPAIRED" }, expectedVersion: c.version }) });
          return { status: r.status, body: await r.text(), keys: keys.length };
        }, { id: seed.c5, k1: uuidV7(new Date()), k2: uuidV7(new Date(Date.now() + 1)) });
        if (refused.status < 400 || !refused.body.includes("QA_INCOMPLETE")) throw new Error(`PASS_QA over a saved failed check: ${refused.status} ${refused.body.slice(0, 200)} (keys ${refused.keys})`);
        if ((await own(seed.bizC, `SELECT "qaCompletedAt" IS NULL x FROM "ServiceCase" WHERE id = $1`, seed.c5))[0].x !== true) throw new Error("a failed check completed QA");
        // B — the screen reads the saved failure; the owner marks the failed check again as passed → one action saves and confirms.
        await openCase(pc, seed.c5);
        await status.getByRole("button", { name: "לשמור ולהחזיר לעבודה", exact: true }).waitFor({ timeout: 30_000 });
        await pc.locator("[data-panel=qa]").getByRole("button", { name: "✓ עבר", exact: true }).first().click();
        await status.getByRole("button", { name: "לאשר שהבדיקות עברו", exact: true }).waitFor();
        await status.getByText("כל בדיקות החובה עברו — אפשר לאשר", { exact: true }).waitFor();
        if (await status.getByText(/להשלים את הבדיקות/).count()) throw new Error("the heading still asks to complete the checks over a full list");
        await shot(pc, "real-case-qa-desktop");
        await clickAction(pc, "לאשר שהבדיקות עברו");
        await until(async () => (await own(seed.bizC, `SELECT "qaCompletedAt" IS NOT NULL ok FROM "ServiceCase" WHERE id = $1`, seed.c5))[0].ok === true, "qaCompletedAt not set");
        await until(async () => String((await own(seed.bizC, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, seed.c5))[0].s) === "READY", "not READY");
        // Business C's user has no profile name: the history says so — never an e-mail, never an invented name.
        await openCase(pc, seed.c5);
        await pc.locator("section[aria-label='היסטוריה']").getByText("משתמש ללא שם").first().waitFor({ timeout: 30_000 });
        if ((await pc.locator("section[aria-label='היסטוריה']").innerText()).includes("@")) throw new Error("an e-mail in the history");
      });
      await check("X3 another business cannot read A's case panels (404)", async () => {
        const codes = await pc.evaluate(async (id) => {
          const h = { Authorization: `Bearer ${localStorage.getItem("token")}` };
          const out: number[] = [];
          for (const p of ["loans", "tasks", "fields", "pickup-reminders", "qa"]) out.push((await fetch(`/api/service-desk/cases/${id}/${p}`, { headers: h })).status);
          return out;
        }, seed.c4);
        if (codes.some((c) => c !== 404)) throw new Error(codes.join(","));
      });
      await cc.close();
    }

    // ── A: the opening form, a quote from the case, tasks, fields (desktop) ──
    {
      const ca = await ctx(browser, seed.tokenA, DESKTOP);
      const pa = await ca.newPage();
      current = pa;
      await check("O1 the opening form: a repair for an existing customer → the case with its track; on to the intake", async () => {
        const before = Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceCase" WHERE "businessId" = $1`, seed.bizA))[0].n);
        await pa.goto("/service-desk/new");
        await pa.getByRole("button", { name: "תיקון במעבדה" }).waitFor({ timeout: 120_000 });
        await shot(pa, "real-open-start-desktop");
        await pa.getByRole("button", { name: "תיקון במעבדה" }).click();
        await pa.locator("#sd-open-customer").fill("דנה");
        await pa.getByRole("button", { name: /דנה כהן/ }).first().click({ timeout: 30_000 });
        await pa.locator("#sd-open-subject").fill("iPad Air");
        await pa.locator("#sd-open-problem").fill("לא נדלק אחרי עדכון");
        await shot(pa, "real-open-repair-desktop");
        await pa.getByRole("button", { name: "לפתוח ולעבור לקליטה" }).click();
        await pa.waitForURL(/\/service-desk\/cases\/\d+\/intake/, { timeout: 60_000 });
        const after = (await own(seed.bizA, `SELECT count(*)::int n, max(id) m FROM "ServiceCase" WHERE "businessId" = $1`, seed.bizA))[0] as { n: number; m: number };
        if (Number(after.n) !== before + 1) throw new Error("no new case");
        const snap = (await own(seed.bizA, `SELECT "profileKey" k, "workType"::text w FROM "ServiceCase" WHERE id = $1`, after.m))[0] as { k: string; w: string };
        if (snap.k !== "device_lab" || snap.w !== "REPAIR") throw new Error(JSON.stringify(snap));
      });
      await check("Q2 c6: the customer's billing quote is sent from the case → QUOTE_PENDING; the billing document's content (status, total, customer, lines) is not changed; billing's own quote numbering may give it its number", async () => {
        const docBefore = JSON.stringify((await own(seed.bizA, `SELECT d.status::text s, d."totalAmount"::text t, d."documentNumber" n, d."customerId" c,
          (SELECT json_agg(json_build_array(l.description, l.quantity::text, l."unitPrice"::text, l."lineTotal"::text) ORDER BY l."lineIndex") FROM "BillingDocumentLine" l WHERE l."billingDocumentId" = d.id) lines
          FROM "BillingDocument" d WHERE d.id = $1`, seed.quoteC6))[0]);
        await openCase(pa, seed.c6);
        const panel = pa.locator("[data-panel=quote]");
        await panel.waitFor({ timeout: 60_000 });
        await shot(pa, "real-case-quote-send-desktop");
        await panel.getByRole("button", { name: "לצרף לתיק" }).first().click();
        const dlg = pa.getByRole("dialog");
        await dlg.waitFor();
        if (!(await dlg.innerText()).includes("המערכת לא שולחת את ההצעה ללקוח")) throw new Error("the confirmation does not say the system does not deliver it");
        if ((await statusOf(seed.c6)) === "QUOTE_PENDING") throw new Error("sent before the confirmation");
        await shot(pa, "real-case-quote-confirm-desktop");
        await confirmDialog(pa, "לצרף לתיק");
        await waitStatus(seed.c6, "QUOTE_PENDING");
        const n = Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceQuote" WHERE "caseId" = $1 AND "billingDocumentId" = $2`, seed.c6, seed.quoteC6))[0].n);
        if (n !== 1) throw new Error(`quote rows ${n}`);
        const docAfter = JSON.stringify((await own(seed.bizA, `SELECT d.status::text s, d."totalAmount"::text t, d."documentNumber" n, d."customerId" c,
          (SELECT json_agg(json_build_array(l.description, l.quantity::text, l."unitPrice"::text, l."lineTotal"::text) ORDER BY l."lineIndex") FROM "BillingDocumentLine" l WHERE l."billingDocumentId" = d.id) lines
          FROM "BillingDocument" d WHERE d.id = $1`, seed.quoteC6))[0]);
        // Billing's own quote PDF (getOrRenderQuotePdf, called as is) numbers a quote the first time it is produced —
        // billing's existing mechanism, the same as producing the PDF in billing. Only that may change; nothing else.
        const b = JSON.parse(docBefore), a = JSON.parse(docAfter);
        const numberOk = b.n === null ? Number.isInteger(a.n) && a.n > 0 : a.n === b.n;
        delete b.n; delete a.n;
        if (!numberOk || JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`the billing document changed: ${docBefore} → ${docAfter}`);
      });
      await check("TK1 an open task is linked to c4 and unlinked", async () => {
        await openCase(pa, seed.c4);
        const panel = pa.locator("[data-panel=tasks]");
        await panel.locator("#sd-task-pick").waitFor({ timeout: 60_000 });
        await panel.locator("#sd-task-pick").selectOption(String(seed.taskA));
        await panel.getByRole("button", { name: "לקשר" }).click();
        await until(async () => Number((await own(seed.bizA, `SELECT coalesce("serviceCaseId", 0) v FROM "Task" WHERE id = $1`, seed.taskA))[0].v) === seed.c4, "not linked");
        await panel.getByText("להזמין מקלדת מהספק").waitFor();
        await panel.getByRole("button", { name: "להסיר" }).click();
        await until(async () => (await own(seed.bizA, `SELECT "serviceCaseId" v FROM "Task" WHERE id = $1`, seed.taskA))[0].v === null, "not unlinked");
      });
      await check("F1 c4: the item location and the estimated date are saved", async () => {
        const panel = pa.locator("[data-panel=fields]");
        await panel.locator("#sd-item-location").fill("מדף 3");
        await panel.locator("#sd-estimated").fill("2026-12-01");
        await panel.getByRole("button", { name: "לשמור" }).click();
        await until(async () => {
          const r = (await own(seed.bizA, `SELECT "itemLocationNote" l, to_char("estimatedReadyOn", 'YYYY-MM-DD') d FROM "ServiceCase" WHERE id = $1`, seed.c4))[0] as { l: string | null; d: string | null };
          return r.l === "מדף 3" && r.d === "2026-12-01";
        }, "not saved");
        await shot(pa, "real-case-panels-desktop");
      });
      await check("H1 c4 history (20261222090000): task linked / unlinked and the work details are shown, by the owner, without a reload; journaled once each with who acted", async () => {
        for (const line of ["קושרה משימה: להזמין מקלדת מהספק", "הוסר קישור למשימה: להזמין מקלדת מהספק", "מיקום הפריט עודכן · סיום משוער: 1.12"]) {
          const li = pa.locator("ol li").filter({ hasText: line });
          await li.first().waitFor({ timeout: 30_000 });
          if ((await li.count()) !== 1) throw new Error(`"${line}" shown ${await li.count()} times`);
          if (!(await li.first().innerText()).includes("שירה כהן")) throw new Error(`"${line}" without the name of who acted`);
        }
        const rows = await own(seed.bizA, `SELECT "eventType"::text t, "actorUserId" u FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "eventType"::text IN ('task.linked', 'task.unlinked', 'case.work_details_recorded') ORDER BY seq`, seed.c4);
        const kinds = rows.map((r) => r.t).join(",");
        if (kinds !== "task.linked,task.unlinked,case.work_details_recorded" || !rows.every((r) => Number(r.u) === seed.userA)) throw new Error(`journal ${JSON.stringify(rows)}`);
        await shot(pa, "real-case-history-records-desktop");
      });
      await ca.close();
    }

    // ── A: pickup calls and a replacement item (phone) ──
    {
      const cp = await ctx(browser, seed.tokenA, PHONE);
      const pp = await cp.newPage();
      current = pp;
      await check("P1 c3 (READY): a pickup call 'no answer' → one reminder row, the counter 1, the header summary", async () => {
        await openCase(pp, seed.c3);
        // The case head offers a call when the customer's phone is known (owner 2026-11-24).
        const call = pp.locator("header[aria-label='כותרת התיק'] a[href^='tel:']");
        await call.waitFor({ timeout: 30_000 });
        if ((await call.getAttribute("href")) !== "tel:0501234567") throw new Error(`call link ${await call.getAttribute("href")}`);
        const panel = pp.locator("[data-panel=pickup]");
        await panel.waitFor({ timeout: 60_000 });
        await panel.getByRole("button", { name: "אין מענה" }).click();
        await until(async () => {
          const r = (await own(seed.bizA, `SELECT (SELECT count(*)::int FROM "ServicePhoneReminder" WHERE "caseId" = $1) n, "pickupRemindersSent" c FROM "ServiceCase" WHERE id = $1`, seed.c3))[0] as { n: number; c: number };
          return Number(r.n) === 1 && Number(r.c) === 1;
        }, "reminder not recorded");
        await pp.getByText(/תזכורת אחת · אחרונה היום/).waitFor({ timeout: 30_000 });
      });
      await check("LN1 a replacement item on c3 → the handover reminder (never a block); returned → returnedAt", async () => {
        const more = pp.locator("details[data-more=loans]");
        if (await more.count()) await more.locator("summary").click();
        const panel = pp.locator("[data-panel=loans]");
        await panel.getByRole("button", { name: "+ ציוד חלופי" }).click();
        await panel.locator("#sd-loan-name").fill("טלפון חלופי");
        await panel.getByRole("button", { name: "לרשום" }).click();
        await pp.getByText("לפני המסירה: לקבל בחזרה את טלפון חלופי").waitFor({ timeout: 30_000 });
        await shot(pp, "real-case-pickup-loan-phone");
        // The loan is a reminder, never a block: c3 has no charge decided, so the only reason the handover waits is the charge.
        const status = pp.locator("section[aria-label='מצב ופעולה הבאה']");
        await status.getByRole("button", { name: "לקבוע חיוב", exact: true }).waitFor();
        const blocked = (await status.locator("[role=note]").allInnerTexts()).join(" ");
        if (blocked.includes("טלפון חלופי")) throw new Error(`the loan blocks the handover: ${blocked}`);
        await pp.locator("[data-panel=loans]").getByRole("button", { name: "הוחזר" }).click();
        await until(async () => Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceCaseLoaner" WHERE "caseId" = $1 AND "returnedAt" IS NOT NULL`, seed.c3))[0].n) === 1, "not returned");
      });
      await check("H2 c3 history (20261222090000): the replacement item lent and returned, once each (no side-line repeat), by the owner", async () => {
        for (const line of ["ניתן ציוד חלופי: טלפון חלופי", "הוחזר ציוד חלופי: טלפון חלופי"]) {
          const li = pp.locator("ol li").filter({ hasText: line });
          await li.first().waitFor({ timeout: 30_000 });
          if ((await li.count()) !== 1) throw new Error(`"${line}" shown ${await li.count()} times`);
          if (!(await li.first().innerText()).includes("שירה כהן")) throw new Error(`"${line}" without the name of who acted`);
        }
        const n = Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "eventType"::text IN ('loan.lent', 'loan.returned') AND "actorUserId" = $2`, seed.c3, seed.userA))[0].n);
        if (n !== 2) throw new Error(`loan records ${n}`);
        await shot(pp, "real-case-history-loan-phone");
      });
      await cp.close();
    }

    // ── 360 px (the narrowest phone; pilot review 2026-11-21): no horizontal scroll on the list, the opening form and every
    //    seeded case; a dialog fits the screen, is opaque, and its confirm / cancel buttons are reachable ──
    {
      const NARROW: Size = { width: 360, height: 740, phone: true };
      const cn = await ctx(browser, seed.tokenA, NARROW);
      const pn = await cn.newPage();
      current = pn;
      const noSideScroll = async (where: string) => {
        const w = await pn.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
        if (w > 360) throw new Error(`${where}: page is ${w}px wide at 360`);
      };
      await check("W360 the list, the opening form and every seeded case fit 360 px with no horizontal scroll", async () => {
        await pn.goto("/service-desk");
        await pn.getByRole("link", { name: /פתיחה חדשה|פתיחת תיק/ }).first().waitFor({ timeout: 120_000 }).catch(() => undefined);
        await noSideScroll("list");
        await shot(pn, "w360-list");
        await pn.goto("/service-desk/new");
        await pn.getByRole("button", { name: "תיקון במעבדה" }).waitFor({ timeout: 120_000 });
        await noSideScroll("opening form");
        await shot(pn, "w360-open");
        for (const [k, id] of [["c1", seed.c1], ["c2", seed.c2], ["c3", seed.c3], ["c4", seed.c4], ["c6", seed.c6]] as const) {
          await openCase(pn, id);
          await pn.waitForTimeout(500);
          await noSideScroll(k);
          await shot(pn, `w360-case-${k}`);
        }
      });
      await check("W360b a dialog at 360 px: inside the screen, opaque, confirm and cancel both visible; cancelled (nothing sent)", async () => {
        await openCase(pn, seed.c4);
        const before = await statusOf(seed.c4);
        await pn.getByRole("button", { name: "עוד פעולות" }).click();
        await pn.getByRole("menuitem", { name: /ביטול ה(תיק|קריאה)/ }).click();
        const dlg = pn.getByRole("dialog");
        await dlg.waitFor();
        const box = await dlg.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > 360.5 || box.y < 0 || box.y + box.height > 740.5) throw new Error(`dialog box ${JSON.stringify(box)}`);
        const bg = await dlg.evaluate((el) => getComputedStyle(el).backgroundColor);
        if (!/^rgb\(255, 255, 255\)$/.test(bg)) throw new Error(`dialog background ${bg}`);
        for (const name of ["לאשר", "ביטול"]) if (!(await dlg.getByRole("button", { name, exact: true }).isVisible())) throw new Error(`${name} not visible`);
        await shot(pn, "w360-dialog");
        await dlg.getByRole("button", { name: "ביטול", exact: true }).click();
        await dlg.waitFor({ state: "detached" });
        if ((await statusOf(seed.c4)) !== before) throw new Error("the status changed");
      });
      await cn.close();
    }

    // ── business B: the module is off ──
    const b = await ctx(browser, seed.tokenB, PHONE);
    const pb = await b.newPage();
    current = pb;
    await check("N1 business B (module OFF): the screen says it is not open; the API answers 404", async () => {
      await pb.goto("/service-desk");
      await pb.getByText("מערכת השירות עדיין לא פתוחה לעסק").waitFor({ timeout: 120_000 });
      const status = await pb.evaluate(async () => (await fetch("/api/service-desk/cases", { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } })).status);
      if (status !== 404) throw new Error(`answered ${status}`);
    });
  } finally {
    await browser.close();
    await owner.$disconnect();
  }
  const failed = rows.filter((r) => !r.ok);
  const md = ["| | check | detail |", "| --- | --- | --- |", ...rows.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${r.detail.replace(/\|/g, "/")} |`)].join("\n");
  writeFileSync(join(OUT, "report.md"), `## Service Desk UI end to end\n\n${md}\n\n${rows.length - failed.length} passed, ${failed.length} failed\n`);
  console.log(`${rows.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
