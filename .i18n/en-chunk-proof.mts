/* eslint-disable @typescript-eslint/no-explicit-any -- E2E harness: loose DOM / CDP payloads */
/**
 * CI-only proof for "the English dictionary as a cached client chunk — off the HTML".
 *
 * MAIN (origin/main) vs THIS BRANCH, each built twice (flag OFF / flag ON), all four served side by side
 * by `next start` on one runner, against the same ephemeral PostgreSQL (same seeded synthetic data):
 *   MAIN_OFF :3621   MAIN_ON :3622   BRANCH_OFF :3612   BRANCH_ON :3611
 *
 *   1 identity   20 routes × {390, 820, 1440} × 5 cookie variants (OFF: none / dz_locale=en ·
 *                ON: none / he / en), Chromium, signed-in owner for app routes: <html lang/dir>, <title>,
 *                final path, visible text and the rendered <body> DOM (scripts/styles/links and
 *                build-hashed /_next/ URLs removed) must be IDENTICAL between MAIN and BRANCH.
 *   2 bytes      server HTML per route, raw + brotli (q5 ≈ dynamic edge, q11 = max) + gzip, for he / en,
 *                MAIN vs BRANCH; the full-tree RSC payload (RSC: 1, what a router.refresh() fetches);
 *                and how many English dictionary sentinel strings each HTML carries.
 *   3 chunk      BRANCH ON, English: which /_next/static JS chunk holds the dictionary, its
 *                Cache-Control (must be immutable), that it is preloaded from the HTML, that a SECOND full
 *                page load serves it from the browser cache (CDP Network events: fromDiskCache /
 *                fromMemoryCache / requestServedFromCache — no network fetch), and that it is the same URL
 *                and the same bytes for two different English users (never user-specific). Hebrew pages
 *                (BRANCH ON he, BRANCH OFF) never request it.
 *   4 timings    Chromium navigation timing (TTFB, FCP, LCP, DCL, load) MAIN vs BRANCH, he / en,
 *                390 / 820 / 1440, 8 routes, ABBA order, 1 warm-up + N rounds, unthrottled and with a
 *                CDP "4G" profile (so the transferred bytes actually cost time). p50 per cell.
 *
 * Writes $PERF_OUT/en-chunk-proof.json + .md. Fails on any identity / chunk / cache difference.
 * Synthetic data only. No secrets, no Neon, no Production.
 */
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { brotliCompressSync, constants as zc, gzipSync } from "zlib";
import { signAuthToken } from "../lib/auth-token";
import { en } from "../lib/i18n/messages/en";

const OUT = process.env.PERF_OUT ?? "perf-out";
const B = { mainOff: "http://localhost:3621", mainOn: "http://localhost:3622", branchOff: "http://localhost:3612", branchOn: "http://localhost:3611" };
const ROUNDS = Number(process.env.EN_CHUNK_ROUNDS ?? "3");
const CONCURRENCY = Number(process.env.EN_CHUNK_WORKERS ?? "4");
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
const report: any = {};

/**
 * The English HTML byte rule. When #780 was a branch it moved the dictionary out of the HTML, so the BRANCH had
 * to be strictly SMALLER than MAIN. Since #780 is on main, an unrelated pull request builds byte-identical English
 * HTML and the strict rule failed every route on equal sizes. The rule that still guards the gain: the BRANCH
 * may not GROW the English HTML — equal passes, any growth fails.
 */
const englishHtmlNotLarger = (mainBytes: number, branchBytes: number) => branchBytes <= mainBytes;
// Self-proof of the rule itself, every run, before anything is measured: equal and smaller pass, one byte more fails.
ok("rule self-proof — equal English HTML passes", englishHtmlNotLarger(90274, 90274));
ok("rule self-proof — smaller English HTML passes", englishHtmlNotLarger(90274, 90273));
ok("rule self-proof — English HTML one byte larger fails", !englishHtmlNotLarger(90274, 90275));

// ───────────────────────────── helpers ─────────────────────────────
const p50 = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.max(1, Math.ceil(0.5 * s.length)) - 1] * 10) / 10; };
const kb = (n: number) => Math.round(n / 102.4) / 10;
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

