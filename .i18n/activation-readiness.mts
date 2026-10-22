/* eslint-disable @typescript-eslint/no-explicit-any -- E2E harness: loose JSON / DOM payloads */
/**
 * English activation readiness — EVERY page route, on two production builds of the SAME commit that run
 * side by side on an ephemeral PostgreSQL (CI service container only):
 *   ON   http://localhost:3611  built + started with DUBIZ_I18N_ENABLED=true
 *   OFF  http://localhost:3612  built + started without the flag (= Production today)
 *
 *   R1  route matrix (flag ON): every reachable route × {he, en} × {390, 820, 1440}: HTTP status, error
 *       boundary, console / page errors (counted), <html lang/dir>, horizontal overflow, Hebrew still
 *       visible in English (reported, excluding user data), screenshot.
 *       FAILS on: wrong lang/dir; an English-only problem (status ≥ 500, error boundary, page error or
 *       overflow that the Hebrew render of the same route/width does not have).
 *  R2  Hebrew users unaffected: for every reachable route × {390, 820, 1440}, flag ON with NO cookie and
 *       with dz_locale=he render the same visible text, <title>, lang/dir and final path as the flag-OFF
 *       build (normalisation: readiness-lib normalizeVisible). Plus: an English browser
 *       (Accept-Language: en-US, navigator.language en-US) without a cookie stays Hebrew = OFF.
 *       Plus: the server HTML of ON with no cookie and with dz_locale=he is byte-identical.
 *  R3  isolation: two businesses / two users / two browsers; A switches to English in Settings →
 *       B stays Hebrew (text identical to before), A's and B's data unchanged (row hashes of every
 *       business-scoped table), switching back restores A's Hebrew text identically.
 *  R4  public / customer-facing: the Hebrew-only marketing pages keep their content RTL/Hebrew under an
 *       owner's dz_locale=en cookie; customer-facing modules (PDF, WhatsApp texts, web-form page,
 *       payment providers, uniform file) reach no locale reader (static import walk).
 *  R6  emails: the account emails are stored with the requesting browser's locale and rendered from
 *       the stored row; with the flag OFF a dz_locale=en cookie still yields Hebrew.
 *
 * Synthetic data only. No secrets, no Neon, no provider, nothing sent.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { signAuthToken } from "../lib/auth-token";
import { he as HE } from "../lib/i18n/messages/he";
import {
  enumeratePages, fillRoute, isHebrewOnlyPublic, localeReaders, normalizeVisible, routeAudience, type PageRoute,
} from "./readiness-lib";

const ON = process.env.I18N_ON_BASE ?? "http://localhost:3611";
const OFF = process.env.I18N_OFF_BASE ?? "http://localhost:3612";
const OUT = process.env.READINESS_OUT ?? "readiness-out";
const WORKERS = Number(process.env.READINESS_WORKERS ?? 4);
const ONLY = process.env.READINESS_ONLY ? new RegExp(process.env.READINESS_ONLY) : null;
if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("ABORT: readiness runs only against the local CI service container");
  process.exit(2);
}
mkdirSync(`${OUT}/shots`, { recursive: true });

const prisma = new PrismaClient();
let pass = 0;
const failures: string[] = [];
const report: Record<string, any> = {};
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;
const DAY = 86400_000;
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
type Vp = (typeof VIEWPORTS)[number];

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

// ───────────────────────────── seed ─────────────────────────────
type Biz = { id: number; userId: number; token: string; data: string[]; fills: Record<string, Record<string, string>>; unseeded: Record<string, string> };

async function seedBusiness(label: string, customer: string): Promise<Biz> {
  const b = await prisma.business.create({ data: { name: `e2e-${label}-${uniq()}` } });
  const u = await prisma.user.create({ data: { email: `e2e-${label}-${uniq()}@example.test`, password: "x", businessId: b.id, role: "USER", name: `${label} Owner` } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: `${label} Synthetic Ltd`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "e2e@example.test" } });
  const c = await prisma.customer.create({ data: { businessId: b.id, name: customer, phone: "0501234567" } });
  const inv = await prisma.billingDocument.create({
    data: {
      businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: c.id,
      customerNameSnapshot: customer, currency: "ILS", subtotalAmount: "847.46", vatAmount: "152.54", totalAmount: "1000.00",
      documentNumber: 800000 + b.id, documentNumberFormatted: String(800000 + b.id), issuedAt: new Date(Date.now() - 40 * DAY),
    },
  });
  const fills: Biz["fills"] = {
    "*": { id: "999999", customerId: String(c.id), documentId: "999999", area: "goal", category: "money" },
    "/customers/[id]": { id: String(c.id) },
    "/billing/[id]": { id: String(inv.id) },
    "/admin/businesses/[id]": { id: String(b.id) },
    "/admin/businesses/[id]/features": { id: String(b.id) },
  };
  const unseeded: Record<string, string> = {};
  const data = [b.name, customer, `${label} Synthetic Ltd`, `${label} Owner`];
  /** targets: [pattern, dynamic-segment name] pairs that take the new row's id. */
  const tryRow = async (targets: Array<[string, string]>, what: string, make: () => Promise<{ id: number | string }>) => {
    try {
      const row = await make();
      for (const [p, param] of targets) fills[p] = { ...(fills[p] ?? {}), [param]: String(row.id) };
    } catch (e) {
      for (const [p] of targets) unseeded[p] = `${what}: seed failed (${(e as Error).message.split("\n").filter(Boolean).pop()?.slice(0, 120)}) — rendered with id 999999 (not-found state)`;
    }
  };
  await tryRow([["/leads/[id]", "id"]], "Lead", () => prisma.lead.create({ data: { businessId: b.id, customerName: customer, phone: "0501234567", customerId: c.id } }));
  await tryRow([["/suppliers/[id]", "id"]], "Supplier", () => prisma.supplier.create({ data: { businessId: b.id, name: `${label} Supplier` } }));
  data.push(`${label} Supplier`);
  await tryRow([["/inventory/items/[id]", "id"]], "InventoryItem", () => prisma.inventoryItem.create({ data: { businessId: b.id, name: `${label} Widget`, unitType: "UNIT" } }));
  data.push(`${label} Widget`);
  await tryRow([["/payments/[id]", "id"]], "PaymentRequest", () => (prisma as any).paymentRequest.create({ data: { businessId: b.id, customerId: c.id, billingDocumentId: inv.id, provider: "CARDCOM", amount: "1000.00", currency: "ILS", status: "PENDING" } }));
  await tryRow([["/documents/review/[id]", "id"], ["/payables/match/[documentId]", "documentId"]], "Document", () => prisma.document.create({ data: { businessId: b.id, fileUrl: `synthetic://${uniq()}.pdf`, source: "UPLOAD", mimeType: "application/pdf", status: "PROCESSED", originalFilename: `${label}-receipt.pdf` } }));
  data.push(`${label}-receipt.pdf`);
  await tryRow([["/inventory/supplier-purchases/[id]/receive", "id"], ["/inventory/supplier-purchases/[id]/send", "id"]], "PurchaseOrder", () => (prisma as any).purchaseOrder.create({ data: { businessId: b.id } }));
  await tryRow([["/payables/[id]", "id"]], "Commitment", () => (prisma as any).commitment.create({ data: { businessId: b.id, title: `${label} Rent`, payeeNameSnapshot: `${label} Landlord`, scheduleKind: "ONE_OFF", totalAmount: "500.00" } }));
  data.push(`${label} Rent`, `${label} Landlord`);
  await tryRow([["/revenue/coupons/[id]", "id"]], "Coupon", async () => {
    const offer = await (prisma as any).offer.create({ data: { issuingBusinessId: b.id, title: `${label} Offer`, customerBenefitText: `${label} benefit`, validUntil: new Date(Date.now() + 30 * DAY) } });
    const cp = await (prisma as any).coupon.create({ data: { offerId: offer.id, issuingBusinessId: b.id, token: `T${uniq()}`, qrValue: `Q${uniq()}`, expiresAt: new Date(Date.now() + 30 * DAY) } });
    return { id: cp.publicId };
  });
  data.push(`${label} Offer`, `${label} benefit`);
  await tryRow([["/settings/import-export/historical/records/[id]", "id"]], "HistoricalFiscalDocument", () => (prisma as any).historicalFiscalDocument.create({ data: { businessId: b.id, documentTypeCode: "305", sourceSystemCode: "OTHER", customerNameSnapshot: customer, currency: "ILS" } }));
  unseeded["/recommendations/[id]"] = "OutcomeRecommendation: generated by the knowledge pipeline (versioned evidence fingerprints), not hand-seeded — rendered with id 999999 (not-found state)";
  return { id: b.id, userId: u.id, token: signAuthToken(u.id), data, fills, unseeded };
}

