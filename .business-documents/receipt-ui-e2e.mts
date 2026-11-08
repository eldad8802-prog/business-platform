/**
 * Receipt screen — the REAL app in a browser (`next build` + `next start` over the business-documents lab), desktop and
 * phone. Synthetic only; no Production, no Preview, no secrets, no network beyond localhost.
 *
 * What the screen must do (owner, 2026-11-09): issue, show an error, and retry after a disconnect — and a retry must
 * never produce a second receipt. Every money scenario ends with a COUNT in the database (owner connection, read only):
 * exactly one more ISSUED receipt per scenario, never two.
 *
 *   E1  consolidated receipt: one payment, two invoices (auto allocation), issued; invoices' remaining checked
 *   E2  server error on the payment lines → error shown, nothing issued → retry → exactly one
 *   E3  the issue answer is lost after the server issued → the screen asks the document → done, exactly one
 *   E4  the answer AND the status check are lost → error → retry asks first → shows the issued one, exactly one
 *   E5  offline at the moment of issuing → error → back online → retry → exactly one
 *   E6  double click on "הפקת הקבלה" → exactly one
 *   R1  answer + status check lost → page REFRESHED → the issued one is found, exactly one (desktop)
 *   R2  server error → page CLOSED and REOPENED → the same draft is continued, exactly one, no second draft (desktop)
 *   P1  phone 390px: bank transfer, RTL, no side scroll, issued, exactly one
 *   R3  as R1, on the phone
 *   N1  back control → "מסמכים נוספים";  N2 business without the feature → the "not open" notice
 *   F1  the PDF of an issued receipt downloads through the existing route
 *
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3710";
const OUT = process.env.OUT ?? "/tmp/bd-receipt-ui";
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as { tokenA: string; tokenB: string; bizA: number; bizB: number; customer: number; customer2: number; invoices: number[] };
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
    const detail = e instanceof Error ? e.message.split("\n")[0].slice(0, 220) : String(e);
    rows.push({ name, ok: false, detail });
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`), fullPage: true }).catch(() => undefined);
    console.log(`  [FAIL] ${name} — ${detail}`);
  }
}

type Size = { width: number; height: number; phone: boolean };
const DESKTOP: Size = { width: 1440, height: 900, phone: false };
const PHONE: Size = { width: 390, height: 844, phone: true };

async function ctx(browser: Browser, token: string, size: Size): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: size.width, height: size.height },
    acceptDownloads: true,
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const issuedReceipts = () => owner.billingDocument.count({ where: { businessId: seed.bizA, documentType: "RECEIPT", status: "ISSUED" } });
const allReceipts = () => owner.billingDocument.count({ where: { businessId: seed.bizA, documentType: "RECEIPT" } });
const ISSUE = /\/api\/billing\/documents\/\d+\/issue$/;
const PAYMENTS = /\/api\/billing\/documents\/\d+\/payments$/;
const DOC = /\/api\/billing\/documents\/\d+$/;

async function open(page: Page) {
  await page.goto("/business-documents/receipts/new");
  await page.getByRole("heading", { name: "קבלה חדשה" }).waitFor({ timeout: 30_000 });
  await page.locator("#rc-customer option").nth(1).waitFor({ state: "attached", timeout: 20_000 });
}
async function fill(page: Page, customerId: number, amount: string) {
  await page.locator("#rc-customer").selectOption(String(customerId));
  await page.locator("#rc-0-amount").fill(amount);
}
async function review(page: Page) {
  await page.getByRole("button", { name: "בדיקה לפני הפקה" }).click();
  await page.getByRole("button", { name: "הפקת הקבלה" }).waitFor({ timeout: 10_000 });
}
async function issue(page: Page) {
  await page.getByRole("button", { name: "הפקת הקבלה" }).click();
}
const done = (page: Page) => page.getByRole("heading", { name: "הקבלה הופקה" }).waitFor({ timeout: 30_000 });
const failed = (page: Page) => page.getByText("הקבלה לא הופקה").first().waitFor({ timeout: 30_000 });

async function main() {
  const browser = await chromium.launch();

  console.log("desktop · business_documents ON");
  const dc = await ctx(browser, seed.tokenA, DESKTOP);
  let p = await dc.newPage();
  current = p;

  await check("E1 consolidated receipt — one payment over two invoices, issued once; remaining 0 and 360.00", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer, "2000");
    await p.getByRole("button", { name: "שיוך אוטומטי (מהישנה לחדשה)" }).waitFor({ timeout: 20_000 });
    await p.getByRole("button", { name: "שיוך אוטומטי (מהישנה לחדשה)" }).click();
    await p.getByText("קבלה מרכזת", { exact: false }).last().waitFor();
    await shot(p, "e1-consolidated-form");
    await review(p);
    await issue(p);
    await done(p);
    await shot(p, "e1-issued");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued receipts ${before} → ${after}`);
    const allocs = await owner.billingPaymentAllocation.findMany({ where: { invoiceDocumentId: { in: seed.invoices } }, select: { invoiceDocumentId: true, allocatedAmount: true } });
    const by = new Map(allocs.map((a) => [a.invoiceDocumentId, Number(a.allocatedAmount)]));
    if (by.get(seed.invoices[0]) !== 1180 || by.get(seed.invoices[1]) !== 820) throw new Error(`allocations ${JSON.stringify([...by])}`);
  });

  await check("F0 the existing billing PDF route answers for the issued receipt (status + body, for diagnosis)", async () => {
    const last = await owner.billingDocument.findFirst({ where: { businessId: seed.bizA, documentType: "RECEIPT", status: "ISSUED" }, orderBy: { id: "desc" }, select: { id: true } });
    const r = await fetch(`${BASE}/api/billing/documents/${last!.id}/pdf`, { headers: { authorization: `Bearer ${seed.tokenA}` } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || buf.subarray(0, 5).toString() !== "%PDF-") throw new Error(`status ${r.status}: ${buf.subarray(0, 300).toString()}`);
  });

  await check("F1 the PDF of the issued receipt downloads (existing billing PDF route)", async () => {
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60_000 }), p.getByRole("button", { name: "הורדת PDF" }).click()]);
    const path = await dl.path();
    const bytes = path ? readFileSync(path) : Buffer.alloc(0);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error(`not a PDF (${bytes.length} bytes)`);
  });

  await check("E2 server error on the payment lines → error, nothing issued → retry → exactly one, on the same draft", async () => {
    const issued0 = await issuedReceipts();
    const all0 = await allReceipts();
    await open(p);
    await fill(p, seed.customer2, "100");
    let fail = true;
    await p.route(PAYMENTS, (route) => (fail ? ((fail = false), route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Internal Server Error"}' })) : route.continue()));
    await review(p);
    await issue(p);
    await failed(p);
    await shot(p, "e2-error");
    if ((await issuedReceipts()) !== issued0) throw new Error("issued after an error");
    await review(p);
    await issue(p);
    await done(p);
    await p.unroute(PAYMENTS);
    const issued1 = await issuedReceipts();
    const all1 = await allReceipts();
    if (issued1 !== issued0 + 1) throw new Error(`issued ${issued0} → ${issued1}`);
    if (all1 !== all0 + 1) throw new Error(`receipt documents ${all0} → ${all1} (the retry made a new draft)`);
  });

  await check("E3 the issue answer is lost after the server issued → the screen reads the document → done, exactly one", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer2, "50");
    await p.route(ISSUE, async (route) => {
      await route.fetch(); // the server issues
      await route.abort("connectionreset"); // the browser never hears it
    });
    await review(p);
    await issue(p);
    await done(p);
    await p.unroute(ISSUE);
    await shot(p, "e3-lost-answer-done");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
  });

  await check("E4 the answer AND the status check are lost → 'unknown' notice, not 'not issued' → retry asks first → the issued one, exactly one", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer2, "60");
    await p.route(ISSUE, async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    let dropCheck = true;
    await p.route(DOC, (route) => (route.request().method() === "GET" && dropCheck ? ((dropCheck = false), route.abort("connectionreset")) : route.continue()));
    await review(p);
    await issue(p);
    await p.getByText("לא ברור אם הקבלה הופקה").first().waitFor({ timeout: 30_000 });
    await shot(p, "e4-unknown-outcome");
    await p.unroute(ISSUE);
    await p.unroute(DOC);
    if ((await issuedReceipts()) !== before + 1) throw new Error("the server should have issued once already");
    await review(p);
    await issue(p);
    await done(p);
    await shot(p, "e4-retry-shows-issued");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after} (a retry issued a second receipt)`);
  });

  await check("E5 offline at the moment of issuing → error → online → retry → exactly one", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer2, "70");
    await review(p);
    await dc.setOffline(true);
    await issue(p);
    await failed(p);
    await p.getByText("אין חיבור").first().waitFor();
    await shot(p, "e5-offline");
    await dc.setOffline(false);
    if ((await issuedReceipts()) !== before) throw new Error("issued while offline");
    await review(p);
    await issue(p);
    await done(p);
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
  });

  await check("E6 double click on the issue button → exactly one", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer2, "80");
    await review(p);
    await p.getByRole("button", { name: "הפקת הקבלה" }).dblclick();
    await done(p);
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
  });

  await check("E7 the screen refuses an allocation above the invoice's remaining before sending anything", async () => {
    const all0 = await allReceipts();
    await open(p);
    await fill(p, seed.customer, "999");
    const remaining = p.getByLabel(/סכום לחשבונית/).last();
    await remaining.waitFor({ timeout: 20_000 });
    await remaining.fill("999");
    await p.getByRole("button", { name: "בדיקה לפני הפקה" }).click();
    await p.getByText("יותר מהיתרה הפתוחה").first().waitFor();
    await shot(p, "e7-over-remaining");
    if ((await allReceipts()) !== all0) throw new Error("a draft was created");
  });

await check("R1 desktop: answer AND status check lost → page REFRESHED → the screen finds the issued receipt, exactly one", async () => {
    const before = await issuedReceipts();
    await open(p);
    await fill(p, seed.customer2, "90");
    await p.route(ISSUE, async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    let dropCheck = true;
    await p.route(DOC, (route) => (route.request().method() === "GET" && dropCheck ? ((dropCheck = false), route.abort("connectionreset")) : route.continue()));
    await review(p);
    await issue(p);
    await p.getByText("לא ברור אם הקבלה הופקה").first().waitFor({ timeout: 30_000 });
    await p.unroute(ISSUE);
    await p.unroute(DOC);
    await p.reload();
    await p.getByText("הקבלה מהניסיון הקודם כבר הופקה").waitFor({ timeout: 30_000 });
    await shot(p, "r1-after-refresh");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
  });

  await check("R2 desktop: server error → page CLOSED and REOPENED → the draft is continued, exactly one, no second draft", async () => {
    const issued0 = await issuedReceipts();
    const all0 = await allReceipts();
    await open(p);
    await fill(p, seed.customer2, "95");
    await p.route(PAYMENTS, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Internal Server Error"}' }));
    await review(p);
    await issue(p);
    await failed(p);
    await p.unroute(PAYMENTS);
    await p.close();
    const p2 = await dc.newPage();
    current = p2;
    await p2.goto("/business-documents/receipts/new");
    await p2.getByText("יש טיוטת קבלה מניסיון קודם").waitFor({ timeout: 30_000 });
    if ((await p2.locator("#rc-customer").inputValue()) !== String(seed.customer2)) throw new Error("customer not restored");
    await p2.locator("#rc-0-amount").fill("95");
    await review(p2);
    await issue(p2);
    await done(p2);
    await shot(p2, "r2-after-reopen");
    const issued1 = await issuedReceipts();
    const all1 = await allReceipts();
    if (issued1 !== issued0 + 1) throw new Error(`issued ${issued0} → ${issued1}`);
    if (all1 !== all0 + 1) throw new Error(`receipt documents ${all0} → ${all1} (the reopened page made a new draft)`);
    p = p2;
  });

  await check("N1 the back control leads to מסמכים נוספים", async () => {
    await p.goto("/business-documents");
    await p.getByRole("link", { name: /קבלה חדשה/ }).click();
    await p.getByRole("heading", { name: "קבלה חדשה" }).waitFor({ timeout: 20_000 });
    await p.getByRole("button", { name: /חזרה|למסמכים נוספים/ }).first().click();
    await p.waitForURL(/\/business-documents$/, { timeout: 15_000 });
  });
  await dc.close();

  console.log("phone 390 · business_documents ON");
  const pc = await ctx(browser, seed.tokenA, PHONE);
  const pp = await pc.newPage();
  current = pp;
  await check("P1 phone: bank transfer, RTL, no side scroll, issued once", async () => {
    const before = await issuedReceipts();
    await open(pp);
    if ((await pp.evaluate(() => document.documentElement.dir)) !== "rtl") throw new Error("not RTL");
    await fill(pp, seed.customer2, "120.5");
    await pp.locator("#rc-0-method").selectOption("BANK_TRANSFER");
    await pp.locator("#rc-0-bankName").fill("12");
    await pp.locator("#rc-0-bankBranch").fill("600");
    await pp.locator("#rc-0-bankAccountNumber").fill("778899");
    const width = await pp.evaluate(() => document.documentElement.scrollWidth);
    if (width > PHONE.width) throw new Error(`page is ${width}px wide at ${PHONE.width}px`);
    await shot(pp, "p1-phone-form");
    await review(pp);
    await issue(pp);
    await done(pp);
    await shot(pp, "p1-phone-issued");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
    const last = await owner.billingDocument.findFirst({ where: { businessId: seed.bizA, documentType: "RECEIPT", status: "ISSUED" }, orderBy: { id: "desc" }, select: { id: true } });
    const pay = await owner.billingReceiptPayment.findMany({ where: { billingDocumentId: last!.id } });
    if (pay.length !== 1 || pay[0].method !== "BANK_TRANSFER" || pay[0].bankAccountNumber !== "778899" || pay[0].currency !== "ILS") throw new Error(JSON.stringify(pay));
  });
await check("R3 phone: answer AND status check lost → page REFRESHED → the issued receipt is shown, exactly one", async () => {
    const before = await issuedReceipts();
    await open(pp);
    await fill(pp, seed.customer2, "33");
    await pp.route(ISSUE, async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    let dropCheck = true;
    await pp.route(DOC, (route) => (route.request().method() === "GET" && dropCheck ? ((dropCheck = false), route.abort("connectionreset")) : route.continue()));
    await review(pp);
    await issue(pp);
    await pp.getByText("לא ברור אם הקבלה הופקה").first().waitFor({ timeout: 30_000 });
    await pp.unroute(ISSUE);
    await pp.unroute(DOC);
    await pp.reload();
    await pp.getByText("הקבלה מהניסיון הקודם כבר הופקה").waitFor({ timeout: 30_000 });
    await shot(pp, "r3-phone-after-refresh");
    const after = await issuedReceipts();
    if (after !== before + 1) throw new Error(`issued ${before} → ${after}`);
  });

  await pc.close();

  console.log("desktop · business without the feature");
  const bc = await ctx(browser, seed.tokenB, DESKTOP);
  const bp = await bc.newPage();
  current = bp;
  await check("N2 a business without business_documents sees the 'not open' notice", async () => {
    await bp.goto("/business-documents/receipts/new");
    await bp.getByText("המסך הזה עדיין לא פתוח לעסק").waitFor({ timeout: 30_000 });
    await shot(bp, "n2-feature-off");
  });
  await bc.close();

  await browser.close();

  // The final ledger: every ISSUED receipt of business A, one per successful scenario (E1–E6, R1, R2, P1, R3 = 10).
  await check("L1 the database holds exactly 10 issued receipts for business A — one per scenario, none twice", async () => {
    const n = await issuedReceipts();
    if (n !== 10) throw new Error(`issued receipts: ${n}`);
  });

  const bad = rows.filter((r) => !r.ok);
  const md = [
    "## Receipt screen — end to end (real app, PG lab, desktop + phone)",
    "",
    `${rows.length - bad.length} passed, ${bad.length} failed`,
    "",
    "| check | result |",
    "|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.ok ? "PASS" : `FAIL — ${r.detail.replace(/\|/g, "\\|")}`} |`),
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md);
  console.log(`\n${rows.length - bad.length} passed, ${bad.length} failed`);
  if (bad.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