/** Long, plain-ASCII English dictionary values (no quotes/escapes, so they appear verbatim in any payload). */
function sentinels(): string[] {
  const vals: string[] = [];
  const walk = (o: any) => { for (const v of Object.values(o)) { if (typeof v === "string") vals.push(v); else if (v && typeof v === "object") walk(v); } };
  walk(en);
  return [...new Set(vals.filter((v) => /^[A-Za-z ,.]{40,}$/.test(v)))].sort((a, b) => b.length - a.length).slice(0, 60);
}
const SENT = sentinels();
const sentinelHits = (body: string) => SENT.filter((s) => body.includes(s)).length;

async function seed() {
  const n = Date.now();
  const mk = async (tag: string) => {
    const b = await prisma.business.create({ data: { name: `enchunk-${tag}-${n}` } });
    const u = await prisma.user.create({ data: { email: `enchunk-${tag}-${n}@example.test`, password: "x", businessId: b.id, role: "USER", name: `EnChunk ${tag}` } });
    await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: `EnChunk ${tag} Ltd`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: `enchunk-${tag}@example.test`, onboardingCompletedAt: new Date(n - 30 * 86400_000) } });
    const c = await prisma.customer.create({ data: { businessId: b.id, name: "לקוח השוואה", phone: "0501234599" } });
    const inv = await prisma.billingDocument.create({
      data: {
        businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: c.id,
        customerNameSnapshot: c.name, currency: "ILS", subtotalAmount: "847.46", vatAmount: "152.54", totalAmount: "1000.00",
        documentNumber: 710000 + b.id, documentNumberFormatted: String(710000 + b.id), issuedAt: new Date(n - 40 * 86400_000),
      },
    });
    return { token: signAuthToken(u.id), customerId: c.id, invoiceId: inv.id };
  };
  return { a: await mk("a"), b: await mk("b") };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function newCtx(browser: Browser, base: string, width: number, token: string | null, cookie: string | null): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width, height: width < 500 ? 844 : width < 1000 ? 1180 : 900 }, extraHTTPHeaders: { "accept-language": "he-IL,he;q=0.9" } });
  if (token) await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  if (cookie) await ctx.addCookies([{ name: "dz_locale", value: cookie, url: base }]);
  return ctx;
}

// ───────────────────────────── 1 · identity ─────────────────────────────
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
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const vol = (s: string) => norm(s).replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "HH:MM").replace(/לפני (\d+ )?(שנייה|שניות|דקה|דקות|שעה|שעות)/g, "לפני N").replace(/\b\d+ (second|minute|hour)s? ago\b/g, "N ago");

function routesOf(s: Seed["a"]) {
  return [
    ...["/home", "/about", "/privacy", "/login", "/register", "/forgot-password"].map((p) => ({ path: p, signedIn: false })),
    ...["/app", "/collection", "/billing", `/billing/${s.invoiceId}`, "/customers", `/customers/${s.customerId}`, "/leads", "/settings", "/settings/workspace", "/secretary", "/payables", "/inventory", "/tasks", "/profile"].map((p) => ({ path: p, signedIn: true })),
  ];
}
const pathOf = (u: string) => new URL(u).pathname;
const stripQuery = (u: string) => u.split("?")[0];
const label = (p: string) => p.replace(/\/\d+$/, "/[id]");

