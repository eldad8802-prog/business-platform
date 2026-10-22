/* eslint-disable @typescript-eslint/no-explicit-any -- E2E harness: loose JSON */
/**
 * Languages + currencies — FULL-STACK end-to-end on the built app (next start) and an ephemeral
 * PostgreSQL (CI service container only), with a signed-in owner in a real browser.
 *
 * The flag is read when pages render, and with the flag OFF at BUILD time Next pre-renders the root
 * layout statically — so the flag takes effect per BUILD (on Vercel: set the env var + redeploy).
 * Two phases, two builds:
 *   E2E_PHASE=on   http://localhost:3611  built + started with DUBIZ_I18N_ENABLED=true  (E1–E4, E6)
 *   E2E_PHASE=off  http://localhost:3612  built + started without the flag (= today)   (E5)
 *
 *   E1  every main screen × {he, en} × {phone 390, tablet 820, desktop 1440}: <html lang/dir>,
 *       no horizontal overflow, English chrome (nav) in English, screenshots as artifacts
 *   E2  the owner switches language in Settings → persists across reload and sign-out/sign-in
 *   E3  switching language changes no data (amounts / currency identical in both languages)
 *   E4  two businesses, different languages, different currencies: each sees only itself
 *   E5  flag OFF: a dz_locale=en cookie is ignored (Hebrew, RTL), the locale endpoint is 404
 *   E6  English pages: Hebrew text still visible is REPORTED per screen (known server-text gaps),
 *       excluding user data
 *
 * Synthetic data only. No secrets, no Neon, no provider.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { signAuthToken } from "../lib/auth-token";

const ON = process.env.I18N_ON_BASE ?? "http://localhost:3611";
const OFF = process.env.I18N_OFF_BASE ?? "http://localhost:3612";
const SHOTS = process.env.E2E_SHOTS ?? "";
const PHASE = process.env.E2E_PHASE ?? "on";
if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("ABORT: e2e runs only against the local CI service container");
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const prisma = new PrismaClient();
let pass = 0;
const failures: string[] = [];
const report: Record<string, unknown> = {};
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;
const DAY = 86400_000;

const SCREENS = ["/app", "/inbox", "/documents", "/billing", "/collection", "/payables", "/customers", "/leads", "/inventory", "/tasks", "/secretary", "/settings", "/settings/workspace", "/business/identity", "/content"];
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
];

type Biz = { id: number; token: string; customer: string };
async function business(label: string, customer: string, invoices: Array<[string, string]>): Promise<Biz> {
  const b = await prisma.business.create({ data: { name: `e2e-${label}-${uniq()}` } });
  const u = await prisma.user.create({ data: { email: `e2e-${label}-${uniq()}@example.test`, password: "x", businessId: b.id, role: "USER" } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: `${label} Synthetic Ltd`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "e2e@example.test" } });
  const c = await prisma.customer.create({ data: { businessId: b.id, name: customer, phone: "0501234567" } });
  let n = 0;
  for (const [total, currency] of invoices) {
    n++;
    await prisma.billingDocument.create({
      data: {
        businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: c.id,
        customerNameSnapshot: customer, currency, subtotalAmount: "0", vatAmount: "0", totalAmount: total,
        documentNumber: 900000 + b.id * 10 + n, documentNumberFormatted: String(900000 + b.id * 10 + n), issuedAt: new Date(Date.now() - 400 * DAY),
      },
    });
  }
  return { id: b.id, token: signAuthToken(u.id), customer };
}

async function contextFor(browser: Browser, base: string, biz: Biz, locale: "he" | "en" | null, viewport = VIEWPORTS[2]): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: viewport.width, height: viewport.height } });
  await ctx.addInitScript((t) => localStorage.setItem("token", t), biz.token);
  if (locale) await ctx.addCookies([{ name: "dz_locale", value: locale, url: base }]);
  return ctx;
}
async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}
const htmlAttrs = (page: Page) => page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Visible text fragments with Hebrew letters, excluding the given user-data strings. */
const hebrewVisible = (page: Page, exclude: string[]) =>
  page.evaluate((ex) => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      if (!/[֐-׿]/.test(text)) continue;
      const el = n.parentElement;
      if (!el || el.closest("script,style,[aria-hidden=true]")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (ex.some((e) => text.includes(e))) continue;
      out.add(text.slice(0, 80));
    }
    return [...out];
  }, exclude);