// ───────────────────────────── browser helpers ─────────────────────────────
type Shot = {
  status: number | null; path: string; lang: string; dir: string; title: string; text: string; overflow: number;
  consoleErrors: string[]; pageErrors: string[]; errorBoundary: boolean; hebrew: string[];
};
type Cfg = { base: string; token: string | null; locale: "he" | "en" | null; vp: Vp; browserLocale?: string };

const ERROR_BOUNDARY = /Application error: a (client|server)-side exception|Internal Server Error|This page couldn.t load|Something went wrong!?$/m;

async function newCtx(browser: Browser, cfg: Cfg): Promise<BrowserContext> {
  const bl = cfg.browserLocale ?? "he-IL";
  const ctx = await browser.newContext({
    locale: bl,
    viewport: { width: cfg.vp.width, height: cfg.vp.height },
    extraHTTPHeaders: { "accept-language": bl === "en-US" ? "en-US,en;q=0.9" : "he-IL,he;q=0.9" },
  });
  if (cfg.token) await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque origin */ } }, cfg.token);
  if (cfg.locale) await ctx.addCookies([{ name: "dz_locale", value: cfg.locale, url: cfg.base }]);
  return ctx;
}

async function read(page: Page, exclude: string[]) {
  return page.evaluate((ex) => {
    const hebrew = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? "").trim();
      if (!/[֐-׿]/.test(t)) continue;
      const el = n.parentElement;
      if (!el || el.closest("script,style,noscript,[aria-hidden=true]")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (ex.some((e) => t.includes(e))) continue;
      hebrew.add(t.slice(0, 80));
    }
    return {
      path: location.pathname, lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title,
      text: document.body.innerText, overflow: document.documentElement.scrollWidth - window.innerWidth, hebrew: [...hebrew],
    };
  }, exclude);
}

