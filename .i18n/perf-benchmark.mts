/* eslint-disable @typescript-eslint/no-explicit-any -- benchmark harness: loose JSON / DOM payloads */
/**
 * i18n performance benchmark — flag OFF vs flag ON, two production builds of the SAME commit served by
 * `next start` side by side on one CI runner, against an ephemeral PostgreSQL (CI service container only).
 *
 *   OFF  http://localhost:3612   built without DUBIZ_I18N_ENABLED (= Production today)
 *   ON   http://localhost:3611   built + started with DUBIZ_I18N_ENABLED=true
 *   EXP  http://localhost:3613   OPTIONAL experiment (only if reachable): flag ON + the marketing route group
 *                                forced static (`export const dynamic = "force-static"` in
 *                                app/(corporate)/layout.tsx, applied in CI to a throwaway worktree only)
 *
 * Phases (PERF_PHASES, default all):
 *   latency   ≥25 page routes (marketing, auth, signed-in app) + 5 RSC (soft-navigation) payloads + 4 signed-in
 *             API controls; warm-up, then
 *             N interleaved rounds (ABBA order per round) of OFF / ON / ON+dz_locale=en: TTFB (headers
 *             received) and total (body read), p50/p95/p99, ON−OFF deltas, x-nextjs-cache header.
 *   load      fixed concurrency (PERF_LOAD_CONC, default 20) for PERF_LOAD_SECONDS (default 25) per run,
 *             runs ordered OFF, ON, ON, OFF per route: req/s, p50/p95/p99, errors, server CPU% and RSS
 *             sampled from /proc every 250 ms (listener pid + descendants).
 *   browser   Chromium navigation timing (TTFB, FCP, LCP, DOMContentLoaded, load, settled = networkidle
 *             − 500 ms) at 390 / 820 / 1440 px, he + en, OFF vs ON, signed-in owner (localStorage token,
 *             the app's real session mechanism); 1 warm-up round + PERF_BROWSER_REPS measured rounds.
 *   experiment  only with EXP: marketing pages' server HTML (visible text, <html> attrs, <title>) of EXP
 *             vs OFF and vs ON for no cookie / dz_locale=he / dz_locale=en.
 *   rollback-pre  on ON (3611): the locale endpoint sets dz_locale=en and /login renders en/ltr; the cookie
 *             is saved for --rollback.
 * `--rollback` (run after the ON server on 3611 is replaced by the OFF build on the same port, same DB):
 *             the saved dz_locale=en cookie renders he/rtl, the endpoint answers 404, and a signed-in
 *             owner whose browser holds dz_locale=en sees Hebrew identical to the OFF server on 3612.
 *
 * Writes $PERF_OUT/perf.json (+ perf.md tables, rollback.json). Synthetic data only; no secrets, no Neon.
 * Exit code: 1 only if a correctness check fails (lang/dir, endpoint, rollback) or a phase crashes;
 * timings are evidence, never a pass/fail threshold.
 */
import { PrismaClient, BillingDocumentStatus, BillingDocumentType } from "@prisma/client";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import { signAuthToken } from "../lib/auth-token";
import { alternate, childPids, delta, mdTable, parseProcStat, parseVmRss, summarize, type Summary } from "./perf-lib";