async function identityPhase(s: Seed) {
  console.log("\n== 1 · identity: MAIN vs BRANCH, 20 routes × 390/820/1440 × 5 variants ==");
  const pairs = [
    { name: "flag OFF, no cookie", main: B.mainOff, branch: B.branchOff, cookie: null },
    { name: "flag OFF, dz_locale=en (ignored)", main: B.mainOff, branch: B.branchOff, cookie: "en" },
    { name: "flag ON, no cookie", main: B.mainOn, branch: B.branchOn, cookie: null },
    { name: "flag ON, dz_locale=he", main: B.mainOn, branch: B.branchOn, cookie: "he" },
    { name: "flag ON, dz_locale=en", main: B.mainOn, branch: B.branchOn, cookie: "en" },
  ];
  const jobs = routesOf(s.a).flatMap((r) => [390, 820, 1440].flatMap((width) => pairs.map((p) => ({ r, width, p }))));
  const browser = await chromium.launch();
  const rows: any[] = [];
  await pool(jobs, CONCURRENCY, async ({ r, width, p }) => {
    let res = { identical: false, volatileOnly: false, detail: "", lang: "", hydration: [] as string[] };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [a, b] = await Promise.all([snap(browser, p.main, r.path, width, r.signedIn ? s.a.token : null, p.cookie), snap(browser, p.branch, r.path, width, r.signedIn ? s.a.token : null, p.cookie)]);
      const meta = a.status === b.status && a.path === b.path && a.lang === b.lang && a.dir === b.dir && a.title === b.title;
      const exact = meta && norm(a.text) === norm(b.text) && a.dom === b.dom;
      const volatileOnly = !exact && meta && vol(a.text) === vol(b.text) && vol(a.dom) === vol(b.dom);
      let i = 0;
      while (i < a.dom.length && a.dom[i] === b.dom[i]) i++;
      res = {
        identical: exact, volatileOnly, lang: `${b.lang}/${b.dir}`,
        hydration: b.errors.filter((e) => !a.errors.includes(e)),
        detail: meta ? `dom differs @${i}: main «${a.dom.slice(Math.max(0, i - 60), i + 80)}» branch «${b.dom.slice(Math.max(0, i - 60), i + 80)}»` : `meta main=${a.status}/${a.path}/${a.lang}/${a.dir}/"${a.title}" branch=${b.status}/${b.path}/${b.lang}/${b.dir}/"${b.title}"`,
      };
      if ((exact || volatileOnly) && res.hydration.length === 0) break;
    }
    rows.push({ route: label(r.path), width, variant: p.name, identical: res.identical, volatileOnly: res.volatileOnly, lang: res.lang });
    ok(`${width} ${r.path} [${p.name}] — MAIN = BRANCH (meta, text, DOM)`, res.identical || res.volatileOnly, res.detail);
    ok(`${width} ${r.path} [${p.name}] — no new hydration error on BRANCH`, res.hydration.length === 0, res.hydration.join(" | "));
  });
  await browser.close();
  report.identity = { comparisons: rows.length, exact: rows.filter((x) => x.identical).length, volatileOnly: rows.filter((x) => x.volatileOnly).length, different: rows.filter((x) => !x.identical && !x.volatileOnly).length, rows };
  console.log(`identity: ${report.identity.comparisons} comparisons, ${report.identity.exact} exact, ${report.identity.volatileOnly} volatile-only, ${report.identity.different} different`);
}

