/**
 * #1264 rename proof (CI only; changes nothing). The shared i18n proof fails #1264 because MAIN and BRANCH differ, and it
 * reports only the FIRST difference per page. This proof answers the owner's question exactly: is the rename
 * «שירות ואחריות» → «תיקונים ושירות» (en: "Service & warranty" → "Repairs & service") the ONLY difference?
 *
 * Same four servers, same synthetic seed, same 20 routes × 390/820/1440 × 5 flag/cookie variants as the shared proof.
 * For every page: meta (status, path, lang, dir, title) must be equal; then the rename map is applied to MAIN's text and
 * DOM, and they must equal BRANCH's text and DOM EXACTLY (the shared proof's volatile-clock normalization is allowed,
 * as there). Every rename occurrence is counted. A single residual difference fails the run.
 * The DOM comparison covers structure, links (href), roles and attributes — so navigation and behaviour markup are
 * proven identical, not only the visible text. No new hydration errors on BRANCH.
 *
 * Synthetic data only. No secrets, no Neon, no Production.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { signAuthToken } from "../lib/auth-token";

const OUT = process.env.PERF_OUT ?? "perf-out";
const B = { mainOff: "http://localhost:3621", mainOn: "http://localhost:3622", branchOff: "http://localhost:3612", branchOn: "http://localhost:3611" };
if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) { console.error("ABORT: local CI service container only"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const prisma = new PrismaClient();

/** The rename, exactly as #1264 makes it (HTML-escaped forms too, for the DOM). Order: longer first. */
const RENAME: [string, string][] = [
  ["לשירות ואחריות", "לתיקונים ושירות"],
  ["שירות ואחריות", "תיקונים ושירות"],
  ["Service &amp; warranty", "Repairs &amp; service"],
  ["Service & warranty", "Repairs & service"],
];
const applyRename = (s: string) => { let n = 0; let out = s; for (const [a, b] of RENAME) { const parts = out.split(a); n += parts.length - 1; out = parts.join(b); } return { out, n }; };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const vol = (s: string) => norm(s).replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "HH:MM").replace(/לפני (\d+ )?(שנייה|שניות|דקה|דקות|שעה|שעות)/g, "לפני N").replace(/\b\d+ (second|minute|hour)s? ago\b/g, "N ago");

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

async function seed() {
  const n = Date.now();
  const b = await prisma.business.create({ data: { name: `rename-a-${n}` } });
  const u = await prisma.user.create({ data: { email: `rename-a-${n}@example.test`, password: "x", businessId: b.id, role: "USER", name: "Rename A" } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: "Rename A Ltd", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "rename-a@example.test", onboardingCompletedAt: new Date(n - 30 * 86400_000) } });
  const c = await prisma.customer.create({ data: { businessId: b.id, name: "לקוח השוואה", phone: "0501234599" } });
  const inv = await prisma.billingDocument.create({
    data: {
      businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: c.id,
      customerNameSnapshot: c.name, currency: "ILS", subtotalAmount: "847.46", vatAmount: "152.54", totalAmount: "1000.00",
      documentNumber: 720000 + b.id, documentNumberFormatted: String(720000 + b.id), issuedAt: new Date(n - 40 * 86400_000),
    },
  });
  return { token: signAuthToken(u.id), customerId: c.id, invoiceId: inv.id };
}

const routesOf = (s: Awaited<ReturnType<typeof seed>>) => [
  ...["/home", "/about", "/privacy", "/login", "/register", "/forgot-password"].map((p) => ({ path: p, signedIn: false })),
  ...["/app", "/collection", "/billing", `/billing/${s.invoiceId}`, "/customers", `/customers/${s.customerId}`, "/leads", "/settings", "/settings/workspace", "/secretary", "/payables", "/inventory", "/tasks", "/profile"].map((p) => ({ path: p, signedIn: true })),
];

async function newCtx(browser: Browser, base: string, width: number, token: string | null, cookie: string | null): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width, height: width < 500 ? 844 : width < 1000 ? 1180 : 900 }, extraHTTPHeaders: { "accept-language": "he-IL,he;q=0.9" } });
  if (token) await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  if (cookie) await ctx.addCookies([{ name: "dz_locale", value: cookie, url: base }]);
  return ctx;
}
type Snap = { status: number | null; path: string; lang: string; dir: string; title: string; text: string; dom: string; errors: string[] };
async function snap(browser: Browser, base: string, route: string, width: number, token: string | null, cookie: string | null): Promise<Snap> {
  const ctx = await newCtx(browser, base, width, token, cookie);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /hydrat|did not match|Minified React error #4(18|19|21|23|25)/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => { if (/hydrat|#4(18|19|21|23|25)/i.test(String(e))) errors.push(String(e).slice(0, 200)); });
  let status: number | null = null;
  try { status = (await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 60_000 }))?.status() ?? null; } catch { /* null */ }
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const read = () => page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,link,noscript,next-route-announcer,template").forEach((n) => n.remove());
    clone.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) if (/\/_next\//.test(a.value) || a.name === "nonce" || a.name === "data-precedence") el.removeAttribute(a.name);
    });
    return { path: location.pathname, lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title, text: document.body.innerText, dom: clone.innerHTML };
  });
  let last: Awaited<ReturnType<typeof read>> | null = null;
  for (let i = 0, same = 0; i < 16 && same < 2; i++) {
    await page.waitForTimeout(i === 0 ? 300 : 500);
    try { const cur = await read(); same = last && cur.dom === last.dom && cur.text.trim() !== "" ? same + 1 : 0; last = cur; } catch { same = 0; }
  }
  await ctx.close();
  return { status, errors, ...(last ?? { path: "?", lang: "?", dir: "?", title: "?", text: "", dom: "" }) };
}

