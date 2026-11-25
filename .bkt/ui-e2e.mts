/**
 * "מעבר לעוסק מורשה" — the screens in a real browser against `next dev` on the lab database (.bkt/lab.sh --with-bkt),
 * through the REAL API and the REAL database function. Chromium (desktop + phone viewports) and WebKit (iPhone-sized
 * viewport): browser EMULATION, not a physical phone. Google itself is not reachable from the lab: the redirect to
 * Google is intercepted and its URL checked; the return is simulated with ?reauth=…, and a simulated "ok" WITHOUT a
 * server proof must still be refused by the server (that is the point of U9).
 *
 *   U1  /business (phone, flag on): the entry asks the API (200); the action row inside the legal card; RTL
 *   U2  step 1: continue disabled until a date; a future date → error + disabled; an early date → warning
 *   U3  step 2: wrong id number → error + "מה עושים?" opens the sheet; Escape closes it, focus returns
 *   U4  wrong password → error, still on step 2; correct password → step 3
 *   U5  back from step 2 keeps the date; back from step 3 keeps the id number
 *   U6  step 3: confirm disabled until all five confirmations; summary shows the date
 *   U7  confirm → success screen; database: AUTHORIZED_DEALER, one history row (PASSWORD)
 *   U8  "חזרה לפרטי העסק" → the history line, no action row; opening the flow again → "already moved"
 *   U9  Google-only: the Google button → redirect to Google with prompt=login & max_age=0 (intercepted);
 *       return ?reauth=other_account → message, typed id restored; return ?reauth=ok with NO server proof →
 *       confirm refused by the server → "לאימות מחדש"
 *   U10 the proof cookie removed before confirming (expired) → reverify message, nothing written
 *   U11 several users: the row disabled with the reason; the page itself shows "not available"
 *   U12 keyboard: Tab reaches the date field and the continue button; Enter in the password field submits
 *   U13 phone 320px: no horizontal scroll on any step
 *   U14 WebKit, iPhone-sized viewport: the whole flow to success
 *   U15 failure mid-process: the confirm call answers 500, then the network drops → "nothing changed", still on step 3,
 *       confirmations kept, nothing written; the retry → success, exactly one history row
 *   U16 cancel on step 3 → the business screen, nothing written, the action row still there; opening the flow again
 *       starts empty (no date kept)
 *   U17 screen widths (Chromium, Android-sized 360 / 412; WebKit, iPhone-sized 375 / 430): no horizontal scroll on
 *       steps 1–3 and the success screen, the page stays RTL
 *
 * env: E2E_BASE, OWNER_URL, AUTH_TOKEN_SECRET, OUT.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";

import { signAuthToken } from "../lib/auth-token";

const BASE = process.env.E2E_BASE ?? "http://localhost:3741";
const OUT = process.env.OUT ?? "./.bkt-ui-out";
mkdirSync(OUT, { recursive: true });
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];

let pass = 0;
const failures: string[] = [];
let current: Page | null = null;
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    if (r === false) throw new Error("condition false");
    pass++; console.log(`  [PASS] ${name}`);
  } catch (e) {
    const d = e instanceof Error ? e.message.split("\n")[0].slice(0, 240) : String(e);
    failures.push(name); console.log(`  [FAIL] ${name} — ${d}`);
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`), fullPage: true }).catch(() => undefined);
  }
}

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const PASSWORD = "Correct-Pass-1";
let seq = 0;
type Biz = { businessId: number; userId: number; taxId: string; token: string; sessionId: string; email: string };

async function business(opts: { password?: string | null; users?: number } = {}): Promise<Biz> {
  const n = ++seq;
  const taxId = withCheckDigit(String(40000000 + n * 104729 + Math.floor(Math.random() * 9000)).slice(0, 8));
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `העסק של דנה ${n}`)) as Rows;
  const businessId = Number(b[0].id);
  const hash = opts.password === null ? null : await bcrypt.hash(opts.password ?? PASSWORD, 4);
  const ids: number[] = [];
  let email = "";
  for (let i = 0; i < (opts.users ?? 1); i++) {
    email = `bkt-ui-${Date.now()}-${n}-${i}@lab.invalid`;
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, email, hash, businessId)) as Rows;
    ids.push(Number(u[0].id));
  }
  await owner.$queryRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingAddress","billingPhone",
       "billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
     VALUES ($1,'EXEMPT_DEALER','דנה כהן',$2,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`, businessId, taxId);
  const s = (await owner.$queryRawUnsafe(
    `INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1,$2,0,now(),now(),now() + interval '1 day',now() + interval '30 days') RETURNING id`,
    ids[0], createHash("sha256").update(randomBytes(32)).digest("hex"))) as Rows;
  const sessionId = String(s[0].id);
  return { businessId, userId: ids[0], taxId, token: signAuthToken(ids[0], 0, sessionId), sessionId, email: ids.length ? email : "" };
}

async function ctxFor(browser: Browser, b: Biz, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport, locale: "he-IL", hasTouch: viewport.width < 500, isMobile: false });
  await ctx.addInitScript(([token, sid, user]) => {
    try {
      localStorage.setItem("token", token as string);
      localStorage.setItem("sessionId", sid as string);
      localStorage.setItem("user", user as string);
    } catch { /* ignore */ }
  }, [b.token, b.sessionId, JSON.stringify({ id: b.userId, businessId: b.businessId, businessName: "העסק של דנה", email: b.email })]);
  return ctx;
}
const history = async (businessId: number) => (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, businessId)) as Rows;
const kind = async (businessId: number) => String(((await owner.$queryRawUnsafe(`SELECT "billingBusinessKind" k FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0].k);
const israelToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const addDays = (ymd: string, d: number) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const TODAY = israelToday();
const EARLY = addDays(TODAY, -20);
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ── 4a T4: interim documents (seeded as issuance freezes them) ──
const docNo: Record<string, number> = {};
async function seedDoc(b: Biz, type: string, ymd: string | null, opts: { total?: string; kind?: string } = {}) {
  const key = `${b.businessId}:${type}`;
  const n = (docNo[key] = (docNo[key] ?? 0) + 1);
  const at = ymd === null ? "now() AT TIME ZONE 'UTC'" : `(('${ymd} 12:00'::timestamp AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'UTC')`;
  await owner.$executeRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","documentNumber","documentNumberFormatted","subtotalAmount","totalAmount","currency","issuedSnapshot","updatedAt")
     VALUES ($1, $2::"BillingDocumentType", 'ISSUED', ${at}, $3, $4, $5::numeric, $5::numeric, 'ILS', $6::jsonb, now())`,
    b.businessId, type, n, String(n).padStart(6, "0"), opts.total ?? "1180.00",
    JSON.stringify({ issuer: { legalName: "דנה כהן", taxId: b.taxId }, extensions: { billingBusinessKind: opts.kind ?? "EXEMPT_DEALER" } }));
}
const interimCount = async (p: Page) => Number(await p.getByTestId("kt-interim").getAttribute("data-count"));

async function toStep3(p: Page, b: Biz) {
  await p.goto(`${BASE}/business/legal-identity/kind-transition`);
  await p.getByTestId("kt-date").fill(EARLY);
  await p.getByTestId("kt-step1-next").click();
  await p.getByTestId("kt-tax").fill(b.taxId);
  await p.getByTestId("kt-password").fill(PASSWORD);
  await p.getByTestId("kt-step2-next").click();
  await p.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
}
async function tickAll(p: Page) {
  for (const box of await p.locator('input[type="checkbox"]').all()) await box.check();
}

async function main() {
  const browser = await chromium.launch();
  const PHONE = { width: 390, height: 844 };

  // ── U1–U8: the main path, phone ──
  const a = await business();
  const ctxA = await ctxFor(browser, a, PHONE);
  const p = await ctxA.newPage(); current = p;
  await check("U1 /business (flag on): the entry asks the API (200) and shows the action row inside the legal card, page is RTL", async () => {
    const asked = p.waitForResponse((r) => r.url().endsWith("/api/business/legal-identity/kind-transition") && r.request().method() === "GET", { timeout: 120_000 });
    await p.goto(`${BASE}/business`);
    const status = (await asked).status();
    await p.getByTestId("kt-entry-action").waitFor({ timeout: 90_000 });
    const dir = await p.evaluate(() => document.documentElement.dir || getComputedStyle(document.body).direction);
    return status === 200 && dir === "rtl";
  });
  await check("U2 step 1: continue disabled until a date; future → error; early → warning", async () => {
    await p.getByTestId("kt-entry-action").click();
    await p.getByRole("heading", { name: "מה המעבר עושה" }).waitFor({ timeout: 60_000 });
    if (!(await p.getByTestId("kt-step1-next").isDisabled())) throw new Error("enabled without a date");
    await p.getByTestId("kt-date").fill(addDays(TODAY, 3));
    await p.getByText("אפשר לעבור רק מהתאריך").waitFor();
    if (!(await p.getByTestId("kt-step1-next").isDisabled())) throw new Error("enabled with a future date");
    await p.getByTestId("kt-date").fill(EARLY);
    await p.getByTestId("kt-early-warning").waitFor();
    return !(await p.getByTestId("kt-step1-next").isDisabled());
  });
  await check("U13a phone 320: step 1 has no side scroll", async () => { await p.setViewportSize({ width: 320, height: 700 }); const r = await noSideScroll(p); await p.setViewportSize(PHONE); return r; });
  await check("U3 wrong id number → error; 'מה עושים?' opens the sheet; Escape closes, focus returns", async () => {
    await p.getByTestId("kt-step1-next").click();
    await p.getByTestId("kt-tax").fill(withCheckDigit("12121212"));
    await p.getByTestId("kt-password").fill(PASSWORD);
    await p.getByTestId("kt-step2-next").click();
    await p.getByText("המספר לא תואם").waitFor();
    const opener = p.getByRole("button", { name: "מה עושים?" });
    await opener.click();
    await p.getByTestId("kt-new-file-sheet").waitFor();
    await p.keyboard.press("Escape");
    await p.getByTestId("kt-new-file-sheet").waitFor({ state: "detached" });
    return p.evaluate(() => document.activeElement?.textContent?.includes("מה עושים"));
  });
  await check("U4 wrong password → error on step 2; correct → step 3", async () => {
    await p.getByTestId("kt-tax").fill(a.taxId);
    await p.getByTestId("kt-password").fill("wrong-password");
    await p.getByTestId("kt-step2-next").click();
    await p.getByText("הסיסמה שגויה").waitFor({ timeout: 30_000 });
    await p.getByTestId("kt-password").fill(PASSWORD);
    await p.getByTestId("kt-step2-next").click();
    await p.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    return true;
  });
  await check("U13b phone 320: step 3 has no side scroll", async () => { await p.setViewportSize({ width: 320, height: 700 }); const r = await noSideScroll(p); await p.setViewportSize(PHONE); return r; });
  await check("U5 back from step 3 keeps the id number; back again keeps the date", async () => {
    await p.getByTestId("kt-back").click();
    const tax = await p.getByTestId("kt-tax").inputValue();
    await p.getByTestId("kt-back").click();
    const d = await p.getByTestId("kt-date").inputValue();
    await p.getByTestId("kt-step1-next").click();
    await p.getByTestId("kt-step2-next").click();
    await p.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    return tax === a.taxId && d === EARLY;
  });
  await check("U6 confirm disabled until all five; the summary shows the date", async () => {
    if (!(await p.getByTestId("kt-confirm").isDisabled())) throw new Error("enabled with nothing ticked");
    const boxes = await p.locator('input[type="checkbox"]').all();
    if (boxes.length !== 5) throw new Error(`${boxes.length} confirmations`);
    for (const box of boxes.slice(0, 4)) await box.check();
    if (!(await p.getByTestId("kt-confirm").isDisabled())) throw new Error("enabled with four");
    await boxes[4].check();
    const [y, m, d] = EARLY.split("-");
    await p.getByText(`${d}.${m}.${y}`).first().waitFor();
    return !(await p.getByTestId("kt-confirm").isDisabled());
  });
  await check("U7 confirm → success; database AUTHORIZED_DEALER + one PASSWORD history row", async () => {
    await p.getByTestId("kt-confirm").click();
    await p.getByTestId("kt-success").waitFor({ timeout: 30_000 });
    const h = await history(a.businessId);
    return (await kind(a.businessId)) === "AUTHORIZED_DEALER" && h.length === 1 && h[0].reauthMethod === "PASSWORD";
  });
  await check("U8 back to the business screen: history line, no action; the flow again → already moved", async () => {
    await p.getByTestId("kt-finish").click();
    await p.getByText("עבר לעוסק מורשה ב-").waitFor({ timeout: 60_000 });
    if (await p.getByTestId("kt-entry-action").count()) throw new Error("action still offered");
    await p.goto(`${BASE}/business/legal-identity/kind-transition`);
    await p.getByRole("heading", { name: "העסק כבר עבר לעוסק מורשה" }).waitFor({ timeout: 30_000 });
    return true;
  });
  await ctxA.close();

  // ── U9: Google-only ──
  const g = await business({ password: null });
  const ctxG = await ctxFor(browser, g, PHONE);
  const pg = await ctxG.newPage(); current = pg;
  let googleUrl = "";
  await ctxG.route("https://accounts.google.com/**", async (route) => { googleUrl = route.request().url(); await route.fulfill({ status: 200, body: "google (lab: intercepted)" }); });
  await check("U9a the Google button redirects to Google with prompt=login & max_age=0", async () => {
    await pg.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pg.getByTestId("kt-date").fill(EARLY);
    await pg.getByTestId("kt-step1-next").click();
    if (await pg.getByTestId("kt-password").count()) throw new Error("password field shown to a Google-only account");
    await pg.getByTestId("kt-tax").fill(g.taxId);
    await pg.getByTestId("kt-google").click();
    await pg.waitForURL(/accounts\.google\.com/, { timeout: 30_000 });
    const u = new URL(googleUrl);
    return u.searchParams.get("prompt") === "login" && u.searchParams.get("max_age") === "0";
  });
  await check("U9b return ?reauth=other_account → the message; the typed id number is restored", async () => {
    await pg.goto(`${BASE}/business/legal-identity/kind-transition?reauth=other_account`);
    await pg.getByText("חשבון ה-Google שבחרתם").waitFor({ timeout: 30_000 });
    return (await pg.getByTestId("kt-tax").inputValue()) === g.taxId;
  });
  await check("U9c return ?reauth=ok WITHOUT a server proof → the server refuses the confirm → 'לאימות מחדש', nothing written", async () => {
    await pg.goto(`${BASE}/business/legal-identity/kind-transition?reauth=ok`);
    await pg.getByText("אומת עם Google").waitFor({ timeout: 30_000 });
    await pg.getByTestId("kt-step2-next").click();
    await pg.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    await tickAll(pg);
    await pg.getByTestId("kt-confirm").click();
    await pg.getByTestId("kt-reverify").waitFor({ timeout: 30_000 });
    return (await history(g.businessId)).length === 0 && (await kind(g.businessId)) === "EXEMPT_DEALER";
  });
  await ctxG.close();

  // ── U10: proof gone before confirming ──
  const e = await business();
  const ctxE = await ctxFor(browser, e, PHONE);
  const pe = await ctxE.newPage(); current = pe;
  await check("U10 the proof cookie removed (expired) → reverify message, nothing written", async () => {
    await toStep3(pe, e);
    await tickAll(pe);
    await ctxE.clearCookies({ name: "dz_reauth_bkt" });
    await pe.getByTestId("kt-confirm").click();
    await pe.getByTestId("kt-reverify").waitFor({ timeout: 30_000 });
    return (await history(e.businessId)).length === 0;
  });
  await ctxE.close();

  // ── U11: several users ──
  const m = await business({ users: 2 });
  const ctxM = await ctxFor(browser, m, PHONE);
  const pm = await ctxM.newPage(); current = pm;
  await check("U11 several users: the row is disabled with the reason; the page shows 'not available'", async () => {
    await pm.goto(`${BASE}/business`);
    await pm.getByTestId("kt-entry-blocked").waitFor({ timeout: 60_000 });
    if (!(await pm.getByTestId("kt-entry-blocked").isDisabled())) throw new Error("not disabled");
    await pm.getByText("יותר ממשתמש אחד").first().waitFor();
    await pm.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pm.getByTestId("kt-blocked-message").waitFor({ timeout: 30_000 });
    return true;
  });
  await ctxM.close();

  // ── U12: keyboard ──
  const k = await business();
  const ctxK = await ctxFor(browser, k, { width: 1280, height: 900 });
  const pk = await ctxK.newPage(); current = pk;
  await check("U12 keyboard: Tab reaches the date and continue; Enter in the password field submits", async () => {
    await pk.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pk.getByRole("heading", { name: "מה המעבר עושה" }).waitFor({ timeout: 60_000 });
    let reachedDate = false;
    for (let i = 0; i < 12 && !reachedDate; i++) { await pk.keyboard.press("Tab"); reachedDate = await pk.evaluate(() => document.activeElement?.id === "kt-date"); }
    if (!reachedDate) throw new Error("Tab never reached the date field");
    await pk.getByTestId("kt-date").fill(EARLY);
    await pk.getByTestId("kt-step1-next").focus();
    await pk.keyboard.press("Enter");
    await pk.getByTestId("kt-tax").fill(k.taxId);
    await pk.getByTestId("kt-password").fill(PASSWORD);
    await pk.getByTestId("kt-password").press("Enter");
    await pk.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    return true;
  });
  await ctxK.close();

  // ── V1–V9: 4a T4, the interim documents, phone (390×844) ──
  const PHONE_SHOTS = (n: string) => join(OUT, `t4-${n}.png`);
  const v = await business();
  const D1 = addDays(TODAY, -20); // = EARLY
  const D2 = addDays(TODAY, -8);
  await seedDoc(v, "RECEIPT", D1);
  await seedDoc(v, "TAX_INVOICE", addDays(TODAY, -15));
  await seedDoc(v, "TAX_INVOICE_RECEIPT", addDays(TODAY, -5), { total: "354.00" });
  await seedDoc(v, "CREDIT_NOTE", addDays(TODAY, -3), { total: "118.00" });
  await seedDoc(v, "RECEIPT", addDays(TODAY, -40)); // before both dates
  const ctxV = await ctxFor(browser, v, PHONE);
  const pv = await ctxV.newPage(); current = pv;
  const asked: string[] = [];
  pv.on("request", (r) => { if (r.url().includes("/api/billing/kind-transition/interim-documents")) asked.push(new URL(r.url()).search); });
  await check("V1 step 1: the date → the owner-approved sentence with the count (4), a request with that date", async () => {
    await pv.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pv.getByTestId("kt-date").fill(D1);
    await pv.getByTestId("kt-interim").waitFor({ timeout: 60_000 });
    const text = await pv.getByTestId("kt-interim").innerText();
    const [y, m, d] = D1.split("-");
    await pv.screenshot({ path: PHONE_SHOTS("1-step1-count"), fullPage: true });
    return (await interimCount(pv)) === 4 && text === `מאז ${d}.${m}.${y} הופקו 4 מסמכים כעוסק פטור. המסמכים יישארו ללא שינוי. מומלץ לבדוק אותם עם רואה החשבון שלך.`
      && asked.some((q) => q === `?from=${D1}`);
  });
  await check("V2 the date changes → asked again automatically → 2", async () => {
    await pv.getByTestId("kt-date").fill(D2);
    await pv.waitForFunction(() => document.querySelector('[data-testid="kt-interim"]')?.getAttribute("data-count") === "2", null, { timeout: 30_000 });
    return asked.some((q) => q === `?from=${D2}`);
  });
  await check("V3 the list: a sheet with the 2 documents (type, number, amount, credit), Escape closes, focus back on the opener", async () => {
    await pv.getByTestId("kt-interim-list-open").click();
    await pv.getByTestId("kt-interim-sheet").waitFor();
    await pv.getByTestId("kt-interim-item").nth(1).waitFor({ timeout: 30_000 });
    const rows = await pv.getByTestId("kt-interim-item").allInnerTexts();
    await pv.screenshot({ path: PHONE_SHOTS("2-list-sheet"), fullPage: false });
    const sideOk = await noSideScroll(pv);
    await pv.keyboard.press("Escape");
    await pv.getByTestId("kt-interim-sheet").waitFor({ state: "detached" });
    const focusBack = await pv.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.testid === "kt-interim-list-open");
    return rows.length === 2 && rows.some((r) => r.includes("חשבונית מס-קבלה")) && rows.some((r) => r.includes("חשבונית זיכוי")) && sideOk && focusBack;
  });
  await check("V4 step 3 shows the same number; confirm waits for it", async () => {
    await pv.getByTestId("kt-step1-next").click();
    await pv.getByTestId("kt-tax").fill(v.taxId);
    await pv.getByTestId("kt-password").fill(PASSWORD);
    await pv.getByTestId("kt-step2-next").click();
    await pv.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    await pv.getByTestId("kt-interim").waitFor({ timeout: 30_000 });
    await tickAll(pv);
    await pv.screenshot({ path: PHONE_SHOTS("3-step3"), fullPage: true });
    return (await interimCount(pv)) === 2;
  });
  await check("V5 a document issued while confirming → 409: 'nothing changed' + the new number (3), nothing written; confirm again → success", async () => {
    let confirmBody: Record<string, unknown> | null = null;
    let once = true;
    await pv.route(/\/api\/business\/legal-identity\/kind-transition$/, async (route) => {
      if (route.request().method() === "POST") {
        confirmBody = JSON.parse(route.request().postData() ?? "{}");
        if (once) { once = false; await seedDoc(v, "RECEIPT", null); } // issued between "seen" and "confirmed"
      }
      await route.continue();
    });
    await pv.getByTestId("kt-confirm").click();
    await pv.getByTestId("kt-confirm-error").waitFor({ timeout: 30_000 });
    const msg = await pv.getByTestId("kt-confirm-error").innerText();
    const sentFirst = (confirmBody as Record<string, unknown> | null)?.interimDocumentCount;
    await pv.waitForFunction(() => document.querySelector('[data-testid="kt-interim"]')?.getAttribute("data-count") === "3", null, { timeout: 30_000 });
    await pv.screenshot({ path: PHONE_SHOTS("4-changed-409"), fullPage: true });
    const nothing = (await history(v.businessId)).length === 0 && (await kind(v.businessId)) === "EXEMPT_DEALER";
    await pv.getByTestId("kt-confirm").click();
    await pv.getByTestId("kt-success").waitFor({ timeout: 30_000 });
    const sentSecond = (confirmBody as Record<string, unknown> | null)?.interimDocumentCount;
    return sentFirst === 2 && msg.includes("הופקו 3 מסמכים") && msg.includes("שום דבר לא השתנה") && nothing && sentSecond === 3
      && (await kind(v.businessId)) === "AUTHORIZED_DEALER";
  });
  await check("V6 success: the number from the history row (asked without a date), the list from the record", async () => {
    await pv.getByTestId("kt-interim").waitFor({ timeout: 30_000 });
    const n = await interimCount(pv);
    await pv.screenshot({ path: PHONE_SHOTS("5-success"), fullPage: true });
    await pv.getByTestId("kt-interim-list-open").click();
    await pv.getByTestId("kt-interim-item").nth(2).waitFor({ timeout: 30_000 });
    const rows = await pv.getByTestId("kt-interim-item").count();
    await pv.getByTestId("kt-interim-close").click();
    return n === 3 && rows === 3 && asked.some((q) => q === "") && asked.some((q) => q === "?list=1");
  });
  await check("V7 the success screen at 320 wide: no side scroll", async () => { await pv.setViewportSize({ width: 320, height: 700 }); const r = await noSideScroll(pv); await pv.setViewportSize(PHONE); return r; });
  await ctxV.close();

  const z = await business();
  const ctxZ = await ctxFor(browser, z, PHONE);
  const pz = await ctxZ.newPage(); current = pz;
  await check("V8 zero documents: 'לא הופקו מסמכים' on step 1 (early date); today → nothing shown; the route failing → an error with a retry, confirm stays off", async () => {
    await pz.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pz.getByTestId("kt-date").fill(EARLY);
    await pz.getByTestId("kt-interim").waitFor({ timeout: 60_000 });
    const none = (await pz.getByTestId("kt-interim").innerText()).includes("לא הופקו מסמכים") && (await interimCount(pz)) === 0;
    await pz.screenshot({ path: PHONE_SHOTS("6-zero"), fullPage: true });
    await pz.getByTestId("kt-date").fill(TODAY);
    await pz.waitForTimeout(1500);
    const todayHidden = (await pz.getByTestId("kt-interim").count()) === 0;
    let fail = true;
    await pz.route(/interim-documents/, (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"INTERIM_DOCUMENTS_FAILED"}' }) : route.continue()));
    await pz.getByTestId("kt-date").fill(EARLY);
    await pz.getByTestId("kt-interim-error").waitFor({ timeout: 30_000 });
    await pz.getByTestId("kt-step1-next").click();
    await pz.getByTestId("kt-tax").fill(z.taxId);
    await pz.getByTestId("kt-password").fill(PASSWORD);
    await pz.getByTestId("kt-step2-next").click();
    await pz.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
    await tickAll(pz);
    await pz.getByTestId("kt-interim-error").waitFor({ timeout: 30_000 });
    const off = await pz.getByTestId("kt-confirm").isDisabled();
    await pz.screenshot({ path: PHONE_SHOTS("7-route-error"), fullPage: true });
    fail = false;
    await pz.getByTestId("kt-interim-retry").click();
    await pz.getByTestId("kt-interim").waitFor({ timeout: 30_000 });
    const on = await pz.getByTestId("kt-confirm").isEnabled();
    return none && todayHidden && off && on;
  });
  await ctxZ.close();

  const many = await business();
  for (let i = 0; i < 60; i++) await seedDoc(many, i % 3 ? "RECEIPT" : "TAX_INVOICE", addDays(TODAY, -1 - (i % 15)), { total: String(100 + i) + ".00" });
  const ctxN = await ctxFor(browser, many, PHONE);
  const pn = await ctxN.newPage(); current = pn;
  await check("V9 60 documents: the list shows 50, 'more' loads the other 10, each once", async () => {
    await pn.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pn.getByTestId("kt-date").fill(EARLY);
    await pn.getByTestId("kt-interim").waitFor({ timeout: 60_000 });
    await pn.getByTestId("kt-interim-list-open").click();
    await pn.getByTestId("kt-interim-item").nth(49).waitFor({ timeout: 30_000 });
    const first = await pn.getByTestId("kt-interim-item").count();
    await pn.getByTestId("kt-interim-more").click();
    await pn.getByTestId("kt-interim-item").nth(59).waitFor({ timeout: 30_000 });
    const all = await pn.getByTestId("kt-interim-item").count();
    const moreGone = (await pn.getByTestId("kt-interim-more").count()) === 0;
    await pn.screenshot({ path: PHONE_SHOTS("8-list-60"), fullPage: false });
    return (await interimCount(pn)) === 60 && first === 50 && all === 60 && moreGone;
  });
  await ctxN.close();
  await browser.close();

  // ── U14: WebKit, iPhone-sized viewport ──
  const wk = await webkit.launch();
  const w = await business();
  const ctxW = await ctxFor(wk, w, PHONE);
  const pw = await ctxW.newPage(); current = pw;
  await check("U14 WebKit (iPhone-sized viewport, emulation): the whole flow to success", async () => {
    await toStep3(pw, w);
    await tickAll(pw);
    await pw.getByTestId("kt-confirm").click();
    await pw.getByTestId("kt-success").waitFor({ timeout: 30_000 });
    await pw.screenshot({ path: join(OUT, "webkit-success.png"), fullPage: true });
    return (await kind(w.businessId)) === "AUTHORIZED_DEALER";
  });
  await ctxW.close();
  await wk.close();

  // The password re-auth shares the login limit (10 per minute per IP, as login): every flow here re-authenticates
  // from the same address, so let the window clear (a 429 here is the product working, not a failure of the screen).
  await new Promise((res) => setTimeout(res, 61_000));
  // ── U15: failure mid-process, then a retry ──
  const cr = await chromium.launch();
  const r = await business();
  const ctxR = await ctxFor(cr, r, PHONE);
  const pr = await ctxR.newPage(); current = pr;
  const CONFIRM_URL = /\/api\/business\/legal-identity\/kind-transition$/;
  let mode: "500" | "abort" | "pass" = "500";
  await pr.route(CONFIRM_URL, async (route) => {
    if (route.request().method() !== "POST" || mode === "pass") return route.continue();
    if (mode === "abort") return route.abort("internetdisconnected");
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "SERVER_ERROR", error: "x" }) });
  });
  await check("U15a the confirm call answers 500 → 'nothing changed', still step 3, confirmations kept, nothing written", async () => {
    await toStep3(pr, r);
    await tickAll(pr);
    await pr.getByTestId("kt-confirm").click();
    await pr.getByTestId("kt-confirm-error").waitFor({ timeout: 30_000 });
    const msg = await pr.getByTestId("kt-confirm-error").innerText();
    const kept = await pr.getByTestId("kt-confirm").isEnabled();
    return msg.includes("שום דבר לא השתנה") && kept && (await history(r.businessId)).length === 0 && (await kind(r.businessId)) === "EXEMPT_DEALER";
  });
  await check("U15b the network drops on confirm → the same message, nothing written", async () => {
    mode = "abort";
    await pr.getByTestId("kt-confirm").click();
    await pr.getByTestId("kt-confirm-error").waitFor({ timeout: 30_000 });
    return (await pr.getByTestId("kt-confirm-error").innerText()).includes("שום דבר לא השתנה") && (await history(r.businessId)).length === 0;
  });
  await check("U15c the retry → success, exactly one history row", async () => {
    mode = "pass";
    await pr.getByTestId("kt-confirm").click();
    await pr.getByTestId("kt-success").waitFor({ timeout: 30_000 });
    return (await history(r.businessId)).length === 1 && (await kind(r.businessId)) === "AUTHORIZED_DEALER";
  });
  await ctxR.close();

  // ── U16: cancel ──
  const c = await business();
  const ctxC = await ctxFor(cr, c, PHONE);
  const pc = await ctxC.newPage(); current = pc;
  await check("U16 cancel on step 3 → the business screen, nothing written, the action still there; the flow again starts empty", async () => {
    await toStep3(pc, c);
    await tickAll(pc);
    await pc.getByTestId("kt-cancel").click();
    await pc.waitForURL(/\/business$/, { timeout: 30_000 });
    await pc.getByTestId("kt-entry-action").waitFor({ timeout: 60_000 });
    await pc.goto(`${BASE}/business/legal-identity/kind-transition`);
    await pc.getByTestId("kt-date").waitFor({ timeout: 60_000 });
    const dateEmpty = (await pc.getByTestId("kt-date").inputValue()) === "";
    return dateEmpty && (await history(c.businessId)).length === 0 && (await kind(c.businessId)) === "EXEMPT_DEALER";
  });
  await ctxC.close();

  // ── U17: screen widths ──
  async function widths(br: Browser, engine: string, sizes: { width: number; height: number }[]) {
    for (const vp of sizes) {
      const b = await business();
      const ctx = await ctxFor(br, b, vp);
      const pg = await ctx.newPage(); current = pg;
      await check(`U17 ${engine} ${vp.width}×${vp.height}: no side scroll on steps 1–3 and success; RTL`, async () => {
        const bad: string[] = [];
        await pg.goto(`${BASE}/business/legal-identity/kind-transition`);
        await pg.getByTestId("kt-date").waitFor({ timeout: 60_000 });
        if ((await pg.evaluate(() => getComputedStyle(document.body).direction)) !== "rtl") bad.push("not rtl");
        if (!(await noSideScroll(pg))) bad.push("step1");
        await pg.getByTestId("kt-date").fill(EARLY);
        await pg.getByTestId("kt-step1-next").click();
        await pg.getByTestId("kt-tax").waitFor();
        if (!(await noSideScroll(pg))) bad.push("step2");
        await pg.getByTestId("kt-tax").fill(b.taxId);
        await pg.getByTestId("kt-password").fill(PASSWORD);
        await pg.getByTestId("kt-step2-next").click();
        await pg.getByRole("heading", { name: "בדיקה ואישור" }).waitFor({ timeout: 30_000 });
        await tickAll(pg);
        if (!(await noSideScroll(pg))) bad.push("step3");
        await pg.getByTestId("kt-confirm").click();
        await pg.getByTestId("kt-success").waitFor({ timeout: 30_000 });
        if (!(await noSideScroll(pg))) bad.push("success");
        await pg.screenshot({ path: join(OUT, `width-${engine}-${vp.width}.png`), fullPage: true });
        if (bad.length) throw new Error(bad.join(", "));
        return true;
      });
      await ctx.close();
    }
  }
  await widths(cr, "chromium", [{ width: 360, height: 800 }, { width: 412, height: 915 }]);
  await cr.close();
  // The password re-auth shares the login limit (10 per minute per IP, as login): every flow here re-authenticates
  // from the same address, so let the window clear (a 429 here is the product working, not a failure of the screen).
  await new Promise((res) => setTimeout(res, 61_000));
  const wk2 = await webkit.launch();
  await widths(wk2, "webkit", [{ width: 375, height: 667 }, { width: 430, height: 932 }]);
  await wk2.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => owner.$disconnect());