// ───────────────────────────── 2 · bytes ─────────────────────────────
async function bytesPhase(s: Seed) {
  console.log("\n== 2 · server HTML / RSC bytes per route (raw, br q5, br q11, gzip) + dictionary sentinels ==");
  const variants = [["mainOnHe", B.mainOn, "dz_locale=he"], ["branchOnHe", B.branchOn, "dz_locale=he"], ["mainOnEn", B.mainOn, "dz_locale=en"], ["branchOnEn", B.branchOn, "dz_locale=en"], ["mainOff", B.mainOff, null], ["branchOff", B.branchOff, null]] as const;
  const rows: any[] = [];
  for (const r of routesOf(s.a)) {
    const row: any = { route: label(r.path) };
    for (const [k, base, cookie] of variants) {
      const res = await fetch(base + r.path, { headers: { "accept-language": "he-IL", "accept-encoding": "identity", ...(cookie ? { cookie } : {}) }, redirect: "manual" });
      const buf = Buffer.from(await res.arrayBuffer());
      const rsc = await fetch(base + r.path, { headers: { RSC: "1", "accept-language": "he-IL", "accept-encoding": "identity", ...(cookie ? { cookie } : {}) }, redirect: "follow" });
      const rbuf = Buffer.from(await rsc.arrayBuffer());
      row[k] = {
        status: res.status, raw: buf.byteLength,
        br5: brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }).byteLength,
        br11: brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
        gzip: gzipSync(buf, { level: 6 }).byteLength,
        rscRaw: rbuf.byteLength, rscBr5: brotliCompressSync(rbuf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }).byteLength,
        sentinels: sentinelHits(buf.toString("utf8")),
      };
    }
    rows.push(row);
    console.log(`${row.route.padEnd(22)} en raw ${kb(row.mainOnEn.raw)}→${kb(row.branchOnEn.raw)} KB, br5 ${kb(row.mainOnEn.br5)}→${kb(row.branchOnEn.br5)} KB, sentinels ${row.mainOnEn.sentinels}→${row.branchOnEn.sentinels} | he raw ${kb(row.mainOnHe.raw)}→${kb(row.branchOnHe.raw)} KB`);
    // Only 200 documents carry a page (redirects are tiny either way).
    if (row.branchOnEn.status === 200) {
      ok(`bytes ${row.route} — BRANCH English HTML carries no dictionary (MAIN ${row.mainOnEn.sentinels}/${SENT.length} sentinels → BRANCH < 25%: only what the page renders)`, row.branchOnEn.sentinels < SENT.length * 0.25, `sentinels=${row.branchOnEn.sentinels}`);
      ok(`bytes ${row.route} — BRANCH English HTML not larger than MAIN`, englishHtmlNotLarger(row.mainOnEn.raw, row.branchOnEn.raw), `${row.mainOnEn.raw} → ${row.branchOnEn.raw}`);
    }
    // Hebrew: the change must not grow a Hebrew document beyond the next/dynamic loader reference.
    ok(`bytes ${row.route} — BRANCH Hebrew HTML within ±2 KB of MAIN`, Math.abs(row.branchOnHe.raw - row.mainOnHe.raw) <= 2048 && Math.abs(row.branchOff.raw - row.mainOff.raw) <= 2048, `ON ${row.mainOnHe.raw}→${row.branchOnHe.raw}, OFF ${row.mainOff.raw}→${row.branchOff.raw}`);
  }
  const med = (k: string, f: string) => p50(rows.filter((x) => x[k].status === 200).map((x) => x[k][f]));
  const keys = variants.map((v) => v[0]);
  report.bytes = { sentinelCount: SENT.length, rows, median: Object.fromEntries(keys.map((k) => [k, Object.fromEntries(["raw", "br5", "br11", "gzip", "rscRaw", "rscBr5", "sentinels"].map((f) => [f, med(k, f)]))])) };
  console.log("median:", JSON.stringify(report.bytes.median));
}

// ───────────────────────────── 3 · chunk + cache ─────────────────────────────
type Net = { url: string; status: number; fromCache: boolean; cacheControl: string; bytes: number };
async function trackedLoad(page: Page, url: string): Promise<Net[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const byId = new Map<string, Net>();
  const servedFromCache = new Set<string>(); // fires BEFORE responseReceived for memory-cache hits
  cdp.on("Network.requestServedFromCache", (e: any) => { servedFromCache.add(e.requestId); const x = byId.get(e.requestId); if (x) x.fromCache = true; });
  cdp.on("Network.responseReceived", (e: any) => {
    if (!/\/_next\/static\/.*\.js(\?|$)/.test(e.response.url)) return;
    byId.set(e.requestId, { url: e.response.url.replace(/\?.*$/, ""), status: e.response.status, fromCache: servedFromCache.has(e.requestId) || !!(e.response.fromDiskCache || e.response.fromMemoryCache || e.response.fromPrefetchCache), cacheControl: e.response.headers["cache-control"] ?? e.response.headers["Cache-Control"] ?? "", bytes: 0 });
  });
  cdp.on("Network.loadingFinished", (e: any) => { const x = byId.get(e.requestId); if (x) x.bytes = e.encodedDataLength; });
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await cdp.detach().catch(() => undefined);
  return [...byId.values()].map((n) => ({ ...n, fromCache: n.fromCache || n.bytes === 0 }));
}

