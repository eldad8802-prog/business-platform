/**
 * Purchase-order sheet — the app in a browser on the supplier order's send screen, desktop and phone, Hebrew and
 * English, flag ON and OFF. Synthetic only; no Production, no Preview, no secrets, no network beyond localhost.
 *
 * LAB NOTE: the app runs as `next dev` here: saving writes the PDF to storage, lib/storage refuses local storage in
 * production mode, and R2 cannot point at a lab server. Every route, guard and query is the same code.
 *
 *   U1 save → "העותק נשמר.", the copy is listed, one row in the database
 *   U2 the downloaded file is byte-identical to the stored file (and to the recorded digest)
 *   U3 double click on "שמירת עותק" → one copy
 *   U4 server error → error shown, nothing saved → retry → one copy
 *   U5 the answer is lost after the server saved → retry reuses the key → the same copy, not a second
 *   U6 editing the supplier order after saving changes neither the stored file nor the listed details
 *   U7 the existing sharing still works: WhatsApp / mail / copy present, "הורדת PDF" downloads a PDF; status unchanged
 *   E1 English interface → the copy carries the English header the screen prints
 *   P1 phone 390: save, list, download; no side scroll
 *   F1 business without the feature: the screen renders, the panel does not; F2 its API answers 404
 *   L1 the database holds exactly the copies the scenarios made
 *
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL, DATABASE_URL (runtime), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3720";
const OUT = process.env.OUT ?? "/tmp/bd-po-ui";
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as { tokenA: string; tokenB: string; bizA: number; bizB: number; orderA: number; orderB: number };
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
async function ctx(browser: Browser, token: string, size: Size, locale: "he" | "en" = "he"): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE,
    locale: locale === "he" ? "he-IL" : "en-US",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: size.width, height: size.height },
    acceptDownloads: true,
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await c.addCookies([{ name: "dz_locale", value: locale, url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SHEETS = /\/api\/business-documents\/supplier-orders\/\d+\/sheets$/;
const copiesOf = (order: number) => owner.purchaseOrderSheet.count({ where: { supplierPurchaseDraftId: order } });
const newest = (order: number) => owner.purchaseOrderSheet.findFirstOrThrow({ where: { supplierPurchaseDraftId: order }, orderBy: { id: "desc" } });
async function stored(sheetId: number): Promise<Buffer> {
  const { readCommittedFile } = await import("@/lib/services/business-documents/files/business-docs-files");
  const s = await owner.purchaseOrderSheet.findUniqueOrThrow({ where: { id: sheetId }, select: { businessId: true, fileId: true } });
  return readCommittedFile(s.businessId, s.fileId);
}
async function open(p: Page, order: number) {
  await p.goto(`/inventory/supplier-purchases/${order}/send`);
  await p.getByText(`הזמנה ${order}`).first().waitFor({ timeout: 120_000 });
}
const saveButton = (p: Page) => p.getByRole("button", { name: "שמירת עותק" });
/** Waits until the list shows exactly n saved copies. */
async function listed(p: Page, n: number) {
  await p.waitForFunction((want) => document.querySelectorAll('button[aria-label^="הורדת העותק שנשמר"]').length === want, n, { timeout: 60_000 });
}
async function downloadRow(p: Page, index = 0): Promise<Buffer> {
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60_000 }), p.getByRole("button", { name: /הורדת העותק שנשמר/ }).nth(index).click()]);
  const path = await dl.path();
  return path ? readFileSync(path) : Buffer.alloc(0);
}

