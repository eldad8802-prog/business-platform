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
 *   W6 close → CLOSED; no action is offered any more; the history lists every step
 *   Q1 c2: "the customer approved" (by phone) → the quote is APPROVED in the database
 *   X1 an illegal action sent straight to the API (PASS_QA on an OPEN case) → 409, nothing changes
 *   X2 a write with a stale version → refused (VERSION_CONFLICT), nothing changes
 *   N1 business B (module OFF): the screen says it is not open; its API answers 404
 *
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL, DATABASE_URL, STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3740";
const OUT = process.env.OUT ?? "/tmp/sdui";
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as { tokenA: string; tokenB: string; bizA: number; bizB: number; userA: number; c1: number; c2: number; c3: number; c4: number };
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
const statusPill = (p: Page, label: string) => p.locator("section[aria-label='מצב ופעולה הבאה']").getByText(label, { exact: true });

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
      await check(`L1-${tag} the list shows the cases, attention first, with reasons`, async () => {
        await p.goto("/service-desk");
        await p.getByRole("heading", { name: "תיקי שירות" }).waitFor({ timeout: 180_000 });
        await p.getByText("דורשים טיפול").first().waitFor();
        await p.getByText("מוכן ולא נאסף").or(p.getByText("מוכן — לעדכן את הלקוח")).first().waitFor();
        await p.getByText("ממתין לחלקים").first().waitFor();
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
    await check("W1 confirm the intake → CHECKED_IN", async () => {
      await clickAction(p, "לאשר את הקליטה");
      await confirmDialog(p);
      await waitStatus(seed.c1, "CHECKED_IN");
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
    await check("B1 handover without a charge decision is refused in Hebrew; the status stays READY", async () => {
      await clickAction(p, "למסור ללקוח");
      await p.getByRole("dialog").getByRole("textbox").fill("דנה");
      await confirmDialog(p, "לאשר מסירה");
      await p.getByRole("alert").waitFor({ timeout: 30_000 });
      const text = (await p.getByRole("alert").innerText()).trim();
      if (!/[֐-׿]/.test(text)) throw new Error(`not a Hebrew message: ${text}`);
      await shot(p, "real-case-refused-phone");
      if ((await statusOf(seed.c1)) !== "READY") throw new Error("status changed");
    });
    await check("W5 after 'no charge' is recorded: handover with the receiver's name → DELIVERED, one handover row", async () => {
      const { recordCharge } = await import("@/lib/services/service-desk/case-charge.service");
      const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
      const { runWithTenantContext } = await import("@/lib/tenant/context");
      await runWithTenantContext({ businessId: seed.bizA }, async () =>
        recordCharge({ businessId: seed.bizA, userId: seed.userA } as never, seed.c1, { mode: "NO_CHARGE", reason: "תיקון באחריות", expectedVersion: await versionOf(seed.c1) }, { idempotencyKey: uuidV7(new Date()) }));
      await p.reload();
      await p.locator("section[aria-label='מצב ופעולה הבאה']").waitFor();
      await clickAction(p, "למסור ללקוח");
      await p.getByRole("dialog").getByRole("textbox").fill("דנה");
      await confirmDialog(p, "לאשר מסירה");
      await waitStatus(seed.c1, "DELIVERED");
      const n = Number((await own(seed.bizA, `SELECT count(*)::int n FROM "ServiceHandover" WHERE "caseId" = $1`, seed.c1))[0].n);
      if (n !== 1) throw new Error(`handover rows ${n}`);
    });
    await check("W6 close → CLOSED; no action offered; the history lists the steps", async () => {
      await clickAction(p, "לסגור את התיק");
      await waitStatus(seed.c1, "CLOSED");
      await statusPill(p, "נסגר").waitFor();
      const buttons = await p.locator("section[aria-label='מצב ופעולה הבאה'] button").count();
      if (buttons !== 0) throw new Error(`${buttons} action buttons on a closed case`);
      for (const step of ["הפריט נקלט", "התחיל אבחון", "העבודה התחילה", "העבודה הסתיימה", "נמסר ללקוח", "נסגר"]) await p.getByText(step, { exact: true }).first().waitFor();
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