async function main() {
  // Self-proof, every run, before anything is measured: the map turns the old name into the new one, and a difference
  // the rename does not explain (a changed link, an extra word) still fails — the proof cannot pass a real change.
  const sp = (a: string, b: string) => applyRename(a).out === b;
  const selfProof = [
    sp(`<a href="/service-desk">שירות ואחריות</a>`, `<a href="/service-desk">תיקונים ושירות</a>`),
    sp(`<span>Service &amp; warranty</span>`, `<span>Repairs &amp; service</span>`),
    !sp(`<a href="/service-desk">שירות ואחריות</a>`, `<a href="/service-desk/x">תיקונים ושירות</a>`),
    !sp(`<span>שירות ואחריות</span>`, `<span>תיקונים ושירות חדש</span>`),
  ];
  if (selfProof.some((x) => !x)) { console.error("ABORT: rename map self-proof failed", selfProof); process.exit(1); }
  console.log("self-proof: 4/4 (the map renames; a link or word change still fails)");
  const s = await seed();
  const variants = [
    { name: "flag OFF, no cookie", main: B.mainOff, branch: B.branchOff, cookie: null },
    { name: "flag OFF, dz_locale=en (ignored)", main: B.mainOff, branch: B.branchOff, cookie: "en" },
    { name: "flag ON, no cookie", main: B.mainOn, branch: B.branchOn, cookie: null },
    { name: "flag ON, dz_locale=he", main: B.mainOn, branch: B.branchOn, cookie: "he" },
    { name: "flag ON, dz_locale=en", main: B.mainOn, branch: B.branchOn, cookie: "en" },
  ];
  const jobs = routesOf(s).flatMap((r) => [390, 820, 1440].flatMap((width) => variants.map((v) => ({ r, width, v }))));
  const browser = await chromium.launch();
  const rows: { route: string; width: number; variant: string; verdict: string; renames: number; detail: string }[] = [];
  await pool(jobs, 4, async ({ r, width, v }) => {
    let row = { route: r.path.replace(/\/\d+$/, "/[id]"), width, variant: v.name, verdict: "", renames: 0, detail: "" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [a, b] = await Promise.all([snap(browser, v.main, r.path, width, r.signedIn ? s.token : null, v.cookie), snap(browser, v.branch, r.path, width, r.signedIn ? s.token : null, v.cookie)]);
      const meta = a.status === b.status && a.path === b.path && a.lang === b.lang && a.dir === b.dir && a.title === b.title;
      const t = applyRename(a.text), d = applyRename(a.dom);
      const rawSame = norm(a.text) === norm(b.text) && a.dom === b.dom;
      const exact = norm(t.out) === norm(b.text) && d.out === b.dom;
      const volOnly = !exact && vol(t.out) === vol(b.text) && vol(d.out) === vol(b.dom);
      const newHyd = b.errors.filter((e) => !a.errors.includes(e));
      let i = 0; while (i < d.out.length && d.out[i] === b.dom[i]) i++;
      const rest = b.dom.includes("שירות ואחריות") || b.dom.includes("Service &amp; warranty") ? " · BRANCH still shows the old name" : "";
      row = {
        ...row, renames: d.n,
        verdict: !meta ? "META DIFFERS" : newHyd.length ? "NEW HYDRATION ERROR" : rawSame ? "identical" : exact ? "rename only" : volOnly ? "rename only (+clock)" : "OTHER DIFFERENCE",
        detail: !meta ? `main=${a.status}/${a.path}/${a.lang}/${a.dir}/"${a.title}" branch=${b.status}/${b.path}/${b.lang}/${b.dir}/"${b.title}"`
          : exact || volOnly || rawSame ? rest : `after the rename the DOM still differs @${i}: main «${d.out.slice(Math.max(0, i - 60), i + 80)}» branch «${b.dom.slice(Math.max(0, i - 60), i + 80)}»${rest}`,
      };
      if (["identical", "rename only", "rename only (+clock)"].includes(row.verdict) && !rest) break;
    }
    rows.push(row);
    console.log(`  [${row.verdict}] ${width} ${r.path} [${v.name}] renames=${row.renames}${row.detail ? " — " + row.detail : ""}`);
  });
  await browser.close();
  const bad = rows.filter((x) => !["identical", "rename only", "rename only (+clock)"].includes(x.verdict) || x.detail);
  const count = (v: string) => rows.filter((x) => x.verdict === v).length;
  const summary = {
    pages: rows.length, identical: count("identical"), renameOnly: count("rename only"), renameOnlyPlusClock: count("rename only (+clock)"),
    otherDifferences: bad.length, renameOccurrences: rows.reduce((n, x) => n + x.renames, 0),
  };
  writeFileSync(`${OUT}/rename-proof.json`, JSON.stringify({ summary, rows: rows.sort((x, y) => (x.route + x.width + x.variant).localeCompare(y.route + y.width + y.variant)), bad }, null, 1));
  const md = [`## #1264 rename proof`, ``, `| pages | identical | rename only | rename only (+clock) | other differences | rename occurrences |`, `| --- | --- | --- | --- | --- | --- |`,
    `| ${summary.pages} | ${summary.identical} | ${summary.renameOnly} | ${summary.renameOnlyPlusClock} | **${summary.otherDifferences}** | ${summary.renameOccurrences} |`, ``,
    ...(bad.length ? ["### Differences other than the rename", "", ...bad.map((x) => `- ${x.width} ${x.route} [${x.variant}] — ${x.verdict} ${x.detail}`)] : ["No difference other than the rename on any page, width or variant."])].join("\n");
  writeFileSync(`${OUT}/rename-proof.md`, md);
  console.log("\n" + md);
  await prisma.$disconnect();
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