async function visit(browser: Browser, cfg: Cfg, route: string, exclude: string[], shotPath?: string): Promise<Shot> {
  const ctx = await newCtx(browser, cfg);
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
  let status: number | null = null;
  try {
    const res = await page.goto(cfg.base + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
    status = res?.status() ?? null;
  } catch (e) {
    pageErrors.push(`navigation: ${(e as Error).message.slice(0, 160)}`);
  }
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  // Settle: two consecutive identical reads (client redirects / data fetches land mid-read otherwise).
  let last: Awaited<ReturnType<typeof read>> | null = null;
  for (let i = 0, same = 0; i < 16 && same < 2; i++) {
    await page.waitForTimeout(i === 0 ? 300 : 500);
    try {
      const cur = await read(page, exclude);
      same = last && cur.path === last.path && cur.text === last.text && cur.title === last.title && cur.text.trim() !== "" ? same + 1 : 0;
      last = cur;
    } catch { same = 0; }
  }
  if (!last) last = { path: "?", lang: "?", dir: "?", title: "?", text: "", overflow: 0, hebrew: [] };
  if (shotPath) await page.screenshot({ path: shotPath, type: "jpeg", quality: 55 }).catch(() => undefined);
  await ctx.close();
  return { status, ...last, consoleErrors, pageErrors, errorBoundary: ERROR_BOUNDARY.test(last.text) };
}

const slug = (r: string) => (r === "/" ? "_root" : r.replace(/[/?=&]/g, "_"));

// ───────────────────────────── main ─────────────────────────────
async function main() {
  const routes = enumeratePages("app");
  const A = await seedBusiness("A", "Alpha Customer");
  const B = await seedBusiness("B", "לקוח בטא");
  const browser = await chromium.launch();

  // Route list: every page.tsx; dynamic segments filled from A's rows.
  type Item = { route: PageRoute; url: string; audience: ReturnType<typeof routeAudience>; note?: string };
  const items: Item[] = [];
  const unreachable: Array<{ pattern: string; reason: string }> = [];
  for (const r of routes) {
    const url = fillRoute(r.pattern, A.fills);
    if (!url) { unreachable.push({ pattern: r.pattern, reason: "no value for a dynamic segment" }); continue; }
    const audience = routeAudience(r);
    let note: string | undefined = A.unseeded[r.pattern];
    if (audience === "platform-admin") note = "platform-admin only (admin role + MFA step-up, gated by the API): rendered in its denied / signed-in-owner state";
    if (r.pattern === "/reset-password") note = "needs a one-time reset token: rendered in its missing-token state";
    if (r.pattern === "/verify-email") note = "needs a one-time verification token (consumed on open): rendered in its missing-token state";
    if (r.pattern === "/") note = "redirects to /app (on the apex host it is rewritten to /home)";
    if (ONLY && !ONLY.test(r.pattern)) continue;
    items.push({ route: r, url, audience, note });
  }
  report.routes = { total: routes.length, visited: items.length, unreachable, notes: items.filter((i) => i.note).map((i) => ({ pattern: i.route.pattern, note: i.note })) };
  console.log(`routes: ${routes.length} page files, ${items.length} visited, ${unreachable.length} not fillable`);
  const tokenFor = (it: Item, biz: Biz) => (it.audience === "public" ? null : biz.token);
  const excludeA = [...A.data, "עברית"]; // "עברית" = the Hebrew option of the language picker (a language is named in itself)

  // ── R1 route matrix (flag ON) ──
  console.log("\n== R1 — route matrix: every route × he/en × 390/820/1440 (flag ON) ==");
  type Cell = { route: string; vp: string; locale: string } & Omit<Shot, "text">;
  const matrix: Cell[] = [];
  const jobs = items.flatMap((it) => VIEWPORTS.flatMap((vp) => (["he", "en"] as const).map((locale) => ({ it, vp, locale }))));
  await pool(jobs, WORKERS, async ({ it, vp, locale }) => {
    const s = await visit(browser, { base: ON, token: tokenFor(it, A), locale, vp }, it.url, excludeA, `${OUT}/shots/${vp.name}-${locale}${slug(it.url)}.jpg`);
    const rest: Omit<Shot, "text"> & { text?: string } = { ...s };
    delete rest.text;
    matrix.push({ route: it.route.pattern, vp: vp.name, locale, ...rest, hebrew: locale === "en" ? s.hebrew : [] });
  });
  const cell = (r: string, vp: string, l: string) => matrix.find((c) => c.route === r && c.vp === vp && c.locale === l)!;
  for (const it of items) {
    for (const vp of VIEWPORTS) {
      const h = cell(it.route.pattern, vp.name, "he");
      const e = cell(it.route.pattern, vp.name, "en");
      const tag = `${vp.name} ${it.route.pattern}`;
      ok(`R1 ${tag} he — lang/dir he/rtl`, h.lang === "he" && h.dir === "rtl", `${h.lang}/${h.dir}`);
      ok(`R1 ${tag} en — lang/dir en/ltr`, e.lang === "en" && e.dir === "ltr", `${e.lang}/${e.dir}`);
      ok(`R1 ${tag} en — no English-only server error`, !((e.status ?? 0) >= 500 && (h.status ?? 0) < 500), `${h.status}→${e.status}`);
      ok(`R1 ${tag} en — no English-only error boundary`, !(e.errorBoundary && !h.errorBoundary));
      const newErr = e.pageErrors.filter((x) => !h.pageErrors.includes(x));
      ok(`R1 ${tag} en — no English-only page error`, newErr.length === 0, newErr.join(" | "));
      ok(`R1 ${tag} en — no English-only horizontal overflow`, !(e.overflow > 1 && e.overflow > h.overflow + 1), `he ${h.overflow}px, en ${e.overflow}px`);
    }
  }
  const sum = (f: (c: Cell) => boolean) => matrix.filter(f).length;
  const hebrewLeft: Record<string, string[]> = {};
  for (const c of matrix) if (c.locale === "en" && c.hebrew.length && !isHebrewOnlyPublic(routes.find((r) => r.pattern === c.route)!)) {
    hebrewLeft[c.route] = [...new Set([...(hebrewLeft[c.route] ?? []), ...c.hebrew])];
  }
  report.matrix = {
    cells: matrix.length,
    status: Object.fromEntries([...new Set(matrix.map((c) => String(c.status)))].map((s) => [s, sum((c) => String(c.status) === s)])),
    errorBoundary: { he: sum((c) => c.locale === "he" && c.errorBoundary), en: sum((c) => c.locale === "en" && c.errorBoundary) },
    withConsoleErrors: { he: sum((c) => c.locale === "he" && c.consoleErrors.length > 0), en: sum((c) => c.locale === "en" && c.consoleErrors.length > 0) },
    consoleErrorsTotal: { he: matrix.filter((c) => c.locale === "he").reduce((n, c) => n + c.consoleErrors.length, 0), en: matrix.filter((c) => c.locale === "en").reduce((n, c) => n + c.consoleErrors.length, 0) },
    withPageErrors: { he: sum((c) => c.locale === "he" && c.pageErrors.length > 0), en: sum((c) => c.locale === "en" && c.pageErrors.length > 0) },
    overflow: { he: sum((c) => c.locale === "he" && c.overflow > 1), en: sum((c) => c.locale === "en" && c.overflow > 1) },
    overflowCells: matrix.filter((c) => c.overflow > 1).map((c) => `${c.vp} ${c.locale} ${c.route} ${c.overflow}px`),
    errorCells: matrix.filter((c) => c.errorBoundary || c.pageErrors.length || (c.status ?? 0) >= 400).map((c) => `${c.vp} ${c.locale} ${c.route} status=${c.status} boundary=${c.errorBoundary} pageErrors=${c.pageErrors.slice(0, 2).join(" | ")}`),
    consoleErrorSamples: Object.fromEntries([...new Set(matrix.flatMap((c) => c.consoleErrors))].slice(0, 40).map((m) => [m, sum((c) => c.consoleErrors.includes(m))])),
    redirected: [...new Set(matrix.filter((c) => c.path !== fillRoute(c.route, A.fills)?.split("?")[0]).map((c) => `${c.route} → ${c.path}`))],
    hebrewLeftRoutes: Object.keys(hebrewLeft).length,
    hebrewLeft,
  };
  writeFileSync(`${OUT}/matrix.json`, JSON.stringify(matrix, null, 1));

  // ── R2 Hebrew users unaffected ──
  console.log("\n== R2 — Hebrew parity: flag ON (no cookie / dz_locale=he / English browser) = flag OFF ==");
  const parity: Array<{ route: string; vp: string; variant: string; result: "identical" | "identical-after-volatile" | "expected" | "different"; attempts: number; detail?: string }> = [];
  const COMING_SOON = HE.settingsLocale.comingSoon;
  const compare = (off: Shot, on: Shot, route: string) => {
    const meta = off.lang === on.lang && off.dir === on.dir && off.title === on.title && off.path === on.path && on.lang === "he" && on.dir === "rtl";
    if (!meta) return { r: "different" as const, d: `meta off=${off.lang}/${off.dir}/"${off.title}"/${off.path} on=${on.lang}/${on.dir}/"${on.title}"/${on.path}` };
    const [ro, rn] = [normalizeVisible(off.text, "raw"), normalizeVisible(on.text, "raw")];
    if (ro === rn) return { r: "identical" as const };
    if (normalizeVisible(off.text, "volatile") === normalizeVisible(on.text, "volatile")) return { r: "identical-after-volatile" as const };
    // The one intentional difference: with the flag OFF the language picker says "בקרוב" (coming soon).
    if (route === "/settings/workspace" && normalizeVisible(ro.replace(COMING_SOON, ""), "volatile") === normalizeVisible(rn, "volatile")) return { r: "expected" as const, d: `flag OFF shows "${COMING_SOON}" under the disabled language picker` };
    let i = 0;
    while (i < ro.length && ro[i] === rn[i]) i++;
    return { r: "different" as const, d: `first difference @${i}: off «${ro.slice(Math.max(0, i - 40), i + 80)}» on «${rn.slice(Math.max(0, i - 40), i + 80)}»` };
  };
  const pjobs = [
    ...items.flatMap((it) => VIEWPORTS.map((vp) => ({ it, vp, variant: "he-browser" as const }))),
    ...items.map((it) => ({ it, vp: VIEWPORTS[2] as Vp, variant: "en-US-browser" as const })),
    ...items.map((it) => ({ it, vp: VIEWPORTS[0] as Vp, variant: "en-US-browser" as const })),
  ];
  await pool(pjobs, WORKERS, async ({ it, vp, variant }) => {
    const bl = variant === "en-US-browser" ? "en-US" : "he-IL";
    const token = tokenFor(it, A);
    const ex = excludeA;
    const ons: Array<[string, Cfg]> = variant === "he-browser"
      ? [["no-cookie", { base: ON, token, locale: null, vp, browserLocale: bl }], ["dz_locale=he", { base: ON, token, locale: "he", vp, browserLocale: bl }]]
      : [["en-US browser, no cookie", { base: ON, token, locale: null, vp, browserLocale: bl }]];
    const pending = new Map(ons.map(([name]) => [name, 0]));
    for (let attempt = 1; attempt <= 3 && pending.size; attempt++) {
      const offCfg: Cfg = { base: OFF, token, locale: null, vp, browserLocale: bl };
      const names = [...pending.keys()];
      const shots = await Promise.all([visit(browser, offCfg, it.url, ex), ...names.map((n) => visit(browser, ons.find(([x]) => x === n)![1], it.url, ex))]);
      names.forEach((n, k) => {
        const c = compare(shots[0], shots[k + 1], it.route.pattern);
        if (c.r !== "different" || attempt === 3) {
          parity.push({ route: it.route.pattern, vp: vp.name, variant: n, result: c.r, attempts: attempt, detail: c.d });
          pending.delete(n);
        }
      });
    }
  });
  for (const p of parity) ok(`R2 ${p.vp} ${p.route} [${p.variant}] — same as flag OFF`, p.result !== "different", p.detail);
  // Server HTML: no cookie vs dz_locale=he on the ON build — byte for byte.
  const ssr: Array<{ route: string; identical: boolean; bytes: number }> = [];
  await pool(items, WORKERS, async (it) => {
    const get = async (cookie?: string) => {
      const r = await fetch(ON + it.url, { redirect: "manual", headers: { "accept-language": "en-US,en;q=0.9", ...(cookie ? { cookie } : {}) } });
      return `${r.status} ${r.headers.get("location") ?? ""}\n${await r.text()}`;
    };
    const [a, b] = [await get(), await get("dz_locale=he")];
    ssr.push({ route: it.route.pattern, identical: a === b, bytes: a.length });
  });
  for (const s of ssr) ok(`R2 ${s.route} — server HTML byte-identical (no cookie vs dz_locale=he)`, s.identical);
  const pc = (v: string, r: string) => parity.filter((p) => p.variant === v && p.result === r).length;
  report.parity = {
    comparisons: parity.length,
    byVariant: Object.fromEntries(["no-cookie", "dz_locale=he", "en-US browser, no cookie"].map((v) => [v, { identical: pc(v, "identical"), identicalAfterVolatile: pc(v, "identical-after-volatile"), expected: pc(v, "expected"), different: pc(v, "different") }])),
    retried: parity.filter((p) => p.attempts > 1).map((p) => `${p.vp} ${p.route} [${p.variant}] ×${p.attempts} → ${p.result}`),
    differences: parity.filter((p) => p.result !== "identical").map((p) => `${p.vp} ${p.route} [${p.variant}] ${p.result}${p.detail ? ": " + p.detail : ""}`),
    ssrIdentical: ssr.filter((s) => s.identical).length,
    ssrTotal: ssr.length,
  };

  // ── R3 isolation ──
  console.log("\n== R3 — two businesses, two users, two browsers ==");
  {
    const SAMPLE = ["/app", "/collection", "/customers", "/billing", "/leads", "/settings", "/settings/workspace", "/inventory"];
    const tables: string[] = (await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT table_name AS t FROM information_schema.columns WHERE table_schema='public' AND column_name='businessId' ORDER BY 1`)).map((r) => r.t);
    const snapshot = async (biz: Biz) => {
      const out: Record<string, string> = {};
      for (const t of tables) {
        const [row] = await prisma.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(`SELECT count(*) AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM "${t}" x WHERE "businessId" = $1`, biz.id);
        out[t] = `${row.n}:${row.h ?? "-"}`;
      }
      const [bz] = await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT md5(x::text) AS h FROM "Business" x WHERE id = $1`, biz.id);
      const [us] = await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT md5(x::text) AS h FROM "User" x WHERE id = $1`, biz.userId);
      out["Business(row)"] = bz.h; out["User(row)"] = us.h;
      return out;
    };
    const desktop = VIEWPORTS[2];
    const texts = async (biz: Biz, ctx: BrowserContext) => {
      const res: Record<string, { lang: string; dir: string; title: string; text: string }> = {};
      for (const r of SAMPLE) {
        const page = await ctx.newPage();
        await page.goto(ON + r, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        let last = "";
        for (let i = 0, same = 0; i < 16 && same < 2; i++) { await page.waitForTimeout(500); const cur = await page.evaluate(() => document.body.innerText).catch(() => ""); same = cur === last && cur ? same + 1 : 0; last = cur; }
        res[r] = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title, text: document.body.innerText }));
        await page.close();
      }
      void biz;
      return res;
    };
    const ctxA = await newCtx(browser, { base: ON, token: A.token, locale: null, vp: desktop });
    const ctxB = await newCtx(browser, { base: ON, token: B.token, locale: null, vp: desktop });
    // Warm-up: two Hebrew passes so visit side effects (if any) settle; tables that still move under
    // Hebrew-only browsing are reported as "visit side effects", not attributed to the language.
    await texts(A, ctxA); await texts(B, ctxB);
    const s0 = { a: await snapshot(A), b: await snapshot(B) };
    const heA = await texts(A, ctxA); const heB = await texts(B, ctxB);
    const s1 = { a: await snapshot(A), b: await snapshot(B) };
    const moving = new Set([...tables, "Business(row)", "User(row)"].filter((t) => s0.a[t] !== s1.a[t] || s0.b[t] !== s1.b[t]));
    // A switches to English through the real Settings control.
    const page = await ctxA.newPage();
    await page.goto(ON + "/settings/workspace", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.getByRole("radio", { name: "English" }).click();
    await page.waitForLoadState("load"); await page.waitForTimeout(1500);
    ok("R3 — A switched to English via Settings", (await page.evaluate(() => document.documentElement.lang)) === "en");
    await page.close();
    const enA = await texts(A, ctxA);
    const afterB = await texts(B, ctxB);
    const s2 = { a: await snapshot(A), b: await snapshot(B) };
    for (const r of SAMPLE) {
      ok(`R3 ${r} — A is English`, enA[r].lang === "en" && enA[r].dir === "ltr", `${enA[r].lang}/${enA[r].dir}`);
      ok(`R3 ${r} — B still Hebrew, text unchanged`, afterB[r].lang === "he" && afterB[r].dir === "rtl" && afterB[r].title === heB[r].title && normalizeVisible(afterB[r].text, "volatile") === normalizeVisible(heB[r].text, "volatile"));
      ok(`R3 ${r} — B never shows A's data`, !A.data.slice(1).some((d) => afterB[r].text.includes(d)));
    }
    const changed = (x: Record<string, string>, y: Record<string, string>) => Object.keys(x).filter((t) => !moving.has(t) && x[t] !== y[t]);
    ok("R3 — A's data unchanged by the English session (every business-scoped table)", changed(s1.a, s2.a).length === 0, changed(s1.a, s2.a).join(","));
    ok("R3 — B's data unchanged", changed(s1.b, s2.b).length === 0, changed(s1.b, s2.b).join(","));
    // A switches back.
    const back = await ctxA.newPage();
    await back.goto(ON + "/settings/workspace", { waitUntil: "domcontentloaded" });
    await back.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await back.getByRole("radio", { name: "עברית" }).click();
    await back.waitForLoadState("load"); await back.waitForTimeout(1500);
    await back.close();
    const heA2 = await texts(A, ctxA);
    const s3 = { a: await snapshot(A), b: await snapshot(B) };
    let rawSame = 0;
    for (const r of SAMPLE) {
      const raw = heA2[r].text === heA[r].text;
      if (raw) rawSame++;
      ok(`R3 ${r} — A back in Hebrew, identical to before`, heA2[r].lang === "he" && heA2[r].dir === "rtl" && heA2[r].title === heA[r].title && (raw || normalizeVisible(heA2[r].text, "volatile") === normalizeVisible(heA[r].text, "volatile")));
    }
    ok("R3 — A's data unchanged after switching back", changed(s1.a, s3.a).length === 0, changed(s1.a, s3.a).join(","));
    report.isolation = { sample: SAMPLE, tablesHashed: tables.length + 2, visitSideEffectTables: [...moving], backToHebrewByteIdentical: `${rawSame}/${SAMPLE.length}` };
    await ctxA.close(); await ctxB.close();
  }

  // ── R4 public / customer-facing ──
  console.log("\n== R4 — public & customer-facing pages under an owner's dz_locale=en cookie ==");
  {
    const pub = items.filter((i) => isHebrewOnlyPublic(i.route));
    const rows: any[] = [];
    for (const it of pub) {
      for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
        const ctx = await newCtx(browser, { base: ON, token: null, locale: "en", vp });
        const page = await ctx.newPage();
        await page.goto(ON + it.url, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        const r = await page.evaluate(() => {
          const main = document.querySelector("#main-content") ?? document.body;
          const wrap = main.closest("[lang]") as HTMLElement | null;
          return { html: `${document.documentElement.lang}/${document.documentElement.dir}`, mainDir: getComputedStyle(main).direction, contentLang: wrap?.lang ?? "", overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        rows.push({ route: it.route.pattern, vp: vp.name, ...r });
        ok(`R4 ${vp.name} ${it.route.pattern} — Hebrew-only content stays RTL + lang=he under dz_locale=en`, r.mainDir === "rtl" && r.contentLang === "he", JSON.stringify(r));
        ok(`R4 ${vp.name} ${it.route.pattern} — no horizontal overflow under dz_locale=en`, r.overflow <= 1, `${r.overflow}px`);
        await ctx.close();
      }
    }
    // Static: customer-facing modules never read the interface language.
    const CUSTOMER_FACING = [
      "lib/services/billing/collection/collection-message.ts",
      "lib/services/billing/pdf/billing-pdf-html-template.ts",
      "lib/services/billing/pdf/billing-pdf-html-renderer.ts",
      "lib/services/billing/billing-pdf.service.ts",
      "lib/services/billing/quote-pdf.service.ts",
      "app/api/billing/documents/[id]/pdf/route.ts",
      "app/api/intake/acquisition/web/[publicId]/route.ts",
      "lib/services/payments/payment-request.service.ts",
      "lib/services/payments/providers/cardcom/cardcom.provider.ts",
      "lib/services/payments/providers/sumit/sumit.provider.ts",
      "lib/services/payments/providers/paypal/paypal.provider.ts",
      "lib/services/billing/uniform/uniform-export-package.service.ts",
    ];
    const staticRows = CUSTOMER_FACING.map((f) => { try { return { file: f, readers: localeReaders(process.cwd(), f).map((h) => h.chain.join(" > ")) }; } catch (e) { return { file: f, readers: [`unreadable: ${(e as Error).message}`] }; } });
    for (const s of staticRows) ok(`R4 static — ${s.file} reaches no locale reader`, s.readers.length === 0, s.readers.join(" ; "));
    report.customerFacing = { publicPages: rows, staticModules: staticRows };
  }

  // ── R6 emails ──
  console.log("\n== R6 — account emails follow the stored locale ==");
  {
    // Route → getServerI18n().locale → TransactionalEmail.locale → rendered from the row (delivery.ts).
    // Routes that enqueue an account email read the locale exactly through the flag-gated resolver:
    const routesWithLocale = ["app/api/auth/register/route.ts", "app/api/auth/password/forgot/route.ts", "app/api/auth/email/resend/route.ts", "app/api/auth/email/verify/route.ts"];
    const { readFileSync } = await import("fs");
    for (const f of routesWithLocale) ok(`R6 ${f} — locale comes from getServerI18n (cookie, flag-gated)`, /const \{[^}]*locale[^}]*\} = await getServerI18n\(\)/.test(readFileSync(f, "utf8")));
    const { enqueueAccountLinkEmail } = await import("../lib/email/transactional/store");
    const { renderStored } = await import("../lib/email/transactional/registry");
    const { getRequestLocale } = await import("../lib/i18n/server");
    // Outside a request scope with the flag unset (this process), the resolver answers Hebrew and never reads a cookie.
    ok("R6 — flag OFF (this process): resolver answers he without a request", (await getRequestLocale()) === "he");
    const rows: Record<string, string> = {};
    for (const [label, locale] of [["absent", undefined], ["he", "he"], ["en", "en"]] as const) {
      try {
        const id = await enqueueAccountLinkEmail(prisma, { kind: "PASSWORD_RESET", tokenId: crypto.randomUUID(), userId: A.userId, businessId: A.id, toEmail: "e2e@example.test", name: "A Owner", now: new Date(), locale });
        const [row] = await prisma.$queryRawUnsafe<{ locale: string; kind: string; payload: any }[]>(`SELECT locale, kind, payload FROM "TransactionalEmail" WHERE id = $1`, Number(id));
        const rendered = renderStored(row.kind, row.payload, { appBaseUrl: "https://example.test", locale: row.locale });
        const html = rendered ? /<html lang="(\w+)" dir="(\w+)"/.exec(rendered.html)?.slice(1).join("/") ?? "?" : "not rendered";
        rows[label] = `stored ${row.locale} → rendered ${html}`;
        const want = locale === "en" ? "en" : "he";
        ok(`R6 enqueue locale ${label} → stored ${want}, rendered ${want === "en" ? "en/ltr" : "he/rtl"}`, row.locale === want && html === (want === "en" ? "en/ltr" : "he/rtl"), rows[label]);
      } catch (e) {
        rows[label] = `could not enqueue in this lab: ${(e as Error).message.split("\n").pop()?.slice(0, 120)}`;
        ok(`R6 enqueue locale ${label}`, false, rows[label]);
      }
    }
    report.emails = rows;
    console.log(`  stored→rendered: ${JSON.stringify(rows)}`);
  }

  await browser.close();
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ pass, failed: failures.length, failures, ...report }, null, 2));
    const m = report.matrix ?? {};
    const p = report.parity ?? {};
    console.log("\n================ SUMMARY ================");
    console.log(`routes: ${JSON.stringify(report.routes?.total)} page files, ${report.routes?.visited} visited, unreachable ${report.routes?.unreachable?.length}`);
    console.log(`matrix: ${m.cells} cells; status ${JSON.stringify(m.status)}; error boundary ${JSON.stringify(m.errorBoundary)}; page errors ${JSON.stringify(m.withPageErrors)}; console errors (cells) ${JSON.stringify(m.withConsoleErrors)} total ${JSON.stringify(m.consoleErrorsTotal)}; overflow ${JSON.stringify(m.overflow)}`);
    console.log(`hebrew left in English: ${m.hebrewLeftRoutes} routes`);
    for (const [k, v] of Object.entries((m.hebrewLeft ?? {}) as Record<string, string[]>)) console.log(`  ${k}: ${v.slice(0, 8).join(" | ")}`);
    console.log(`parity: ${JSON.stringify(p.byVariant)}; server HTML identical ${p.ssrIdentical}/${p.ssrTotal}`);
    for (const d of (p.differences ?? []).slice(0, 60)) console.log(`  ${d.slice(0, 400)}`);
    console.log(`isolation: ${JSON.stringify(report.isolation)}`);
    console.log(`emails: ${JSON.stringify(report.emails)}`);
    console.log(`overflow cells: ${(m.overflowCells ?? []).slice(0, 40).join(" ; ")}`);
    console.log(`error cells: ${(m.errorCells ?? []).slice(0, 40).join(" ; ")}`);
    console.log(`\nactivation readiness: ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.slice(0, 200).map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