async function chunkPhase(s: Seed) {
  console.log("\n== 3 · English chunk(s): location, cache headers, preload, second-load cache, user-independence, Hebrew never fetches them ==");
  const browser = await chromium.launch();
  const out: any = {};
  // Which static JS file(s) hold the dictionary? Every /_next/static JS an English page loads is scanned.
  const ctxA = await newCtx(browser, B.branchOn, 1440, s.a.token, "en");
  const page = await ctxA.newPage();
  const first = await trackedLoad(page, B.branchOn + "/app");
  // The Hebrew page's JS set (same route, same build): the dictionary chunk(s) are the English-only files.
  const heCtx = await newCtx(browser, B.branchOn, 1440, s.a.token, "he");
  const heSet = new Set((await trackedLoad(await heCtx.newPage(), B.branchOn + "/app")).map((n) => n.url));
  await heCtx.close();
  const covered = new Set<string>();
  const chunks: string[] = [];
  const bufs = new Map<string, Buffer>();
  for (const n of first) {
    const buf = Buffer.from(await (await fetch(n.url)).arrayBuffer());
    const body = buf.toString("utf8");
    const hits = SENT.filter((x) => body.includes(x));
    if (hits.length >= 3 && !heSet.has(n.url)) { chunks.push(n.url); bufs.set(n.url, buf); hits.forEach((h) => covered.add(h)); }
  }
  out.firstLoad = first;
  out.coverage = `${covered.size}/${SENT.length}`;
  ok("chunk — the English-only /_next/static JS (not loaded by the Hebrew page) carries the whole dictionary (≥ 90% of sentinels)", covered.size >= Math.floor(SENT.length * 0.9), out.coverage);
  ok("chunk — the dictionary is in 1-3 dedicated chunk files", chunks.length >= 1 && chunks.length <= 3, JSON.stringify(chunks));
  const paths = chunks.map((u) => pathOf(u));
  out.chunks = [];
  for (const u of chunks) {
    const res = await fetch(u);
    const cc = res.headers.get("cache-control") ?? "";
    const buf = bufs.get(u)!;
    const p = pathOf(u);
    out.chunks.push({ path: p, cacheControl: cc, raw: buf.byteLength, br5: brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }).byteLength, br11: brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).byteLength, gzip: gzipSync(buf, { level: 6 }).byteLength });
    ok(`chunk ${p} — served under /_next/static/ with a content hash in its name`, /^\/_next\/static\/chunks\/(.*\/)?[^/]*[0-9a-z]{8,}[^/]*\.js$/i.test(p), p);
    ok(`chunk ${p} — Cache-Control public, max-age=31536000, immutable`, /public/.test(cc) && /max-age=31536000/.test(cc) && /immutable/.test(cc), cc);
  }
  console.log("chunks:", JSON.stringify(out.chunks));
  // Referenced from the English HTML (preloaded alongside the other scripts — no waterfall behind hydration).
  const htmlEn = await (await fetch(B.branchOn + "/app", { headers: { cookie: "dz_locale=en" } })).text();
  out.preloadedInHtml = paths.map((p) => htmlEn.includes(p));
  ok("chunk — every dictionary chunk is referenced (preload) from the English HTML", paths.length > 0 && out.preloadedInHtml.every(Boolean), JSON.stringify(out.preloadedInHtml));
  // Second full page loads (new navigations, same browser profile): served from the browser cache.
  out.second = {};
  for (const route of ["/app", "/collection", "/customers"]) {
    const second = await trackedLoad(page, B.branchOn + route);
    const hits = chunks.map((u) => second.find((n) => n.url === u) ?? null);
    out.second[route] = hits;
    ok(`cache — full page load of ${route} after /app: every dictionary chunk comes from the browser cache (no download)`, hits.every((h) => !!h && h.fromCache), JSON.stringify(hits));
  }
  // A reload (F5) — REPORTED, not asserted. Whether a browser refetches an immutable subresource on a
  // reload is browser policy, not something the app controls beyond `Cache-Control: immutable` (asserted
  // above); headless Chromium under Playwright refetched it in run 39956923300. The owner's requirement —
  // no repeated download on every full page load — is asserted by the full-navigation checks above.
  {
    const cdp = await ctxA.newCDPSession(page);
    await cdp.send("Network.enable");
    const rel: Record<string, any> = {};
    cdp.on("Network.responseReceived", (e: any) => { const u = stripQuery(e.response.url); if (chunks.includes(u)) rel[u] = { status: e.response.status, fromCache: !!(e.response.fromDiskCache || e.response.fromMemoryCache) }; });
    cdp.on("Network.requestServedFromCache", () => undefined);
    await page.reload({ waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    out.reload = rel;
    console.log(`  [INFO] cache — page.reload(): dictionary chunk(s) ${chunks.every((u) => rel[u]?.fromCache || (rel[u]?.status ?? 0) === 304) ? "served from cache" : "refetched by the browser on reload"} — ${JSON.stringify(rel)}`);
    await cdp.detach().catch(() => undefined);
  }
  await ctxA.close();
  // Same URLs and bytes for another English user (business B) — locale-specific, never user-specific.
  const ctxB = await newCtx(browser, B.branchOn, 390, s.b.token, "en");
  const pb = await ctxB.newPage();
  const otherUser = await trackedLoad(pb, B.branchOn + "/app");
  ok("isolation — a different English user (other business, phone width) loads the SAME chunk URLs", chunks.every((u) => otherUser.some((n) => n.url === u)), JSON.stringify(otherUser.map((n) => n.url)));
  for (const u of chunks) {
    const withCookie = Buffer.from(await (await fetch(u, { headers: { cookie: "dz_locale=en" } })).arrayBuffer());
    const anon = Buffer.from(await (await fetch(u, { headers: { cookie: "dz_locale=he" } })).arrayBuffer());
    const a = bufs.get(u)!;
    ok(`isolation — ${pathOf(u)} bytes do not depend on cookie / user`, withCookie.equals(a) && anon.equals(a));
    ok(`isolation — ${pathOf(u)} carries no user / business data`, a.indexOf("EnChunk") < 0 && a.indexOf("enchunk-") < 0);
  }
  await ctxB.close();
  // Hebrew never fetches them: BRANCH ON with he / no cookie, BRANCH OFF with the en cookie (flag off → Hebrew).
  for (const [name, base, cookie] of [["BRANCH ON, dz_locale=he", B.branchOn, "he"], ["BRANCH ON, no cookie", B.branchOn, null], ["BRANCH OFF, dz_locale=en", B.branchOff, "en"]] as const) {
    for (const route of ["/login", "/app", "/collection", "/home"]) {
      const ctx = await newCtx(browser, base, 1440, s.a.token, cookie);
      const pg = await ctx.newPage();
      const nets = await trackedLoad(pg, base + route);
      const max = Math.max(0, ...(await Promise.all(nets.map(async (n) => sentinelHits(await (await fetch(n.url)).text())))));
      const html = await (await fetch(base + route, { headers: cookie ? { cookie: `dz_locale=${cookie}` } : {} })).text();
      ok(`hebrew — ${name} ${route}: no JS file carrying English dictionary strings is requested`, max < 3 && !nets.some((n) => chunks.includes(n.url)), `max sentinels in a loaded chunk = ${max}`);
      ok(`hebrew — ${name} ${route}: the HTML does not reference the English chunk(s)`, paths.every((p) => !html.includes(p)));
      await ctx.close();
    }
  }
  // Client JS weight per page (first visit, empty cache), MAIN vs BRANCH, he / en: what each user downloads.
  out.jsWeight = [];
  for (const route of ["/login", "/app", "/collection"]) {
    for (const [name, base, cookie] of [["mainHe", B.mainOn, "he"], ["branchHe", B.branchOn, "he"], ["mainEn", B.mainOn, "en"], ["branchEn", B.branchOn, "en"]] as const) {
      const ctx = await newCtx(browser, base, 1440, s.a.token, cookie);
      const nets = await trackedLoad(await ctx.newPage(), base + route);
      await ctx.close();
      let raw = 0, br5 = 0, maxSent = 0;
      for (const n of nets) {
        const buf = Buffer.from(await (await fetch(n.url)).arrayBuffer());
        raw += buf.byteLength;
        br5 += brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }).byteLength;
        maxSent = Math.max(maxSent, sentinelHits(buf.toString("utf8")));
      }
      out.jsWeight.push({ route, variant: name, files: nets.length, raw, br5, maxSentinelsInOneFile: maxSent });
    }
    const w = (v: string) => out.jsWeight.find((x: any) => x.route === route && x.variant === v);
    console.log(`JS ${route}: he ${kb(w("mainHe").br5)}→${kb(w("branchHe").br5)} KB br, en ${kb(w("mainEn").br5)}→${kb(w("branchEn").br5)} KB br; English strings in Hebrew JS: main ${w("mainHe").maxSentinelsInOneFile} branch ${w("branchHe").maxSentinelsInOneFile}`);
    ok(`hebrew JS ${route} — BRANCH Hebrew client JS no larger than MAIN (+2 KB br for the loader)`, w("branchHe").br5 <= w("mainHe").br5 + 2048, `${w("mainHe").br5} → ${w("branchHe").br5}`);
    ok(`hebrew JS ${route} — BRANCH Hebrew client JS carries no English dictionary strings`, w("branchHe").maxSentinelsInOneFile < 3, String(w("branchHe").maxSentinelsInOneFile));
  }
  await browser.close();
  report.chunk = out;
}

