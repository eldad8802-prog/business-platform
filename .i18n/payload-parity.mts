/* eslint-disable @typescript-eslint/no-explicit-any -- E2E harness: loose DOM payloads */
/**
 * Before/after proof for the root-layout payload change (app/layout.tsx no longer serializes the Hebrew
 * dictionary into every page; I18nProvider uses the bundled `he`, the very same object):
 * MAIN (origin/main) vs THIS BRANCH, each built twice — flag OFF and flag ON — all four served side by side
 * on the same ephemeral PostgreSQL (same seeded data):
 *   MAIN_OFF :3621   MAIN_ON :3622   BRANCH_OFF :3612   BRANCH_ON :3611
 * For every route × {390, 1440} × cookie variant (OFF: none, dz_locale=en · ON: none, he, en), in Chromium,
 * signed-in owner (localStorage token) for app routes, after the page settles:
 *   <html lang/dir>, <title>, final path, visible text, and the rendered <body> DOM (scripts, styles,
 *   links and build-hashed asset URLs removed) must be IDENTICAL between MAIN and BRANCH.
 * Also records the server HTML bytes MAIN vs BRANCH (the point of the change). Fails on any difference.
 * Synthetic data only. No secrets, no Neon.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { signAuthToken } from "../lib/auth-token";

const OUT = process.env.PERF_OUT ?? "perf-out";
const B = { mainOff: "http://localhost:3621", mainOn: "http://localhost:3622", branchOff: "http://localhost:3612", branchOn: "http://localhost:3611" };
if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("ABORT: runs only against the local CI service container");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();
let pass = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

async function seed() {
  const n = Date.now();
  const b = await prisma.business.create({ data: { name: `parity-${n}` } });
  const u = await prisma.user.create({ data: { email: `parity-${n}@example.test`, password: "x", businessId: b.id, role: "USER", name: "Parity Owner" } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: "Parity Synthetic Ltd", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "parity@example.test", onboardingCompletedAt: new Date(n - 30 * 86400_000) } });
  const c = await prisma.customer.create({ data: { businessId: b.id, name: "לקוח השוואה", phone: "0501234599" } });
  const inv = await prisma.billingDocument.create({
    data: {
      businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: c.id,
      customerNameSnapshot: c.name, currency: "ILS", subtotalAmount: "847.46", vatAmount: "152.54", totalAmount: "1000.00",
      documentNumber: 700000 + b.id, documentNumberFormatted: String(700000 + b.id), issuedAt: new Date(n - 40 * 86400_000),
    },
  });
  return { token: signAuthToken(u.id), customerId: c.id, invoiceId: inv.id };
}

type Snap = { status: number | null; path: string; lang: string; dir: string; title: string; text: string; dom: string };

async function snap(browser: Browser, base: string, route: string, width: number, token: string | null, cookie: string | null): Promise<Snap> {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width, height: 900 }, extraHTTPHeaders: { "accept-language": "he-IL,he;q=0.9" } });
  if (token) await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  if (cookie) await ctx.addCookies([{ name: "dz_locale", value: cookie, url: base }]);
  const page = await ctx.newPage();
  let status: number | null = null;
  try { status = (await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 60_000 }))?.status() ?? null; } catch { /* recorded as null */ }
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const read = () => page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,link,noscript,next-route-announcer,template").forEach((n) => n.remove());
    clone.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) {
        if (/\/_next\//.test(a.value) || a.name === "nonce" || a.name === "data-precedence") el.removeAttribute(a.name);
      }
    });
    return { path: location.pathname, lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title, text: document.body.innerText, dom: clone.innerHTML };
  });
  let last: Awaited<ReturnType<typeof read>> | null = null;
  for (let i = 0, same = 0; i < 16 && same < 2; i++) {
    await page.waitForTimeout(i === 0 ? 300 : 500);
    try { const cur = await read(); same = last && cur.dom === last.dom && cur.text.trim() !== "" ? same + 1 : 0; last = cur; } catch { same = 0; }
  }
  await ctx.close();
  return { status, ...(last ?? { path: "?", lang: "?", dir: "?", title: "?", text: "", dom: "" }) };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// Wall-clock values that move between two renders seconds apart (same rule as readiness-lib "volatile").
const vol = (s: string) => norm(s).replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "HH:MM").replace(/לפני (\d+ )?(שנייה|שניות|דקה|דקות|שעה|שעות)/g, "לפני N");