async function main() {
  // Seed: A works in English with ILS + USD; B in Hebrew with ILS only. Customer names are data.
  const a = await business("A", "Alpha Customer", [["1000.00", "ILS"], ["300.00", "USD"]]);
  const b = await business("B", "לקוח בטא", [["500.00", "ILS"]]);
  const browser = await chromium.launch();
  if (PHASE === "on") {

  console.log("\n== E1 / E6 — every screen × language × width ==");
  const gaps: Record<string, string[]> = {};
  for (const vp of VIEWPORTS) {
    for (const locale of ["he", "en"] as const) {
      const ctx = await contextFor(browser, ON, a, locale, vp);
      const page = await ctx.newPage();
      for (const screen of SCREENS) {
        await open(page, `${ON}${screen}`);
        const attrs = await htmlAttrs(page);
        const expectDir = locale === "he" ? "rtl" : "ltr";
        ok(`E1 ${vp.name} ${locale} ${screen} — lang/dir`, attrs.lang === locale && attrs.dir === expectDir, JSON.stringify(attrs));
        const over = await overflow(page);
        ok(`E1 ${vp.name} ${locale} ${screen} — no horizontal overflow`, over <= 1, `${over}px`);
        if (locale === "en") {
          // "עברית" is the Hebrew option of the language picker — a language is always named in itself.
          const heb = await hebrewVisible(page, [a.customer, "עברית"]);
          if (heb.length) gaps[`${vp.name} ${screen}`] = heb;
        }
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${vp.name}-${locale}${screen.replace(/\//g, "_")}.png`, fullPage: false });
      }
      await ctx.close();
    }
  }
  report.englishHebrewGaps = gaps;
  const desktopNav = await (async () => {
    const ctx = await contextFor(browser, ON, a, "en");
    const page = await ctx.newPage();
    await open(page, `${ON}/collection`);
    const text = await page.locator("nav.dz-sidebar").innerText().catch(() => "");
    await ctx.close();
    return text;
  })();
  ok("E1 — English sidebar is English", /Home/.test(desktopNav) && /Collection/.test(desktopNav) && !/[֐-׿]/.test(desktopNav), desktopNav.slice(0, 200));

  console.log("\n== E2 — language choice persists ==");
  {
    const ctx = await contextFor(browser, ON, a, null);
    const page = await ctx.newPage();
    await open(page, `${ON}/settings/workspace`);
    ok("E2 — default is Hebrew", (await htmlAttrs(page)).lang === "he");
    await page.getByRole("radio", { name: "English" }).click();
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
    ok("E2 — switched to English", (await htmlAttrs(page)).lang === "en");
    await open(page, `${ON}/settings/workspace`);
    ok("E2 — persists across reload", (await htmlAttrs(page)).lang === "en");
    await page.evaluate(() => localStorage.removeItem("token")); // sign out
    await page.evaluate((t) => localStorage.setItem("token", t), a.token); // sign in again
    await open(page, `${ON}/app`);
    ok("E2 — persists across sign-out / sign-in", (await htmlAttrs(page)).lang === "en");
    await ctx.close();
  }

  console.log("\n== E3 — language changes no data ==");
  const amounts: Record<string, any> = {};
  for (const locale of ["he", "en"] as const) {
    const r = await fetch(`${ON}/api/collection/inbox`, { headers: { authorization: `Bearer ${a.token}`, cookie: `dz_locale=${locale}` } });
    const body: any = await r.json();
    amounts[locale] = body.toCollect?.map((c: any) => `${c.currency}:${c.totalOutstanding}`).sort();
  }
  ok("E3 — identical amounts and currencies in both languages", JSON.stringify(amounts.he) === JSON.stringify(amounts.en) && JSON.stringify(amounts.en) === JSON.stringify(["ILS:1000.00", "USD:300.00"]), JSON.stringify(amounts));

  console.log("\n== E4 — two businesses, two languages, two currency mixes ==");
  {
    const ra: any = await (await fetch(`${ON}/api/collection/inbox`, { headers: { authorization: `Bearer ${a.token}`, cookie: "dz_locale=en" } })).json();
    const rb: any = await (await fetch(`${ON}/api/collection/inbox`, { headers: { authorization: `Bearer ${b.token}`, cookie: "dz_locale=he" } })).json();
    ok("E4 — A sees ILS + USD, flagged mixed", ra.summary?.toCollect?.isMixedCurrency === true && ra.summary?.toCollect?.amount === "1000.00", JSON.stringify(ra.summary));
    ok("E4 — B sees only its ILS 500, not flagged", rb.summary?.toCollect?.isMixedCurrency === false && rb.summary?.toCollect?.amount === "500.00", JSON.stringify(rb.summary));
    ok("E4 — no cross-tenant names", !JSON.stringify(ra).includes(b.customer) && !JSON.stringify(rb).includes(a.customer));
    const ctx = await contextFor(browser, ON, b, "he");
    const page = await ctx.newPage();
    await open(page, `${ON}/collection`);
    const text = await page.locator("body").innerText();
    ok("E4 — B's collection screen shows none of A", !text.includes(a.customer));
    await ctx.close();
  }

  }

  if (PHASE === "off") {
  console.log("\n== E5 — flag OFF is today's behaviour ==");
  {
    const ctx = await contextFor(browser, OFF, a, "en");
    const page = await ctx.newPage();
    for (const screen of ["/app", "/collection", "/settings/workspace"]) {
      await open(page, `${OFF}${screen}`);
      const attrs = await htmlAttrs(page);
      ok(`E5 — ${screen}: cookie en ignored → he/rtl`, attrs.lang === "he" && attrs.dir === "rtl", JSON.stringify(attrs));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/flag-off${screen.replace(/\//g, "_")}.png` });
    }
    const radios = await page.getByRole("radio").count();
    const disabled = await page.locator('[role="radio"][disabled]').count();
    ok("E5 — the language buttons are shown but disabled", radios === 2 && disabled === 2, `${radios}/${disabled}`);
    await ctx.close();
    const r = await fetch(`${OFF}/api/preferences/locale`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: "en" }) });
    ok("E5 — locale endpoint 404", r.status === 404, String(r.status));
  }
  }

  await browser.close();
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    if (SHOTS) writeFileSync(`${SHOTS}/report-${PHASE}.json`, JSON.stringify({ pass, failures, ...report }, null, 2));
    const gaps = (report.englishHebrewGaps ?? {}) as Record<string, string[]>;
    console.log(`\nEnglish screens with Hebrew still visible (reported, not failed): ${Object.keys(gaps).length}`);
    for (const [k, v] of Object.entries(gaps)) console.log(`  ${k}: ${v.slice(0, 6).join(" | ")}`);
    console.log(`\ni18n e2e (${PHASE}): ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