// ───────────────────────────── 4 · timings ─────────────────────────────
async function timingPhase(s: Seed) {
  console.log(`\n== 4 · browser timings MAIN vs BRANCH (flag ON), he/en × 390/820/1440 × 8 routes, 1 warm-up + ${ROUNDS} rounds, unthrottled + 4G ==`);
  const routes = ["/home", "/login", "/app", "/collection", "/billing", `/billing/${s.a.invoiceId}`, "/customers", "/settings"];
  const profiles = [
    { name: "unthrottled", net: null as null | { latency: number; downloadThroughput: number; uploadThroughput: number } },
    // ≈ "4G": 40 ms RTT, 10 Mbps down, 3 Mbps up (bytes/s).
    { name: "4G", net: { latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 } },
  ];
  const browser = await chromium.launch();
  const agg: any[] = [];
  const perRoute: any[] = [];
  for (const prof of profiles) {
    for (const width of [390, 820, 1440]) {
      for (const locale of ["he", "en"] as const) {
        const ctxs = { main: await newCtx(browser, B.mainOn, width, s.a.token, locale), branch: await newCtx(browser, B.branchOn, width, s.a.token, locale) };
        const acc: Record<string, Record<string, number[]>> = {};
        for (let round = 0; round <= ROUNDS; round++) {
          for (const r of routes) {
            const order = round % 2 === 0 ? (["main", "branch"] as const) : (["branch", "main"] as const);
            for (const build of order) {
              const page = await ctxs[build].newPage();
              if (prof.net) { const cdp = await ctxs[build].newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, ...prof.net }); }
              await page.goto((build === "main" ? B.mainOn : B.branchOn) + r, { waitUntil: "load", timeout: 60_000 }).catch(() => undefined);
              const m = await page.evaluate(() => new Promise<any>((res) => {
                const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
                const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
                let lcp: number | null = null;
                try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch { /* unsupported */ }
                setTimeout(() => res({ ttfb: nav ? nav.responseStart - nav.startTime : null, fcp, lcp, dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null, load: nav ? nav.loadEventEnd - nav.startTime : null, transfer: nav ? nav.transferSize : null }), 150);
              })).catch(() => null);
              await page.close();
              if (!m || round === 0) continue;
              const k = `${build} ${r}`;
              acc[k] ??= { ttfb: [], fcp: [], lcp: [], dcl: [], load: [], transfer: [] };
              for (const f of Object.keys(acc[k])) if (typeof m[f] === "number") acc[k][f].push(m[f]);
            }
          }
        }
        await ctxs.main.close(); await ctxs.branch.close();
        const all = (build: string, f: string) => routes.flatMap((r) => acc[`${build} ${r}`]?.[f] ?? []);
        const row: any = { profile: prof.name, width, locale };
        for (const build of ["main", "branch"]) row[build] = Object.fromEntries(["ttfb", "fcp", "lcp", "dcl", "load", "transfer"].map((f) => [f, p50(all(build, f))]));
        agg.push(row);
        for (const r of routes) perRoute.push({ profile: prof.name, width, locale, route: label(r), main: Object.fromEntries(Object.entries(acc[`main ${r}`] ?? {}).map(([f, xs]) => [f, p50(xs)])), branch: Object.fromEntries(Object.entries(acc[`branch ${r}`] ?? {}).map(([f, xs]) => [f, p50(xs)])) });
        console.log(`${prof.name.padEnd(11)} ${width} ${locale}: TTFB ${row.main.ttfb}→${row.branch.ttfb} FCP ${row.main.fcp}→${row.branch.fcp} LCP ${row.main.lcp}→${row.branch.lcp} DCL ${row.main.dcl}→${row.branch.dcl} load ${row.main.load}→${row.branch.load} doc transfer ${row.main.transfer}→${row.branch.transfer}`);
      }
    }
  }
  await browser.close();
  report.timings = { rounds: ROUNDS, agg, perRoute };
}