async function main() {
  const browser = await chromium.launch();
  let made = 0;

  console.log("desktop · Hebrew · business_documents ON");
  const dc = await ctx(browser, seed.tokenA, DESKTOP);
  const p = await dc.newPage();
  current = p;

  let firstId = 0;
  let firstSha = "";
  await check("U1 save a copy → saved message, listed, one row in the database", async () => {
    await open(p, seed.orderA);
    await saveButton(p).waitFor({ timeout: 60_000 });
    await shot(p, "u1-panel");
    await saveButton(p).click();
    await p.getByText("העותק נשמר.").waitFor({ timeout: 60_000 });
    await listed(p, 1);
    made++;
    if ((await copiesOf(seed.orderA)) !== made) throw new Error(`copies ${await copiesOf(seed.orderA)}`);
    firstId = (await newest(seed.orderA)).id;
    await shot(p, "u1-saved");
  });

  await check("U2 the downloaded file is byte-identical to the stored file and its recorded digest", async () => {
    const got = await downloadRow(p, 0);
    const disk = await stored(firstId);
    const rec = (await owner.purchaseOrderSheet.findUniqueOrThrow({ where: { id: firstId } })).sha256;
    firstSha = sha(got);
    if (got.subarray(0, 5).toString() !== "%PDF-" || firstSha !== sha(disk) || firstSha !== rec) throw new Error(`downloaded ${firstSha} stored ${sha(disk)} recorded ${rec}`);
  });

  await check("U3 double click on 'שמירת עותק' → exactly one more copy", async () => {
    const before = await copiesOf(seed.orderA);
    await saveButton(p).dblclick();
    await listed(p, before + 1);
    await p.waitForTimeout(2000); // a second save, if one had started, has time to land
    made++;
    if ((await copiesOf(seed.orderA)) !== before + 1) throw new Error(`copies ${before} → ${await copiesOf(seed.orderA)}`);
  });

  await check("U4 server error → error shown, nothing saved → retry → one copy", async () => {
    const before = await copiesOf(seed.orderA);
    let fail = true;
    await p.route(SHEETS, (route) => (route.request().method() === "POST" && fail ? ((fail = false), route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Internal Server Error"}' })) : route.continue()));
    await saveButton(p).click();
    await p.getByText(/שמירת העותק נכשלה/).waitFor({ timeout: 60_000 });
    await shot(p, "u4-error");
    if ((await copiesOf(seed.orderA)) !== before) throw new Error("saved despite the error");
    await saveButton(p).click();
    await p.getByText("העותק נשמר.").waitFor({ timeout: 60_000 });
    await p.unroute(SHEETS);
    made++;
    if ((await copiesOf(seed.orderA)) !== before + 1) throw new Error(`copies ${before} → ${await copiesOf(seed.orderA)}`);
  });

  await check("U5 the answer is lost after the server saved → retry reuses the key → the same copy, not a second", async () => {
    const before = await copiesOf(seed.orderA);
    let drop = true;
    await p.route(SHEETS, async (route) => {
      if (route.request().method() === "POST" && drop) {
        drop = false;
        await route.fetch(); // the server saves
        await route.abort("connectionreset"); // the browser never hears it
      } else await route.continue();
    });
    await saveButton(p).click();
    await p.getByText(/שמירת העותק נכשלה/).waitFor({ timeout: 60_000 });
    if ((await copiesOf(seed.orderA)) !== before + 1) throw new Error("the server should have saved once");
    const savedId = (await newest(seed.orderA)).id;
    await saveButton(p).click();
    await p.getByText("העותק נשמר.").waitFor({ timeout: 60_000 });
    await p.unroute(SHEETS);
    made++;
    if ((await copiesOf(seed.orderA)) !== before + 1 || (await newest(seed.orderA)).id !== savedId) throw new Error(`copies ${before} → ${await copiesOf(seed.orderA)} (a retry saved a second copy)`);
  });

  await check("U6 editing the order after saving changes neither the stored file nor the listed details", async () => {
    await owner.supplierPurchaseDraft.update({ where: { id: seed.orderA }, data: { supplierName: "ספק אחר", externalOrderId: "Z-9" } });
    await open(p, seed.orderA);
    await p.getByText(/עותק שנשמר ב־/).first().waitFor({ timeout: 60_000 });
    const rowsCount = await p.getByRole("button", { name: /הורדת העותק שנשמר/ }).count();
    const got = await downloadRow(p, rowsCount - 1); // the oldest copy is listed last
    if (sha(got) !== firstSha) throw new Error(`first copy changed: ${sha(got)} ≠ ${firstSha}`);
    if ((await owner.purchaseOrderSheet.findUniqueOrThrow({ where: { id: firstId } })).externalNumberSnapshot !== "A-100") throw new Error("snapshot changed");
    await shot(p, "u6-after-edit");
  });

  await check("U7 the existing sharing still works: WhatsApp / mail / copy present, 'הורדת PDF' downloads a PDF, status unchanged", async () => {
    for (const name of ["וואטסאפ", "מייל", "העתקה"]) await p.getByRole("button", { name }).first().waitFor({ timeout: 20_000 });
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60_000 }), p.getByRole("button", { name: /הורדת PDF/ }).first().click()]);
    const path = await dl.path();
    const bytes = path ? readFileSync(path) : Buffer.alloc(0);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error(`existing download not a PDF (${bytes.length} bytes)`);
    const o = await owner.supplierPurchaseDraft.findUniqueOrThrow({ where: { id: seed.orderA }, select: { status: true } });
    if (o.status !== "PENDING_REVIEW") throw new Error(`status ${o.status}`);
    if ((await owner.purchaseOrder.count({ where: { businessId: seed.bizA } })) !== 0) throw new Error("a purchase order was created");
  });
  await dc.close();

  console.log("desktop · English interface");
  const ec = await ctx(browser, seed.tokenA, DESKTOP, "en");
  const pe = await ec.newPage();
  current = pe;
  await check("E1 English interface → the saved copy carries the English header the screen prints", async () => {
    await open(pe, seed.orderA);
    const before = await copiesOf(seed.orderA);
    await saveButton(pe).click();
    await pe.getByText("העותק נשמר.").waitFor({ timeout: 60_000 });
    made++;
    const r = await newest(seed.orderA);
    if ((await copiesOf(seed.orderA)) !== before + 1 || r.locale !== "en" || r.headerTitleSnapshot !== "Inventory · Dubiz") throw new Error(`${r.locale} / ${r.headerTitleSnapshot}`);
    await shot(pe, "e1-english");
  });
  await ec.close();

  console.log("phone 390 · Hebrew");
  const pc = await ctx(browser, seed.tokenA, PHONE);
  const pp = await pc.newPage();
  current = pp;
  await check("P1 phone: save, listed, download; no side scroll", async () => {
    await open(pp, seed.orderA);
    const before = await copiesOf(seed.orderA);
    await saveButton(pp).click();
    await pp.getByText("העותק נשמר.").waitFor({ timeout: 60_000 });
    made++;
    const width = await pp.evaluate(() => document.documentElement.scrollWidth);
    if (width > PHONE.width) throw new Error(`page is ${width}px wide`);
    const got = await downloadRow(pp, 0);
    const r = await newest(seed.orderA);
    if ((await copiesOf(seed.orderA)) !== before + 1 || sha(got) !== r.sha256) throw new Error("phone save/download mismatch");
    await shot(pp, "p1-phone");
  });
  await pc.close();

  console.log("desktop · business without the feature");
  const bc = await ctx(browser, seed.tokenB, DESKTOP);
  const pb = await bc.newPage();
  current = pb;
  await check("F1 without business_documents the send screen renders and the panel does not", async () => {
    await open(pb, seed.orderB);
    await pb.getByRole("button", { name: /הורדת PDF/ }).first().waitFor({ timeout: 30_000 });
    await pb.waitForTimeout(3000); // the feature state has time to load
    if ((await saveButton(pb).count()) !== 0 || (await pb.getByText("עותקים שמורים").count()) !== 0) throw new Error("the panel is shown with the feature off");
    await shot(pb, "f1-flag-off");
  });
  await check("F2 its API answers 404 (flag off), and nothing is saved", async () => {
    const r = await fetch(`${BASE}/api/business-documents/supplier-orders/${seed.orderB}/sheets`, { headers: { authorization: `Bearer ${seed.tokenB}` } });
    if (r.status !== 404 || (await copiesOf(seed.orderB)) !== 0) throw new Error(`status ${r.status}`);
  });
  await bc.close();

  await browser.close();
  await check(`L1 the database holds exactly the ${made} copies the scenarios made`, async () => {
    const n = await copiesOf(seed.orderA);
    if (n !== made) throw new Error(`copies ${n}`);
  });

  const bad = rows.filter((r) => !r.ok);
  writeFileSync(join(OUT, "report.md"), ["## Purchase-order sheet — end to end (app in a browser, PG lab, desktop + phone)", "", `${rows.length - bad.length} passed, ${bad.length} failed`, "", "| check | result |", "|---|---|", ...rows.map((r) => `| ${r.name} | ${r.ok ? "PASS" : `FAIL — ${r.detail.replace(/\|/g, "\\|")}`} |`)].join("\n"));
  console.log(`\n${rows.length - bad.length} passed, ${bad.length} failed`);
  if (bad.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