async function main() {
  const s = await seed();
  const routes: Array<{ path: string; signedIn: boolean }> = [
    ...["/home", "/about", "/privacy", "/login", "/register", "/forgot-password"].map((p) => ({ path: p, signedIn: false })),
    ...["/app", "/collection", "/billing", `/billing/${s.invoiceId}`, "/customers", `/customers/${s.customerId}`, "/leads", "/settings", "/settings/workspace", "/secretary", "/payables", "/inventory", "/tasks", "/profile"].map((p) => ({ path: p, signedIn: true })),
  ];
  const pairs: Array<{ name: string; main: string; branch: string; cookie: string | null }> = [
    { name: "flag OFF, no cookie", main: B.mainOff, branch: B.branchOff, cookie: null },
    { name: "flag OFF, dz_locale=en (ignored)", main: B.mainOff, branch: B.branchOff, cookie: "en" },
    { name: "flag ON, no cookie", main: B.mainOn, branch: B.branchOn, cookie: null },
    { name: "flag ON, dz_locale=he", main: B.mainOn, branch: B.branchOn, cookie: "he" },
    { name: "flag ON, dz_locale=en", main: B.mainOn, branch: B.branchOn, cookie: "en" },
  ];
  const browser = await chromium.launch();
  const rows: any[] = [];
  for (const r of routes) {
    for (const width of [390, 1440]) {
      for (const p of pairs) {
        let res: { identical: boolean; detail: string; volatileOnly: boolean } = { identical: false, detail: "", volatileOnly: false };
        for (let attempt = 1; attempt <= 3; attempt++) {
          const [a, b] = await Promise.all([snap(browser, p.main, r.path, width, r.signedIn ? s.token : null, p.cookie), snap(browser, p.branch, r.path, width, r.signedIn ? s.token : null, p.cookie)]);
          const meta = a.status === b.status && a.path === b.path && a.lang === b.lang && a.dir === b.dir && a.title === b.title;
          const exact = meta && norm(a.text) === norm(b.text) && a.dom === b.dom;
          const volatileOnly = !exact && meta && vol(a.text) === vol(b.text) && vol(a.dom) === vol(b.dom);
          let i = 0;
          while (i < a.dom.length && a.dom[i] === b.dom[i]) i++;
          res = { identical: exact, volatileOnly, detail: meta ? `dom differs @${i}: main «${a.dom.slice(Math.max(0, i - 60), i + 80)}» branch «${b.dom.slice(Math.max(0, i - 60), i + 80)}»` : `meta main=${a.status}/${a.path}/${a.lang}/${a.dir}/"${a.title}" branch=${b.status}/${b.path}/${b.lang}/${b.dir}/"${b.title}"` };
          if (exact || volatileOnly) break;
        }
        rows.push({ route: r.path.replace(/\/\d+$/, "/[id]"), width, variant: p.name, identical: res.identical, volatileOnly: res.volatileOnly });
        ok(`${width} ${r.path} [${p.name}] — MAIN = BRANCH (meta, text, DOM)`, res.identical || res.volatileOnly, res.detail);
      }
    }
  }
  await browser.close();
  // Server HTML bytes, MAIN vs BRANCH.
  const bytes: any[] = [];
  for (const r of routes) {
    const row: any = { route: r.path.replace(/\/\d+$/, "/[id]") };
    for (const [k, base, cookie] of [["mainOff", B.mainOff, null], ["branchOff", B.branchOff, null], ["mainOnHe", B.mainOn, null], ["branchOnHe", B.branchOn, null], ["mainOnEn", B.mainOn, "dz_locale=en"], ["branchOnEn", B.branchOn, "dz_locale=en"]] as const) {
      const res = await fetch(base + r.path, { headers: { "accept-language": "he-IL", ...(cookie ? { cookie } : {}) }, redirect: "manual" });
      row[k] = (await res.arrayBuffer()).byteLength;
    }
    bytes.push(row);
  }
  const med = (k: string) => { const xs = bytes.map((b) => b[k]).sort((x, y) => x - y); return xs[Math.floor(xs.length / 2)]; };
  const summary = Object.fromEntries(["mainOff", "branchOff", "mainOnHe", "branchOnHe", "mainOnEn", "branchOnEn"].map((k) => [k, med(k)]));
  console.log(`HTML bytes (median over ${bytes.length} routes): ${JSON.stringify(summary)}`);
  ok("branch HTML is smaller than main for Hebrew (flag OFF)", summary.branchOff < summary.mainOff, JSON.stringify(summary));
  writeFileSync(`${OUT}/payload-parity.json`, JSON.stringify({ pass, failed: failures.length, failures, comparisons: rows.length, exact: rows.filter((r) => r.identical).length, volatileOnly: rows.filter((r) => r.volatileOnly).length, bytesMedian: summary, bytes, rows }, null, 1));
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\npayload parity (main vs branch): ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.slice(0, 80).map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