function markdown(): string {
  const L: string[] = ["# English dictionary chunk — proof (MAIN vs BRANCH)", "", `checks: ${pass} passed, ${failures.length} failed`, ""];
  if (report.identity) L.push(`## Identity`, "", `${report.identity.comparisons} comparisons (20 routes × 390/820/1440 × 5 cookie/flag variants): ${report.identity.exact} exact, ${report.identity.volatileOnly} differ only in wall-clock text, ${report.identity.different} different.`, "");
  if (report.bytes) {
    const m = report.bytes.median;
    L.push("## HTML bytes (median over the routes that answer 200)", "", "| variant | raw KB | br q5 KB | br q11 KB | gzip KB | RSC raw KB | dictionary sentinels |", "|---|---|---|---|---|---|---|");
    for (const k of Object.keys(m)) L.push(`| ${k} | ${kb(m[k].raw)} | ${kb(m[k].br5)} | ${kb(m[k].br11)} | ${kb(m[k].gzip)} | ${kb(m[k].rscRaw)} | ${m[k].sentinels}/${report.bytes.sentinelCount} |`);
    L.push("", "| route | en MAIN raw | en BRANCH raw | en MAIN br5 | en BRANCH br5 | he MAIN raw | he BRANCH raw |", "|---|---|---|---|---|---|---|");
    for (const r of report.bytes.rows) L.push(`| ${r.route} | ${kb(r.mainOnEn.raw)} | ${kb(r.branchOnEn.raw)} | ${kb(r.mainOnEn.br5)} | ${kb(r.branchOnEn.br5)} | ${kb(r.mainOnHe.raw)} | ${kb(r.branchOnHe.raw)} |`);
    L.push("");
  }
  if (report.chunk) L.push("## Chunk", "", "```json", JSON.stringify({ coverage: report.chunk.coverage, chunks: report.chunk.chunks, preloadedInHtml: report.chunk.preloadedInHtml, second: report.chunk.second, reload: report.chunk.reload }, null, 1), "```", "");
  if (report.chunk?.jsWeight) {
    L.push("## Client JS per page (first visit, empty cache)", "", "| route | variant | files | raw KB | br q5 KB | max English sentinels in one file |", "|---|---|---|---|---|---|");
    for (const w of report.chunk.jsWeight) L.push(`| ${w.route} | ${w.variant} | ${w.files} | ${kb(w.raw)} | ${kb(w.br5)} | ${w.maxSentinelsInOneFile} |`);
    L.push("");
  }
  if (report.timings) {
    L.push("## Timings (p50 ms, MAIN → BRANCH, flag ON)", "", "| profile | width | locale | TTFB | FCP | LCP | DCL | load | doc transfer B |", "|---|---|---|---|---|---|---|---|---|");
    for (const a of report.timings.agg) L.push(`| ${a.profile} | ${a.width} | ${a.locale} | ${a.main.ttfb} → ${a.branch.ttfb} | ${a.main.fcp} → ${a.branch.fcp} | ${a.main.lcp} → ${a.branch.lcp} | ${a.main.dcl} → ${a.branch.dcl} | ${a.main.load} → ${a.branch.load} | ${a.main.transfer} → ${a.branch.transfer} |`);
  }
  if (failures.length) L.push("", "## Failures", "", ...failures.slice(0, 100).map((f) => `- ${f}`));
  return L.join("\n");
}

async function main() {
  console.log(`sentinels: ${SENT.length} English dictionary strings`);
  const s = await seed();
  const phases = new Set((process.env.EN_CHUNK_PHASES ?? "bytes,chunk,identity,timings").split(","));
  if (phases.has("bytes")) await bytesPhase(s);
  if (phases.has("chunk")) await chunkPhase(s);
  if (phases.has("identity")) await identityPhase(s);
  if (phases.has("timings")) await timingPhase(s);
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    writeFileSync(`${OUT}/en-chunk-proof.json`, JSON.stringify({ pass, failed: failures.length, failures, ...report }, null, 1));
    writeFileSync(`${OUT}/en-chunk-proof.md`, markdown());
    console.log(`\nen-chunk proof: ${pass} passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.slice(0, 80).map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
