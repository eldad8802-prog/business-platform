/**
 * "הפקת מסמך" stage 1 — the production entry in a browser (invoices screen + customer card), desktop and phone,
 * feature ON and OFF. Synthetic only; no Production, no secrets, no network beyond localhost.
 *
 *   O1 feature OFF: the invoices screen shows the two create buttons exactly as before, no production button
 *   O2 feature OFF: "+ צור חשבונית" still opens the existing invoice create modal
 *   O3 feature OFF: the customer card has no production button
 *   N1 feature ON: one production button, the old create buttons are gone
 *   N2 the list offers exactly: tax invoice, quote, letter, supplier order — nothing whose flow does not work
 *   N3 tax invoice → the existing create modal → a DRAFT tax invoice with no number (existing behaviour)
 *   N4 quote → the existing quote create modal
 *   N5 letter and supplier order open their existing screens
 *   N6 the follow-up link at the foot of the list opens "מסמכים נוספים"
 *   X1 exempt dealer: no tax invoice in the list
 *   G1 identity incomplete: tax invoice opens the existing identity gate, not the create modal
 *   C1 customer card (ON): "הפקת מסמך ללקוח" opens the list for that customer; tax invoice → the modal has the
 *      customer selected → the draft belongs to that customer
 *   P1 phone 390: the list fits, no side scroll
 *   E1 English interface: the list speaks English (no Hebrew left in the list)
 *   XO1 exempt dealer, feature OFF: "+ צור חשבונית" shows the notice — no create modal, no draft
 *   XO2 … the empty-state button shows the notice
 *   XO3 … /billing?create=1 and /billing?create=documents show the notice
 *   XO4 … the quote stays available (its create modal opens)
 *   XO5 … English: the notice in English
 *   XG1 kind unknown, feature OFF: the identity gate opens as before; declaring "עוסק פטור" there shows the notice
 *   AO1 authorized dealer, feature OFF: the empty-state button and ?create=1 open the invoice create modal as before
 *   EO1 exempt dealer, feature ON: ?create=1 behaves as before (the invoice create modal), the list still has no tax invoice
 *   L1 the database holds exactly the drafts the scenarios made, all DRAFT, none numbered
 *
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3730";
const OUT = process.env.OUT ?? "/tmp/bd-pe-ui";
type Biz = { businessId: number; token: string; customerId: number };
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as Record<"A" | "E" | "I" | "B" | "X" | "U", Biz>;
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
const DESKTOP = { width: 1440, height: 900, phone: false };
const PHONE = { width: 390, height: 844, phone: true };
async function ctx(browser: Browser, token: string, size: typeof DESKTOP, lang: "he" | "en" = "he"): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE,
    locale: lang === "he" ? "he-IL" : "en-US",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: size.width, height: size.height },
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await c.addCookies([{ name: "dz_locale", value: lang, url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
const drafts = (b: Biz) => owner.billingDocument.findMany({ where: { businessId: b.businessId }, select: { documentType: true, status: true, documentNumber: true, customerId: true }, orderBy: { id: "asc" } });
const OPTION = (page: Page, key: string) => page.locator(`[data-testid="document-production-sheet"] [data-option="${key}"]`);
const listKeys = async (page: Page) => page.locator('[data-testid="document-production-sheet"] [data-option]').evaluateAll((els) => els.map((e) => e.getAttribute("data-option")));

async function openBilling(page: Page) {
  current = page;
  await page.goto("/billing");
  await page.getByRole("heading", { name: "חשבוניות" }).waitFor({ timeout: 90_000 });
}
async function openList(page: Page) {
  await openBilling(page);
  await page.getByTestId("document-production-button").click({ timeout: 30_000 });
  await page.getByTestId("document-production-sheet").waitFor();
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ── feature OFF ─────────────────────────────────────────────────────────────────────────────
    {
      const c = await ctx(browser, seed.B.token, DESKTOP);
      const page = await c.newPage();
      await openBilling(page);
      await page.getByRole("button", { name: "+ צור חשבונית" }).waitFor({ timeout: 30_000 });
      await check("O1 feature OFF: the two create buttons as before, no production button", async () => {
        if ((await page.getByRole("button", { name: "+ צור הצעת מחיר" }).count()) !== 1) throw new Error("quote button missing");
        if ((await page.getByTestId("document-production-button").count()) !== 0) throw new Error("production button shown with the feature off");
        if ((await page.getByRole("link", { name: "מסמכים נוספים" }).count()) !== 0) throw new Error("'מסמכים נוספים' shown with the feature off");
      });
      await shot(page, "O1-off-invoices");
      await check("O2 feature OFF: '+ צור חשבונית' opens the existing invoice create modal", async () => {
        await page.getByRole("button", { name: "+ צור חשבונית" }).click();
        await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).waitFor();
        if ((await page.getByTestId("document-production-sheet").count()) !== 0) throw new Error("production list opened");
      });
      await check("O3 feature OFF: the customer card has no production button", async () => {
        await page.goto(`/customers/${seed.B.customerId}`);
        await page.getByText("לקוחה בדיקה B").first().waitFor({ timeout: 90_000 });
        await page.waitForTimeout(1500);
        return (await page.getByTestId("customer-produce-document").count()) === 0;
      });
      await c.close();
    }

    // ── feature ON, authorized dealer ───────────────────────────────────────────────────────────
    {
      const c = await ctx(browser, seed.A.token, DESKTOP);
      const page = await c.newPage();
      await openBilling(page);
      await check("N1 feature ON: one production button, the old create buttons are gone", async () => {
        await page.getByTestId("document-production-button").waitFor({ timeout: 30_000 });
        if ((await page.getByRole("button", { name: "+ צור חשבונית" }).count()) !== 0) throw new Error("old invoice button still shown");
        if ((await page.getByRole("button", { name: "+ צור הצעת מחיר" }).count()) !== 0) throw new Error("old quote button still shown");
      });
      await page.getByTestId("document-production-button").click();
      await page.getByTestId("document-production-sheet").waitFor();
      await page.waitForTimeout(800); // the business kind arrives
      await check("N2 the list offers exactly tax invoice, quote, letter, supplier order", async () => {
        const keys = await listKeys(page);
        if (JSON.stringify(keys) !== JSON.stringify(["TAX_INVOICE", "QUOTE", "LETTER", "SUPPLIER_ORDER"])) throw new Error(JSON.stringify(keys));
        const text = await page.getByTestId("document-production-sheet").innerText();
        for (const absent of ["קבלה", "תעודת משלוח", "תעודת החזרה", "דרישת תשלום", "קריאת שירות", "בקרוב"]) if (text.includes(absent)) throw new Error(`shows ${absent}`);
      });
      await shot(page, "N2-on-list");
      await check("N3 tax invoice → the existing create modal → a DRAFT tax invoice with no number", async () => {
        await OPTION(page, "TAX_INVOICE").click();
        const dialog = page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" });
        await dialog.waitFor();
        await dialog.locator('input[type="text"]').fill("לקוח חופשי בדיקה");
        await Promise.all([page.waitForURL(/\/billing\/\d+$/, { timeout: 60_000 }), dialog.getByRole("button", { name: "התחל מסמך" }).click()]);
        const d = await drafts(seed.A);
        if (d.length !== 1 || d[0].documentType !== "TAX_INVOICE" || d[0].status !== "DRAFT" || d[0].documentNumber !== null) throw new Error(JSON.stringify(d));
      });
      await check("N4 quote → the existing quote create modal", async () => {
        await openList(page);
        await OPTION(page, "QUOTE").click();
        await page.getByRole("dialog", { name: "יצירת הצעת מחיר" }).waitFor();
      });
      await check("N5 letter and supplier order open their existing screens", async () => {
        await openList(page);
        await Promise.all([page.waitForURL(/\/business-documents\/letters\/new$/), OPTION(page, "LETTER").click()]);
        await openList(page);
        await Promise.all([page.waitForURL(/\/inventory\/supplier-purchases\/new$/), OPTION(page, "SUPPLIER_ORDER").click()]);
      });
      await check("N6 the link at the foot of the list opens 'מסמכים נוספים'", async () => {
        await openList(page);
        await Promise.all([page.waitForURL(/\/business-documents$/), page.getByRole("link", { name: "מעקב הצעות מחיר ומכתבים שמורים" }).click()]);
      });
      await check("C1 customer card: the list opens for that customer; tax invoice → the customer is selected → the draft is hers", async () => {
        await page.goto(`/customers/${seed.A.customerId}`);
        await page.getByTestId("customer-produce-document").click({ timeout: 90_000 });
        await page.getByTestId("document-production-sheet").waitFor({ timeout: 60_000 });
        if (!(await page.getByTestId("document-production-sheet").innerText()).includes("לקוחה בדיקה A")) throw new Error("customer name not shown");
        await shot(page, "C1-customer-list");
        await OPTION(page, "TAX_INVOICE").click();
        const dialog = page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" });
        const select = dialog.locator("select").first();
        await select.waitFor();
        // the customer list loads after the modal opens; the pre-selected customer must be the selected option then
        await page.waitForFunction(([id]) => (document.querySelector("[role=dialog] select") as HTMLSelectElement | null)?.value === id, [String(seed.A.customerId)], { timeout: 30_000 }).catch(() => undefined);
        if ((await select.inputValue()) !== String(seed.A.customerId)) throw new Error(`selected ${await select.inputValue()}`);
        await Promise.all([page.waitForURL(/\/billing\/\d+$/, { timeout: 60_000 }), dialog.getByRole("button", { name: "התחל מסמך" }).click()]);
        const d = await drafts(seed.A);
        const last = d[d.length - 1];
        if (d.length !== 2 || last.customerId !== seed.A.customerId || last.status !== "DRAFT" || last.documentNumber !== null) throw new Error(JSON.stringify(d));
      });
      await c.close();
    }

    // ── exempt dealer / incomplete identity / phone ─────────────────────────────────────────────
    {
      const c = await ctx(browser, seed.E.token, DESKTOP);
      const page = await c.newPage();
      await openList(page);
      await page.waitForTimeout(1500);
      await check("X1 exempt dealer: no tax invoice in the list", async () => {
        const keys = await listKeys(page);
        if (JSON.stringify(keys) !== JSON.stringify(["QUOTE", "LETTER", "SUPPLIER_ORDER"])) throw new Error(JSON.stringify(keys));
      });
      await shot(page, "X1-exempt-list");
      await c.close();
    }
    {
      const c = await ctx(browser, seed.I.token, DESKTOP);
      const page = await c.newPage();
      await openBilling(page);
      await page.waitForTimeout(2000); // the identity state settles
      await check("G1 identity incomplete: tax invoice opens the existing identity gate, not the create modal", async () => {
        await page.getByTestId("document-production-button").click();
        await OPTION(page, "TAX_INVOICE").click();
        await page.locator('[aria-labelledby="identity-gate-title"]').waitFor({ timeout: 15_000 });
        if ((await page.getByTestId("document-production-sheet").count()) !== 0) throw new Error("list still open");
        if ((await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).count()) !== 0) throw new Error("create modal opened despite the gate");
      });
      await shot(page, "G1-identity-gate");
      await c.close();
    }
    {
      const c = await ctx(browser, seed.A.token, PHONE);
      const page = await c.newPage();
      await openList(page);
      await check("P1 phone 390: the list fits, no side scroll", async () => {
        const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
        if (w.doc > w.view + 1) throw new Error(JSON.stringify(w));
        const box = await page.getByTestId("document-production-sheet").locator("> div").boundingBox();
        if (!box || box.x < 0 || box.x + box.width > 391) throw new Error(JSON.stringify(box));
      });
      await shot(page, "P1-phone-list");
      await c.close();
    }

    {
      const c = await ctx(browser, seed.A.token, DESKTOP, "en");
      const page = await c.newPage();
      current = page;
      await check("E1 English interface: the list speaks English", async () => {
        await page.goto("/billing");
        await page.getByTestId("document-production-button").click({ timeout: 90_000 });
        const sheet = page.getByTestId("document-production-sheet");
        await sheet.waitFor();
        await page.waitForTimeout(800);
        const text = await sheet.innerText();
        for (const w of ["Produce a document", "Tax invoice", "Quote", "Letter", "Supplier order"]) if (!text.includes(w)) throw new Error(`missing ${w}`);
        if (/[֐-׿]/.test(text)) throw new Error(`Hebrew left: ${text.slice(0, 120)}`);
      });
      await shot(page, "E1-english-list");
      await c.close();
    }

    // ── exempt dealer, feature OFF: the three tax-invoice entries show a notice (owner-approved 2026-11-11) ──
    {
      const NOTICE = "עוסק פטור אינו רשאי להפיק חשבונית מס";
      const c = await ctx(browser, seed.X.token, DESKTOP);
      const page = await c.newPage();
      const noticeShown = async () => {
        const n = page.getByTestId("exempt-tax-invoice-notice");
        await n.waitFor({ timeout: 30_000 });
        if (!(await n.innerText()).includes(NOTICE)) throw new Error("notice text");
        if ((await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).count()) !== 0) throw new Error("invoice create modal opened");
        if (new URL(page.url()).pathname !== "/billing") throw new Error(`navigated to ${page.url()}`);
      };
      const closeNotice = () => page.getByTestId("exempt-tax-invoice-notice").getByRole("button").click();
      await openBilling(page);
      await check("XO1 exempt, feature OFF: '+ צור חשבונית' shows the notice, no modal", async () => {
        await page.getByRole("button", { name: "+ צור חשבונית" }).click({ timeout: 30_000 });
        await noticeShown();
      });
      await shot(page, "XO1-exempt-off-notice");
      await check("XO2 … the empty-state button shows the notice", async () => {
        await closeNotice();
        await page.getByRole("button", { name: "התחל מסמך ללקוח" }).click({ timeout: 30_000 });
        await noticeShown();
      });
      await check("XO3 … ?create=1 and ?create=documents show the notice", async () => {
        for (const q of ["create=1", "create=documents"]) {
          await page.goto(`/billing?${q}`);
          await noticeShown();
        }
      });
      await check("XO4 … the quote stays available", async () => {
        await closeNotice();
        await page.getByRole("button", { name: "+ צור הצעת מחיר" }).click();
        await page.getByRole("dialog", { name: "יצירת הצעת מחיר" }).waitFor();
      });
      await c.close();
      const en = await ctx(browser, seed.X.token, DESKTOP, "en");
      const p2 = await en.newPage();
      current = p2;
      await check("XO5 … English: the notice in English", async () => {
        await p2.goto("/billing");
        await p2.getByRole("button", { name: "+ Create invoice" }).click({ timeout: 90_000 });
        const n = p2.getByTestId("exempt-tax-invoice-notice");
        await n.waitFor();
        if (!(await n.innerText()).includes("An exempt dealer may not issue a tax invoice")) throw new Error(await n.innerText());
      });
      await shot(p2, "XO5-exempt-off-notice-en");
      await en.close();
    }

    // ── kind unknown, feature OFF: the identity gate as before; declaring exempt there shows the notice ──
    {
      const c = await ctx(browser, seed.U.token, DESKTOP);
      const page = await c.newPage();
      await openBilling(page);
      await page.waitForTimeout(2000);
      await check("XG1 unknown kind: the gate opens as before; declaring exempt there shows the notice, not the modal", async () => {
        await page.getByRole("button", { name: "+ צור חשבונית" }).click({ timeout: 30_000 });
        const gate = page.locator('[aria-labelledby="identity-gate-title"]');
        await gate.waitFor({ timeout: 15_000 });
        await gate.getByLabel("שם העסק במסמך").fill("עסק בדיקה U");
        await gate.getByLabel("סוג עסק").selectOption("EXEMPT_DEALER");
        await gate.getByLabel("ע.מ. / ח.פ.").fill("515000123");
        await gate.getByLabel("כתובת").fill("רחוב הבדיקה 2, חיפה");
        await gate.getByLabel("טלפון").fill("0501234567");
        await gate.getByLabel('דוא"ל').fill("u@lab.test");
        await gate.getByRole("button", { name: "שמור והמשך" }).click();
        await page.getByTestId("exempt-tax-invoice-notice").waitFor({ timeout: 30_000 });
        if ((await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).count()) !== 0) throw new Error("invoice create modal opened");
      });
      await shot(page, "XG1-gate-exempt-notice");
      await c.close();
    }

    // ── authorized dealer, feature OFF and exempt dealer, feature ON: unchanged ──
    {
      const c = await ctx(browser, seed.B.token, DESKTOP);
      const page = await c.newPage();
      await openBilling(page);
      await check("AO1 authorized, feature OFF: empty-state button and ?create=1 open the invoice create modal as before", async () => {
        await page.getByRole("button", { name: "התחל מסמך ללקוח" }).click({ timeout: 30_000 });
        await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).waitFor();
        await page.goto("/billing?create=1");
        await page.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).waitFor({ timeout: 60_000 });
        if ((await page.getByTestId("exempt-tax-invoice-notice").count()) !== 0) throw new Error("notice shown to an authorized dealer");
      });
      await c.close();
      const c2 = await ctx(browser, seed.E.token, DESKTOP);
      const p2 = await c2.newPage();
      current = p2;
      await check("EO1 exempt, feature ON: ?create=1 behaves as before (invoice create modal); no notice", async () => {
        await p2.goto("/billing?create=1");
        await p2.getByRole("dialog", { name: "יצירת טיוטת חשבונית" }).waitFor({ timeout: 90_000 });
        if ((await p2.getByTestId("exempt-tax-invoice-notice").count()) !== 0) throw new Error("notice shown with the feature ON");
      });
      await c2.close();
    }

    await check("L1 the database holds exactly the drafts the scenarios made, all DRAFT, none numbered", async () => {
      const a = await drafts(seed.A);
      const others = (await Promise.all([seed.E, seed.I, seed.B, seed.X, seed.U].map(drafts))).flat();
      if (a.length !== 2 || others.length !== 0 || a.some((d) => d.status !== "DRAFT" || d.documentNumber !== null)) throw new Error(JSON.stringify({ a, others }));
    });
  } finally {
    await browser.close();
    await owner.$disconnect();
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