const ON = process.env.I18N_ON_BASE ?? "http://localhost:3611";
const OFF = process.env.I18N_OFF_BASE ?? "http://localhost:3612";
const EXP = process.env.PERF_EXP_BASE ?? "http://localhost:3613";
const OUT = process.env.PERF_OUT ?? "perf-out";
const N = Number(process.env.PERF_N ?? 40);
const WARM = Number(process.env.PERF_WARM ?? 5);
const LOAD_SECONDS = Number(process.env.PERF_LOAD_SECONDS ?? 25);
const LOAD_CONC = Number(process.env.PERF_LOAD_CONC ?? 20);
const BROWSER_REPS = Number(process.env.PERF_BROWSER_REPS ?? 3);
const PHASES = new Set((process.env.PERF_PHASES ?? "latency,load,browser,experiment,rollback-pre").split(","));
const ROLLBACK = process.argv.includes("--rollback");
if (!/@localhost:5432\//.test(process.env.DATABASE_URL ?? "")) {
  console.error("ABORT: the benchmark runs only against the local CI service container");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const prisma = new PrismaClient();
const failures: string[] = [];
let pass = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 dubiz-perf";
const DAY = 86400_000;
let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

// ───────────────────────────── seed (one set-up business, the routes' dynamic ids) ─────────────────────────────
async function seed() {
  const b = await prisma.business.create({ data: { name: `perf-${uniq()}` } });
  const u = await prisma.user.create({ data: { email: `perf-${uniq()}@example.test`, password: "x", businessId: b.id, role: "USER", name: "Perf Owner" } });
  await prisma.businessProfile.create({ data: { businessId: b.id, billingLegalName: "Perf Synthetic Ltd", billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "1 Test St", billingPhone: "0500000000", billingEmail: "perf@example.test", onboardingCompletedAt: new Date(Date.now() - 30 * DAY) } });
  const customers = [];
  for (let i = 0; i < 12; i++) customers.push(await prisma.customer.create({ data: { businessId: b.id, name: `לקוח ${i + 1}`, phone: `05012345${String(i).padStart(2, "0")}` } }));
  let firstInv = 0;
  for (let i = 0; i < 12; i++) {
    const inv = await prisma.billingDocument.create({
      data: {
        businessId: b.id, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, customerId: customers[i].id,
        customerNameSnapshot: customers[i].name, currency: "ILS", subtotalAmount: "847.46", vatAmount: "152.54", totalAmount: "1000.00",
        documentNumber: 900000 + b.id * 100 + i, documentNumberFormatted: String(900000 + b.id * 100 + i), issuedAt: new Date(Date.now() - (40 + i) * DAY),
      },
    });
    if (!firstInv) firstInv = inv.id;
  }
  let leadId = "999999";
  try { leadId = String((await prisma.lead.create({ data: { businessId: b.id, customerName: customers[0].name, phone: "0501234500", customerId: customers[0].id } })).id); } catch { /* not-found state */ }
  return { businessId: b.id, token: signAuthToken(u.id), customerId: String(customers[0].id), invoiceId: String(firstInv), leadId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

// ───────────────────────────── route set ─────────────────────────────
type Cls = "marketing" | "auth" | "app" | "rsc" | "api";
type R = { cls: Cls; path: string; label: string };
function routeSet(s: Seed): R[] {
  const m = (p: string): R => ({ cls: "marketing", path: p, label: p });
  const a = (p: string): R => ({ cls: "auth", path: p, label: p });
  const app = (p: string, label = p): R => ({ cls: "app", path: p, label });
  return [
    m("/home"), m("/about"), m("/contact"), m("/privacy"), m("/terms"), m("/data-deletion"),
    a("/login"), a("/register"), a("/forgot-password"),
    app("/app"), app("/collection"), app(`/collection/c/${s.customerId}`, "/collection/c/[customerId]"),
    app("/billing"), app(`/billing/${s.invoiceId}`, "/billing/[id]"),
    app("/customers"), app(`/customers/${s.customerId}`, "/customers/[id]"),
    app("/leads"), app(`/leads/${s.leadId}`, "/leads/[id]"),
    app("/settings"), app("/settings/workspace"), app("/secretary"), app("/payables"),
    app("/inventory"), app("/inventory/items"), app("/documents"), app("/tasks"), app("/profile"),
    app("/search"), app("/tools/money"),
    // Client-side (soft) navigation: the RSC payload the router fetches (header RSC: 1). Static in Production
    // today (served from the CDN with the page); a function call per soft navigation with the flag ON.
    ...["/app", "/collection", "/customers", "/billing", "/settings"].map((p): R => ({ cls: "rsc", path: p, label: `RSC ${p}` })),
    { cls: "api", path: "/api/home", label: "GET /api/home" },
    { cls: "api", path: "/api/customers", label: "GET /api/customers" },
    { cls: "api", path: "/api/leads", label: "GET /api/leads" },
    { cls: "api", path: "/api/billing/documents", label: "GET /api/billing/documents" },
  ];
}

type Variant = { name: "off" | "on" | "on-en" | "exp" | "exp-en"; base: string; cookie?: string };
async function reachable(base: string) {
  try { return (await fetch(base + "/login", { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
}

type Hit = { status: number; ttfb: number; total: number; bytes: number; cache: string | null; html: string };
async function hit(base: string, path: string, opts: { cookie?: string; token?: string; keepBody?: boolean; rsc?: boolean } = {}): Promise<Hit> {
  const headers: Record<string, string> = { "user-agent": UA, "accept-language": "he-IL,he;q=0.9", accept: "text/html,application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.rsc) { headers.rsc = "1"; headers.accept = "*/*"; }
  const t0 = performance.now();
  const res = await fetch(base + path, { headers, redirect: "manual" });
  const t1 = performance.now();
  const buf = await res.arrayBuffer();
  const t2 = performance.now();
  return {
    status: res.status, ttfb: t1 - t0, total: t2 - t0, bytes: buf.byteLength,
    cache: res.headers.get("x-nextjs-cache") ?? (res.headers.get("x-nextjs-prerender") ? "prerender" : null),
    html: opts.keepBody ? new TextDecoder().decode(buf) : "",
  };
}
const htmlTag = (html: string) => /<html[^>]*>/.exec(html)?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

// ───────────────────────────── 1 · latency ─────────────────────────────
async function latency(s: Seed, hasExp: boolean) {
  console.log(`\n== 1 · server latency: ${WARM} warm-up + ${N} measured rounds, ABBA per round ==`);
  const routes = routeSet(s);
  const variantsFor = (r: R): Variant[] => {
    if (r.cls === "api") return [{ name: "off", base: OFF }, { name: "on", base: ON }];
    const v: Variant[] = [{ name: "off", base: OFF }, { name: "on", base: ON }, { name: "on-en", base: ON, cookie: "dz_locale=en" }];
    if (hasExp && r.cls === "marketing") v.push({ name: "exp", base: EXP }, { name: "exp-en", base: EXP, cookie: "dz_locale=en" });
    return v;
  };
  const samples = new Map<string, { ttfb: number[]; total: number[]; status: Record<string, number>; cache: Record<string, number>; bytes: number[] }>();
  const key = (r: R, v: string) => `${r.label}\u0000${v}`;
  // An RSC request without the matching `_rsc` cache-busting parameter is answered 307 → the URL that has it
  // (Next 16). Resolve that URL once per route × variant, then time the real payload request.
  const rscPath = new Map<string, string>();
  for (const r of routes.filter((x) => x.cls === "rsc")) {
    for (const v of variantsFor(r)) {
      const res = await fetch(v.base + r.path, { headers: { "user-agent": UA, rsc: "1", accept: "*/*", ...(v.cookie ? { cookie: v.cookie } : {}) }, redirect: "manual" });
      const loc = res.headers.get("location");
      await res.arrayBuffer();
      const u = loc ? new URL(loc, v.base) : null;
      rscPath.set(key(r, v.name), u ? u.pathname + u.search : r.path);
    }
  }
  for (let round = 0; round < WARM + N; round++) {
    for (const r of routes) {
      for (const v of alternate(variantsFor(r), round)) {
        const h = await hit(v.base, rscPath.get(key(r, v.name)) ?? r.path, { cookie: v.cookie, token: r.cls === "api" ? s.token : undefined, rsc: r.cls === "rsc" });
        if (round < WARM) continue;
        const k = key(r, v.name);
        const e = samples.get(k) ?? { ttfb: [], total: [], status: {}, cache: {}, bytes: [] };
        e.ttfb.push(h.ttfb); e.total.push(h.total); e.bytes.push(h.bytes);
        e.status[h.status] = (e.status[h.status] ?? 0) + 1;
        e.cache[String(h.cache)] = (e.cache[String(h.cache)] ?? 0) + 1;
        samples.set(k, e);
      }
    }
    if (round % 10 === 0) console.log(`  round ${round + 1}/${WARM + N}`);
  }
  const rows = routes.map((r) => {
    const per: Record<string, any> = {};
    for (const v of variantsFor(r)) {
      const e = samples.get(key(r, v.name))!;
      per[v.name] = { ttfb: summarize(e.ttfb), total: summarize(e.total), status: e.status, cache: e.cache, bytesP50: summarize(e.bytes).p50 };
    }
    const d = (a: string, b: string, f: "ttfb" | "total") => (per[a] && per[b] ? delta(per[a][f], per[b][f]) : null);
    return { cls: r.cls, route: r.label, per, deltaOnOff: { ttfb: d("off", "on", "ttfb"), total: d("off", "on", "total") }, deltaOnEnOff: { ttfb: d("off", "on-en", "ttfb"), total: d("off", "on-en", "total") }, deltaExpOff: { ttfb: d("off", "exp", "ttfb"), total: d("off", "exp", "total") } };
  });
  // Per class: the pooled samples of every route of the class.
  const byClass: Record<string, any> = {};
  for (const cls of ["marketing", "auth", "app", "rsc", "api"] as Cls[]) {
    const names = cls === "api" ? ["off", "on"] : ["off", "on", "on-en", ...(hasExp && cls === "marketing" ? ["exp", "exp-en"] : [])];
    const pooled: Record<string, { ttfb: Summary; total: Summary }> = {};
    for (const v of names) {
      const t: number[] = []; const tt: number[] = [];
      for (const r of routes.filter((x) => x.cls === cls)) { const e = samples.get(key(r, v)); if (e) { t.push(...e.ttfb); tt.push(...e.total); } }
      pooled[v] = { ttfb: summarize(t), total: summarize(tt) };
    }
    byClass[cls] = { routes: routes.filter((x) => x.cls === cls).length, pooled, deltaOnOff: { ttfb: delta(pooled.off.ttfb, pooled.on.ttfb), total: delta(pooled.off.total, pooled.on.total) }, ...(pooled["on-en"] ? { deltaOnEnOff: { ttfb: delta(pooled.off.ttfb, pooled["on-en"].ttfb), total: delta(pooled.off.total, pooled["on-en"].total) } } : {}) };
  }
  for (const r of rows) ok(`latency ${r.route} — same status OFF vs ON`, JSON.stringify(Object.keys(r.per.off.status)) === JSON.stringify(Object.keys(r.per.on.status)), `${JSON.stringify(r.per.off.status)} vs ${JSON.stringify(r.per.on.status)}`);
  for (const r of routes.filter((x) => x.cls === "rsc")) {
    const st = (v: string) => samples.get(key(r, v))?.status ?? {};
    ok(`latency ${r.label} — RSC payload answered 200 on both builds`, !!st("off")["200"] && !!st("on")["200"], JSON.stringify([st("off"), st("on")]));
  }
  return { n: N, warm: WARM, rows, byClass, rscPaths: Object.fromEntries(rscPath) };
}

// ───────────────────────────── 2 · load ─────────────────────────────
function listenerPid(port: number): number | null {
  try {
    const out = execSync(`ss -Htlnp "sport = :${port}"`, { encoding: "utf8" });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
function procTree(root: number): number[] {
  const pairs: Array<{ pid: number; ppid: number }> = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = parseProcStat(readFileSync(`/proc/${d}/stat`, "utf8")); if (st) pairs.push({ pid: Number(d), ppid: st.ppid }); } catch { /* exited */ }
  }
  return [root, ...childPids(root, pairs)];
}
function sampleProc(pids: number[]) {
  let ticks = 0, rss = 0;
  for (const p of pids) {
    try { ticks += parseProcStat(readFileSync(`/proc/${p}/stat`, "utf8"))?.ticks ?? 0; } catch { /* exited */ }
    try { rss += parseVmRss(readFileSync(`/proc/${p}/status`, "utf8")) ?? 0; } catch { /* exited */ }
  }
  return { ticks, rssKb: rss };
}
const CLK_TCK = 100; // Linux USER_HZ on GitHub ubuntu runners (getconf CLK_TCK = 100)

async function loadRun(base: string, path: string, cookie: string | undefined, seconds: number) {
  const port = Number(new URL(base).port);
  const pid = listenerPid(port);
  const pids = pid ? procTree(pid) : [];
  const lat: number[] = [];
  let errors = 0, done = 0;
  const statuses: Record<string, number> = {};
  const cpuSamples: number[] = [];
  const rssSamples: number[] = [];
  let prev = pids.length ? sampleProc(pids) : null;
  let prevT = performance.now();
  const sampler = setInterval(() => {
    if (!pids.length) return;
    const cur = sampleProc(pids);
    const now = performance.now();
    cpuSamples.push(((cur.ticks - prev!.ticks) / CLK_TCK) / ((now - prevT) / 1000) * 100);
    rssSamples.push(cur.rssKb / 1024);
    prev = cur; prevT = now;
  }, 250);
  const clientCpu0 = process.cpuUsage();
  const t0 = performance.now();
  const end = t0 + seconds * 1000;
  await Promise.all(Array.from({ length: LOAD_CONC }, async () => {
    while (performance.now() < end) {
      const s = performance.now();
      try {
        const res = await fetch(base + path, { headers: { "user-agent": UA, "accept-language": "he-IL,he;q=0.9", ...(cookie ? { cookie } : {}) }, redirect: "manual" });
        await res.arrayBuffer();
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status >= 400) errors++;
      } catch { errors++; statuses.exception = (statuses.exception ?? 0) + 1; }
      lat.push(performance.now() - s);
      done++;
    }
  }));
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(sampler);
  const cc = process.cpuUsage(clientCpu0);
  const lsum = summarize(lat);
  const cpu = summarize(cpuSamples);
  return {
    requests: done, reqPerSec: Math.round((done / elapsed) * 10) / 10, errors, statuses,
    latency: { p50: lsum.p50, p95: lsum.p95, p99: lsum.p99 },
    serverCpuPct: { mean: cpu.mean, p95: cpu.p95, max: cpu.max }, serverRssMb: { mean: summarize(rssSamples).mean, max: summarize(rssSamples).max },
    serverPids: pids.length, loadgenCpuPct: Math.round(((cc.user + cc.system) / 1e6 / elapsed) * 1000) / 10,
  };
}

async function load() {
  console.log(`\n== 2 · load: concurrency ${LOAD_CONC}, ${LOAD_SECONDS}s per run, OFF/ON/ON/OFF per route ==`);
  const routes = ["/home", "/login", "/app", "/collection", "/settings"];
  const rows: any[] = [];
  for (const path of routes) {
    const runs: Record<string, any[]> = { off: [], on: [] };
    for (const [name, base] of [["off", OFF], ["on", ON], ["on", ON], ["off", OFF]] as const) {
      // 2 s warm-up at the same concurrency, not counted
      await loadRun(base, path, undefined, 2);
      const r = await loadRun(base, path, undefined, LOAD_SECONDS);
      runs[name].push(r);
      console.log(`  ${path} ${name}: ${r.reqPerSec} req/s p95 ${r.latency.p95} ms errors ${r.errors} cpu ${r.serverCpuPct.mean}% rss ${r.serverRssMb.max} MB`);
    }
    const avg = (xs: any[], f: (x: any) => number) => Math.round((xs.reduce((a, x) => a + f(x), 0) / xs.length) * 10) / 10;
    const agg = (xs: any[]) => ({ reqPerSec: avg(xs, (x) => x.reqPerSec), p50: avg(xs, (x) => x.latency.p50), p95: avg(xs, (x) => x.latency.p95), p99: avg(xs, (x) => x.latency.p99), errors: xs.reduce((a, x) => a + x.errors, 0), cpuPct: avg(xs, (x) => x.serverCpuPct.mean), cpuMsPerReq: avg(xs, (x) => (x.serverCpuPct.mean * 10) / x.reqPerSec), rssMaxMb: Math.max(...xs.map((x) => x.serverRssMb.max)), loadgenCpuPct: avg(xs, (x) => x.loadgenCpuPct) });
    rows.push({ route: path, off: agg(runs.off), on: agg(runs.on), runs });
  }
  return { concurrency: LOAD_CONC, seconds: LOAD_SECONDS, rows };
}

// ───────────────────────────── 3 · browser ─────────────────────────────
async function browserPhase(s: Seed) {
  console.log(`\n== 3 · browser: 8 routes × 3 widths × he/en × OFF/ON, 1 warm-up + ${BROWSER_REPS} rounds ==`);
  const routes = ["/home", "/login", "/app", "/collection", "/billing", `/billing/${s.invoiceId}`, "/customers", "/settings"];
  const label = (r: string) => r.replace(/\/billing\/\d+/, "/billing/[id]");
  const vps = [{ name: "390", width: 390, height: 844 }, { name: "820", width: 820, height: 1180 }, { name: "1440", width: 1440, height: 900 }];
  const browser: Browser = await chromium.launch();
  const out: any[] = [];
  const mkCtx = async (base: string, vp: (typeof vps)[number], locale: "he" | "en") => {
    const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height }, extraHTTPHeaders: { "accept-language": "he-IL,he;q=0.9" } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque origin */ } }, s.token);
    if (locale === "en") await ctx.addCookies([{ name: "dz_locale", value: "en", url: base }]);
    return ctx;
  };
  for (const vp of vps) {
    for (const locale of ["he", "en"] as const) {
      const ctxs: Record<"off" | "on", BrowserContext> = { off: await mkCtx(OFF, vp, locale), on: await mkCtx(ON, vp, locale) };
      const acc = new Map<string, Record<string, number[]>>();
      const langs = new Map<string, string>();
      for (let round = 0; round <= BROWSER_REPS; round++) {
        for (const r of routes) {
          for (const build of alternate(["off", "on"] as const, round)) {
            const page = await ctxs[build].newPage();
            const t0 = Date.now();
            await page.goto((build === "off" ? OFF : ON) + r, { waitUntil: "load", timeout: 60_000 }).catch(() => undefined);
            const idleOk = await page.waitForLoadState("networkidle", { timeout: 10_000 }).then(() => true).catch(() => false);
            const settled = Date.now() - t0 - (idleOk ? 500 : 0);
            const m = await page.evaluate(() => new Promise<any>((res) => {
              const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
              const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
              let lcp: number | null = null;
              try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch { /* unsupported */ }
              setTimeout(() => res({
                ttfb: nav ? nav.responseStart - nav.startTime : null, fcp, lcp,
                dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null, load: nav ? nav.loadEventEnd - nav.startTime : null,
                lang: document.documentElement.lang, dir: document.documentElement.dir,
              }), 100);
            })).catch(() => null);
            await page.close();
            if (!m) continue;
            langs.set(`${build} ${r}`, `${m.lang}/${m.dir}`);
            if (round === 0) continue;
            const k = `${build}\u0000${r}`;
            const e = acc.get(k) ?? { ttfb: [], fcp: [], lcp: [], dcl: [], load: [], settled: [] };
            for (const f of ["ttfb", "fcp", "lcp", "dcl", "load"] as const) if (typeof m[f] === "number") e[f].push(m[f]);
            e.settled.push(settled);
            acc.set(k, e);
          }
        }
      }
      await ctxs.off.close(); await ctxs.on.close();
      for (const r of routes) {
        const row: any = { vp: vp.name, locale, route: label(r) };
        for (const build of ["off", "on"] as const) {
          const e = acc.get(`${build}\u0000${r}`) ?? {};
          row[build] = Object.fromEntries(Object.entries(e).map(([f, xs]) => [f, summarize(xs).p50]));
          row[`${build}Lang`] = langs.get(`${build} ${r}`);
        }
        out.push(row);
        const wantOn = locale === "en" ? "en/ltr" : "he/rtl";
        // Marketing pages: the root <html> follows the cookie (the content wrapper is pinned he/rtl, checked by R4).
        ok(`browser ${vp.name} ${locale} ${label(r)} — OFF renders he/rtl`, row.offLang === "he/rtl", row.offLang);
        ok(`browser ${vp.name} ${locale} ${label(r)} — ON renders ${wantOn}`, row.onLang === wantOn, row.onLang);
      }
      console.log(`  ${vp.name}px ${locale} done`);
    }
  }
  await browser.close();
  // Aggregate: median over routes of the per-route p50, per width × locale.
  const agg: any[] = [];
  for (const vp of vps) for (const locale of ["he", "en"]) {
    const rs = out.filter((x) => x.vp === vp.name && x.locale === locale);
    const med = (b: string, f: string) => summarize(rs.map((x) => x[b][f]).filter((v: any) => typeof v === "number")).p50;
    const row: any = { vp: vp.name, locale };
    for (const f of ["ttfb", "fcp", "lcp", "dcl", "load", "settled"]) row[f] = { off: med("off", f), on: med("on", f) };
    agg.push(row);
  }
  return { reps: BROWSER_REPS, rows: out, agg };
}

// ───────────────────────────── experiment: marketing pages forced static on the ON build ─────────────────────────────
function visibleText(html: string) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html;
  return body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<template[\s\S]*?<\/template>/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
/** The marketing wrapper's pin: a <div lang="he" dir="rtl"> before <main id="main-content"> (layout.tsx), or none. */
const wrapperAttrs = (html: string) => {
  const i = html.indexOf('id="main-content"');
  if (i < 0) return "no-wrapper";
  const pinned = /<div(?=[^>]*\blang="he")(?=[^>]*\bdir="rtl")[^>]*>/.test(html.slice(Math.max(0, html.indexOf("<body")), i));
  return pinned ? "he/rtl" : "null/null";
};
async function experiment() {
  console.log("\n== experiment: marketing route group forced static on the flag-ON build ==");
  const pages = ["/home", "/about", "/contact", "/privacy", "/terms", "/data-deletion", "/home-prototype"];
  const rows: any[] = [];
  for (const p of pages) {
    const get = async (base: string, cookie?: string) => { const h = await hit(base, p, { cookie, keepBody: true }); if (p === "/about") writeFileSync(`${OUT}/html-about-${base.slice(-4)}-${(cookie ?? "nocookie").replace(/[=;]/g, "_")}.html`, h.html); return { status: h.status, cache: h.cache, html: htmlTag(h.html), title: titleOf(h.html), text: visibleText(h.html), wrapper: wrapperAttrs(h.html) }; };
    const off = await get(OFF);
    const v: Record<string, any> = { off, on: await get(ON), "on-he": await get(ON, "dz_locale=he"), "on-en": await get(ON, "dz_locale=en"), exp: await get(EXP), "exp-he": await get(EXP, "dz_locale=he"), "exp-en": await get(EXP, "dz_locale=en") };
    const same = (x: any) => x.status === off.status && x.html === off.html && x.title === off.title && x.text === off.text && x.wrapper === off.wrapper;
    const row = { page: p, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { identicalToOff: same(x), html: x.html.replace(/ class="[^"]*"/, ""), wrapper: x.wrapper, cache: x.cache, textLen: x.text.length }])) };
    rows.push(row);
  }
  return { rows };
}

// ───────────────────────────── 5 · rollback ─────────────────────────────
async function rollbackPre() {
  console.log("\n== 5a · rollback, before: ON build on :3611 issues dz_locale=en ==");
  const res = await fetch(ON + "/api/preferences/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: "en" }) });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = /dz_locale=en/.test(setCookie) ? "dz_locale=en" : "";
  ok("rollback-pre — ON: POST /api/preferences/locale {en} → 200 + Set-Cookie dz_locale=en", res.status === 200 && !!cookie, `${res.status} ${setCookie.slice(0, 80)}`);
  const pages: Record<string, string> = {};
  for (const p of ["/login", "/app", "/customers"]) {
    const h = await hit(ON, p, { cookie, keepBody: true });
    pages[p] = `${h.status} ${attr(htmlTag(h.html), "lang")}/${attr(htmlTag(h.html), "dir")}`;
    ok(`rollback-pre — ON ${p} with the cookie renders en/ltr`, pages[p] === "200 en/ltr", pages[p]);
  }
  writeFileSync(`${OUT}/rollback-cookie.txt`, cookie);
  return { endpoint: res.status, setCookie: setCookie.split(";")[0], pages };
}

async function rollbackPost() {
  console.log("\n== 5b · rollback, after: the OFF build now serves :3611 (same DB, same browser cookie) ==");
  const cookie = existsSync(`${OUT}/rollback-cookie.txt`) ? readFileSync(`${OUT}/rollback-cookie.txt`, "utf8").trim() : "dz_locale=en";
  const s = await seed();
  const result: any = { cookie, pages: {}, browser: {} };
  const ep = await fetch(ON + "/api/preferences/locale", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ locale: "en" }) });
  result.endpoint = ep.status;
  ok("rollback — POST /api/preferences/locale → 404 on the OFF build", ep.status === 404, String(ep.status));
  for (const p of ["/login", "/app", "/customers", "/home", "/settings/workspace"]) {
    const h = await hit(ON, p, { cookie, keepBody: true });
    result.pages[p] = `${h.status} ${attr(htmlTag(h.html), "lang")}/${attr(htmlTag(h.html), "dir")}`;
    ok(`rollback — ${p} with dz_locale=en renders he/rtl`, result.pages[p] === "200 he/rtl", result.pages[p]);
  }
  // Signed-in owner whose browser holds dz_locale=en: Hebrew, identical visible text to the reference OFF server.
  const browser = await chromium.launch();
  for (const p of ["/app", "/customers", "/settings/workspace"]) {
    const read = async (base: string, withCookie: boolean) => {
      const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, s.token);
      if (withCookie) await ctx.addCookies([{ name: "dz_locale", value: "en", url: base }]);
      const page = await ctx.newPage();
      await page.goto(base + p, { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      let last = "";
      for (let i = 0, same = 0; i < 16 && same < 2; i++) { await page.waitForTimeout(500); const cur = await page.evaluate(() => document.body.innerText).catch(() => ""); same = cur === last && cur ? same + 1 : 0; last = cur; }
      const meta = await page.evaluate(() => `${document.documentElement.lang}/${document.documentElement.dir}`);
      await ctx.close();
      return { meta, text: last.replace(/\s+/g, " ").trim() };
    };
    const rolled = await read(ON, true);
    const ref = await read(OFF, false);
    result.browser[p] = { rolledBack: rolled.meta, reference: ref.meta, textIdentical: rolled.text === ref.text };
    ok(`rollback — signed-in ${p} with dz_locale=en: he/rtl, same text as the OFF reference`, rolled.meta === "he/rtl" && rolled.text === ref.text, JSON.stringify(result.browser[p]));
  }
  await browser.close();
  writeFileSync(`${OUT}/rollback.json`, JSON.stringify({ pass, failed: failures.length, failures, ...result }, null, 2));
  return result;
}

// ───────────────────────────── report ─────────────────────────────
function markdown(rep: any) {
  const parts: string[] = [];
  const f = (s: Summary | undefined) => (s ? `${s.p50} / ${s.p95} / ${s.p99}` : "—");
  if (rep.latency) {
    const L = rep.latency;
    parts.push(`### Server latency by class (pooled; ms, p50 / p95 / p99; N=${L.n} per route per variant)\n`);
    parts.push(mdTable(["class", "routes", "TTFB OFF", "TTFB ON", "TTFB ON en", "Δ p50 ON−OFF", "Δ p95 ON−OFF", "total OFF", "total ON", "total ON en"],
      Object.entries(L.byClass).map(([c, x]: [string, any]) => [c, x.routes, f(x.pooled.off.ttfb), f(x.pooled.on.ttfb), f(x.pooled["on-en"]?.ttfb), x.deltaOnOff.ttfb.p50, x.deltaOnOff.ttfb.p95, f(x.pooled.off.total), f(x.pooled.on.total), f(x.pooled["on-en"]?.total)])));
    if (L.byClass.marketing?.pooled?.exp) {
      const x = L.byClass.marketing.pooled;
      parts.push(`\nExperiment (marketing, flag ON + (corporate) force-static): TTFB ${f(x.exp.ttfb)} (en cookie ${f(x["exp-en"].ttfb)}); total ${f(x.exp.total)}`);
    }
    parts.push(`\n### Server latency per route (ms; TTFB p50/p95/p99; total p50; cache header)\n`);
    parts.push(mdTable(["class", "route", "OFF TTFB", "ON TTFB", "ON en TTFB", "Δ p50", "Δ p95", "OFF total p50", "ON total p50", "OFF cache", "ON cache", "status OFF/ON"],
      L.rows.map((r: any) => [r.cls, r.route, f(r.per.off.ttfb), f(r.per.on.ttfb), f(r.per["on-en"]?.ttfb), r.deltaOnOff.ttfb?.p50, r.deltaOnOff.ttfb?.p95, r.per.off.total.p50, r.per.on.total.p50, Object.keys(r.per.off.cache).join(","), Object.keys(r.per.on.cache).join(","), `${Object.keys(r.per.off.status)}/${Object.keys(r.per.on.status)}`])));
  }
  if (rep.load) {
    parts.push(`\n### Load (concurrency ${rep.load.concurrency}, ${rep.load.seconds}s × 2 runs per build, OFF/ON/ON/OFF)\n`);
    parts.push(mdTable(["route", "req/s OFF", "req/s ON", "p95 OFF", "p95 ON", "p99 OFF", "p99 ON", "errors OFF/ON", "server CPU% OFF", "server CPU% ON", "CPU ms/req OFF", "CPU ms/req ON", "RSS max MB OFF", "RSS max MB ON", "loadgen CPU% OFF/ON"],
      rep.load.rows.map((r: any) => [r.route, r.off.reqPerSec, r.on.reqPerSec, r.off.p95, r.on.p95, r.off.p99, r.on.p99, `${r.off.errors}/${r.on.errors}`, r.off.cpuPct, r.on.cpuPct, r.off.cpuMsPerReq, r.on.cpuMsPerReq, r.off.rssMaxMb, r.on.rssMaxMb, `${r.off.loadgenCpuPct}/${r.on.loadgenCpuPct}`])));
  }
  if (rep.browser) {
    parts.push(`\n### Browser (median over the 8 routes of each route's p50; ms; OFF → ON)\n`);
    const c = (x: any) => `${x.off} → ${x.on}`;
    parts.push(mdTable(["width", "locale", "TTFB", "FCP", "LCP", "DCL", "load", "settled"], rep.browser.agg.map((a: any) => [a.vp, a.locale, c(a.ttfb), c(a.fcp), c(a.lcp), c(a.dcl), c(a.load), c(a.settled)])));
    parts.push(`\n#### Browser per route (p50 ms, OFF → ON)\n`);
    parts.push(mdTable(["width", "locale", "route", "TTFB", "FCP", "LCP", "load", "settled", "lang OFF / ON"], rep.browser.rows.map((r: any) => [r.vp, r.locale, r.route, `${r.off.ttfb} → ${r.on.ttfb}`, `${r.off.fcp} → ${r.on.fcp}`, `${r.off.lcp} → ${r.on.lcp}`, `${r.off.load} → ${r.on.load}`, `${r.off.settled} → ${r.on.settled}`, `${r.offLang} / ${r.onLang}`])));
  }
  if (rep.experiment) {
    parts.push(`\n### Experiment — marketing pages' server output vs flag OFF (visible text, <html>, <title>, wrapper)\n`);
    const vs = ["on", "on-he", "on-en", "exp", "exp-he", "exp-en"];
    parts.push(mdTable(["page", ...vs.map((v) => `${v} = OFF?`), "on-en <html> / wrapper", "exp-en <html> / wrapper", "cache OFF / ON / EXP"],
      rep.experiment.rows.map((r: any) => [r.page, ...vs.map((v) => (r[v].identicalToOff ? "yes" : "NO")), `${r["on-en"].html} / ${r["on-en"].wrapper}`, `${r["exp-en"].html} / ${r["exp-en"].wrapper}`, `${r.off.cache} / ${r.on.cache} / ${r.exp.cache}`])));
  }
  return parts.join("\n");
}

async function main() {
  if (ROLLBACK) { await rollbackPost(); return; }
  const env = {
    node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}`,
    commit: process.env.GITHUB_SHA ?? "local", run: process.env.GITHUB_RUN_ID ?? "local",
  };
  const hasExp = PHASES.has("experiment") && (await reachable(EXP));
  console.log(`env: ${JSON.stringify(env)}; experiment server: ${hasExp}`);
  for (const b of [ON, OFF]) ok(`${b} reachable`, await reachable(b));
  const s = await seed();
  const rep: any = { env, hasExp };
  const run = async (name: string, fn: () => Promise<any>) => {
    if (!PHASES.has(name)) return;
    try { rep[name] = await fn(); } catch (e) { failures.push(`${name} crashed: ${(e as Error).stack ?? e}`); console.error(e); }
    writeFileSync(`${OUT}/perf.json`, JSON.stringify(rep, null, 1));
  };
  await run("latency", () => latency(s, hasExp));
  await run("load", load);
  await run("browser", () => browserPhase(s));
  if (hasExp) await run("experiment", experiment);
  await run("rollback-pre", rollbackPre);
  rep.checks = { pass, failed: failures.length, failures };
  writeFileSync(`${OUT}/perf.json`, JSON.stringify(rep, null, 1));
  const md = markdown(rep);
  writeFileSync(`${OUT}/perf.md`, md);
  console.log("\n" + md);
}

main()
  .catch((e) => { failures.push(`crash: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nperf benchmark${ROLLBACK ? " (rollback)" : ""}: ${pass} checks passed, ${failures.length} failed`);
    if (failures.length) { console.log(failures.slice(0, 100).map((f) => ` - ${f}`).join("\n")); process.exit(1); }
  });
